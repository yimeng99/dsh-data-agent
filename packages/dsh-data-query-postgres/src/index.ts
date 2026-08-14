/**
 * dsh-data-query-postgres — PostgreSQL provider for the `dataQuery` capability.
 *
 * V0.2 implementation, mirroring the MySQL provider: information_schema schema
 * discovery (TTL cache) → shared read-only Text-to-SQL prompt → shared SQL
 * validation → `pg` pool execution with timeout + abort.
 *
 * Load this plugin INSTEAD of any other `dataQuery` provider — only one
 * provider may register the service in a profile.
 */
import { type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import pg from 'pg'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  DataQueryError,
  DataQueryService,
  buildTextToSqlPrompt,
  extractSql,
  type DataQueryCapabilities,
  type DataQueryRequest,
  type DataQueryResult,
  type DataQueryTable,
  validateReadOnlySql,
} from 'dsh-data-query'

/** Resolved plugin configuration. */
export interface Config {
  host: string
  port: number
  user: string
  password: string
  database: string
  llmProvider: string
  llmModel: string
  maxRows: number
  timeoutMs: number
  schemaCacheTtlMs: number
}

/** Runtime schema for the plugin configuration. */
export const Config = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().default(5432),
  user: z.string().default('postgres'),
  password: z.string().default(''),
  database: z.string().required(),
  llmProvider: z.string().default('deepseek-official'),
  llmModel: z.string().default('deepseek-v4-flash'),
  maxRows: z.number().default(100),
  timeoutMs: z.number().default(15000),
  schemaCacheTtlMs: z.number().default(60000),
})

const SCHEMA_TABLES_SQL = `
  SELECT t.table_schema,
         t.table_name,
         obj_description(c.oid) AS table_comment,
         col.column_name,
         col.data_type,
         col.is_nullable,
         col_description(c.oid, col.ordinal_position::int) AS column_comment
  FROM information_schema.tables t
  JOIN information_schema.columns col
    ON col.table_schema = t.table_schema AND col.table_name = t.table_name
  JOIN pg_catalog.pg_class c ON c.relname = t.table_name
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.table_schema
  WHERE t.table_schema = $1 AND t.table_type = 'BASE TABLE'
  ORDER BY t.table_name, col.ordinal_position`

const SCHEMA_FKS_SQL = `
  SELECT tc.table_name,
         kcu.column_name,
         ccu.table_schema AS ref_schema,
         ccu.table_name   AS ref_table,
         ccu.column_name  AS ref_column
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
  JOIN information_schema.constraint_column_usage ccu
    ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
  WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1`

/** Convert a row into JSON-safe values (Date → ISO string, Buffer → hex). */
function sanitizeCell(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return value.toString('hex')
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(sanitizeCell)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeCell(v)
    return out
  }
  return value
}

export class PostgresDataQueryService extends DataQueryService {
  private readonly pool: pg.Pool
  private schemaCache: { at: number; schema: DataQueryTable[] } | undefined

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx)
    this.pool = new pg.Pool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      max: 4,
    })
  }

  capabilities(): DataQueryCapabilities {
    return { dialect: 'postgresql', readOnly: true, supportsSchemaDiscovery: true }
  }

  /** Close the underlying connection pool. */
  async stop(): Promise<void> {
    await this.pool.end()
  }

  async refreshSchema(): Promise<void> {
    this.schemaCache = undefined
    await this.loadSchema()
  }

  async query(request: DataQueryRequest): Promise<DataQueryResult> {
    const started = Date.now()
    if (!request.question?.trim() && !request.sql?.trim()) {
      throw new DataQueryError('question or sql is required', 'INVALID_QUESTION')
    }
    this.throwIfAborted(request.signal)

    const schema = await this.loadSchema(request.signal)

    let sql = request.sql?.trim()
    if (!sql) {
      try {
        sql = await this.textToSql(request, schema)
      } catch (error) {
        if (error instanceof DataQueryError) throw error
        throw new DataQueryError(
          `text-to-sql failed: ${error instanceof Error ? error.message : String(error)}`,
          'TEXT_TO_SQL_FAILED',
        )
      }
      this.throwIfAborted(request.signal)
    }

    const maxRows = request.maxRows ?? this.config.maxRows
    const validated = validateReadOnlySql(sql, maxRows, true)

    const { rows, columns } = await this.execute(validated, request)
    const truncated = rows.length > maxRows
    const visible = truncated ? rows.slice(0, maxRows) : rows

    return {
      sql: validated,
      columns,
      rows: visible,
      truncated,
      rowCount: visible.length,
      elapsedMs: Date.now() - started,
      schema,
    }
  }

  // ---------------------------------------------------------------- pipeline

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new DataQueryError('query aborted by the caller', 'ABORTED')
    }
  }

  private async loadSchema(signal?: AbortSignal): Promise<DataQueryTable[]> {
    const ttl = this.config.schemaCacheTtlMs
    if (ttl > 0 && this.schemaCache && Date.now() - this.schemaCache.at < ttl) {
      return this.schemaCache.schema
    }
    this.throwIfAborted(signal)

    let tables: DataQueryTable[]
    try {
      const tableResult = await this.pool.query(SCHEMA_TABLES_SQL, [this.config.database])
      const fkResult = await this.pool.query(SCHEMA_FKS_SQL, [this.config.database])
      tables = groupSchema(tableResult.rows, fkResult.rows)
    } catch (error) {
      throw new DataQueryError(
        `schema discovery failed: ${error instanceof Error ? error.message : String(error)}`,
        'SCHEMA_LOAD_FAILED',
      )
    }

    this.schemaCache = { at: Date.now(), schema: tables }
    return tables
  }

  private async textToSql(request: DataQueryRequest, schema: DataQueryTable[]): Promise<string> {
    const llmProvider = request.llmProvider ?? this.config.llmProvider
    const llmModel = request.llmModel ?? this.config.llmModel
    const system = buildTextToSqlPrompt({
      dialect: 'PostgreSQL',
      schema,
      identity: request,
    })

    const message = createUserMessage({
      content: [{ type: 'text', text: request.question }],
      source: { kind: 'user' },
    })

    let text = ''
    const stream = this.ctx.llm.stream({
      provider: llmProvider,
      model: llmModel,
      system,
      messages: [message],
      temperature: 0,
      signal: request.signal,
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'finish' && chunk.reason.kind !== 'stop') {
        throw new DataQueryError(
          `text-to-sql generation ended abnormally: ${chunk.reason.kind}`,
          'TEXT_TO_SQL_FAILED',
        )
      }
    }
    return extractSql(text)
  }

  private async execute(
    sql: string,
    request: DataQueryRequest,
  ): Promise<{ rows: Record<string, unknown>[]; columns: string[] }> {
    const timeoutMs = request.timeoutMs ?? this.config.timeoutMs
    const signal = request.signal

    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new DataQueryError(`query timed out after ${timeoutMs}ms`, 'TIMEOUT'))
      }, timeoutMs)
    })
    const aborted = signal
      ? new Promise<never>((_, reject) => {
          if (signal.aborted) {
            reject(new DataQueryError('query aborted by the caller', 'ABORTED'))
            return
          }
          signal.addEventListener(
            'abort',
            () => reject(new DataQueryError('query aborted by the caller', 'ABORTED')),
            { once: true },
          )
        })
      : undefined

    try {
      const result = await Promise.race(
        aborted ? [this.pool.query(sql), timeout, aborted] : [this.pool.query(sql), timeout],
      )
      const { rows, fields } = result as pg.QueryResult
      const sanitized = rows.map((r) => {
        const out: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(r)) out[k] = sanitizeCell(v)
        return out
      })
      const columns = fields?.map((f) => f.name) ?? (sanitized[0] ? Object.keys(sanitized[0]) : [])
      return { rows: sanitized, columns }
    } catch (error) {
      if (error instanceof DataQueryError) throw error
      throw new DataQueryError(
        `query execution failed: ${error instanceof Error ? error.message : String(error)}`,
        'SQL_EXECUTION_FAILED',
      )
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}

/** Group information_schema rows into typed tables with foreign keys. */
function groupSchema(
  tableRows: Record<string, unknown>[],
  fkRows: Record<string, unknown>[],
): DataQueryTable[] {
  const tables = new Map<string, DataQueryTable>()
  for (const r of tableRows) {
    const name = String(r.table_name)
    let table = tables.get(name)
    if (!table) {
      table = {
        schema: String(r.table_schema ?? ''),
        name,
        comment: r.table_comment ? String(r.table_comment) : undefined,
        columns: [],
        foreignKeys: [],
      }
      tables.set(name, table)
    }
    table.columns.push({
      name: String(r.column_name),
      type: r.data_type ? String(r.data_type) : undefined,
      nullable: r.is_nullable !== 'NO',
      comment: r.column_comment ? String(r.column_comment) : undefined,
    })
  }
  for (const r of fkRows) {
    const table = tables.get(String(r.table_name))
    if (!table) continue
    table.foreignKeys?.push({
      column: String(r.column_name),
      refSchema: String(r.ref_schema),
      refTable: String(r.ref_table),
      refColumn: String(r.ref_column),
    })
  }
  return [...tables.values()]
}

export const name = 'data-query-postgres'
export const inject = ['llm']

export function apply(ctx: Context, config: Config): () => Promise<void> {
  const service = new PostgresDataQueryService(ctx, config)
  return () => service.stop()
}

export { extractSql, validateReadOnlySql }

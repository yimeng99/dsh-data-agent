/**
 * dsh-data-query-mysql — MySQL provider for the `dataQuery` capability.
 *
 * Implements the query pipeline:
 *
 *   question
 *     ↓
 *   schema discovery   (information_schema, TTL cache)
 *     ↓
 *   Text-to-SQL        (ctx.llm, read-only rules, shared prompt builder)
 *     ↓
 *   SQL validation     (shared: SELECT/WITH only, forbidden keywords, LIMIT clamp)
 *     ↓
 *   read-only execution (mysql2 pool, timeout + abort)
 *     ↓
 *   structured rows
 *
 * Load this plugin INSTEAD of any other `dataQuery` provider — only one
 * provider may register the service in a profile.
 */
import { type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import mysql from 'mysql2/promise'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  DataQueryError,
  buildTextToSqlPrompt,
  extractSql,
  type DataQueryBackend,
  type DataQueryCapabilities,
  type DataQueryRequest,
  type DataQueryResult,
  type DataQueryTable,
  validateReadOnlySql,
} from 'dsh-data-query'

/** Resolved plugin configuration (schemastery output shape). */
export interface Config {
  /** Unique data source id exposed to the `data_query` tool's `source` arg. */
  sourceId: string
  /** Make this source the default (fallback) when `source` is omitted. */
  isDefault: boolean
  host: string
  port: number
  user: string
  password: string
  database: string
  /** LLM route used for Text-to-SQL generation. */
  llmProvider: string
  llmModel: string
  /** Safety cap on returned rows. */
  maxRows: number
  /** Per-execute timeout in ms. */
  timeoutMs: number
  /** information_schema cache TTL in ms; 0 disables caching. */
  schemaCacheTtlMs: number
}

/** Runtime schema for the plugin configuration (validated by the loader). */
export const Config = z.object({
  sourceId: z.string().default('mysql'),
  isDefault: z.boolean().default(false),
  host: z.string().default('127.0.0.1'),
  port: z.number().default(3306),
  user: z.string().default('root'),
  password: z.string().default(''),
  database: z.string().required(),
  llmProvider: z.string().default('deepseek-official'),
  llmModel: z.string().default('deepseek-v4-flash'),
  maxRows: z.number().default(100),
  timeoutMs: z.number().default(15000),
  schemaCacheTtlMs: z.number().default(60000),
})

const SCHEMA_TABLES_SQL = `
  SELECT t.TABLE_SCHEMA, t.TABLE_NAME, t.TABLE_COMMENT,
         c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE, c.COLUMN_COMMENT
  FROM information_schema.TABLES t
  JOIN information_schema.COLUMNS c
    ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME
  WHERE t.TABLE_SCHEMA = ? AND t.TABLE_TYPE = 'BASE TABLE'
  ORDER BY t.TABLE_NAME, c.ORDINAL_POSITION`

const SCHEMA_FKS_SQL = `
  SELECT TABLE_NAME, COLUMN_NAME,
         REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
  FROM information_schema.KEY_COLUMN_USAGE
  WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL`

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

export class MysqlDataQueryService implements DataQueryBackend {
  private readonly pool: mysql.Pool
  private schemaCache: { at: number; schema: DataQueryTable[] } | undefined

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
  ) {
    this.pool = mysql.createPool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      connectionLimit: 4,
      // BIGINT/COUNT/SUM come back as JS numbers when they fit the safe
      // integer range, and as strings otherwise (lossless). DECIMAL stays a
      // string by mysql2 default — exact money representation.
      supportBigNumbers: true,
    })
  }

  capabilities(): DataQueryCapabilities {
    return { dialect: 'mysql', readOnly: true, supportsSchemaDiscovery: true }
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
      const [tableRows] = await this.pool.query(SCHEMA_TABLES_SQL, [this.config.database])
      const [fkRows] = await this.pool.query(SCHEMA_FKS_SQL, [this.config.database])
      tables = groupSchema(tableRows, fkRows)
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
      dialect: 'MySQL',
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
      const [rowset, fields] = result as [unknown, mysql.FieldPacket[] | undefined]
      if (!Array.isArray(rowset)) {
        throw new DataQueryError('query returned no row set (write statement?)', 'SQL_EXECUTION_FAILED')
      }
      const flat = Array.isArray(rowset[0]) ? rowset[0] : rowset
      const rows = (flat as unknown as mysql.RowDataPacket[]).map((r) => {
        const out: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(r)) out[k] = sanitizeCell(v)
        return out
      })
      const columns = fields?.map((f) => f.name) ?? (rows[0] ? Object.keys(rows[0]) : [])
      return { rows, columns }
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
  tableRows: unknown,
  fkRows: unknown,
): DataQueryTable[] {
  const tables = new Map<string, DataQueryTable>()
  const records = tableRows as Record<string, unknown>[]
  for (const r of records) {
    const name = String(r.TABLE_NAME)
    let table = tables.get(name)
    if (!table) {
      table = {
        schema: String(r.TABLE_SCHEMA),
        name,
        comment: r.TABLE_COMMENT ? String(r.TABLE_COMMENT) : undefined,
        columns: [],
        foreignKeys: [],
      }
      tables.set(name, table)
    }
    table.columns.push({
      name: String(r.COLUMN_NAME),
      type: r.DATA_TYPE ? String(r.DATA_TYPE) : undefined,
      nullable: r.IS_NULLABLE === 'YES',
      comment: r.COLUMN_COMMENT ? String(r.COLUMN_COMMENT) : undefined,
    })
  }
  const fks = fkRows as Record<string, unknown>[]
  for (const r of fks) {
    const table = tables.get(String(r.TABLE_NAME))
    if (!table) continue
    table.foreignKeys?.push({
      column: String(r.COLUMN_NAME),
      refSchema: String(r.REFERENCED_TABLE_SCHEMA),
      refTable: String(r.REFERENCED_TABLE_NAME),
      refColumn: String(r.REFERENCED_COLUMN_NAME),
    })
  }
  return [...tables.values()]
}

export const name = 'data-query-mysql'
export const inject = ['dataQuery', 'llm']

export function apply(ctx: Context, config: Config): () => Promise<void> {
  const service = new MysqlDataQueryService(ctx, config)
  const unregister = ctx.dataQuery.register(config.sourceId, service, {
    default: config.isDefault,
  })
  return async () => {
    unregister()
    await service.stop()
  }
}

// Re-exported for consumers/tests that used the provider-local copies.
export { extractSql, validateReadOnlySql }

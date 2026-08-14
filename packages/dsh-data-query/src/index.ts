/**
 * dsh-data-query — Service Definition layer.
 *
 * Declares the `dataQuery` capability that providers implement and tools
 * consume, without knowing anything about a concrete database. Following the
 * DeepSeek Harness capability layering:
 *
 *   Service Definition (this package)
 *         ↓
 *   Service Provider   (dsh-data-query-mysql / dsh-data-query-postgres / ...)
 *         ↓
 *   Consumer / Tool    (dsh-tool-data-query)
 *
 * A provider plugin instantiates a concrete `DataQueryService` subclass, which
 * (via the Cordis `Service` base) immediately registers itself as `ctx.dataQuery`.
 */
import { Service } from '@deepseek-ai/cordis'

/** Caller identity carried into the query pipeline (used by permission-aware
 * text-to-sql in V0.5; today it only seeds the LLM prompt context). */
export interface DataQueryIdentity {
  userId?: string
  roleIds?: string[]
  tenantId?: string
  departmentId?: string
}

/** One natural-language data query request. */
export interface DataQueryRequest extends DataQueryIdentity {
  /** The user's natural-language question, e.g. "统计最近 30 天订单数量". */
  question: string
  /**
   * Optional pre-generated SQL. When present, the provider skips text-to-sql
   * but still runs every safety check before executing.
   */
  sql?: string
  /** Maximum rows the executor returns (defaults to the provider config). */
  maxRows?: number
  /** Whole-query timeout budget in ms (defaults to the provider config). */
  timeoutMs?: number
  /** Caller-owned cancellation (forwarded from the tool's `exec.signal`). */
  signal?: AbortSignal
  /**
   * LLM route override for text-to-sql. Consumers usually forward the calling
   * agent's own provider/model so generation matches the conversation.
   */
  llmProvider?: string
  llmModel?: string
  /**
   * Data source id to route to (e.g. `mysql`, `postgres`, `analytics`).
   * Omit to use the default (first registered) source.
   */
  source?: string
}

/** One column of a discovered table. */
export interface DataQueryColumn {
  name: string
  /** Database type name, e.g. `int`, `varchar`, `decimal`. */
  type?: string
  nullable?: boolean
  comment?: string
}

/** One table of the discovered schema. */
export interface DataQueryTable {
  schema: string
  name: string
  comment?: string
  columns: DataQueryColumn[]
  /** Named foreign keys: source column → target schema.table(column). */
  foreignKeys?: {
    column: string
    refSchema: string
    refTable: string
    refColumn: string
  }[]
}

/** The structured outcome of one query. */
export interface DataQueryResult {
  /** The exact SQL that was executed (post validation / rewrite). */
  sql: string
  /** Column names in result order. */
  columns: string[]
  /** Rows as plain JSON-safe objects. */
  rows: Record<string, unknown>[]
  /** Whether rows were truncated by `maxRows`. */
  truncated: boolean
  rowCount: number
  elapsedMs: number
  /** Schema snapshot the SQL was generated against (audit / debugging). */
  schema?: DataQueryTable[]
}

export type DataQueryErrorCode =
  | 'NO_PROVIDER'
  | 'NO_SOURCE'
  | 'DUPLICATE_SOURCE'
  | 'INVALID_QUESTION'
  | 'SCHEMA_LOAD_FAILED'
  | 'TEXT_TO_SQL_FAILED'
  | 'SQL_VALIDATION_FAILED'
  | 'SQL_EXECUTION_FAILED'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'NOT_IMPLEMENTED'

/** Typed error raised by every stage of the data query pipeline. */
export class DataQueryError extends Error {
  readonly code: DataQueryErrorCode

  constructor(message: string, code: DataQueryErrorCode, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DataQueryError'
    this.code = code
  }
}

/** Provider capability metadata exposed for tooling / debugging. */
export interface DataQueryCapabilities {
  dialect: 'mysql' | 'postgresql' | string
  readOnly: boolean
  supportsSchemaDiscovery: boolean
}

/**
 * One registered data source: a concrete provider instance behind the
 * `dataQuery` facade. Providers implement this interface and register
 * themselves with a `sourceId`; they never mount the facade themselves.
 */
export interface DataQueryBackend {
  /** Translate a question into validated SQL, execute it, and return rows. */
  query(request: DataQueryRequest): Promise<DataQueryResult>

  /** Provider capability metadata. */
  capabilities(): DataQueryCapabilities

  /** Drop the cached schema snapshot and reload it from the database. */
  refreshSchema(): Promise<void>

  /** Release provider-owned resources (connection pools). */
  stop?(): Promise<void>
}

/** One registered data source entry as seen through {@link DataQueryService.list}. */
export interface DataQuerySourceInfo {
  id: string
  capabilities: DataQueryCapabilities
}

/**
 * The `dataQuery` facade service (registered on `ctx.dataQuery` by this
 * package's plugin `apply`). Providers register their backends under distinct
 * `sourceId`s, so ANY NUMBER of databases can be active at once; `query()`
 * routes by `request.source` (defaulting to the first registered source).
 */
export class DataQueryService extends Service {
  private readonly backends = new Map<string, DataQueryBackend>()
  private defaultSource: string | undefined

  constructor(ctx: import('@deepseek-ai/cordis').Context) {
    super(ctx, 'dataQuery')
  }

  /**
   * Register a provider backend under a stable id.
   * @param id - unique data source id, e.g. `mysql`, `postgres`, `analytics`.
   * @param backend - the provider instance.
   * @param options - `default: true` makes this the fallback source (the first
   *   registered source becomes the default automatically).
   * @returns a disposer that unregisters the source.
   */
  register(id: string, backend: DataQueryBackend, options: { default?: boolean } = {}): () => void {
    if (this.backends.has(id)) {
      throw new DataQueryError(`data source "${id}" is already registered`, 'DUPLICATE_SOURCE')
    }
    this.backends.set(id, backend)
    if (options.default || this.defaultSource === undefined) this.defaultSource = id
    return () => {
      this.backends.delete(id)
      if (this.defaultSource === id) this.defaultSource = [...this.backends.keys()][0]
    }
  }

  /** Resolve the backend for a source id, or the default when omitted. */
  resolve(source?: string): DataQueryBackend {
    const id = source ?? this.defaultSource
    if (id === undefined) {
      throw new DataQueryError('no data source is registered (load a provider plugin)', 'NO_PROVIDER')
    }
    const backend = this.backends.get(id)
    if (!backend) {
      throw new DataQueryError(
        `unknown data source "${id}" (available: ${[...this.backends.keys()].join(', ') || 'none'})`,
        'NO_SOURCE',
      )
    }
    return backend
  }

  /** Registered data sources (id + capabilities). */
  list(): DataQuerySourceInfo[] {
    return [...this.backends.entries()].map(([id, backend]) => ({
      id,
      capabilities: backend.capabilities(),
    }))
  }

  /** Route a query to the named source (or the default). */
  async query(request: DataQueryRequest): Promise<DataQueryResult> {
    const id = request.source ?? this.defaultSource
    const backend = this.resolve(id)
    // Stamp the resolved source id onto the request so the backend (and any
    // downstream audit/logging) can observe which source actually served it.
    return backend.query({ ...request, source: id })
  }

  /** Refresh the schema cache of one source (or all sources). */
  async refreshSchema(source?: string): Promise<void> {
    if (source !== undefined) {
      await this.resolve(source).refreshSchema()
      return
    }
    await Promise.all([...this.backends.values()].map((b) => b.refreshSchema()))
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The data query facade; providers register their backends on it. */
    dataQuery: DataQueryService
  }
}

/** Mount the `dataQuery` facade. Providers depend on it via `inject: ['dataQuery']`. */
export const name = 'data-query'
export function apply(ctx: import('@deepseek-ai/cordis').Context): void {
  void new DataQueryService(ctx)
}

// ---------------------------------------------------------------------------
// Shared SQL-safety utilities. Every provider reuses these so the read-only
// contract is defined in ONE place (the capability package), not per dialect.
// ---------------------------------------------------------------------------

/** SQL keywords that never belong in a read-only analytical query. */
const FORBIDDEN_KEYWORDS =
  /\b(DROP|DELETE|UPDATE|INSERT|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|REPLACE|RENAME|LOCK|UNLOCK)\b/i

/** Strip `--`, `#`, and `/* ... *​/` comments for statement inspection. */
export function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n\r]*/g, ' ')
    .replace(/#[^\n\r]*/g, ' ')
}

/**
 * Basic read-only validation shared by all providers. A full SQL AST validator
 * is a later milestone — this gate is a first line of defense, not a security
 * boundary.
 *
 * @param raw - the SQL to check.
 * @param maxRows - safety cap; the LIMIT clause is clamped to it.
 * @param detectTruncation - fetch `maxRows + 1` so the caller can report
 *   truncation (the extra row is not returned to the user).
 */
export function validateReadOnlySql(raw: string, maxRows: number, detectTruncation = false): string {
  const sql = stripComments(raw).trim()
  if (!sql) throw new DataQueryError('empty SQL', 'SQL_VALIDATION_FAILED')

  const head = sql.match(/^(SELECT|WITH|WITH\s+RECURSIVE)\b/i)
  if (!head) {
    throw new DataQueryError('only SELECT / WITH queries are allowed', 'SQL_VALIDATION_FAILED')
  }
  if (FORBIDDEN_KEYWORDS.test(sql)) {
    throw new DataQueryError('forbidden SQL keyword detected', 'SQL_VALIDATION_FAILED')
  }

  const limit = detectTruncation ? maxRows + 1 : maxRows
  // Matches `LIMIT n`, `LIMIT n, m` (MySQL offset form) and `LIMIT ALL` (PG).
  const limitClause = /\bLIMIT\s+(?:\d+(?:\s*,\s*\d+)?|ALL)\b/i
  const limitValue = /LIMIT\s+(\d+)/i
  if (limitClause.test(sql)) {
    const declared = Number(sql.match(limitValue)?.[1])
    if (Number.isFinite(declared) && declared > limit) {
      return sql.replace(limitClause, `LIMIT ${limit}`)
    }
    return sql
  }
  return `${sql} LIMIT ${limit}`
}

/** Extract the SQL payload from a model answer (tolerates code fences). */
export function extractSql(text: string): string {
  const fenced = text.match(/```(?:sql)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? (fenced[1] ?? '') : text
  const sql = candidate.trim()
  if (!sql) throw new DataQueryError('text-to-sql produced an empty answer', 'TEXT_TO_SQL_FAILED')
  return sql
}

/** Render a table as DDL-ish text for the text-to-sql prompt. */
export function renderTableDdl(table: DataQueryTable): string {
  const cols = table.columns
    .map((c) => `  ${c.name} ${c.type ?? ''}${c.nullable === false ? ' NOT NULL' : ''}${c.comment ? ` -- ${c.comment}` : ''}`)
    .join('\n')
  const fks = (table.foreignKeys ?? [])
    .map((f) => `  FOREIGN KEY (${f.column}) REFERENCES ${f.refTable}(${f.refColumn})`)
    .join('\n')
  const comment = table.comment ? ` -- ${table.comment}` : ''
  return `CREATE TABLE ${table.name} (${comment}\n${cols}${fks ? `\n${fks}` : ''}\n);`
}

/** Inputs for the shared text-to-sql system prompt. */
export interface TextToSqlPromptInput {
  /** Human dialect name, e.g. `MySQL` or `PostgreSQL`. */
  dialect: string
  schema: DataQueryTable[]
  identity?: DataQueryIdentity
}

/**
 * Build the read-only text-to-sql system prompt shared by all providers.
 * The caller identity only seeds context for now; V0.5 adds a policy engine
 * that rewrites the generated SQL with tenant/role predicates.
 */
export function buildTextToSqlPrompt(input: TextToSqlPromptInput): string {
  const { dialect, schema, identity } = input
  const ddl = schema.map(renderTableDdl).join('\n\n')

  const identityLines = [
    identity?.userId ? `- current user id: ${identity.userId}` : '',
    identity?.roleIds?.length ? `- current role ids: ${identity.roleIds.join(', ')}` : '',
    identity?.tenantId ? `- current tenant id: ${identity.tenantId}` : '',
    identity?.departmentId ? `- current department id: ${identity.departmentId}` : '',
  ].filter(Boolean)

  return [
    `You translate natural-language business questions into READ-ONLY ${dialect} SQL.`,
    'You may only answer with SQL. Do not explain, do not ask questions.',
    'Rules:',
    '- Only SELECT or WITH queries. Never DROP/DELETE/UPDATE/INSERT/TRUNCATE/ALTER/CREATE.',
    '- Use column names exactly as declared in the schema below.',
    '- Aggregate with GROUP BY when the question asks for counts/sums/averages.',
    '- Always end with a LIMIT clause (at most 1000 rows).',
    '- Never fabricate tables or columns not present in the schema.',
    ...(identityLines.length > 0
      ? [`Caller identity (may inform scoping, never impersonate):\n${identityLines.join('\n')}`]
      : []),
    '',
    'Database schema:',
    ddl,
  ].filter((line) => line !== '').join('\n')
}

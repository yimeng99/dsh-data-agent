/**
 * dsh-data-query-config — Settings-driven data source management.
 *
 * Mounts the `dataQuery` facade and registers the `data-query-sources`
 * settings namespace, which the Web UI settings page renders as an editable
 * form (passwords use `role('secret')` — written but never echoed back).
 *
 * Users configure database connections there (sourceId / dialect / host /
 * port / user / password / database / isDefault / LLM route / limits); every
 * change is applied LIVE: backends are re-registered on `ctx.dataQuery`
 * without a restart. The patch no longer needs per-database rows.
 *
 *   Web UI settings ──▶ data-query-sources ──▶ reconcile() ──▶ ctx.dataQuery
 *   (schemastery form)      (settings.yaml)      (rebuild)      (registry)
 */
import { type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  DataQueryError,
  DataQueryService,
  type DataQueryBackend,
} from 'dsh-data-query'
import { MysqlDataQueryService } from 'dsh-data-query-mysql'
import { PostgresDataQueryService } from 'dsh-data-query-postgres'

/** One user-configured data source (mirrors the provider Config shape). */
export interface DataSourceConfig {
  /** Unique data source id used by the `data_query` tool's `source` arg. */
  sourceId: string
  dialect: 'mysql' | 'postgresql'
  host: string
  port: number
  user: string
  password: string
  database: string
  /** Whether this source is the fallback when `source` is omitted. */
  isDefault: boolean
  llmProvider: string
  llmModel: string
  maxRows: number
  timeoutMs: number
}

/** The resolved settings section: a list of data sources. */
export interface Config {
  sources: DataSourceConfig[]
}

/** Schemastery schema for ONE data source (rendered as the settings form). */
export const sourceSchema: z<DataSourceConfig> = z.object({
  sourceId: z.string().required().description('Unique id used by the data_query tool (e.g. mysql, demo2, postgres).'),
  dialect: z.union(['mysql', 'postgresql']).required().description('Database dialect.'),
  host: z.string().default('127.0.0.1'),
  port: z.number().default(3306),
  user: z.string().default('root'),
  password: z.string().default('').role('secret').description('Database password (stored, never echoed back).'),
  database: z.string().required(),
  isDefault: z.boolean().default(false).description('Fallback source when the tool omits `source`.'),
  llmProvider: z.string().default('deepseek-official'),
  llmModel: z.string().default('deepseek-v4-flash'),
  maxRows: z.number().default(100),
  timeoutMs: z.number().default(15000),
})

/** Schemastery schema for the `data-query-sources` namespace. */
export const Config: z<Config> = z.object({
  sources: z.array(sourceSchema).default([]).description('Registered database connections.'),
})

export const name = 'data-query-config'
export const inject = ['settings']

const NAMESPACE = settingsNamespace('data-query-sources')

/** Instantiate the provider backend for one configured source. */
function instantiateBackend(ctx: Context, cfg: DataSourceConfig): DataQueryBackend {
  const base = {
    sourceId: cfg.sourceId,
    isDefault: cfg.isDefault,
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    llmProvider: cfg.llmProvider,
    llmModel: cfg.llmModel,
    maxRows: cfg.maxRows,
    timeoutMs: cfg.timeoutMs,
  }
  switch (cfg.dialect) {
    case 'mysql':
      return new MysqlDataQueryService(ctx, { ...base, schemaCacheTtlMs: 60000 })
    case 'postgresql':
      return new PostgresDataQueryService(ctx, { ...base, schemaCacheTtlMs: 60000 })
  }
}

export function apply(ctx: Context): () => Promise<void> {
  // 1. Mount the routing facade.
  void new DataQueryService(ctx)

  // 2. Register the settings namespace (appears in the Web UI settings page).
  const scope = ctx.settings.register(NAMESPACE, Config, { applies: 'live' })

  // 3. Reconcile: unregister everything, then register one backend per source.
  const disposers = new Map<string, { unregister: () => void; stop: () => Promise<void> }>()
  const stopBackends = async (): Promise<void> => {
    const pending = [...disposers.values()]
    disposers.clear()
    for (const { unregister } of pending) unregister()
    await Promise.all(pending.map(({ stop }) => stop()))
  }
  const reconcile = (sources: DataSourceConfig[]): void => {
    const seen = new Set<string>()
    for (const source of sources) {
      if (seen.has(source.sourceId)) {
        ctx.logger.warn(`[data-query-config] duplicate sourceId "${source.sourceId}" skipped`)
        continue
      }
      seen.add(source.sourceId)
      const backend = instantiateBackend(ctx, source)
      const unregister = ctx.dataQuery.register(source.sourceId, backend, {
        default: source.isDefault,
      })
      disposers.set(source.sourceId, {
        unregister,
        stop: async () => {
          await backend.stop?.()
        },
      })
    }
    ctx.logger.info(`[data-query-config] active sources: ${ctx.dataQuery.list().map((s) => s.id).join(', ') || '(none)'}`)
  }

  reconcile(scope.get().sources)

  // 4. Live-apply user edits from the settings page.
  const off = scope.watch(async (next) => {
    await stopBackends()
    reconcile(next.sources)
  })

  return async () => {
    off()
    await stopBackends()
  }
}

export type { DataQueryError }

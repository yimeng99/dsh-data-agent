/**
 * dsh-tool-data-query — Consumer/Tool layer.
 *
 * Registers the `data_query` tool. The agent calls it with a natural-language
 * question and an optional `source` id; the `dataQuery` facade routes to the
 * matching registered backend (MySQL, PostgreSQL, …), which owns schema
 * discovery, text-to-sql, validation, and execution. This tool never changes
 * when providers are added, removed, or swapped.
 */
import { type Context } from '@deepseek-ai/cordis'
import { defineTool, type JsonValue } from '@deepseek-ai/dsh-tools'
import type { DataQueryResult } from 'dsh-data-query'

export const name = 'tool-data-query'
export const inject = ['tools', 'dataQuery']

/** Render a query result as a compact markdown table for the model. */
function renderQueryResult(value: {
  sql: string
  columns: string[]
  rows: JsonValue[]
  truncated: boolean
  rowCount: number
  elapsedMs: number
}): string {
  const { sql, columns, rows, truncated, rowCount, elapsedMs } = value
  const lines = [`SQL: \`${sql}\``, `Rows: ${rowCount}${truncated ? ' (truncated)' : ''} · ${elapsedMs}ms`]
  if (rows.length === 0) {
    lines.push('(empty result set)')
    return lines.join('\n')
  }
  const esc = (cell: unknown): string => String(cell ?? 'NULL').replace(/\|/g, '\\|').replace(/\n/g, ' ')
  const header = `| ${columns.map(esc).join(' | ')} |`
  const sep = `| ${columns.map(() => '---').join(' | ')} |`
  lines.push(header, sep)
  for (const row of rows.slice(0, 20)) {
    lines.push(`| ${columns.map((c) => esc((row as Record<string, unknown>)[c])).join(' | ')} |`)
  }
  if (rows.length > 20) lines.push(`| … (${rows.length - 20} more rows) |`)
  return lines.join('\n')
}

export function apply(ctx: Context): void {
  const sources = ctx.dataQuery.list()
  const sourceList = sources.map((s) => s.id).join(', ')
  const sourceNote =
    sources.length > 0
      ? ` Available data sources: ${sourceList}. Pass \`source\` to query a specific one; omit for the default.`
      : ' No data source is registered yet — load a provider plugin first.'

  ctx.tools.register(
    defineTool({
      name: 'data_query',
      description:
        'Query business data using natural language. Returns the executed SQL, the column names, and up to a bounded number of rows. Use this FIRST to fetch data, then pass the returned rows to generate_chart when the user asks for a chart. Example: "查询最近 30 天订单数量".' +
        sourceNote,
      parameters: {
        question: {
          type: 'string',
          required: true,
          description:
            'The natural-language business question, e.g. "统计最近 30 天订单数量" or "按月份统计今年各月的销售额".',
        },
        source: {
          type: 'string',
          description: `Data source id to query.${sources.length > 0 ? ` Available: ${sourceList}.` : ''} Omit for the default source.`,
        },
        maxRows: {
          type: 'integer',
          description: 'Maximum rows to return. Defaults to the provider configuration.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sql: { type: 'string', required: true },
            columns: { type: 'array', items: { type: 'string' }, required: true },
            rows: { type: 'array', items: { type: 'json' }, required: true },
            truncated: { type: 'boolean', required: true },
            rowCount: { type: 'integer', required: true },
            elapsedMs: { type: 'number', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: renderQueryResult(value) }],
      },
      async execute(args, exec) {
        const result: DataQueryResult = await ctx.dataQuery.query({
          question: args.question,
          ...(args.source !== undefined ? { source: args.source } : {}),
          ...(args.maxRows !== undefined ? { maxRows: args.maxRows } : {}),
          signal: exec.signal,
          // Text-to-SQL reuses the conversation's own LLM route so generation
          // matches the session model; the provider config is the fallback.
          ...(exec.agent?.options.provider ? { llmProvider: exec.agent.options.provider } : {}),
          ...(exec.agent?.options.model ? { llmModel: exec.agent.options.model } : {}),
          // V0.5 permission-aware pipeline: the agent id stands in for the
          // real user identity until RBAC / tenant resolution lands.
          ...(exec.agent ? { userId: exec.agent.id } : {}),
        })
        return {
          sql: result.sql,
          columns: result.columns,
          rows: result.rows as unknown as JsonValue[],
          truncated: result.truncated,
          rowCount: result.rowCount,
          elapsedMs: result.elapsedMs,
        }
      },
    }),
  )
}

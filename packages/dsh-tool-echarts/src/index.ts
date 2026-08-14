/**
 * dsh-tool-echarts — chart generation tool.
 *
 * Registers `generate_chart`: a pure, provider-neutral tool that turns tabular
 * rows into an ECharts option object. V0.4 renders the option as JSON for the
 * model/UI; a custom client module can later draw real charts from the same
 * option (the presentation seam is `presentResult`/`presentationMeta`).
 */
import { type Context } from '@deepseek-ai/cordis'
import { defineTool, type JsonValue } from '@deepseek-ai/dsh-tools'

export const name = 'tool-echarts'
export const inject = ['tools']

type ChartType = 'line' | 'bar' | 'pie' | 'scatter'

interface ChartArgs {
  type: ChartType
  title?: string
  xField?: string
  yField: string
  nameField?: string
  data: JsonValue[]
}

/** Build a ready-to-render ECharts option from tabular rows (pure). */
function buildEChartsOption(args: ChartArgs): JsonValue {
  const { type, title, xField, yField, nameField, data } = args
  const rows = data as unknown as Record<string, unknown>[]
  const jv = (value: unknown): JsonValue => value as JsonValue

  const seriesData: JsonValue[] =
    type === 'pie'
      ? rows.map((r) => ({ name: String(r[nameField ?? 'name']), value: jv(r[yField]) }))
      : type === 'scatter'
        ? rows.map((r) => [jv(r[xField ?? '']), jv(r[yField])])
        : rows.map((r) => jv(r[yField]))

  const axes: JsonValue =
    type === 'line' || type === 'bar'
      ? {
          xAxis: { type: 'category', data: rows.map((r) => jv(r[xField ?? ''])) },
          yAxis: { type: 'value' },
        }
      : type === 'scatter'
        ? { xAxis: { type: 'value' }, yAxis: { type: 'value' } }
        : {}

  const series: JsonValue = {
    name: title ?? type,
    type,
    ...(type === 'pie' ? { radius: '60%' } : {}),
    data: seriesData,
  }

  return {
    ...(title ? { title: { text: title } } : {}),
    tooltip: { trigger: 'axis' },
    ...(axes as Record<string, unknown>),
    series: [series],
  } as JsonValue
}

export function apply(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'generate_chart',
      description:
        'Generate an ECharts option object (line/bar/pie/scatter) from tabular data. Call data_query FIRST to fetch rows, then pass those rows here with the field names to plot. The result can be rendered by the UI.',
      parameters: {
        type: {
          type: 'string',
          required: true,
          enum: ['line', 'bar', 'pie', 'scatter'],
          description: 'Chart type. line/bar need xField + yField; scatter needs xField + yField; pie needs nameField + yField.',
        },
        title: { type: 'string', description: 'Chart title.' },
        xField: { type: 'string', description: 'Row field plotted on the x axis (category or value).' },
        yField: { type: 'string', required: true, description: 'Row field plotted on the y axis / as the value.' },
        nameField: { type: 'string', description: 'Row field used as the slice name for pie charts.' },
        data: {
          type: 'array',
          items: { type: 'json' },
          required: true,
          description: 'Tabular rows, usually the rows returned by data_query.',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [
          { type: 'text', text: `ECharts option:\n${JSON.stringify(value, null, 2)}` },
        ],
      },
      execute: (args) => Promise.resolve(buildEChartsOption(args)),
    }),
  )
}

export { buildEChartsOption }

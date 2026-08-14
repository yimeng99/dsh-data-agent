/**
 * dsh-tool-echarts — chart generation tool.
 *
 * Registers `generate_chart`: turns tabular rows into (1) an ECharts option
 * object the model can reason about, and (2) a self-contained HTML page that
 * renders the real chart in any browser. The agent is guided to save `html`
 * with the `write` tool (e.g. `charts/trend.html`); the produced file then
 * appears in the chat's deliverables row and opens as a live chart.
 *
 * A future client plugin can render the same option inline in the chat via
 * the tool-result presentation seam (`presentationMeta`).
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
export function buildEChartsOption(args: ChartArgs): JsonValue {
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

/** Escape text for safe embedding in HTML. */
function escHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Build a self-contained HTML page that renders the option with ECharts
 * (loaded from a CDN). Openable in any browser; used as a chat deliverable.
 */
export function buildChartHtml(option: JsonValue, title = 'chart'): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escHtml(title)}</title>
<script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>
</head>
<body style="margin:0;font-family:system-ui,sans-serif">
<div id="chart" style="width:100vw;height:100vh"></div>
<script>
const option = ${JSON.stringify(option)};
const chart = echarts.init(document.getElementById('chart'));
chart.setOption(option);
window.addEventListener('resize', () => chart.resize());
</script>
</body>
</html>`
}

export function apply(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'generate_chart',
      description:
        'Generate a chart from tabular data: returns an ECharts option object plus a self-contained HTML page that renders the real chart. Call data_query FIRST to fetch rows, then pass those rows here with the field names to plot. When the user wants to SEE the chart, save the returned `html` field to a file with the write tool (e.g. write a `charts/trend.html`), so it appears in the deliverables row and opens as a live chart.',
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
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            option: { type: 'json', required: true },
            html: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `ECharts option:\n${JSON.stringify(value.option, null, 2)}\n\nSelf-contained HTML (${value.html.length} bytes) — save it with the write tool to a .html file to view the live chart.`,
          },
        ],
        // Replayable presentation metadata: lands on the client's
        // ToolResultNode.meta and lets the dsh-client-ui-chart plugin render
        // the chart inline in the chat (tool.call.toolview seat).
        presentationMeta: (args, value) => ({
          kind: 'echarts',
          title: args.title ?? args.type,
          option: value.option,
        }),
      },
      execute: (args) => {
        const option = buildEChartsOption(args)
        return Promise.resolve({
          option,
          html: buildChartHtml(option, args.title ?? args.type),
        })
      },
    }),
  )
}

/**
 * dsh-client-ui-chart — Browser half.
 *
 * Registers an inline chart view for the `generate_chart` tool through the
 * `tool.call.toolview` keyed seat (open key domain — additive for our own
 * tool, never touches other tools). Reads the tool's `presentationMeta`
 * (landed on the settled ToolResultNode.meta) and renders it with ECharts.
 *
 * Build: esbuild bundles this into lib/client.js; @deepseek-ai/*, react and
 * react-dom stay external (provided by the web app runtime), echarts is
 * bundled in (tree-shaken via echarts/core).
 */
import { useEffect, useRef } from 'react'
import * as echarts from 'echarts'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-runtime/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

/** The presentationMeta shape `generate_chart` publishes. */
interface EchartsMeta {
  kind: 'echarts'
  title?: string
  option: Record<string, unknown>
}

const containerStyle = { padding: '8px 12px 10px' } as const
const titleStyle = { fontWeight: 600, fontSize: 13, marginBottom: 6, color: 'var(--fg-1)' } as const
const chartStyle = { height: 320, width: '100%' } as const
const fallbackStyle = { padding: '8px 12px', color: 'var(--fg-2)', fontSize: 12 } as const

function ChartToolView({ block }: ToolCallViewProps): JSX.Element | null {
  const host = useRef<HTMLDivElement>(null)
  const settled = block !== null && 'kind' in block ? (block as ToolResultNode) : null
  const meta = settled?.meta as EchartsMeta | undefined
  const option = meta?.kind === 'echarts' ? meta.option : undefined
  const title = meta?.kind === 'echarts' ? meta.title : undefined

  useEffect(() => {
    if (!option || !host.current) return
    const chart = echarts.init(host.current)
    chart.setOption(option)
    const observer = new ResizeObserver(() => chart.resize())
    observer.observe(host.current)
    return () => {
      observer.disconnect()
      chart.dispose()
    }
  }, [option])

  if (!settled) {
    // Running call — the result has not landed yet.
    return <div style={fallbackStyle}>generate_chart…</div>
  }
  if (!option) {
    // Settled without chart metadata (e.g. an older session log).
    return <div style={fallbackStyle}>generate_chart（无图表数据）</div>
  }
  return (
    <div style={containerStyle}>
      {title ? <div style={titleStyle}>{title}</div> : null}
      <div ref={host} style={chartStyle} />
    </div>
  )
}

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register(
      {
        name: 'tool.call.toolview',
        key: 'generate_chart',
        priority: 10,
      },
      ChartToolView,
    ),
  )
}

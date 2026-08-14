/**
 * dsh-client-ui-chart — Node half.
 *
 * This package is a CLIENT plugin: the browser half (`./client`) renders
 * `generate_chart` results as inline ECharts in the chat via the
 * `tool.call.toolview` keyed seat. The loader entry exists so the
 * client-modules scanner (which walks loader entries) discovers the
 * `dsh.client` declaration and serves the bundle.
 */
import { type Context } from '@deepseek-ai/cordis'

export const name = 'client-ui-chart'

export function apply(_ctx: Context): void {
  // Client-only plugin — nothing to do on the host plane.
}

/**
 * Minimal local declaration for `echarts`.
 *
 * The package's own types use `export =` (CJS-style) while its ESM runtime
 * has no default export — under NodeNext + verbatimModuleSyntax neither
 * `import * as` nor `import dflt` type-checks cleanly. This narrow ambient
 * declaration keeps the bundler (esbuild) resolving the REAL echarts ESM
 * module at build time while giving TypeScript exactly the surface this
 * plugin uses.
 */
declare module 'echarts' {
  export interface EChartsInstance {
    setOption(option: unknown): void
    resize(): void
    dispose(): void
  }
  export function init(dom: HTMLElement, theme?: unknown, opts?: unknown): EChartsInstance
}

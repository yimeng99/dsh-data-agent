/**
 * Build the browser bundle (lib/client.js) with esbuild.
 * @deepseek-ai/*, react and react-dom stay external — the web app runtime
 * provides them; echarts is bundled in (tree-shaken via echarts/core).
 */
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(root, 'lib'), { recursive: true })

const result = await build({
  entryPoints: [join(root, 'client/index.tsx')],
  bundle: true,
  format: 'esm',
  target: 'es2020',
  jsx: 'automatic',
  outfile: join(root, 'lib/client.js'),
  sourcemap: true,
  external: ['@deepseek-ai/*', 'react', 'react-dom'],
  logLevel: 'info',
})

if (result.errors.length > 0) process.exit(1)
console.log('built lib/client.js')

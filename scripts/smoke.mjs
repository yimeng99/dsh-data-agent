/**
 * Wiring smoke test for dsh-data-agent V0.1 (no database required).
 *
 * Verifies the actual Cordis mechanics end to end:
 *   1. the MySQL provider registers `ctx.dataQuery` when applied;
 *   2. the `data_query` tool registers itself with the expected schema;
 *   3. the ECharts option builder produces a valid option;
 *   4. the SQL validator blocks write statements and clamps LIMIT.
 *
 * Run: node scripts/smoke.mjs
 */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import * as provider from 'dsh-data-query-mysql'
import * as tool from 'dsh-tool-data-query'
import { buildEChartsOption } from 'dsh-tool-echarts'

// ---------------------------------------------------------------------------
// 1. Provider registers ctx.dataQuery (pool creation is lazy, no DB needed)
// ---------------------------------------------------------------------------
const ctx = new Context()
const dispose = provider.apply(ctx, {
  host: '127.0.0.1',
  port: 3306,
  user: 'root',
  password: '',
  database: 'demo',
  llmProvider: 'deepseek-official',
  llmModel: 'deepseek-v4-flash',
  maxRows: 100,
  timeoutMs: 15000,
  schemaCacheTtlMs: 60000,
})

const service = ctx.get('dataQuery')
assert.ok(service, 'ctx.dataQuery must be provided after applying the MySQL provider')
assert.equal(service.capabilities().dialect, 'mysql')
assert.equal(service.capabilities().readOnly, true)
assert.equal(typeof service.query, 'function')
assert.equal(typeof service.refreshSchema, 'function')

// ---------------------------------------------------------------------------
// 2. Tool registers data_query with the expected contract
// ---------------------------------------------------------------------------
const toolsCtx = new Context()
let registered
toolsCtx.provide('tools', {
  register: (definition) => {
    registered = definition
  },
})
tool.apply(toolsCtx)
assert.equal(registered.name, 'data_query')
// defineTool compiles the author spec into JSON Schema:
// requiredness becomes a top-level `required` array.
assert.equal(registered.parameters.type, 'object')
assert.equal(registered.parameters.properties.question.type, 'string')
assert.deepEqual(registered.parameters.required, ['question'])
assert.equal(registered.output.schema.properties.sql.type, 'string')
assert.ok(registered.output.schema.required.includes('sql'))
assert.ok(registered.execute, 'tool must expose execute')

// ---------------------------------------------------------------------------
// 3. ECharts option builder (pure)
// ---------------------------------------------------------------------------
const line = buildEChartsOption({
  type: 'line',
  title: '订单趋势',
  xField: 'month',
  yField: 'count',
  data: [
    { month: '2025-01', count: 10 },
    { month: '2025-02', count: 14 },
  ],
})
assert.equal(line.title.text, '订单趋势')
assert.deepEqual(line.xAxis.data, ['2025-01', '2025-02'])
assert.deepEqual(line.series[0].data, [10, 14])

const pie = buildEChartsOption({
  type: 'pie',
  title: '状态占比',
  nameField: 'status',
  yField: 'amount',
  data: [
    { status: 'PAID', amount: 100 },
    { status: 'PENDING', amount: 50 },
  ],
})
assert.deepEqual(pie.series[0].data, [
  { name: 'PAID', value: 100 },
  { name: 'PENDING', value: 50 },
])

// ---------------------------------------------------------------------------
// 4. SQL validator (pure): allow SELECT, reject writes, clamp LIMIT
// ---------------------------------------------------------------------------
const { extractSql, validateReadOnlySql } = provider
assert.equal(extractSql('```sql\nSELECT 1\n```'), 'SELECT 1')
assert.equal(extractSql('just select 1'), 'just select 1')

const ok = validateReadOnlySql('SELECT COUNT(*) FROM orders WHERE status = \'PAID\'', 100, false)
assert.match(ok, /LIMIT 100$/)
assert.equal(
  validateReadOnlySql('SELECT * FROM orders LIMIT 5000', 100, false),
  'SELECT * FROM orders LIMIT 100',
)

for (const bad of [
  'DROP TABLE orders',
  'DELETE FROM orders',
  'UPDATE orders SET status = \'PAID\'',
  'INSERT INTO orders (id) VALUES (1)',
  'TRUNCATE orders',
  'ALTER TABLE orders ADD COLUMN x INT',
]) {
  assert.throws(() => validateReadOnlySql(bad, 100, false), /only SELECT|forbidden SQL keyword/i)
}
assert.throws(() => validateReadOnlySql('SELECT 1; DROP TABLE orders', 100, false))

await dispose()
console.log('smoke OK — provider, tool, chart builder and validator all wired correctly')

/**
 * Wiring smoke test for dsh-data-agent V0.1 (no database required).
 *
 * Verifies the actual Cordis mechanics end to end:
 *   1. the `dataQuery` facade mounts and the MySQL provider registers a source;
 *   2. multi-source routing (register/resolve/list/unknown/duplicate);
 *   3. the `data_query` tool registers itself with the expected schema;
 *   4. the ECharts option builder produces a valid option;
 *   5. the SQL validator blocks write statements and clamps LIMIT.
 *
 * Run: node scripts/smoke.mjs
 */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import * as dq from 'dsh-data-query'
import * as provider from 'dsh-data-query-mysql'
import * as tool from 'dsh-tool-data-query'
import { buildEChartsOption } from 'dsh-tool-echarts'

// ---------------------------------------------------------------------------
// 1. Facade mounts; MySQL provider registers a source (pool is lazy, no DB)
// ---------------------------------------------------------------------------
const ctx = new Context()
dq.apply(ctx)
assert.ok(ctx.dataQuery, 'ctx.dataQuery facade must exist after applying dsh-data-query')

const dispose = provider.apply(ctx, {
  sourceId: 'mysql',
  isDefault: true,
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

const sources = ctx.dataQuery.list()
assert.equal(sources.length, 1)
assert.equal(sources[0].id, 'mysql')
assert.equal(sources[0].capabilities.dialect, 'mysql')
assert.equal(sources[0].capabilities.readOnly, true)
assert.equal(typeof ctx.dataQuery.query, 'function')
assert.equal(typeof ctx.dataQuery.refreshSchema, 'function')

// ---------------------------------------------------------------------------
// 2. Multi-source routing (fake backends, no DB involved)
// ---------------------------------------------------------------------------
const fakeBackend = {
  query: async (request) => ({
    sql: `SELECT '${request.source ?? 'default'}'`,
    columns: ['src'],
    rows: [{ src: request.source ?? 'default' }],
    truncated: false,
    rowCount: 1,
    elapsedMs: 0,
  }),
  capabilities: () => ({ dialect: 'fake', readOnly: true, supportsSchemaDiscovery: false }),
  refreshSchema: async () => {},
}

const unregisterA = ctx.dataQuery.register('analytics', fakeBackend, { default: true })
const unregisterB = ctx.dataQuery.register('reports', fakeBackend)
assert.deepEqual(
  ctx.dataQuery.list().map((s) => s.id),
  ['mysql', 'analytics', 'reports'],
)

// explicit source routing
assert.equal((await ctx.dataQuery.query({ question: 'x', source: 'analytics' })).rows[0].src, 'analytics')
// default source is 'analytics' (registered with default: true)
assert.equal((await ctx.dataQuery.query({ question: 'x' })).rows[0].src, 'analytics')

// unknown source -> typed error
await assert.rejects(
  ctx.dataQuery.query({ question: 'x', source: 'nope' }),
  (err) => err.code === 'NO_SOURCE',
)

// duplicate registration -> typed error
assert.throws(
  () => ctx.dataQuery.register('mysql', fakeBackend),
  (err) => err.code === 'DUPLICATE_SOURCE',
)

// unregister keeps the default source intact
unregisterB()
assert.equal((await ctx.dataQuery.query({ question: 'x' })).rows[0].src, 'analytics')
unregisterA()

// ---------------------------------------------------------------------------
// 3. Tool registers data_query with the expected contract
// ---------------------------------------------------------------------------
const toolsCtx = new Context()
dq.apply(toolsCtx)
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
assert.equal(registered.parameters.properties.source.type, 'string')
assert.deepEqual(registered.parameters.required, ['question'])
assert.equal(registered.output.schema.properties.sql.type, 'string')
assert.ok(registered.output.schema.required.includes('sql'))
assert.ok(registered.execute, 'tool must expose execute')

// ---------------------------------------------------------------------------
// 4. ECharts option builder (pure)
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
// 5. SQL validator (pure): allow SELECT, reject writes, clamp LIMIT
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
console.log('smoke OK — facade, multi-source routing, tool, chart builder and validator all wired correctly')

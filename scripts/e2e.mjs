/**
 * End-to-end test against a REAL local MySQL (demo schema from
 * examples/mysql/schema.sql). The LLM stage is stubbed — everything else
 * (schema discovery, validation, execution, timeout, abort) is real.
 *
 * Run: node scripts/e2e.mjs
 * Env overrides: DSH_DB_HOST / DSH_DB_PORT / DSH_DB_USER / DSH_DB_PASSWORD
 */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import mysql from 'mysql2/promise'
import * as provider from 'dsh-data-query-mysql'

const host = process.env.DSH_DB_HOST ?? '127.0.0.1'
const port = Number(process.env.DSH_DB_PORT ?? 3306)
const user = process.env.DSH_DB_USER ?? 'root'
const password = process.env.DSH_DB_PASSWORD ?? ''
const database = 'demo'

// ---------------------------------------------------------------------------
// Stub LLM: answers text-to-sql with canned SQL, streamed as StreamChunks.
// ---------------------------------------------------------------------------
function stubAnswer(question) {
  if (/最近\s*30\s*天/.test(question) && /数量|订单数/.test(question)) {
    return `SELECT COUNT(*) AS order_count FROM orders WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`
  }
  if (/销量|top|前\s*10/.test(question)) {
    return `SELECT p.name, SUM(oi.quantity) AS total_qty
FROM order_items oi
JOIN products p ON p.id = oi.product_id
GROUP BY p.id, p.name
ORDER BY total_qty DESC
LIMIT 10`
  }
  if (/趋势|月份/.test(question)) {
    return `SELECT DATE_FORMAT(created_at, '%Y-%m') AS ym, COUNT(*) AS cnt
FROM orders
GROUP BY ym
ORDER BY ym`
  }
  return `SELECT * FROM orders LIMIT 10`
}

const llmStub = {
  stream() {
    return (async function* () {
      // The provider picks the question out of messages; here the stub
      // receives options but answers from a captured last question.
      const question = llmStub.lastQuestion
      const sql = stubAnswer(question)
      yield { type: 'text-delta', index: 0, text: '```sql\n' }
      yield { type: 'text-delta', index: 0, text: sql }
      yield { type: 'text-delta', index: 0, text: '\n```' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  },
}

// ---------------------------------------------------------------------------
// Boot: context + stub llm + real MySQL provider
// ---------------------------------------------------------------------------
const ctx = new Context()
ctx.provide('llm', llmStub)
const dispose = provider.apply(ctx, {
  host,
  port,
  user,
  password,
  database,
  llmProvider: 'stub',
  llmModel: 'stub',
  maxRows: 100,
  timeoutMs: 5000,
  schemaCacheTtlMs: 60000,
})
const dataQuery = ctx.get('dataQuery')
assert.ok(dataQuery, 'ctx.dataQuery must be provided')

// Reference connection for expected values.
const db = await mysql.createConnection({ host, port, user, password, database })
const ref = async (sql) => {
  const [rows] = await db.query(sql)
  return rows
}

try {
  // -------------------------------------------------------------------------
  // 1. Direct SQL path (no LLM): schema discovery + validation + execution
  // -------------------------------------------------------------------------
  const r1 = await dataQuery.query({
    question: 'bypass',
    sql: 'SELECT COUNT(*) AS cnt FROM orders',
  })
  assert.equal(r1.columns[0], 'cnt')
  assert.equal(r1.rows[0].cnt, 360)
  assert.equal(r1.truncated, false)
  assert.ok(Array.isArray(r1.schema), 'result must carry the schema snapshot')
  assert.equal(r1.schema.length, 4)
  const orders = r1.schema.find((t) => t.name === 'orders')
  assert.ok(orders, 'orders table must be discovered')
  assert.ok(
    orders.columns.some((c) => c.name === 'tenant_id'),
    'tenant_id column must be discovered (V0.5 RBAC groundwork)',
  )
  assert.ok(
    orders.columns.some((c) => c.name === 'department_id'),
    'department_id column must be discovered',
  )
  assert.ok(
    orders.foreignKeys.some((f) => f.refTable === 'customers'),
    'foreign key orders.customer_id -> customers must be discovered',
  )

  // -------------------------------------------------------------------------
  // 2. Text-to-SQL path (stub LLM): question -> SQL -> real MySQL
  // -------------------------------------------------------------------------
  llmStub.lastQuestion = '统计最近 30 天订单数量'
  const r2 = await dataQuery.query({ question: '统计最近 30 天订单数量' })
  const expected30 = await ref(
    'SELECT COUNT(*) AS c FROM orders WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)',
  )
  assert.equal(r2.rows[0].order_count, expected30[0].c, '30-day order count must match MySQL')
  assert.match(r2.sql, /COUNT\(\*\) AS order_count/)

  // -------------------------------------------------------------------------
  // 3. Text-to-SQL -> multi-table join (top 10 products)
  // -------------------------------------------------------------------------
  llmStub.lastQuestion = '查询产品销量前 10'
  const r3 = await dataQuery.query({ question: '查询产品销量前 10' })
  assert.equal(r3.rows.length, 10)
  assert.ok(r3.columns.includes('total_qty'))

  // -------------------------------------------------------------------------
  // 4. LIMIT clamp + truncation detection
  // -------------------------------------------------------------------------
  const r4 = await dataQuery.query({ question: 'all', sql: 'SELECT * FROM orders' })
  assert.equal(r4.rows.length, 100, 'must clamp to maxRows')
  assert.equal(r4.truncated, true, 'must report truncation')
  assert.match(r4.sql, /LIMIT 101$/, 'must fetch maxRows+1 to detect truncation')

  // -------------------------------------------------------------------------
  // 5. Forbidden SQL rejected with typed codes
  // -------------------------------------------------------------------------
  for (const bad of ['DROP TABLE orders', 'DELETE FROM orders', 'UPDATE orders SET status=1']) {
    await assert.rejects(
      dataQuery.query({ question: 'bad', sql: bad }),
      (err) => err.code === 'SQL_VALIDATION_FAILED',
      `${bad} must be rejected`,
    )
  }

  // -------------------------------------------------------------------------
  // 6. Execution errors map to SQL_EXECUTION_FAILED
  // -------------------------------------------------------------------------
  await assert.rejects(
    dataQuery.query({ question: 'bad', sql: 'SELECT * FROM no_such_table' }),
    (err) => err.code === 'SQL_EXECUTION_FAILED',
  )

  // -------------------------------------------------------------------------
  // 7. Aborted signal -> ABORTED
  // -------------------------------------------------------------------------
  await assert.rejects(
    dataQuery.query({ question: 'x', sql: 'SELECT 1', signal: AbortSignal.abort() }),
    (err) => err.code === 'ABORTED',
  )

  console.log('e2e OK — real MySQL: schema discovery, text-to-sql, LIMIT clamp, rejections, abort')
} finally {
  await dispose()
  await db.end()
}

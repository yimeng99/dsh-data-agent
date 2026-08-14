/**
 * Load the demo schema into a local MySQL (idempotent).
 *
 * Run: node scripts/load-schema.mjs
 * Env overrides: DSH_DB_HOST / DSH_DB_PORT / DSH_DB_USER / DSH_DB_PASSWORD / DSH_DB_NAME
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import mysql from 'mysql2/promise'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const host = process.env.DSH_DB_HOST ?? '127.0.0.1'
const port = Number(process.env.DSH_DB_PORT ?? 3306)
const user = process.env.DSH_DB_USER ?? 'root'
const password = process.env.DSH_DB_PASSWORD ?? ''
const dbname = process.env.DSH_DB_NAME ?? 'demo'

const conn = await mysql.createConnection({ host, port, user, password, multipleStatements: true })
try {
  const sql = readFileSync(join(root, 'examples', 'mysql', 'schema.sql'), 'utf8')
    .replace(/\bdemo\b/g, dbname)
  await conn.query(sql)
  const [tables] = await conn.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'`,
    [dbname],
  )
  const [counts] = await conn.query(
    `SELECT (SELECT COUNT(*) FROM \`${dbname}\`.orders) AS orders,
            (SELECT COUNT(*) FROM \`${dbname}\`.customers) AS customers,
            (SELECT COUNT(*) FROM \`${dbname}\`.products) AS products,
            (SELECT COUNT(*) FROM \`${dbname}\`.order_items) AS items`,
  )
  console.log(`${dbname} schema loaded. tables:`, JSON.stringify(tables))
  console.log('row counts:', JSON.stringify(counts))
} finally {
  await conn.end()
}

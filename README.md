[English](README.md) · [中文](README.zh-CN.md)

# dsh-data-agent

> An enterprise-ready AI data analyst plugin suite for **DeepSeek Harness**:
> Natural Language → Text-to-SQL → Database → Structured Results → ECharts.

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-0.1.0--rc.6-purple)

Built on the DeepSeek Harness Cordis plugin system with the official
**Service Definition / Provider / Consumer** three-layer pattern: database
capabilities are abstracted behind a replaceable Service, the agent consumes it
through Tools, and swapping database providers requires **zero** changes to the
Tools.

```
                DeepSeek Harness
                       │
                       ▼
                    AI Agent
                       │
            ┌──────────┴───────────┐
            ▼                      ▼
        data_query               generate_chart
            │                      │
            ▼                      ▼
      DataQueryService         ECharts option
            │
     ┌──────┼──────────┐
     ▼      ▼          ▼
   MySQL  Postgres  ClickHouse...   (Provider is swappable)
     │
     ▼
  Schema Discovery ──→ Text-to-SQL ──→ SQL Validator ──→ Read-only Executor
```

## Features

- **Natural language → SQL**: the agent turns a business question into read-only
  SQL through the same LLM route as the conversation.
- **Automatic schema discovery**: tables, columns, comments and foreign keys are
  read from `information_schema` (with a TTL cache) and fed to the model.
- **Safety by default**: only `SELECT` / `WITH`; write/DDL keywords are rejected;
  `LIMIT` is clamped; every execution has a timeout and honors `AbortSignal`.
- **Replaceable providers**: MySQL today, PostgreSQL implemented — add
  ClickHouse/Doris by writing one provider package.
- **Charts**: `generate_chart` turns query rows into a ready-to-render ECharts
  option (line / bar / pie / scatter).

## Package Layout

| Package | Layer | Responsibility |
| --- | --- | --- |
| `packages/dsh-data-query` | Service Definition | Declares the `dataQuery` capability (request/result/error types + abstract service + shared SQL-safety utilities), database-agnostic |
| `packages/dsh-data-query-mysql` | Provider | MySQL implementation: information_schema discovery → LLM Text-to-SQL → SQL validation → read-only execution |
| `packages/dsh-data-query-postgres` | Provider | PostgreSQL implementation (V0.2, same interface as MySQL) |
| `packages/dsh-tool-data-query` | Consumer / Tool | Registers the `data_query` tool; forwards natural-language questions to `ctx.dataQuery` |
| `packages/dsh-tool-echarts` | Consumer / Tool | Registers the `generate_chart` tool; tabular rows → ECharts option |

## Requirements

- Node.js ≥ 20, pnpm
- DeepSeek Harness 0.1.0-rc.6 (any profile with the `dsh-base` bundle, e.g. `web`)
- A MySQL 8 instance (demo data: `examples/mysql/schema.sql`)

## Installation

### 1. Clone and build

```bash
git clone https://github.com/yimeng99/dsh-data-agent.git
cd dsh-data-agent
pnpm install
pnpm build
```

### 2. (Optional) Load the demo database

```bash
mysql -u root -p < examples/mysql/schema.sql     # creates the `demo` database
```

### 3. Register the plugins into your DSH profile

Pick **one** of the two methods. Let `$REPO` be the absolute path of the clone.

**Method A — via `dsh plugin` (manages the profile's dependencies):**

```bash
dsh plugin --profile web add \
  file:$REPO/packages/dsh-data-query \
  file:$REPO/packages/dsh-data-query-mysql \
  file:$REPO/packages/dsh-tool-data-query \
  file:$REPO/packages/dsh-tool-echarts
```

**Method B — link into the shared store (keeps the profile's manifest untouched):**

Windows (junction):

```powershell
$store = "$env:USERPROFILE\.dsh\profiles\node_modules"
foreach ($pkg in 'dsh-data-query','dsh-data-query-mysql','dsh-tool-data-query','dsh-tool-echarts') {
  New-Item -ItemType Junction -Path "$store\$pkg" -Target "$REPO\packages\$pkg"
}
```

macOS / Linux (symlink):

```bash
store="$HOME/.dsh/profiles/node_modules"
for pkg in dsh-data-query dsh-data-query-mysql dsh-tool-data-query dsh-tool-echarts; do
  ln -s "$REPO/packages/$pkg" "$store/$pkg"
done
```

> The `dsh-data-query` package needs **no** loader row — providers import it
> directly, exactly like the official `dsh-fs` package.

### 4. Apply the profile overlay and start

The database password is read from the environment — never hardcode it in files:

```bash
export DSH_DB_PASSWORD='your-mysql-password'    # PowerShell: $env:DSH_DB_PASSWORD = '...'
dsh web --patch ./cordis.patch.yml
```

`cordis.patch.yml` registers `data-query-mysql` (as `ctx.dataQuery`) plus the
`data_query` and `generate_chart` tools. Restart `dsh web` if HMR does not pick
the change up automatically.

> **Only one provider may be active.** To use PostgreSQL instead of MySQL,
> comment out the MySQL block in `cordis.patch.yml`, uncomment the PostgreSQL
> block, and install `dsh-data-query-postgres` the same way.

### 5. Try it

In the Web UI (new conversation), just ask:

- 「统计一下最近 30 天订单数量」/ "Count orders in the last 30 days"
- 「查询产品销量前 10」/ "Top 10 products by sales"
- 「帮我分析最近 12 个月订单趋势，并画一个折线图」/ "Analyze the 12-month order trend and draw a line chart"

The agent will call `data_query` → `generate_chart` automatically.

## Switching Providers (Capability Seam)

Only **one** provider may register `ctx.dataQuery`. Switch to PostgreSQL:

```bash
dsh plugin --profile web add file:$REPO/packages/dsh-data-query-postgres
dsh plugin --profile web remove dsh-data-query-mysql
```

`dsh-tool-data-query` and `dsh-tool-echarts` stay untouched. New dialects
(ClickHouse / Doris / SQLServer…) are just another provider package mirroring
`dsh-data-query-mysql`.

## Security Design (built into V0.1)

- **Read-only gate**: only `SELECT` / `WITH`; `DROP / DELETE / UPDATE / INSERT /
  TRUNCATE / ALTER / CREATE / GRANT / REVOKE / REPLACE / RENAME / LOCK / UNLOCK`
  are rejected (regex layer; an AST-level validator is the V0.3 milestone).
- **LIMIT clamp**: a safety cap is appended/enforced to prevent full-table pulls.
- **Timeout + cancellation**: every execution has a budget; the tool's
  `AbortSignal` is propagated end to end.
- **Lossless numbers**: BIGINT/DECIMAL values stay exact (numbers when they fit
  the safe range, strings otherwise).

## Testing

```bash
node scripts/smoke.mjs        # no-DB smoke: wiring, tool registration, chart builder, SQL validator
node scripts/load-schema.mjs  # load examples/mysql/schema.sql into local MySQL
node scripts/e2e.mjs          # real-DB e2e: discovery, text-to-sql, LIMIT clamp, rejections, abort
```

`e2e.mjs` stubs the LLM stage (no model tokens consumed); everything else runs
against a real MySQL. Connection settings are overridable via
`DSH_DB_HOST / DSH_DB_PORT / DSH_DB_USER / DSH_DB_PASSWORD` (defaults:
`127.0.0.1:3306 root / demo`).

## Verified with Real DeepSeek ✅

Verified end to end with the real DeepSeek LLM (SQL generation) against a real
MySQL, e.g.:

```text
$ dsh --profile headless --patch ./cordis.patch.yml "统计最近 30 天订单数量"
最近 30 天订单数量：30 单
SQL: SELECT COUNT(*) FROM orders WHERE created_at >= NOW() - INTERVAL 30 DAY
```

and a two-tool flow (`data_query` + `generate_chart`) producing a 12-month order
trend line chart.

## Roadmap

| Version | Content | Status |
| --- | --- | --- |
| V0.1 | MySQL + `data_query` + Text-to-SQL + basic SQL validation | ✅ |
| V0.2 | PostgreSQL provider; schema cache & comment enrichment | ✅ implemented, live-DB test pending |
| V0.3 | SQL AST validator; finer `maxRows`/`timeout`; audit log | — |
| V0.4 | ECharts line/bar/pie/scatter included; custom client render module | tool included |
| V0.5 | Permission-aware Text-to-SQL: RBAC / Tenant / Data Scope policy engine + SQL rewrite | — |

## Design Notes

- **Why Tools never touch the database**: `data_query` depends only on the
  abstract `ctx.dataQuery`; dialects, schemas and safety policies live in the
  provider, mirroring the official `dsh-shell → dsh-bash-local → dsh-tool-bash`
  layering.
- **Permission context**: `DataQueryRequest` already carries `userId / roleIds /
  tenantId / departmentId`; V0.5 adds a policy engine that rewrites generated
  SQL (e.g. appends `AND tenant_id = ?`).
- **ECharts rendering**: `generate_chart` returns the option JSON for the
  model/UI today; real chart cards need a custom client module
  (`ClientModuleRegistry`) — separate Web UI work.
- **Before publishing to npm**: rename packages to a scoped name (e.g.
  `@yourname/dsh-data-query`) and replace the `file:../` internal dependencies
  with version ranges.

## License

MIT

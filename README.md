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
- **Multi-source routing**: any number of databases can be active at once —
  each provider instance registers under a `sourceId` (e.g. `mysql`, `demo2`,
  `postgresql`) and the `data_query` tool routes by its `source` argument.
- **Automatic schema discovery**: tables, columns, comments and foreign keys are
  read from `information_schema` (with a TTL cache) and fed to the model.
- **Safety by default**: only `SELECT` / `WITH`; write/DDL keywords are rejected;
  `LIMIT` is clamped; every execution has a timeout and honors `AbortSignal`.
- **Replaceable providers**: MySQL and PostgreSQL implemented — add
  ClickHouse/Doris by writing one provider package.
- **Charts**: `generate_chart` turns query rows into a ready-to-render ECharts
  option (line / bar / pie / scatter).

## Package Layout

| Package | Layer | Responsibility |
| --- | --- | --- |
| `packages/dsh-data-query` | Service Definition + Facade | Declares the `dataQuery` capability (request/result/error types + shared SQL-safety utilities) and mounts the routing facade (`ctx.dataQuery`) that providers register backends on |
| `packages/dsh-data-query-config` | Management (Settings) | Registers the `data-query-sources` settings namespace — the Web UI settings page renders it as a form; instantiates the matching provider backend per configured source and re-registers them **live** on every edit |
| `packages/dsh-data-query-mysql` | Provider | MySQL backend: information_schema discovery → LLM Text-to-SQL → SQL validation → read-only execution (one instance per `sourceId`) |
| `packages/dsh-data-query-postgres` | Provider | PostgreSQL backend (V0.2, same interface as MySQL) |
| `packages/dsh-tool-data-query` | Consumer / Tool | Registers the `data_query` tool (with a `source` argument); forwards natural-language questions to `ctx.dataQuery` |
| `packages/dsh-tool-echarts` | Consumer / Tool | Registers the `generate_chart` tool: tabular rows → ECharts option **plus a self-contained HTML page** that renders the real chart |

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

```bash
dsh web --patch ./cordis.patch.yml
```

`cordis.patch.yml` mounts `dsh-data-query-config` (the settings-driven data
source manager) plus the `data_query` and `generate_chart` tools. Restart
`dsh web` if HMR does not pick the change up automatically.

### 5. Configure your database connections (Web UI)

No YAML editing needed — the settings page renders the **`data-query-sources`**
namespace as a form. Add one entry per database:

| Field | Meaning |
| --- | --- |
| `sourceId` | Unique id used by the `data_query` tool's `source` argument (e.g. `mysql`, `demo2`, `postgres`) |
| `dialect` | `mysql` or `postgresql` |
| `host` / `port` / `user` / `password` / `database` | Connection settings (password is stored, **never echoed back** to the UI) |
| `isDefault` | Fallback source when `source` is omitted |
| `llmProvider` / `llmModel` | Text-to-SQL route (defaults to the conversation's model) |
| `maxRows` / `timeoutMs` | Safety rails |

Changes apply **live** — backends re-register without a restart. The same
section is stored in `$DSH_HOME/settings.yaml` under `data-query-sources:`.

### 6. Try it

In the Web UI (new conversation), just ask:

- 「统计一下最近 30 天订单数量」/ "Count orders in the last 30 days"
- 「查询产品销量前 10」/ "Top 10 products by sales"
- 「帮我分析最近 12 个月订单趋势，并画一个折线图」/ "Analyze the 12-month order trend and draw a line chart"
- 「用 demo2 数据源统计订单数量」/ "Count orders in the **demo2** data source"

## Chart Display

`generate_chart` returns two things: an ECharts **option** object the model can
reason about, and a **self-contained HTML page** (ECharts loaded from a CDN)
that renders the real chart. When you ask for a chart, the agent saves the HTML
with the `write` tool (e.g. `charts/trend.html`); the produced file appears in
the chat's **deliverables** row and opens as a live, interactive chart.

A future client plugin can render the same option inline in the chat (via the
tool-result presentation seam) — that is separate Web UI work.

## Multiple Data Sources

Any number of databases can be active at once. Add them in the settings page
(see above) — each entry registers a backend under its `sourceId`:

```yaml
# $DSH_HOME/settings.yaml — written by the settings page
data-query-sources:
  sources:
    - { sourceId: mysql,      dialect: mysql,      database: demo,  isDefault: true }
    - { sourceId: demo2,      dialect: mysql,      database: demo2, isDefault: false }
    - { sourceId: postgresql, dialect: postgresql, database: demo,  isDefault: false }
```

The `data_query` tool's `source` argument picks the backend; omitted → the
default source. New dialects (ClickHouse / Doris / SQLServer…) are just another
provider package mirroring `dsh-data-query-mysql`, wired into
`dsh-data-query-config`'s `instantiateBackend`.

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

Multi-source routing with the real LLM: two MySQL sources (`mysql` → `demo`,
`demo2` → `demo2`) registered side by side — the agent routes by `source`
("统计 demo2 数据源订单总数" → returns 361, while the default source returns
360), proving the registry picks the right database per question.

## Roadmap

| Version | Content | Status |
| --- | --- | --- |
| V0.1 | MySQL + `data_query` + Text-to-SQL + basic SQL validation | ✅ |
| V0.2 | PostgreSQL provider; schema cache & comment enrichment | ✅ implemented, live-DB test pending |
| V0.2.5 | Multi-source routing: `dataQuery` facade + per-instance `sourceId` registry | ✅ |
| V0.3 | Settings-UI data source configuration (`data-query-sources`, live) + self-contained chart HTML deliverable | ✅ |
| V0.4 | SQL AST validator; finer `maxRows`/`timeout`; audit log | — |
| V0.5 | Inline chart cards (client plugin) + Permission-aware Text-to-SQL: RBAC / Tenant / Data Scope | — |

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

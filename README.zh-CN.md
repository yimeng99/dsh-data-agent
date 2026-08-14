[English](README.md) · [中文](README.zh-CN.md)

# dsh-data-agent

> 面向 **DeepSeek Harness** 的企业级 AI 数据分析插件套件：
> 自然语言 → Text-to-SQL → 数据库 → 结构化结果 → ECharts。

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-0.1.0--rc.6-purple)

基于 DeepSeek Harness 的 Cordis 插件体系，采用官方推荐的
**Service Definition / Provider / Consumer 三层模式**：数据库能力被抽象为可替换的
Service，Agent 通过 Tool 消费它，更换数据库 Provider **完全不需要改动** Tool 代码。

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
   MySQL  Postgres  ClickHouse...   (Provider 可替换)
     │
     ▼
  Schema Discovery ──→ Text-to-SQL ──→ SQL Validator ──→ Read-only Executor
```

## 功能特性

- **自然语言 → SQL**：Agent 把业务问题翻译成只读 SQL，且复用会话同一条 LLM 路由
  （Text-to-SQL 与对话使用同一个模型）。
- **多数据源路由**：任意数量的数据库可同时生效——每个 Provider 实例按
  `sourceId` 注册（如 `mysql`、`demo2`、`postgresql`），`data_query` 工具通过
  `source` 参数路由。
- **Schema 自动发现**：从 `information_schema` 读取表、列、注释、外键（带 TTL
  缓存）并喂给模型。
- **安全默认**：仅允许 `SELECT` / `WITH`；写操作 / DDL 关键字一律拒绝；`LIMIT`
  自动钳制；每次执行有超时预算并全程透传 `AbortSignal`。
- **Provider 可替换**：MySQL、PostgreSQL 已实现——新增 ClickHouse / Doris 只需
  照抄一个 Provider 包。
- **图表**：`generate_chart` 把查询结果转成可直接渲染的 ECharts option
  （line / bar / pie / scatter）。

## 包结构

| 包 | 层 | 职责 |
| --- | --- | --- |
| `packages/dsh-data-query` | Service Definition + 门面 | 定义 `dataQuery` 能力（请求/结果/错误类型 + 共享 SQL 安全工具），并挂载路由门面 `ctx.dataQuery`，Provider 在它上面注册后端 |
| `packages/dsh-data-query-mysql` | Provider | MySQL 后端：information_schema 自动发现 → LLM Text-to-SQL → SQL 安全校验 → 只读执行（每个 `sourceId` 一个实例） |
| `packages/dsh-data-query-postgres` | Provider | PostgreSQL 后端（V0.2，接口与 MySQL 完全一致） |
| `packages/dsh-tool-data-query` | Consumer / Tool | 注册 `data_query` 工具（带 `source` 参数），把自然语言问题转发给 `ctx.dataQuery` |
| `packages/dsh-tool-echarts` | Consumer / Tool | 注册 `generate_chart` 工具，表格数据 → ECharts option |

## 环境要求

- Node.js ≥ 20，pnpm
- DeepSeek Harness 0.1.0-rc.6（任意带 `dsh-base` bundle 的 profile，如 `web`）
- 一个 MySQL 8 实例（示例数据：`examples/mysql/schema.sql`）

## 安装方法

### 1. 克隆并构建

```bash
git clone https://github.com/yimeng99/dsh-data-agent.git
cd dsh-data-agent
pnpm install
pnpm build
```

### 2.（可选）加载演示数据库

```bash
mysql -u root -p < examples/mysql/schema.sql     # 创建 demo 库
```

### 3. 把插件注册进你的 DSH profile

两种方式任选其一。`$REPO` 为 clone 下来的仓库绝对路径。

**方式 A —— 用 `dsh plugin`（纳入 profile 依赖管理）：**

```bash
dsh plugin --profile web add \
  file:$REPO/packages/dsh-data-query \
  file:$REPO/packages/dsh-data-query-mysql \
  file:$REPO/packages/dsh-tool-data-query \
  file:$REPO/packages/dsh-tool-echarts
```

**方式 B —— 链接进共享库（不改动 profile 的依赖清单）：**

Windows（junction）：

```powershell
$store = "$env:USERPROFILE\.dsh\profiles\node_modules"
foreach ($pkg in 'dsh-data-query','dsh-data-query-mysql','dsh-tool-data-query','dsh-tool-echarts') {
  New-Item -ItemType Junction -Path "$store\$pkg" -Target "$REPO\packages\$pkg"
}
```

macOS / Linux（symlink）：

```bash
store="$HOME/.dsh/profiles/node_modules"
for pkg in dsh-data-query dsh-data-query-mysql dsh-tool-data-query dsh-tool-echarts; do
  ln -s "$REPO/packages/$pkg" "$store/$pkg"
done
```

> `dsh-data-query` 不需要单独的加载行——Provider 直接 import 它，与官方
> `dsh-fs` 包的做法一致。

### 4. 应用 overlay 并启动

数据库密码从环境变量读取，**不要写进任何文件**：

```bash
export DSH_DB_PASSWORD='你的MySQL密码'    # PowerShell: $env:DSH_DB_PASSWORD = '...'
dsh web --patch ./cordis.patch.yml
```

`cordis.patch.yml` 会挂载 `dataQuery` 门面、注册**两个 MySQL 数据源**（`mysql`
→ `demo`，默认；`demo2` → `demo2` 库）以及 `data_query`、`generate_chart` 两个
工具（PostgreSQL 数据源以注释示例给出）。若 HMR 未自动生效，重启 `dsh web`。

### 5. 试试

在 Web UI 新开一个会话，直接问：

- 「统计一下最近 30 天订单数量」
- 「查询产品销量前 10」
- 「帮我分析最近 12 个月订单趋势，并画一个折线图」
- 「用 demo2 数据源统计订单数量」

Agent 会自动调用 `data_query`（你说到具体数据源时会带上 `source`）→
`generate_chart`。

## 多数据源

任意数量的 Provider 实例可同时生效——每个实例按 `sourceId` 注册：

```yaml
- id: data-query
  name: 'dsh-data-query'            # 门面：ctx.dataQuery

- id: data-query-mysql              # 数据源 1：默认
  name: 'dsh-data-query-mysql'
  config: { sourceId: 'mysql', isDefault: true, database: 'demo', ... }

- id: data-query-mysql-demo2        # 数据源 2：另一个 MySQL 实例
  name: 'dsh-data-query-mysql'
  config: { sourceId: 'demo2', database: 'demo2', ... }

- id: data-query-postgres           # 数据源 3：PostgreSQL
  name: 'dsh-data-query-postgres'
  config: { sourceId: 'postgresql', database: 'demo', ... }
```

`data_query` 工具的 `source` 参数选择后端；省略时用默认源（第一个注册的 /
`isDefault: true`）。新增方言（ClickHouse / Doris / SQLServer…）只需照抄
`dsh-data-query-mysql` 实现一个 Provider 包。

## 安全设计（V0.1 已内置）

- **只读校验**：仅允许 `SELECT` / `WITH`；`DROP / DELETE / UPDATE / INSERT /
  TRUNCATE / ALTER / CREATE / GRANT / REVOKE / REPLACE / RENAME / LOCK /
  UNLOCK` 一律拒绝（正则层，V0.3 升级为 SQL AST 校验）。
- **LIMIT 钳制**：自动追加 / 收敛 `LIMIT` 到安全上限，防止全表拉取。
- **超时 + 取消**：每次执行有超时预算，工具调用的 `AbortSignal` 全程透传。
- **大数安全**：BIGINT / DECIMAL 保持精确（安全整数范围内返回数字，超出返回字符串）。

## 测试（本仓库自带）

```bash
node scripts/smoke.mjs        # 无库冒烟：Cordis 接线 + 工具注册 + 图表 builder + SQL 校验器
node scripts/load-schema.mjs  # 把 examples/mysql/schema.sql 灌进本地 MySQL（demo 库）
node scripts/e2e.mjs          # 真库端到端：schema 发现 + Text-to-SQL + LIMIT 钳制 + 拒绝/中止
```

`e2e.mjs` 里 LLM 阶段用 stub 代替（不消耗真实模型调用），其余全部走真实 MySQL。
连接参数可用 `DSH_DB_HOST / DSH_DB_PORT / DSH_DB_USER / DSH_DB_PASSWORD`
环境变量覆盖，默认 `127.0.0.1:3306 root / demo`。

## 真实 DeepSeek 端到端（已验证 ✅）

已用真实 DeepSeek（生成 SQL）+ 真实 MySQL 端到端验证，例如：

```text
$ dsh --profile headless --patch ./cordis.patch.yml "统计最近 30 天订单数量"
最近 30 天订单数量：30 单
SQL: SELECT COUNT(*) FROM orders WHERE created_at >= NOW() - INTERVAL 30 DAY
```

以及双工具协作（`data_query` + `generate_chart`）产出 12 个月订单趋势折线图。

多数据源路由（真实 LLM）：两个 MySQL 数据源（`mysql` → `demo`、`demo2` →
`demo2`）并存，Agent 按 `source` 路由——「统计 demo2 数据源订单总数」返回
361，而默认数据源返回 360，证明注册表按问题选中了正确的库。

## 路线图

| 版本 | 内容 | 状态 |
| --- | --- | --- |
| V0.1 | MySQL + `data_query` + Text-to-SQL + 基础 SQL 校验 | ✅ |
| V0.2 | PostgreSQL Provider；Schema 缓存与注释增强 | ✅ 已实现，真库验证待补 |
| V0.2.5 | 多数据源路由：`dataQuery` 门面 + 按实例 `sourceId` 注册表 | ✅ |
| V0.3 | SQL AST 校验器；`maxRows`/`timeout` 精细化；审计日志 | — |
| V0.4 | ECharts line/bar/pie/scatter 已含；自定义客户端渲染模块 | tool 已含 |
| V0.5 | Permission-aware Text-to-SQL：RBAC / Tenant / Data Scope 策略引擎 + SQL 改写 | — |

## 设计说明

- **为什么 Tool 不直接连库**：`data_query` 只依赖抽象的 `ctx.dataQuery`，方言、
  Schema、安全策略都在 Provider 里，与官方 `dsh-shell → dsh-bash-local →
  dsh-tool-bash` 的分层一致。
- **权限上下文**：`DataQueryRequest` 已携带 `userId / roleIds / tenantId /
  departmentId`；V0.5 增加 Policy Engine，对生成的 SQL 做权限改写（如自动追加
  `AND tenant_id = ?`）。
- **ECharts 呈现**：当前 `generate_chart` 返回 option JSON 供模型/UI 阅读；
  真正的图表卡片需要注册自定义客户端模块（`ClientModuleRegistry`），属于 Web
  UI 侧的独立工作。
- **发布 npm 前**：把包名换成 scoped 名（如 `@yourname/dsh-data-query`），并把
  内部 `file:../` 依赖换成版本号。

## 许可证

MIT

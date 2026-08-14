# dsh-data-agent

> An enterprise-ready AI data analyst plugin suite for **DeepSeek Harness**:
> 自然语言 → Text-to-SQL → 数据库 → 结构化结果 → ECharts。

基于 DeepSeek Harness 的 Cordis 插件体系（Service Definition / Provider /
Consumer 三层）实现的生态项目：数据库能力被抽象为可替换的 Service，Agent
通过 Tool 消费它，换数据库 Provider 不需要改任何 Tool 代码。

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

## 包结构

| 包 | 层 | 职责 |
| --- | --- | --- |
| `packages/dsh-data-query` | Service Definition | 定义 `dataQuery` 能力（请求/结果/错误类型 + 抽象服务），不接触具体数据库 |
| `packages/dsh-data-query-mysql` | Provider | MySQL 实现：information_schema 自动发现 Schema → LLM Text-to-SQL → SQL 安全校验 → 只读执行 |
| `packages/dsh-data-query-postgres` | Provider | PostgreSQL 实现（V0.2 里程碑，接口已就位，当前为 stub） |
| `packages/dsh-tool-data-query` | Consumer / Tool | 注册 `data_query` 工具，把自然语言问题转发给 `ctx.dataQuery` |
| `packages/dsh-tool-echarts` | Consumer / Tool | 注册 `generate_chart` 工具，表格数据 → ECharts option（line/bar/pie/scatter） |

## 快速开始

### 0. 环境

- Node.js ≥ 20，pnpm
- 一个 MySQL 8 实例（示例数据：`examples/mysql/schema.sql`）

### 1. 构建

```bash
pnpm install
pnpm build
```

### 2. 把插件装进你的 DSH profile

把仓库根路径记为 `$REPO`，然后：

```bash
# 方式 A：把 4 个包装进 profile（会初始化/更新 profile 的依赖）
dsh plugin --profile web add \
  file:$REPO/packages/dsh-data-query \
  file:$REPO/packages/dsh-data-query-mysql \
  file:$REPO/packages/dsh-tool-data-query \
  file:$REPO/packages/dsh-tool-echarts

# 方式 B：直接链接进共享库（与运行中 GUI 同一模块图）
#   New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\<pkg>" -Target "$REPO\packages\<pkg>"
```

（`dsh plugin --profile <name>` 会转发给 profile 目录里的 pnpm，把本地包装成
依赖；方式 B 适合不想改动 profile 依赖清单的场合。）

### 3. 启动并应用 overlay

```bash
$env:DSH_DB_PASSWORD = '<你的 MySQL 密码>'   # 密码不写进文件
dsh web --patch ./cordis.patch.yml
```

`cordis.patch.yml` 会：
1. 挂载 `dsh-data-query-mysql` 并把 `ctx.dataQuery` 注册为 MySQL 实现
   （连接配置在文件里，密码从 `DSH_DB_PASSWORD` 环境变量读取）；
2. 挂载 `dsh-tool-data-query` 和 `dsh-tool-echarts` 两个工具。

### 4. 试试

在 Web UI 里直接问：

- 「统计一下最近 30 天订单数量」
- 「查询产品销量前 10」
- 「帮我分析最近 12 个月订单趋势，并画一个折线图」

Agent 会自动依次调用 `data_query` → `generate_chart`。

## 测试（本仓库自带）

```bash
node scripts/smoke.mjs   # 无库冒烟：Cordis 接线 + 工具注册 + 图表 builder + SQL 校验器
node scripts/load-schema.mjs  # 把 examples/mysql/schema.sql 灌进本地 MySQL（demo 库）
node scripts/e2e.mjs     # 真库端到端：schema 发现 + Text-to-SQL + LIMIT 钳制 + 拒绝/中止
```

`e2e.mjs` 里 LLM 阶段用 stub 代替（不消耗真实模型调用），其余全部走真实
MySQL。连接参数可用 `DSH_DB_HOST / DSH_DB_PORT / DSH_DB_USER /
DSH_DB_PASSWORD` 环境变量覆盖，默认 `127.0.0.1:3306 root / demo`。

## 真实 DeepSeek 端到端（已验证 ✅）

本仓库已接入本机 DSH 环境（`$DSH_HOME/profiles`）：

- 5 个包以 junction 链接进共享库 `$DSH_HOME/profiles/node_modules`（与
  web/headless profile 同一模块图，避免 Symbol 双副本问题）；
- `web` profile 的 `cordis.patch.yml` 已写入插件行（`data-query-mysql` +
  `tool-data-query` + `tool-echarts`），`dsh --profile web --dump-config`
  组合验证通过，运行中的 GUI 经 HMR 热加载（或重启 `dsh web` 后）即可使用；
- headless 一次性任务实测（真 DeepSeek 生成 SQL + 真 MySQL）：

```text
$ dsh --profile headless --patch ./cordis.patch.yml "统计最近 30 天订单数量"
最近 30 天订单数量：30 单
SQL: SELECT COUNT(*) FROM orders WHERE created_at >= NOW() - INTERVAL 30 DAY
```

以及双工具协作：

```text
$ dsh --profile headless --patch ./cordis.patch.yml "帮我分析最近 12 个月订单趋势，
  用 generate_chart 生成一个折线图"
→ data_query 返回 12 个月订单数（2025-09 ~ 2026-08）→ generate_chart 生成折线图
→ 趋势分析：11 个月稳定在 28~31 单/月，当月 14 单为低点
```

> 备注：`dsh-data-query-postgres` 已完整实现并通过编译，本机无可用
> PostgreSQL 凭据，真库验证待补（接口与 MySQL 完全一致）。

## 换 Provider（演示 Capability Seam）

只有 **一个** Provider 能注册 `ctx.dataQuery`。切到 PostgreSQL：

```bash
dsh plugin --profile web add file:$REPO/packages/dsh-data-query-postgres
dsh plugin --profile web remove dsh-data-query-mysql
```

`dsh-tool-data-query` / `dsh-tool-echarts` 一行都不用改。

新增方言（ClickHouse / Doris / SQLServer…）只需要照抄
`dsh-data-query-mysql` 实现一个 Provider 包。

## 安全设计（V0.1 已内置）

- **只读校验**：仅允许 `SELECT` / `WITH`；`DROP / DELETE / UPDATE / INSERT /
  TRUNCATE / ALTER / CREATE / GRANT / REVOKE / REPLACE / RENAME / LOCK /
  UNLOCK` 一律拒绝（正则层，V0.3 升级为 SQL AST 校验）。
- **LIMIT 钳制**：自动追加 / 收敛 `LIMIT` 到安全上限，防止全表拉取。
- **超时 + 取消**：每次执行有超时预算，工具调用的 `AbortSignal` 全程透传。
- **大数安全**：BIGINT / DECIMAL 以字符串返回，结果保持 lossless JSON。

## 路线图

| 版本 | 内容 | 状态 |
| --- | --- | --- |
| V0.1 | MySQL + `data_query` Tool + Text-to-SQL + 基础 SQL 校验 | ✅ 本骨架 |
| V0.2 | PostgreSQL Provider；Schema Discovery 缓存与注释增强 | 占位包已就位 |
| V0.3 | SQL AST 校验器；`maxRows`/`timeout` 精细化；审计日志 | — |
| V0.4 | ECharts：line/bar/pie/scatter 已含；自定义客户端渲染模块 | tool 已含 |
| V0.5 | Permission-aware Text-to-SQL：RBAC / Tenant / Data Scope 策略引擎 + SQL 改写 | — |

## 设计说明

- **为什么 Tool 不直接连库**：`data_query` 只依赖 `ctx.dataQuery`（Service
  Definition 声明的抽象），真正的方言、Schema、安全策略都在 Provider 里，
  与 DeepSeek Harness 官方 `dsh-shell → dsh-bash-local → dsh-tool-bash`
  的分层一致。
- **权限上下文**：`DataQueryRequest` 已携带 `userId / roleIds / tenantId /
  departmentId`，工具会把当前 agent 的 session id 填入 `userId`（V0.1
  仅作为 Text-to-SQL 提示上下文）；V0.5 在 Provider 内接入 Policy Engine，
  对生成的 SQL 做权限改写（如自动追加 `AND tenant_id = ?`）。
- **ECharts 呈现**：V0.4 前 `generate_chart` 返回 ECharts option JSON 供
  模型/UI 阅读；真正的图表卡片需要注册自定义客户端模块（
  `ClientModuleRegistry`），这是 Web UI 侧的独立工作。
- **发布前改名**：当前包名是工作区占位名（`dsh-data-query` 等），上 npm
  前建议换成 scoped 名（如 `@yourname/dsh-data-query`）避免撞名。

## 许可证

MIT

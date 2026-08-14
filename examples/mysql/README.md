# MySQL 示例

## 1. 建库

```bash
mysql -u root -p < schema.sql
```

创建 `demo` 库：4 张表（customers / products / orders / order_items）+ 种子数据
（360 笔订单分布在最近 12 个月，用于聚合/趋势类演示）。

## 2. 验证

```sql
USE demo;
SELECT DATE_FORMAT(created_at, '%Y-%m') AS ym, COUNT(*) AS cnt, SUM(total_amount) AS amt
FROM orders GROUP BY ym ORDER BY ym;
```

## 3. 接线到 DeepSeek Harness

见根目录 `README.md` 的「接线」一节。核心三步：

```bash
pnpm install && pnpm build
dsh plugin --profile web add \
  file:<本仓库绝对路径>/packages/dsh-data-query \
  file:<本仓库绝对路径>/packages/dsh-data-query-mysql \
  file:<本仓库绝对路径>/packages/dsh-tool-data-query \
  file:<本仓库绝对路径>/packages/dsh-tool-echarts
dsh web --patch ./cordis.patch.yml
```

把 `cordis.patch.yml` 里 `data-query-mysql` 的 `password` / `database` 改成你的连接配置。

## 4. 试着问

- 统计最近 30 天订单数量
- 查询销量前 10 的产品
- 帮我分析最近 12 个月订单趋势，并画一个折线图
- 按状态统计订单金额占比（画饼图）

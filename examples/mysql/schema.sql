-- =============================================================================
-- dsh-data-agent demo schema (MySQL 8+)
-- A small multi-tenant e-commerce dataset sized for Text-to-SQL demos:
--   * customers / products / orders / order_items
--   * tenant_id + department_id columns already in place for the V0.5
--     permission-aware pipeline (row-level scoping) — not yet enforced.
--
-- Load with:  mysql -u root -p < schema.sql
-- =============================================================================

CREATE DATABASE IF NOT EXISTS demo DEFAULT CHARACTER SET utf8mb4;
USE demo;

DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS customers;

CREATE TABLE customers (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id  INT UNSIGNED NOT NULL,
  name       VARCHAR(64)  NOT NULL COMMENT 'customer name',
  email      VARCHAR(128) NOT NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
) COMMENT = 'customers';

CREATE TABLE products (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   INT UNSIGNED NOT NULL,
  name        VARCHAR(128) NOT NULL COMMENT 'product name',
  category    VARCHAR(32)  NOT NULL COMMENT 'e.g. 数码/家电/服饰',
  price       DECIMAL(12, 2) NOT NULL,
  stock       INT UNSIGNED NOT NULL DEFAULT 0
) COMMENT = 'products';

CREATE TABLE orders (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id     INT UNSIGNED NOT NULL,
  department_id INT UNSIGNED NOT NULL,
  customer_id   INT UNSIGNED NOT NULL,
  status        ENUM('PENDING', 'PAID', 'SHIPPED', 'CANCELLED') NOT NULL,
  total_amount  DECIMAL(12, 2) NOT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers (id)
) COMMENT = 'orders';

CREATE TABLE order_items (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id   INT UNSIGNED NOT NULL,
  product_id INT UNSIGNED NOT NULL,
  quantity   INT UNSIGNED NOT NULL,
  unit_price DECIMAL(12, 2) NOT NULL,
  CONSTRAINT fk_items_order   FOREIGN KEY (order_id)   REFERENCES orders (id),
  CONSTRAINT fk_items_product FOREIGN KEY (product_id) REFERENCES products (id)
) COMMENT = 'order items';

-- ---------------------------------------------------------------- seed data

INSERT INTO customers (tenant_id, name, email)
VALUES
  (1, '张三', 'zhangsan@example.com'),
  (1, '李四', 'lisi@example.com'),
  (1, '王五', 'wangwu@example.com'),
  (1, '赵六', 'zhaoliu@example.com'),
  (1, '钱七', 'qianqi@example.com'),
  (2, '孙八', 'sunba@example.com'),
  (2, '周九', 'zhoujiu@example.com'),
  (2, '吴十', 'wushi@example.com'),
  (2, '郑十一', 'zhengshiyi@example.com'),
  (2, '冯十二', 'fengshier@example.com');

INSERT INTO products (tenant_id, name, category, price, stock)
VALUES
  (1, '无线蓝牙耳机', '数码', 299.00, 120),
  (1, '机械键盘',     '数码', 459.00, 80),
  (1, '智能手表',     '数码', 1299.00, 45),
  (1, '便携充电宝',   '数码', 129.00, 300),
  (1, '4K 显示器',    '数码', 1899.00, 30),
  (1, '扫地机器人',   '家电', 2399.00, 25),
  (1, '空气炸锅',     '家电', 399.00, 90),
  (1, '咖啡机',       '家电', 899.00, 40),
  (1, '羽绒服',       '服饰', 599.00, 150),
  (1, '运动鞋',       '服饰', 329.00, 200),
  (2, '笔记本支架',   '数码', 99.00, 500),
  (2, '降噪头戴耳机', '数码', 1599.00, 60);

-- 360 orders spread over the last 12 months; amounts deterministic per row.
INSERT INTO orders (tenant_id, department_id, customer_id, status, total_amount, created_at)
WITH RECURSIVE seq AS (
  SELECT 1 AS n
  UNION ALL
  SELECT n + 1 FROM seq WHERE n < 360
)
SELECT
  MOD(n, 2) + 1               AS tenant_id,
  MOD(n, 3) + 1               AS department_id,
  MOD(n, 10) + 1              AS customer_id,
  ELT(MOD(n, 4) + 1, 'PENDING', 'PAID', 'SHIPPED', 'CANCELLED') AS status,
  ROUND(50 + (n * 37) % 2000, 2) AS total_amount,
  DATE_SUB(NOW(), INTERVAL (360 - n) DAY) AS created_at
FROM seq;

INSERT INTO order_items (order_id, product_id, quantity, unit_price)
WITH RECURSIVE seq AS (
  SELECT 1 AS n
  UNION ALL
  SELECT n + 1 FROM seq WHERE n < 720
)
SELECT
  MOD(n, 360) + 1 AS order_id,
  MOD(n, 12) + 1  AS product_id,
  MOD(n, 3) + 1   AS quantity,
  ROUND(50 + (n * 13) % 800, 2) AS unit_price
FROM seq;

-- Quick sanity checks
-- SELECT COUNT(*) FROM orders;                          -- 360
-- SELECT DATE_FORMAT(created_at, '%Y-%m') AS ym, COUNT(*) FROM orders GROUP BY ym;

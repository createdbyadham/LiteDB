-- LiteDB eval fixture (SQLite dialect).
--
-- Small, deterministic storefront schema. Seed data is hand-written rather
-- than generated so every run produces byte-identical result sets.
--
-- The schema carries deliberate ambiguity so the `ambiguous-schema` slice has
-- something real to measure:
--   * `name` exists on customers, products and categories
--   * `status` exists on orders and payments with different value domains
--   * `created_at` exists on customers, products and reviews
--   * orders.total is denormalised and may disagree with SUM(order_items)
--   * products.price is current; order_items.unit_price is historical

PRAGMA foreign_keys = ON;

CREATE TABLE customers (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    email      TEXT NOT NULL,
    country    TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE categories (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL
);

CREATE TABLE products (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    price       REAL NOT NULL,
    stock       INTEGER NOT NULL,
    created_at  TEXT NOT NULL
);

CREATE TABLE orders (
    id          INTEGER PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    status      TEXT NOT NULL,
    order_date  TEXT NOT NULL,
    total       REAL NOT NULL
);

CREATE TABLE order_items (
    id         INTEGER PRIMARY KEY,
    order_id   INTEGER NOT NULL REFERENCES orders(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    quantity   INTEGER NOT NULL,
    unit_price REAL NOT NULL
);

CREATE TABLE payments (
    id       INTEGER PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    method   TEXT NOT NULL,
    amount   REAL NOT NULL,
    paid_at  TEXT NOT NULL,
    status   TEXT NOT NULL
);

CREATE TABLE reviews (
    id          INTEGER PRIMARY KEY,
    product_id  INTEGER NOT NULL REFERENCES products(id),
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    rating      INTEGER NOT NULL,
    comment     TEXT,
    created_at  TEXT NOT NULL
);

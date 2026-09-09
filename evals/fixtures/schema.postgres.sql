-- LiteDB eval fixture (PostgreSQL dialect).
-- Mirrors schema.sqlite.sql exactly; only the type system differs.
-- Seed data is shared (seed.sql) so both dialects hold identical rows.

DROP TABLE IF EXISTS reviews, payments, order_items, orders, products, categories, customers CASCADE;

CREATE TABLE customers (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    email      TEXT NOT NULL,
    country    TEXT NOT NULL,
    created_at DATE NOT NULL
);

CREATE TABLE categories (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL
);

CREATE TABLE products (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    price       NUMERIC(10,2) NOT NULL,
    stock       INTEGER NOT NULL,
    created_at  DATE NOT NULL
);

CREATE TABLE orders (
    id          INTEGER PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    status      TEXT NOT NULL,
    order_date  DATE NOT NULL,
    total       NUMERIC(10,2) NOT NULL
);

CREATE TABLE order_items (
    id         INTEGER PRIMARY KEY,
    order_id   INTEGER NOT NULL REFERENCES orders(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    quantity   INTEGER NOT NULL,
    unit_price NUMERIC(10,2) NOT NULL
);

CREATE TABLE payments (
    id       INTEGER PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    method   TEXT NOT NULL,
    amount   NUMERIC(10,2) NOT NULL,
    paid_at  DATE NOT NULL,
    status   TEXT NOT NULL
);

CREATE TABLE reviews (
    id          INTEGER PRIMARY KEY,
    product_id  INTEGER NOT NULL REFERENCES products(id),
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    rating      INTEGER NOT NULL,
    comment     TEXT,
    created_at  DATE NOT NULL
);

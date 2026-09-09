-- Second eval fixture (PostgreSQL): a lending library.
-- Mirrors library.sqlite.sql; only the type system differs.
-- Seed data is shared (library.seed.sql).

DROP TABLE IF EXISTS fines, loans, copies, titles, members CASCADE;

CREATE TABLE members (
    member_id   INTEGER PRIMARY KEY,
    full_name   TEXT NOT NULL,
    joined_on   DATE NOT NULL,
    branch_code TEXT NOT NULL
);

CREATE TABLE titles (
    title_id   INTEGER PRIMARY KEY,
    title_name TEXT NOT NULL,
    author     TEXT NOT NULL,
    genre      TEXT NOT NULL
);

CREATE TABLE copies (
    copy_id        INTEGER PRIMARY KEY,
    title_id       INTEGER NOT NULL REFERENCES titles(title_id),
    acquired_on    DATE NOT NULL,
    condition_code TEXT NOT NULL
);

CREATE TABLE loans (
    loan_id     INTEGER PRIMARY KEY,
    copy_id     INTEGER NOT NULL REFERENCES copies(copy_id),
    member_id   INTEGER NOT NULL REFERENCES members(member_id),
    loaned_on   DATE NOT NULL,
    returned_on DATE
);

CREATE TABLE fines (
    fine_id      INTEGER PRIMARY KEY,
    loan_id      INTEGER NOT NULL REFERENCES loans(loan_id),
    amount_cents INTEGER NOT NULL,
    paid         INTEGER NOT NULL
);

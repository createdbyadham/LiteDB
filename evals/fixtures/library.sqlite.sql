-- Second eval fixture (SQLite): a lending library.
--
-- Exists to test generalisation to an UNSEEN SCHEMA, not just unseen
-- questions. Every convention here differs from the storefront fixture on
-- purpose:
--   * primary keys are suffixed (member_id) rather than bare (id)
--   * people and things carry full_name / title_name, not name
--   * money is an INTEGER count of cents, not a REAL
--   * dates use an _on suffix, not _at
--   * loans.returned_on is nullable, so "still out" is a NULL test
--   * copies is a junction-ish table between titles and loans

CREATE TABLE members (
    member_id   INTEGER PRIMARY KEY,
    full_name   TEXT NOT NULL,
    joined_on   TEXT NOT NULL,
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
    acquired_on    TEXT NOT NULL,
    condition_code TEXT NOT NULL
);

CREATE TABLE loans (
    loan_id     INTEGER PRIMARY KEY,
    copy_id     INTEGER NOT NULL REFERENCES copies(copy_id),
    member_id   INTEGER NOT NULL REFERENCES members(member_id),
    loaned_on   TEXT NOT NULL,
    returned_on TEXT
);

CREATE TABLE fines (
    fine_id      INTEGER PRIMARY KEY,
    loan_id      INTEGER NOT NULL REFERENCES loans(loan_id),
    amount_cents INTEGER NOT NULL,
    paid         INTEGER NOT NULL
);

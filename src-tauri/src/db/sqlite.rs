//! SQLite, opened in place.
//!
//! One connection per open file, behind a mutex, so statements from the grid
//! and the editor take turns the way SQLite wants. Other programs (the MCP
//! server, the user's own app) use the file at the same time through SQLite's
//! own locking; the busy timeout turns a brief lock into a short wait rather
//! than an error.

use super::{value, OpenInfo, RunError, RunOptions, RunResponse, StatementResult};
use rusqlite::types::ValueRef;
use rusqlite::{ffi, Batch, Connection, DatabaseName, InterruptHandle, OpenFlags, Statement};
use serde_json::Value;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

pub struct SqliteConn {
    pub conn: Arc<Mutex<Connection>>,
    pub interrupt: Arc<InterruptHandle>,
}

impl SqliteConn {
    /// Open an existing file, or create one when `create` is set.
    ///
    /// A write-protected file opens read-only rather than failing (SQLite does
    /// this itself for READ_WRITE); the caller is told so it can say why
    /// edits will be refused.
    ///
    /// `read_only` opens a connection that cannot write at all, for agents'
    /// reads. Databases it ATTACHes inherit that, and URI filenames are off so
    /// none can ask for more.
    pub fn open(path: &Path, create: bool, read_only: bool) -> Result<(Self, OpenInfo), String> {
        let mut flags = if read_only {
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX
        } else {
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_URI
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
        };
        if create && !read_only {
            flags |= OpenFlags::SQLITE_OPEN_CREATE;
        }
        let conn = Connection::open_with_flags(path, flags).map_err(|e| e.to_string())?;
        conn.busy_timeout(BUSY_TIMEOUT).map_err(|e| e.to_string())?;

        // A file that is not a database fails here, at open, with SQLite's own
        // "file is not a database", rather than on the first click in the grid.
        conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| {
            r.get::<_, i64>(0)
        })
        .map_err(|e| match &e {
            rusqlite::Error::SqliteFailure(f, _) if f.code == rusqlite::ErrorCode::NotADatabase => {
                "The file is not a SQLite database, or it is encrypted.".to_string()
            }
            _ => e.to_string(),
        })?;

        let read_only = read_only || conn.is_readonly(DatabaseName::Main).unwrap_or(false);
        let version: String = conn
            .query_row("SELECT sqlite_version()", [], |r| r.get(0))
            .unwrap_or_default();
        let mut notices = Vec::new();
        if read_only && flags.contains(OpenFlags::SQLITE_OPEN_READ_WRITE) {
            notices.push(
                "The file is write-protected, so it opened read-only. Edits will be refused."
                    .into(),
            );
        }

        let interrupt = Arc::new(conn.get_interrupt_handle());
        Ok((
            Self {
                conn: Arc::new(Mutex::new(conn)),
                interrupt,
            },
            OpenInfo {
                engine: "sqlite".into(),
                server_version: version,
                read_only,
                notices,
                ..Default::default()
            },
        ))
    }

    /// Skipped while a query holds the connection: the poll asks again soon,
    /// and waiting here would queue it behind a long-running statement.
    pub fn data_version(&self) -> Option<i64> {
        let guard = self.conn.try_lock().ok()?;
        guard
            .query_row("PRAGMA data_version", [], |r| r.get(0))
            .ok()
    }
}

fn total_changes(conn: &Connection) -> i32 {
    // SAFETY: the handle belongs to `conn`, which outlives this call, and
    // sqlite3_total_changes only reads a counter on it.
    unsafe { ffi::sqlite3_total_changes(conn.handle()) }
}

fn cell(v: ValueRef<'_>, full_blobs: bool) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => value::int_value(i),
        ValueRef::Real(f) => value::float_value(f),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => value::blob_value(b, full_blobs),
    }
}

fn run_error(statement: usize, e: &rusqlite::Error, cancelled: &AtomicBool) -> RunError {
    let (code, interrupted) = match e {
        rusqlite::Error::SqliteFailure(f, _) => (
            Some(format!("{:?}", f.code)),
            f.code == rusqlite::ErrorCode::OperationInterrupted,
        ),
        _ => (None, false),
    };
    let cancelled = interrupted || cancelled.load(Ordering::SeqCst);
    RunError {
        statement,
        message: if cancelled {
            "Cancelled.".to_string()
        } else {
            e.to_string()
        },
        code,
        cancelled,
        position: None,
    }
}

fn run_statement(
    conn: &Connection,
    stmt: &mut Statement<'_>,
    index: usize,
    opts: &RunOptions,
) -> rusqlite::Result<StatementResult> {
    let started = Instant::now();
    let before = total_changes(conn);
    let mut result = StatementResult::new(index);
    let count = stmt.column_count();

    if count > 0 {
        result.returns_rows = true;
        for column in stmt.columns() {
            result.columns.push(column.name().to_string());
            result
                .column_types
                .push(column.decl_type().unwrap_or_default().to_string());
        }
        let max = opts.max_rows.unwrap_or(usize::MAX);
        let mut rows = stmt.raw_query();
        // Stopping early is safe even for INSERT … RETURNING: SQLite applies
        // every change on the first step and only buffers the returned rows.
        while let Some(row) = rows.next()? {
            if result.rows.len() >= max {
                result.truncated = true;
                break;
            }
            let mut cells = Vec::with_capacity(count);
            for i in 0..count {
                cells.push(cell(row.get_ref(i)?, opts.full_blobs));
            }
            result.rows.push(cells);
        }
    } else {
        stmt.raw_execute()?;
    }

    // sqlite3_changes keeps the count of the last INSERT/UPDATE/DELETE, so a
    // SELECT or CREATE run after an UPDATE would inherit the UPDATE's count.
    // The total only moves when this statement changed rows.
    result.rows_affected = if total_changes(conn) != before {
        conn.changes()
    } else {
        0
    };
    result.elapsed_ms = started.elapsed().as_millis() as u64;
    Ok(result)
}

fn query_only(conn: &Connection) -> bool {
    conn.query_row("PRAGMA query_only", [], |r| r.get::<_, i64>(0))
        .map(|v| v != 0)
        .unwrap_or(false)
}

/// Run each string in order. A string may hold several statements; each one
/// that SQLite parses becomes its own result.
///
/// `read_only` refuses every statement SQLite says would write, before it
/// runs, and sets `query_only` for the run. The check is per statement, so a
/// string that turns `query_only` off and then writes still meets it.
pub fn run(
    conn: &Connection,
    statements: &[String],
    opts: &RunOptions,
    cancelled: &AtomicBool,
) -> RunResponse {
    let restore = opts.read_only && !query_only(conn);
    if restore {
        if let Err(e) = conn.execute_batch("PRAGMA query_only = ON") {
            let mut response = RunResponse::default();
            response.errors.push(run_error(0, &e, cancelled));
            return response;
        }
    }
    let response = run_all(conn, statements, opts, cancelled);
    if restore {
        let _ = conn.execute_batch("PRAGMA query_only = OFF");
    }
    response
}

fn run_all(
    conn: &Connection,
    statements: &[String],
    opts: &RunOptions,
    cancelled: &AtomicBool,
) -> RunResponse {
    let mut response = RunResponse::default();
    let stop_on_error = opts.transaction || !opts.continue_on_error;

    if opts.transaction {
        if let Err(e) = conn.execute_batch("BEGIN") {
            response.errors.push(run_error(0, &e, cancelled));
            response.in_transaction = !conn.is_autocommit();
            return response;
        }
    }

    'statements: for (index, sql) in statements.iter().enumerate() {
        let mut batch = Batch::new(conn, sql);
        loop {
            // An interrupt only reaches a statement that is running. One that
            // lands between statements would otherwise be lost.
            if cancelled.load(Ordering::SeqCst) {
                response.errors.push(RunError {
                    statement: index,
                    message: "Cancelled.".into(),
                    code: None,
                    cancelled: true,
                    position: None,
                });
                break 'statements;
            }
            let outcome = match batch.next() {
                Ok(Some(stmt)) if opts.read_only && !stmt.readonly() => {
                    response.errors.push(RunError {
                        statement: index,
                        message: "This statement would change the database, and this run is read-only. Nothing ran."
                            .into(),
                        code: Some("ReadOnly".into()),
                        cancelled: false,
                        position: None,
                    });
                    break 'statements;
                }
                Ok(Some(mut stmt)) => run_statement(conn, &mut stmt, index, opts).map(Some),
                Ok(None) => Ok(None),
                Err(e) => Err(e),
            };
            match outcome {
                Ok(Some(result)) => response.results.push(result),
                Ok(None) => break,
                Err(e) => {
                    response.errors.push(run_error(index, &e, cancelled));
                    if stop_on_error {
                        break 'statements;
                    }
                    break;
                }
            }
        }
    }

    if opts.transaction {
        if response.errors.is_empty() {
            if let Err(e) = conn.execute_batch("COMMIT") {
                response
                    .errors
                    .push(run_error(statements.len().saturating_sub(1), &e, cancelled));
                let _ = conn.execute_batch("ROLLBACK");
                response.rolled_back = true;
            }
        } else {
            // May already be rolled back by the failing statement; that is fine.
            let _ = conn.execute_batch("ROLLBACK");
            response.rolled_back = true;
        }
    }

    response.in_transaction = !conn.is_autocommit();
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_db(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("litedb-native-{}-{}", std::process::id(), name));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("test.db")
    }

    fn open(name: &str) -> (SqliteConn, std::path::PathBuf) {
        let path = temp_db(name);
        let (conn, _) = SqliteConn::open(&path, true, false).unwrap();
        (conn, path)
    }

    fn exec(conn: &SqliteConn, sql: &[&str], opts: RunOptions) -> RunResponse {
        let guard = conn.conn.lock().unwrap();
        let statements: Vec<String> = sql.iter().map(|s| s.to_string()).collect();
        run(&guard, &statements, &opts, &AtomicBool::new(false))
    }

    #[test]
    fn opens_in_place_and_reports_rows_and_changes() {
        let (conn, _) = open("basic");
        let r = exec(
            &conn,
            &[
                "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, big INTEGER, data BLOB)",
                "INSERT INTO t (name, big, data) VALUES ('a', 9007199254740993, x'6869'), ('b', 1, NULL)",
                "UPDATE t SET name = 'z' WHERE id = 1",
                "SELECT id, name, big, data FROM t ORDER BY id",
            ],
            RunOptions::default(),
        );
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert_eq!(r.results.len(), 4);
        assert_eq!(r.results[0].rows_affected, 0, "DDL changes no rows");
        assert_eq!(r.results[1].rows_affected, 2);
        assert_eq!(r.results[2].rows_affected, 1);
        let select = &r.results[3];
        assert_eq!(
            select.rows_affected, 0,
            "a SELECT must not inherit the UPDATE's count"
        );
        assert!(select.returns_rows);
        assert_eq!(select.columns, vec!["id", "name", "big", "data"]);
        assert_eq!(
            select.column_types,
            vec!["INTEGER", "TEXT", "INTEGER", "BLOB"]
        );
        assert_eq!(select.rows[0][1], json!("z"));
        assert_eq!(select.rows[0][2], json!("9007199254740993"));
        assert_eq!(select.rows[0][3]["$blob"], json!("aGk="));
        assert_eq!(select.rows[1][3], Value::Null);
    }

    #[test]
    fn max_rows_truncates_without_holding_the_rest() {
        let (conn, _) = open("truncate");
        let r = exec(
            &conn,
            &["WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 5000) SELECT x FROM n"],
            RunOptions {
                max_rows: Some(100),
                ..Default::default()
            },
        );
        assert!(r.errors.is_empty());
        assert_eq!(r.results[0].rows.len(), 100);
        assert!(r.results[0].truncated);
    }

    #[test]
    fn empty_result_still_has_columns() {
        let (conn, _) = open("empty");
        let r = exec(
            &conn,
            &["CREATE TABLE e (a TEXT, b INT)", "SELECT a, b FROM e"],
            RunOptions::default(),
        );
        assert!(r.results[1].returns_rows);
        assert_eq!(r.results[1].columns, vec!["a", "b"]);
        assert!(r.results[1].rows.is_empty());
    }

    #[test]
    fn transaction_rolls_back_on_error() {
        let (conn, _) = open("tx");
        exec(
            &conn,
            &["CREATE TABLE t (id INTEGER PRIMARY KEY)"],
            RunOptions::default(),
        );
        let r = exec(
            &conn,
            &["INSERT INTO t VALUES (1)", "INSERT INTO nope VALUES (2)"],
            RunOptions {
                transaction: true,
                ..Default::default()
            },
        );
        assert_eq!(r.errors.len(), 1);
        assert_eq!(r.errors[0].statement, 1);
        assert!(r.errors[0].message.contains("no such table"));
        assert!(r.rolled_back);
        assert!(!r.in_transaction);
        let after = exec(&conn, &["SELECT count(*) FROM t"], RunOptions::default());
        assert_eq!(after.results[0].rows[0][0], json!(0));
    }

    #[test]
    fn continue_on_error_runs_the_rest() {
        let (conn, _) = open("continue");
        let r = exec(
            &conn,
            &["SELEC 1", "SELECT 2"],
            RunOptions {
                continue_on_error: true,
                ..Default::default()
            },
        );
        assert_eq!(r.errors.len(), 1);
        assert_eq!(r.results.len(), 1);
        assert_eq!(r.results[0].statement, 1);

        let stop = exec(&conn, &["SELEC 1", "SELECT 2"], RunOptions::default());
        assert_eq!(stop.results.len(), 0);
    }

    #[test]
    fn a_users_open_transaction_is_reported() {
        let (conn, _) = open("usertx");
        let r = exec(
            &conn,
            &["BEGIN", "CREATE TABLE x (a)"],
            RunOptions::default(),
        );
        assert!(r.in_transaction);
        let r = exec(&conn, &["ROLLBACK"], RunOptions::default());
        assert!(!r.in_transaction);
    }

    fn read_only() -> RunOptions {
        RunOptions {
            read_only: true,
            ..Default::default()
        }
    }

    fn count(conn: &SqliteConn) -> serde_json::Value {
        exec(conn, &["SELECT count(*) FROM t"], RunOptions::default()).results[0].rows[0][0].clone()
    }

    #[test]
    fn a_read_only_run_reads_and_refuses_writes() {
        let (conn, _) = open("readonly-run");
        exec(
            &conn,
            &[
                "CREATE TABLE t (id INTEGER PRIMARY KEY)",
                "INSERT INTO t VALUES (1), (2)",
            ],
            RunOptions::default(),
        );

        let read = exec(&conn, &["SELECT id FROM t ORDER BY id"], read_only());
        assert!(read.errors.is_empty(), "{:?}", read.errors);
        assert_eq!(read.results[0].rows, vec![vec![json!(1)], vec![json!(2)]]);

        let write = exec(&conn, &["DELETE FROM t"], read_only());
        assert_eq!(write.errors.len(), 1);
        assert!(write.results.is_empty(), "nothing ran");

        // The check is per statement, so switching query_only off first
        // does not open a way through.
        let sneaky = exec(
            &conn,
            &["PRAGMA query_only = OFF; DELETE FROM t"],
            read_only(),
        );
        assert_eq!(sneaky.errors.len(), 1, "{:?}", sneaky.results);
        assert_eq!(count(&conn), json!(2));

        // And the option lasts for its run only.
        let after = exec(
            &conn,
            &["DELETE FROM t WHERE id = 2"],
            RunOptions::default(),
        );
        assert!(after.errors.is_empty(), "{:?}", after.errors);
        assert_eq!(count(&conn), json!(1));
    }

    #[test]
    fn a_read_only_connection_cannot_write_or_attach_new_files() {
        let (writer, path) = open("readonly-open");
        exec(
            &writer,
            &[
                "CREATE TABLE t (id INTEGER PRIMARY KEY)",
                "INSERT INTO t VALUES (1)",
            ],
            RunOptions::default(),
        );
        let (reader, info) = SqliteConn::open(&path, false, true).unwrap();
        assert!(info.read_only);
        assert!(
            info.notices.is_empty(),
            "nothing to explain: it was asked for"
        );

        let read = exec(&reader, &["SELECT id FROM t"], RunOptions::default());
        assert!(read.errors.is_empty(), "{:?}", read.errors);

        let write = exec(
            &reader,
            &["INSERT INTO t VALUES (2)"],
            RunOptions::default(),
        );
        assert_eq!(
            write.errors.len(),
            1,
            "the engine refuses, not the classifier"
        );

        let elsewhere = path.with_file_name("attached.db");
        let attach = exec(
            &reader,
            &[&format!("ATTACH '{}' AS other", elsewhere.display())],
            RunOptions::default(),
        );
        assert_eq!(attach.errors.len(), 1);
        assert!(!elsewhere.exists());
        assert_eq!(count(&writer), json!(1));
    }

    #[test]
    fn interrupt_cancels_a_running_statement() {
        let (conn, _) = open("interrupt");
        let handle = conn.interrupt.clone();
        let cancelled = Arc::new(AtomicBool::new(false));
        let flag = cancelled.clone();
        let canceller = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            flag.store(true, Ordering::SeqCst);
            handle.interrupt();
        });
        let guard = conn.conn.lock().unwrap();
        let r = run(
            &guard,
            &["WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT count(*) FROM n".into()],
            &RunOptions::default(),
            &cancelled,
        );
        canceller.join().unwrap();
        assert_eq!(r.errors.len(), 1);
        assert!(r.errors[0].cancelled, "{:?}", r.errors);
    }

    #[test]
    fn data_version_moves_when_another_connection_writes() {
        let (conn, path) = open("dataversion");
        exec(&conn, &["CREATE TABLE t (a)"], RunOptions::default());
        let before = conn.data_version().unwrap();
        exec(&conn, &["INSERT INTO t VALUES (1)"], RunOptions::default());
        assert_eq!(
            conn.data_version().unwrap(),
            before,
            "own writes do not count"
        );
        let other = Connection::open(&path).unwrap();
        other.execute("INSERT INTO t VALUES (2)", []).unwrap();
        assert_ne!(conn.data_version().unwrap(), before);
    }

    #[test]
    fn not_a_database_is_refused_at_open() {
        let path = temp_db("garbage");
        std::fs::write(&path, b"this is not a database at all, not even close....").unwrap();
        let err = SqliteConn::open(&path, false, false)
            .err()
            .expect("should refuse");
        assert!(err.contains("not a SQLite database"), "{err}");
    }
}

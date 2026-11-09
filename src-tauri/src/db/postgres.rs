//! Postgres: a pool for the app, a session for the editor, an optional tunnel.

use super::{
    ssh, too_many_changes, value, Canceller, DbState, OpenInfo, RunError, RunOptions, RunResponse,
    StatementResult,
};
use futures_util::future::BoxFuture;
use futures_util::TryStreamExt;
use serde::Deserialize;
use serde_json::Value;
use sqlx::postgres::{
    PgConnectOptions, PgConnection, PgDatabaseError, PgErrorPosition, PgPool, PgPoolOptions, PgRow,
    PgSslMode,
};
use sqlx::{Column, Connection as _, Either, Executor, Row, TypeInfo, ValueRef};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PgConnectConfig {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    #[serde(default)]
    pub password: String,
    /// The old checkbox. Only consulted when `ssl_mode` is absent.
    pub ssl: Option<bool>,
    /// disable | allow | prefer | require | verify-ca | verify-full
    pub ssl_mode: Option<String>,
    /// CA certificate (PEM) to verify the server against.
    pub ssl_root_cert: Option<String>,
    pub ssh: Option<ssh::SshConfig>,
}

pub fn ssl_mode(config: &PgConnectConfig) -> Result<PgSslMode, String> {
    let mode = config
        .ssl_mode
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty());
    Ok(match mode {
        None if config.ssl.unwrap_or(false) => PgSslMode::Require,
        None => PgSslMode::Disable,
        Some("disable") => PgSslMode::Disable,
        Some("allow") => PgSslMode::Allow,
        Some("prefer") => PgSslMode::Prefer,
        Some("require") => PgSslMode::Require,
        Some("verify-ca") => PgSslMode::VerifyCa,
        Some("verify-full") => PgSslMode::VerifyFull,
        Some(other) => return Err(format!("Unknown SSL mode \"{other}\".")),
    })
}

struct Session {
    conn: PgConnection,
    pid: i32,
}

pub struct PgConn {
    pool: PgPool,
    options: PgConnectOptions,
    /// The editor's own connection, opened on first use.
    session: Mutex<Option<Session>>,
    tunnel: Option<ssh::SshTunnel>,
}

impl PgConn {
    pub async fn open(
        config: PgConnectConfig,
        known_hosts: PathBuf,
    ) -> Result<(Self, OpenInfo), String> {
        let mut notices = Vec::new();
        let mut mode = ssl_mode(&config)?;

        let tunnel = match &config.ssh {
            Some(ssh_config) if !ssh_config.host.trim().is_empty() => {
                let tunnel =
                    ssh::SshTunnel::open(ssh_config, &config.host, config.port, known_hosts)
                        .await?;
                notices.extend(tunnel.notices.iter().cloned());
                if matches!(mode, PgSslMode::VerifyFull) {
                    // sqlx verifies the certificate against the host it dials,
                    // which through a tunnel is 127.0.0.1.
                    mode = PgSslMode::VerifyCa;
                    notices.push(
                        "Through the SSH tunnel the certificate is checked against your CA, \
                         but not against the host name."
                            .into(),
                    );
                }
                Some(tunnel)
            }
            _ => None,
        };
        let (host, port) = match &tunnel {
            Some(t) => ("127.0.0.1".to_string(), t.local_port),
            None => (config.host.trim().to_string(), config.port),
        };

        let mut options = PgConnectOptions::new()
            .host(&host)
            .port(port)
            .username(&config.username)
            .password(&config.password)
            .database(&config.database)
            .ssl_mode(mode)
            .application_name("LiteDB");
        if let Some(cert) = config
            .ssl_root_cert
            .as_deref()
            .map(str::trim)
            .filter(|c| !c.is_empty())
        {
            options = options.ssl_root_cert(cert);
        }

        let pool = PgPoolOptions::new()
            .max_connections(8)
            .acquire_timeout(Duration::from_secs(30))
            .connect_with(options.clone())
            .await
            .map_err(|e| e.to_string())?;

        let version: String = sqlx::query_scalar("SHOW server_version")
            .fetch_one(&pool)
            .await
            .unwrap_or_default();
        // A standby, or a role whose transactions default to read-only.
        let read_only: bool = sqlx::query_scalar(
            "SELECT pg_is_in_recovery() OR current_setting('default_transaction_read_only') = 'on'",
        )
        .fetch_one(&pool)
        .await
        .unwrap_or(false);
        if read_only {
            notices.push("The server only accepts reads (a standby, or a read-only role).".into());
        }

        let info = OpenInfo {
            engine: "postgres".into(),
            server_version: version,
            read_only,
            agent_host: Some(host),
            agent_port: Some(port),
            notices,
            ..Default::default()
        };
        Ok((
            Self {
                pool,
                options,
                session: Mutex::new(None),
                tunnel,
            },
            info,
        ))
    }

    pub async fn close(&self) {
        if let Some(session) = self.session.lock().await.take() {
            let _ = session.conn.close().await;
        }
        self.pool.close().await;
        if let Some(tunnel) = &self.tunnel {
            tunnel.shutdown();
        }
    }

    // Boxed with explicit lifetimes: as plain `async fn`s these hit rustc's
    // "Executor is not general enough" limit once a Tauri command awaits them.
    pub fn run<'a>(
        &'a self,
        state: &'a DbState,
        statements: &'a [String],
        opts: &'a RunOptions,
        cancelled: Arc<AtomicBool>,
    ) -> BoxFuture<'a, Result<RunResponse, String>> {
        Box::pin(async move {
            // Never on the editor's session: a transaction the user has open
            // there would be rolled back with ours.
            if opts.session && !opts.read_only {
                let mut guard = self.session.lock().await;
                if guard.is_none() {
                    let mut conn = PgConnection::connect_with(&self.options)
                        .await
                        .map_err(|e| e.to_string())?;
                    let pid = backend_pid(&mut conn).await?;
                    *guard = Some(Session { conn, pid });
                }
                let session = guard.as_mut().expect("session was just opened");
                state.register(
                    &opts.query_id,
                    Canceller::Postgres {
                        pool: self.pool.clone(),
                        pid: session.pid,
                        cancelled: cancelled.clone(),
                    },
                );
                let mut response = run_statements(
                    &mut session.conn,
                    Some(session.pid),
                    &self.pool,
                    statements,
                    opts,
                    &cancelled,
                )
                .await;
                response.in_transaction = in_transaction(&mut session.conn).await;
                if !response.errors.is_empty() && session.conn.ping().await.is_err() {
                    // The server went away; reconnect on the next run.
                    *guard = None;
                    response.in_transaction = false;
                }
                return Ok(response);
            }

            let mut conn = self.pool.acquire().await.map_err(|e| e.to_string())?;
            let pid = if opts.query_id.is_some() {
                let pid = backend_pid(&mut conn).await?;
                state.register(
                    &opts.query_id,
                    Canceller::Postgres {
                        pool: self.pool.clone(),
                        pid,
                        cancelled: cancelled.clone(),
                    },
                );
                Some(pid)
            } else {
                None
            };
            if opts.read_only {
                return Ok(
                    run_read_only(&mut conn, pid, &self.pool, statements, opts, &cancelled).await,
                );
            }
            let mut response =
                run_statements(&mut conn, pid, &self.pool, statements, opts, &cancelled).await;
            // A pooled connection must not go back with a transaction open, or the
            // next caller would run inside it.
            let opens_transaction = statements.iter().any(|s| {
                let head = s.trim_start().to_ascii_uppercase();
                head.starts_with("BEGIN") || head.starts_with("START")
            });
            if opens_transaction && in_transaction(&mut conn).await {
                let _ = (&mut *conn).execute("ROLLBACK").await;
                response.rolled_back = true;
            }
            Ok(response)
        })
    }
}

/// The backend's process id, which `pg_cancel_backend` needs.
///
/// Every query on a `&mut PgConnection` in this file goes through the Executor
/// methods with a bare `&str`. That is the simple query protocol (text values,
/// several statements per string), the same as `raw_sql`, but without the
/// generic executor parameter that rustc cannot prove `Send` for here.
fn backend_pid(conn: &mut PgConnection) -> BoxFuture<'_, Result<i32, String>> {
    Box::pin(async move {
        let row = (&mut *conn)
            .fetch_one("SELECT pg_backend_pid()")
            .await
            .map_err(|e| e.to_string())?;
        row.try_get::<i32, _>(0).map_err(|e| e.to_string())
    })
}

pub async fn cancel_backend(pool: &PgPool, pid: i32) -> Result<(), String> {
    sqlx::query("SELECT pg_cancel_backend($1)")
        .bind(pid)
        .execute(pool)
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// `now()` is fixed at the start of the transaction; `statement_timestamp()`
/// is this statement. Outside a transaction block they are the same instant.
/// An aborted transaction refuses the query, which also means "still open".
fn in_transaction(conn: &mut PgConnection) -> BoxFuture<'_, bool> {
    Box::pin(async move {
        match (&mut *conn)
            .fetch_one("SELECT now() <> statement_timestamp()")
            .await
        {
            Ok(row) => row.try_get::<bool, _>(0).unwrap_or(false),
            Err(_) => true,
        }
    })
}

fn set_columns(result: &mut StatementResult, row: &PgRow) {
    result.returns_rows = true;
    for col in row.columns() {
        result.columns.push(col.name().to_string());
        result.column_types.push(col.type_info().name().to_string());
    }
}

/// One row as JSON values, in column order.
///
/// Extracted so it can be tested against a real server, which is the only way
/// to know whether a `numeric` or `date` column comes back as a value or as
/// null. See the tests below.
pub fn row_values(row: &PgRow) -> Vec<Value> {
    (0..row.columns().len()).map(|i| cell(row, i)).collect()
}

fn cell(row: &PgRow, i: usize) -> Value {
    if let Ok(v) = row.try_get::<String, _>(i) {
        return Value::String(v);
    }
    if let Ok(v) = row.try_get::<i64, _>(i) {
        return value::int_value(v);
    }
    if let Ok(v) = row.try_get::<i32, _>(i) {
        return Value::Number(v.into());
    }
    if let Ok(v) = row.try_get::<i16, _>(i) {
        return Value::Number(v.into());
    }
    if let Ok(v) = row.try_get::<f64, _>(i) {
        return value::float_value(v);
    }
    if let Ok(v) = row.try_get::<f32, _>(i) {
        return value::float_value(v as f64);
    }
    if let Ok(v) = row.try_get::<bool, _>(i) {
        return Value::Bool(v);
    }
    // Everything else — date, timestamp, numeric, uuid, json, arrays, enums,
    // pgvector — in the server's own text rendering. The simple query
    // protocol sends every value as text, so this is exact where f64 is not,
    // and it is the value rather than an invented NULL.
    row.try_get_raw(i)
        .ok()
        .filter(|raw| !raw.is_null())
        .and_then(|raw| raw.as_str().ok().map(|s| Value::String(s.to_string())))
        .unwrap_or(Value::Null)
}

fn run_error(statement: usize, e: &sqlx::Error, cancelled: &AtomicBool) -> RunError {
    let db = e.as_database_error();
    let code = db.and_then(|d| d.code()).map(|c| c.to_string());
    let user_cancelled = code.as_deref() == Some("57014") && cancelled.load(Ordering::SeqCst);
    let message = match db.and_then(|d| d.try_downcast_ref::<PgDatabaseError>()) {
        Some(pg) => {
            let mut text = pg.message().to_string();
            if let Some(detail) = pg.detail() {
                text.push_str("\nDetail: ");
                text.push_str(detail);
            }
            if let Some(hint) = pg.hint() {
                text.push_str("\nHint: ");
                text.push_str(hint);
            }
            text
        }
        None => e.to_string(),
    };
    let position = db
        .and_then(|d| d.try_downcast_ref::<PgDatabaseError>())
        .and_then(|pg| match pg.position() {
            Some(PgErrorPosition::Original(p)) => Some(p),
            _ => None,
        });
    RunError {
        statement,
        message: if user_cancelled {
            "Cancelled.".into()
        } else {
            message
        },
        code,
        cancelled: user_cancelled,
        position,
    }
}

fn looks_like_query(sql: &str) -> bool {
    let head = sql.trim_start().to_ascii_uppercase();
    ["SELECT", "WITH", "VALUES", "TABLE", "SHOW"]
        .iter()
        .any(|kw| head.starts_with(kw))
}

/// A run that changes nothing: in a READ ONLY transaction, always rolled back.
///
/// Each string must be one statement. The simple query protocol runs several,
/// and a COMMIT among them would end the READ ONLY transaction with the rest
/// still to come. Parsing each string as a prepared statement first refuses
/// that before anything runs; the run itself stays on the simple protocol,
/// which sends values as the text the grid shows.
///
/// A single statement cannot escape: a COMMIT ends a transaction that changed
/// nothing, and a SET is undone by the rollback.
fn run_read_only<'a>(
    conn: &'a mut PgConnection,
    pid: Option<i32>,
    pool: &'a PgPool,
    statements: &'a [String],
    opts: &'a RunOptions,
    cancelled: &'a AtomicBool,
) -> BoxFuture<'a, RunResponse> {
    Box::pin(async move {
        for (index, sql) in statements.iter().enumerate() {
            if let Err(e) = (&mut *conn).describe(sql.as_str()).await {
                let mut response = RunResponse::default();
                response.errors.push(run_error(index, &e, cancelled));
                return response;
            }
        }
        if let Err(e) = (&mut *conn).execute("BEGIN READ ONLY").await {
            let mut response = RunResponse::default();
            response.errors.push(run_error(0, &e, cancelled));
            return response;
        }
        let inner = RunOptions {
            transaction: false,
            session: false,
            ..opts.clone()
        };
        let response = run_statements(conn, pid, pool, statements, &inner, cancelled).await;
        // Always. There is nothing to commit, and the connection goes back to
        // the pool.
        let _ = (&mut *conn).execute("ROLLBACK").await;
        response
    })
}

fn run_statements<'a>(
    conn: &'a mut PgConnection,
    pid: Option<i32>,
    pool: &'a PgPool,
    statements: &'a [String],
    opts: &'a RunOptions,
    cancelled: &'a AtomicBool,
) -> BoxFuture<'a, RunResponse> {
    Box::pin(async move {
        let mut response = RunResponse::default();
        let stop_on_error = opts.transaction || !opts.continue_on_error;
        let max = opts.max_rows.unwrap_or(usize::MAX);
        let single = statements.len() == 1;

        if opts.transaction {
            if let Err(e) = (&mut *conn).execute("BEGIN").await {
                response.errors.push(run_error(0, &e, cancelled));
                return response;
            }
        }

        for (index, sql) in statements.iter().enumerate() {
            if cancelled.load(Ordering::SeqCst) {
                response.errors.push(RunError {
                    statement: index,
                    message: "Cancelled.".into(),
                    code: None,
                    cancelled: true,
                    position: None,
                });
                break;
            }

            let started = Instant::now();
            let results_before = response.results.len();
            let mut current = StatementResult::new(index);
            let mut stop_sent = false;
            let mut failure: Option<RunError> = None;
            {
                let mut stream = (&mut *conn).fetch_many(sql.as_str());
                loop {
                    match stream.try_next().await {
                        Ok(Some(Either::Right(row))) => {
                            if !current.returns_rows {
                                set_columns(&mut current, &row);
                            }
                            if current.rows.len() >= max {
                                current.truncated = true;
                                // Without this the server keeps sending every row
                                // of a large table, only for it to be dropped here.
                                if opts.stop_at_limit && single && !stop_sent {
                                    if let Some(pid) = pid {
                                        stop_sent = true;
                                        let pool = pool.clone();
                                        tokio::spawn(async move {
                                            let _ = cancel_backend(&pool, pid).await;
                                        });
                                    }
                                }
                                continue;
                            }
                            current.rows.push(row_values(&row));
                        }
                        Ok(Some(Either::Left(done))) => {
                            current.rows_affected = done.rows_affected();
                            current.elapsed_ms = started.elapsed().as_millis() as u64;
                            response
                                .results
                                .push(std::mem::replace(&mut current, StatementResult::new(index)));
                        }
                        Ok(None) => break,
                        Err(e) => {
                            let own_stop = stop_sent
                                && e.as_database_error().and_then(|d| d.code()).as_deref()
                                    == Some("57014");
                            if !own_stop {
                                failure = Some(run_error(index, &e, cancelled));
                            }
                            break;
                        }
                    }
                }
            }

            // Rows kept before our own stop, or before an error mid-stream.
            if current.returns_rows {
                current.elapsed_ms = started.elapsed().as_millis() as u64;
                response.results.push(current);
            }

            // An empty result carries no row to read column names from.
            if failure.is_none()
                && response.results.len() == results_before + 1
                && looks_like_query(sql)
            {
                let last = response.results.last_mut().expect("one result");
                if !last.returns_rows {
                    if let Ok(describe) = (&mut *conn).describe(sql.as_str()).await {
                        if !describe.columns().is_empty() {
                            last.returns_rows = true;
                            last.rows_affected = 0;
                            for col in describe.columns() {
                                last.columns.push(col.name().to_string());
                                last.column_types.push(col.type_info().name().to_string());
                            }
                        }
                    }
                }
            }

            if let Some(error) = failure {
                response.errors.push(error);
                if stop_on_error {
                    break;
                }
            }
        }

        if let (true, true, Some(limit)) = (
            opts.transaction,
            response.errors.is_empty(),
            opts.max_changes,
        ) {
            // Postgres counts the rows a SELECT returns as affected, so reads
            // are left out.
            let changed: u64 = response
                .results
                .iter()
                .filter(|r| !looks_like_query(&statements[r.statement]))
                .map(|r| r.rows_affected)
                .sum();
            if changed > limit {
                response.errors.push(too_many_changes(
                    statements.len().saturating_sub(1),
                    changed,
                    limit,
                ));
            }
        }

        if opts.transaction {
            let finish = if response.errors.is_empty() {
                "COMMIT"
            } else {
                response.rolled_back = true;
                "ROLLBACK"
            };
            if let Err(e) = (&mut *conn).execute(finish).await {
                response
                    .errors
                    .push(run_error(statements.len().saturating_sub(1), &e, cancelled));
                if finish == "COMMIT" {
                    let _ = (&mut *conn).execute("ROLLBACK").await;
                    response.rolled_back = true;
                }
            }
        }

        response
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sqlx::Executor;

    fn config(ssl: Option<bool>, mode: Option<&str>) -> PgConnectConfig {
        PgConnectConfig {
            host: "localhost".into(),
            port: 5432,
            database: "shop".into(),
            username: "user@name".into(),
            password: r#"p/w?d#x%yy"#.into(),
            ssl,
            ssl_mode: mode.map(str::to_string),
            ssl_root_cert: None,
            ssh: None,
        }
    }

    #[test]
    fn ssl_mode_follows_the_mode_then_the_old_checkbox() {
        assert!(matches!(
            ssl_mode(&config(None, None)),
            Ok(PgSslMode::Disable)
        ));
        assert!(matches!(
            ssl_mode(&config(Some(true), None)),
            Ok(PgSslMode::Require)
        ));
        assert!(matches!(
            ssl_mode(&config(Some(true), Some("verify-full"))),
            Ok(PgSslMode::VerifyFull)
        ));
        assert!(matches!(
            ssl_mode(&config(None, Some("prefer"))),
            Ok(PgSslMode::Prefer)
        ));
        assert!(ssl_mode(&config(None, Some("sometimes"))).is_err());
    }

    #[test]
    fn query_detection_for_describe() {
        assert!(looks_like_query("  select 1"));
        assert!(looks_like_query("WITH x AS (SELECT 1) SELECT * FROM x"));
        assert!(!looks_like_query("DELETE FROM t"));
    }

    /// Skipped unless EVAL_POSTGRES_URL points at a throwaway database.
    ///
    /// Answers the question that matters: whether a `numeric` or `date`
    /// column reaches the frontend as its value or as null. Both used to come
    /// back null, so a numeric column displayed as NULL whatever it held.
    #[tokio::test]
    async fn non_primitive_columns_are_not_reported_as_null() {
        let Ok(url) = std::env::var("EVAL_POSTGRES_URL") else {
            eprintln!("skipping: EVAL_POSTGRES_URL not set");
            return;
        };
        // As the app does at startup, so `sslmode=verify-ca` URLs work here too.
        crate::install_crypto_provider();
        let pool = PgPoolOptions::new().connect(&url).await.unwrap();
        pool.execute(
            "DROP TABLE IF EXISTS row_json_probe;
             CREATE TABLE row_json_probe (
                 id serial PRIMARY KEY, label text, amount numeric(10,2),
                 happened_on date, at timestamptz, flag boolean, payload jsonb, absent text
             );
             INSERT INTO row_json_probe (label, amount, happened_on, at, flag, payload, absent)
             VALUES ('hello', 200.00, '2026-09-01', '2026-09-01T10:30:00Z', true, '{\"a\":1}'::jsonb, NULL);",
        )
        .await
        .unwrap();

        let mut conn = pool.acquire().await.unwrap();
        let r = run_statements(
            &mut conn,
            None,
            &pool,
            &[
                "SELECT label, amount, happened_on, at, flag, payload, absent FROM row_json_probe"
                    .into(),
            ],
            &RunOptions::default(),
            &AtomicBool::new(false),
        )
        .await;
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        let row = &r.results[0].rows[0];
        assert_eq!(row[0], json!("hello"));
        assert_eq!(row[1], json!("200.00"), "numeric must not be null");
        assert_eq!(row[2], json!("2026-09-01"), "date must not be null");
        assert!(row[3].is_string());
        assert_eq!(row[4], json!(true));
        assert!(row[5].is_string());
        assert_eq!(row[6], Value::Null, "a real NULL stays null");

        // Empty results still name their columns.
        let empty = run_statements(
            &mut conn,
            None,
            &pool,
            &["SELECT label, amount FROM row_json_probe WHERE false".into()],
            &RunOptions::default(),
            &AtomicBool::new(false),
        )
        .await;
        assert_eq!(empty.results[0].columns, vec!["label", "amount"]);

        // A failed statement in a transaction rolls the run back.
        let tx = run_statements(
            &mut conn,
            None,
            &pool,
            &[
                "UPDATE row_json_probe SET label = 'changed'".into(),
                "SELECT nope FROM row_json_probe".into(),
            ],
            &RunOptions {
                transaction: true,
                ..Default::default()
            },
            &AtomicBool::new(false),
        )
        .await;
        assert!(tx.rolled_back);
        assert!(
            tx.errors[0].position.is_some(),
            "error position is reported"
        );
        let label: String = sqlx::query_scalar("SELECT label FROM row_json_probe")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(label, "hello");

        // max_rows keeps the first rows and flags the rest.
        let many = run_statements(
            &mut conn,
            None,
            &pool,
            &["SELECT generate_series(1, 5000)".into()],
            &RunOptions {
                max_rows: Some(10),
                ..Default::default()
            },
            &AtomicBool::new(false),
        )
        .await;
        assert_eq!(many.results[0].rows.len(), 10);
        assert!(many.results[0].truncated);

        // A read-only run reads, and refuses writes however they are dressed.
        let read_only = RunOptions {
            read_only: true,
            ..Default::default()
        };
        let read = run_read_only(
            &mut conn,
            None,
            &pool,
            &["SELECT label FROM row_json_probe".into()],
            &read_only,
            &AtomicBool::new(false),
        )
        .await;
        assert!(read.errors.is_empty(), "{:?}", read.errors);
        assert_eq!(read.results[0].rows[0][0], json!("hello"));
        for sql in [
            "DELETE FROM row_json_probe",
            "COMMIT; DELETE FROM row_json_probe",
            "SELECT 1; DELETE FROM row_json_probe",
        ] {
            let refused = run_read_only(
                &mut conn,
                None,
                &pool,
                &[sql.into()],
                &read_only,
                &AtomicBool::new(false),
            )
            .await;
            assert_eq!(refused.errors.len(), 1, "{sql} was not refused");
        }
        let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM row_json_probe")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(rows, 1);
        assert!(!in_transaction(&mut conn).await, "nothing left open");

        // A write over its row limit is rolled back; a read in the same run
        // does not count towards it.
        let limited = |max| RunOptions {
            transaction: true,
            max_changes: Some(max),
            ..Default::default()
        };
        let statements: Vec<String> = vec![
            "INSERT INTO row_json_probe (label) VALUES ('a'), ('b')".into(),
            "SELECT * FROM row_json_probe".into(),
        ];
        let over = run_statements(
            &mut conn,
            None,
            &pool,
            &statements,
            &limited(1),
            &AtomicBool::new(false),
        )
        .await;
        assert!(over.rolled_back);
        assert_eq!(over.errors[0].code.as_deref(), Some("TooManyChanges"));
        let within = run_statements(
            &mut conn,
            None,
            &pool,
            &statements,
            &limited(2),
            &AtomicBool::new(false),
        )
        .await;
        assert!(within.errors.is_empty(), "{:?}", within.errors);
        let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM row_json_probe")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(rows, 3);

        drop(conn);
        pool.execute("DROP TABLE row_json_probe").await.unwrap();
    }
}

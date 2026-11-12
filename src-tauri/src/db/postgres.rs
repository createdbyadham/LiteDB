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
use sqlx::{Column, Connection as _, Either, Executor, Row, Statement as _, TypeInfo, ValueRef};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, Notify};

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

/// Transaction-mode pooling: each transaction can run on a different backend.
///
/// Supabase's shared pooler (`*.pooler.supabase.com`) and dedicated pooler
/// (`db.<ref>.supabase.co`) do this on port 6543, and so does any PgBouncer or
/// Supavisor on that port. Neon pooled hosts do it on whatever port they
/// publish; the first label ends in `-pooler`.
///
/// Judged from the host the user configured, not the SSH tunnel's local end.
pub fn is_transaction_pooler(host: &str, port: u16) -> bool {
    let host = normalize_host(host);
    port == 6543 || neon_pooled_host(&host)
}

/// A pooler, including Supabase's session mode on port 5432.
///
/// Session mode keeps one backend per client, so cancel-by-pid still works,
/// but every client counts against a small project limit.
pub fn is_pooled_host(host: &str, port: u16) -> bool {
    let host = normalize_host(host);
    supabase_shared_pooler(&host)
        || (port == 6543 && supabase_dedicated_pooler(&host))
        || neon_pooled_host(&host)
}

/// Pool size, and how long an idle connection may hold a pooler slot.
///
/// `(max_connections, idle_timeout)`. `None` leaves sqlx's default idle timeout.
fn pool_settings(host: &str, port: u16) -> (u32, Option<Duration>) {
    if is_pooled_host(host, port) {
        // The editor session is one more connection on top of the pool.
        (3, Some(Duration::from_secs(60)))
    } else {
        (8, None)
    }
}

fn normalize_host(host: &str) -> String {
    host.trim().trim_end_matches('.').to_ascii_lowercase()
}

fn supabase_shared_pooler(host: &str) -> bool {
    match host.strip_suffix(".pooler.supabase.com") {
        Some(prefix) => !prefix.is_empty() && !prefix.ends_with('.'),
        None => false,
    }
}

/// `db.<ref>.supabase.co`
fn supabase_dedicated_pooler(host: &str) -> bool {
    let mut parts = host.split('.');
    matches!(
        (
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next()
        ),
        (Some("db"), Some(reference), Some("supabase"), Some("co"), None) if !reference.is_empty()
    )
}

fn neon_pooled_host(host: &str) -> bool {
    host.split('.')
        .next()
        .is_some_and(|label| label.ends_with("-pooler"))
}

struct Session {
    conn: PgConnection,
    /// None through a transaction pooler: the next transaction is a different
    /// process, so this number cannot name the session.
    pid: Option<i32>,
}

/// What a run needs besides the statements. Split out so the signature stays short.
struct RunCtx<'a> {
    pool: &'a PgPool,
    /// Backend pid for `pg_cancel_backend`. None when it would hit the wrong process.
    pid: Option<i32>,
    cancelled: &'a AtomicBool,
    /// Set when the user hits Cancel on a transaction pooler.
    stop: Option<&'a Notify>,
    transaction_pooler: bool,
}

struct Executed {
    response: RunResponse,
    /// The connection must not be used again. Either the protocol was left
    /// mid-message, or Cancel on a transaction pooler threw it away.
    discard: bool,
}

fn finished(response: RunResponse) -> Executed {
    Executed {
        response,
        discard: false,
    }
}

pub struct PgConn {
    pool: PgPool,
    options: PgConnectOptions,
    /// The editor's own connection, opened on first use.
    session: Mutex<Option<Session>>,
    tunnel: Option<ssh::SshTunnel>,
    /// From the configured host and port, not the tunnel's local address.
    transaction_pooler: bool,
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

        // The dial address may be the tunnel's local end. Pooler behaviour
        // follows the host the user configured.
        let transaction_pooler = is_transaction_pooler(&config.host, config.port);
        let (max_connections, idle_timeout) = pool_settings(&config.host, config.port);
        let mut pool_options = PgPoolOptions::new()
            .max_connections(max_connections)
            .acquire_timeout(Duration::from_secs(30));
        if let Some(idle) = idle_timeout {
            pool_options = pool_options.idle_timeout(idle);
        }
        let pool = pool_options
            .connect_with(options.clone())
            .await
            .map_err(|e| e.to_string())?;

        // Unnamed statements. sqlx's named cache (`sqlx_s_1`) collides on a
        // transaction pooler, and these errors used to be swallowed, so the
        // version came back empty.
        let version: String = sqlx::query_scalar("SHOW server_version")
            .persistent(false)
            .fetch_one(&pool)
            .await
            .unwrap_or_default();
        // A standby, or a role whose transactions default to read-only.
        let read_only: bool = sqlx::query_scalar(
            "SELECT pg_is_in_recovery() OR current_setting('default_transaction_read_only') = 'on'",
        )
        .persistent(false)
        .fetch_one(&pool)
        .await
        .unwrap_or(false);
        if read_only {
            notices.push("The server only accepts reads (a standby, or a read-only role).".into());
        }
        if transaction_pooler {
            notices.push(
                "This is a transaction pooler. Cancel stops waiting but cannot stop the server. \
                 SET and temporary tables do not carry between runs. For a desktop app, Supabase \
                 recommends the session pooler (same host, port 5432)."
                    .into(),
            );
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
                transaction_pooler,
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
                    let pid = if self.transaction_pooler {
                        None
                    } else {
                        Some(backend_pid(&mut conn).await?)
                    };
                    *guard = Some(Session { conn, pid });
                }
                let pid = guard.as_ref().and_then(|session| session.pid);
                let stop = self.arm_cancel(state, opts, &cancelled, pid);
                let ctx = RunCtx {
                    pool: &self.pool,
                    pid,
                    cancelled: &cancelled,
                    stop: stop.as_deref(),
                    transaction_pooler: self.transaction_pooler,
                };
                let executed = {
                    let session = guard.as_mut().expect("session was just opened");
                    run_statements(&mut session.conn, statements, opts, &ctx).await
                };
                if executed.discard {
                    // Mid-protocol, or Cancel on a pooler. The next run connects again.
                    // Dropped, not closed: see `discard_pooled`.
                    drop(guard.take());
                    let mut response = executed.response;
                    response.in_transaction = false;
                    return Ok(response);
                }
                let session = guard.as_mut().expect("session still open");
                let mut response = executed.response;
                response.in_transaction = in_transaction(&mut session.conn).await;
                if !response.errors.is_empty() && session.conn.ping().await.is_err() {
                    // The server went away; reconnect on the next run.
                    *guard = None;
                    response.in_transaction = false;
                }
                return Ok(response);
            }

            let mut conn = self.pool.acquire().await.map_err(|e| e.to_string())?;
            let pid = if self.transaction_pooler || opts.query_id.is_none() {
                None
            } else {
                Some(backend_pid(&mut conn).await?)
            };
            let stop = self.arm_cancel(state, opts, &cancelled, pid);
            let ctx = RunCtx {
                pool: &self.pool,
                pid,
                cancelled: &cancelled,
                stop: stop.as_deref(),
                transaction_pooler: self.transaction_pooler,
            };
            if opts.read_only {
                let executed = run_read_only(&mut conn, statements, opts, &ctx).await;
                if executed.discard {
                    discard_pooled(conn);
                }
                return Ok(executed.response);
            }
            let executed = run_statements(&mut conn, statements, opts, &ctx).await;
            if executed.discard {
                discard_pooled(conn);
                return Ok(executed.response);
            }
            let mut response = executed.response;
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

    /// Register whatever `db_cancel` needs for this run.
    ///
    /// A transaction pooler gets a `Notify` instead of a pid. The returned
    /// handle has to stay alive until the run finishes, or the permit is dropped
    /// with it.
    fn arm_cancel(
        &self,
        state: &DbState,
        opts: &RunOptions,
        cancelled: &Arc<AtomicBool>,
        pid: Option<i32>,
    ) -> Option<Arc<Notify>> {
        opts.query_id.as_ref()?;
        if self.transaction_pooler {
            let notify = Arc::new(Notify::new());
            state.register(
                &opts.query_id,
                Canceller::PostgresDetach {
                    notify: Arc::clone(&notify),
                    cancelled: Arc::clone(cancelled),
                },
            );
            Some(notify)
        } else if let Some(pid) = pid {
            state.register(
                &opts.query_id,
                Canceller::Postgres {
                    pool: self.pool.clone(),
                    pid,
                    cancelled: Arc::clone(cancelled),
                },
            );
            None
        } else {
            None
        }
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
    // Unnamed. A named statement is cached on whichever backend drew the
    // previous transaction, and the next one answers `already exists`.
    sqlx::query("SELECT pg_cancel_backend($1)")
        .persistent(false)
        .bind(pid)
        .execute(pool)
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Drop a pooled connection instead of returning it.
///
/// A ping on the way back into the pool would wait for the statement we
/// stopped reading. Dropping closes the socket at once. `close_hard` does not
/// over TLS: it sends close_notify and then waits to read, and the server
/// sends nothing until the statement we stopped waiting for has finished,
/// which made Cancel on Supabase's pooler take as long as the query.
fn discard_pooled(conn: sqlx::pool::PoolConnection<sqlx::Postgres>) {
    drop(conn.detach());
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

/// Simple-protocol results name an extension type "?". Blank until the catalog
/// lookup below replaces it. The oid is how that lookup finds the name.
fn column_type(col: &sqlx::postgres::PgColumn) -> (String, Option<u32>) {
    let info = col.type_info();
    if info.name() == "?" {
        (String::new(), info.oid().map(|oid| oid.0))
    } else {
        (info.name().to_string(), None)
    }
}

fn set_columns(result: &mut StatementResult, row: &PgRow) -> Vec<Option<u32>> {
    result.returns_rows = true;
    let mut oids = Vec::with_capacity(row.columns().len());
    for col in row.columns() {
        result.columns.push(col.name().to_string());
        let (name, oid) = column_type(col);
        result.column_types.push(name);
        oids.push(oid);
    }
    oids
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
        return value::float32_value(v);
    }
    if let Ok(v) = row.try_get::<bool, _>(i) {
        return Value::Bool(v);
    }
    // Everything else, date, timestamp, numeric, uuid, json, arrays, enums,
    // pgvector, in the server's own text rendering. The simple query
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

/// Whether a string might hold more than one statement.
///
/// Postgres needs a semicolon between two statements, so a string with none,
/// apart from a trailing one, holds a single statement. One with a semicolon
/// anywhere else, even inside a string literal or a comment, is checked by the
/// server instead.
fn may_hold_several(sql: &str) -> bool {
    sql.trim_end().trim_end_matches(';').contains(';')
}

fn stopped_waiting(statement: usize) -> RunError {
    RunError {
        statement,
        // Starts with "Cancelled." so the editor does not offer to "fix" it.
        message:
            "Cancelled. LiteDB stopped waiting, but the server may still finish this statement."
                .into(),
        code: None,
        cancelled: true,
        position: None,
    }
}

fn several_statements(statement: usize) -> RunError {
    RunError {
        statement,
        message: "A transaction pooler cannot check a string that may hold several statements. Send one statement per call.".into(),
        code: None,
        cancelled: false,
        position: None,
    }
}

/// A run that changes nothing: in a READ ONLY transaction, always rolled back.
///
/// Each string must be one statement. The simple query protocol runs several,
/// and a COMMIT among them would end the READ ONLY transaction with the rest
/// still to come. A string that might hold several is parsed as a prepared
/// statement first, which the server refuses for more than one, before
/// anything runs; the run itself stays on the simple protocol, which sends
/// values as the text the grid shows.
///
/// A transaction pooler cannot prepare at all (the statement is named), so a
/// string that might hold several is refused here instead of being sent.
///
/// A single statement cannot escape: a COMMIT ends a transaction that changed
/// nothing, and a SET is undone by the rollback.
fn run_read_only<'a>(
    conn: &'a mut PgConnection,
    statements: &'a [String],
    opts: &'a RunOptions,
    ctx: &'a RunCtx<'a>,
) -> BoxFuture<'a, Executed> {
    Box::pin(async move {
        for (index, sql) in statements.iter().enumerate() {
            // Most reads have no semicolon, and skip the round trip to the server.
            if !may_hold_several(sql) {
                continue;
            }
            if ctx.transaction_pooler {
                let mut response = RunResponse::default();
                response.errors.push(several_statements(index));
                return finished(response);
            }
            if let Err(e) = (&mut *conn).prepare(sql.as_str()).await {
                let mut response = RunResponse::default();
                response.errors.push(run_error(index, &e, ctx.cancelled));
                return finished(response);
            }
        }
        if let Err(e) = (&mut *conn).execute("BEGIN READ ONLY").await {
            let mut response = RunResponse::default();
            response.errors.push(run_error(0, &e, ctx.cancelled));
            return finished(response);
        }
        let inner = RunOptions {
            transaction: false,
            session: false,
            ..opts.clone()
        };
        let executed = run_statements(conn, statements, &inner, ctx).await;
        if executed.discard {
            // The connection is mid-protocol. ROLLBACK would wait on it.
            return executed;
        }
        // Always. There is nothing to commit, and the connection goes back to
        // the pool.
        let _ = (&mut *conn).execute("ROLLBACK").await;
        executed
    })
}

fn run_statements<'a>(
    conn: &'a mut PgConnection,
    statements: &'a [String],
    opts: &'a RunOptions,
    ctx: &'a RunCtx<'a>,
) -> BoxFuture<'a, Executed> {
    Box::pin(async move {
        let mut response = RunResponse::default();
        let stop_on_error = opts.transaction || !opts.continue_on_error;
        let max = opts.max_rows.unwrap_or(usize::MAX);
        let single = statements.len() == 1;
        let mut discard = false;
        // One future for the whole run. Recreating it per row drops a
        // notification that arrived while the previous one was polled.
        let mut stop_fut = ctx.stop.map(|notify| {
            Box::pin(async move {
                let mut notified = std::pin::pin!(notify.notified());
                let _ = notified.as_mut().enable();
                notified.await;
            })
        });

        if opts.transaction {
            if let Err(e) = (&mut *conn).execute("BEGIN").await {
                response.errors.push(run_error(0, &e, ctx.cancelled));
                return finished(response);
            }
        }

        for (index, sql) in statements.iter().enumerate() {
            if ctx.cancelled.load(Ordering::SeqCst) {
                response.errors.push(if ctx.transaction_pooler {
                    stopped_waiting(index)
                } else {
                    RunError {
                        statement: index,
                        message: "Cancelled.".into(),
                        code: None,
                        cancelled: true,
                        position: None,
                    }
                });
                discard = ctx.transaction_pooler;
                break;
            }

            let started = Instant::now();
            let results_before = response.results.len();
            let mut current = StatementResult::new(index);
            let mut current_oids: Vec<Option<u32>> = Vec::new();
            let mut pending: Vec<(usize, Vec<Option<u32>>)> = Vec::new();
            let mut stop_sent = false;
            let mut failure: Option<RunError> = None;
            {
                let mut stream = (&mut *conn).fetch_many(sql.as_str());
                loop {
                    let next = if let Some(stop_fut) = stop_fut.as_mut() {
                        tokio::select! {
                            biased;
                            _ = stop_fut.as_mut() => {
                                failure = Some(stopped_waiting(index));
                                discard = true;
                                break;
                            }
                            next = stream.try_next() => next,
                        }
                    } else {
                        stream.try_next().await
                    };
                    match next {
                        Ok(Some(Either::Right(row))) => {
                            if !current.returns_rows {
                                current_oids = set_columns(&mut current, &row);
                            }
                            if current.rows.len() >= max {
                                current.truncated = true;
                                // Without this the server keeps sending every row
                                // of a large table, only for it to be dropped here.
                                // No pid on a transaction pooler: the number would
                                // name some other client's backend. Rows past the
                                // limit are dropped here and the server finishes.
                                if opts.stop_at_limit && single && !stop_sent {
                                    if let Some(pid) = ctx.pid {
                                        stop_sent = true;
                                        let pool = ctx.pool.clone();
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
                            let oids = std::mem::take(&mut current_oids);
                            let idx = response.results.len();
                            response
                                .results
                                .push(std::mem::replace(&mut current, StatementResult::new(index)));
                            if oids.iter().any(Option::is_some) {
                                pending.push((idx, oids));
                            }
                        }
                        Ok(None) => break,
                        Err(e) => {
                            let own_stop = stop_sent
                                && e.as_database_error().and_then(|d| d.code()).as_deref()
                                    == Some("57014");
                            if !own_stop {
                                failure = Some(run_error(index, &e, ctx.cancelled));
                            }
                            break;
                        }
                    }
                }
            }

            if discard {
                // The stream was dropped mid-message. Nothing else may be sent
                // on this connection.
                if current.returns_rows {
                    current.elapsed_ms = started.elapsed().as_millis() as u64;
                    response.results.push(current);
                }
                if let Some(error) = failure {
                    response.errors.push(error);
                }
                break;
            }

            // Rows kept before our own stop, or before an error mid-stream.
            if current.returns_rows {
                current.elapsed_ms = started.elapsed().as_millis() as u64;
                let oids = std::mem::take(&mut current_oids);
                let idx = response.results.len();
                response.results.push(current);
                if failure.is_none() && oids.iter().any(Option::is_some) {
                    pending.push((idx, oids));
                }
            }

            // An empty result carries no row to read column names from.
            // Prepared rather than described: describe also asks the catalog
            // which columns can be null, two more round trips for nothing used.
            // `prepare` is a named statement, which a transaction pooler rejects,
            // so there the result simply has no column names.
            if !ctx.transaction_pooler
                && failure.is_none()
                && response.results.len() == results_before + 1
                && looks_like_query(sql)
            {
                let last = response.results.last_mut().expect("one result");
                if !last.returns_rows {
                    if let Ok(prepared) = (&mut *conn).prepare(sql.as_str()).await {
                        if !prepared.columns().is_empty() {
                            last.returns_rows = true;
                            last.rows_affected = 0;
                            let mut oids = Vec::new();
                            for col in prepared.columns() {
                                last.columns.push(col.name().to_string());
                                let (name, oid) = column_type(col);
                                last.column_types.push(name);
                                oids.push(oid);
                            }
                            if oids.iter().any(Option::is_some) {
                                pending.push((response.results.len() - 1, oids));
                            }
                        }
                    }
                }
            }

            // A failed statement may have aborted the transaction. The catalog
            // query would error, so unknown types stay blank. Only the editor
            // (its session) shows type names; the grid and the app's own
            // catalog reads would pay a round trip per page for nothing.
            if opts.session && failure.is_none() && !pending.is_empty() {
                fill_column_types(conn, &mut response.results, &pending).await;
            }

            if let Some(error) = failure {
                response.errors.push(error);
                if stop_on_error {
                    break;
                }
            }
        }

        if discard {
            if opts.transaction {
                response.rolled_back = true;
            }
            return Executed {
                response,
                discard: true,
            };
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
                response.errors.push(run_error(
                    statements.len().saturating_sub(1),
                    &e,
                    ctx.cancelled,
                ));
                if finish == "COMMIT" {
                    let _ = (&mut *conn).execute("ROLLBACK").await;
                    response.rolled_back = true;
                }
            }
        }

        finished(response)
    })
}

/// One catalog query for the columns whose type name arrived as "?".
///
/// Runs after the statement's rows are in hand, on the same connection. Simple
/// query protocol, so a transaction pooler never sees a named statement. Any
/// failure leaves the blank names and does not fail the run.
async fn fill_column_types(
    conn: &mut PgConnection,
    results: &mut [StatementResult],
    pending: &[(usize, Vec<Option<u32>>)],
) {
    let mut unique = Vec::new();
    for (_, oids) in pending {
        for oid in oids.iter().flatten().copied() {
            if !unique.contains(&oid) {
                unique.push(oid);
            }
        }
    }
    if unique.is_empty() {
        return;
    }
    let sql = type_lookup_sql(&unique);
    let Ok(rows) = (&mut *conn).fetch_all(sql.as_str()).await else {
        return;
    };
    let mut names = HashMap::new();
    for row in rows {
        let Some(oid_text) = text_cell(&row, 0) else {
            continue;
        };
        let Some(name) = text_cell(&row, 1) else {
            continue;
        };
        let Ok(oid) = oid_text.parse::<u32>() else {
            continue;
        };
        if !name.is_empty() {
            names.insert(oid, name);
        }
    }
    for (idx, oids) in pending {
        let Some(result) = results.get_mut(*idx) else {
            continue;
        };
        for (col, oid) in oids.iter().enumerate() {
            let Some(oid) = oid else { continue };
            let Some(name) = names.get(oid) else { continue };
            if let Some(slot) = result.column_types.get_mut(col) {
                *slot = name.clone();
            }
        }
    }
}

fn text_cell(row: &PgRow, index: usize) -> Option<String> {
    if let Ok(value) = row.try_get::<String, _>(index) {
        return Some(value);
    }
    row.try_get_raw(index)
        .ok()
        .filter(|raw| !raw.is_null())
        .and_then(|raw| raw.as_str().ok().map(|text| text.to_string()))
}

fn type_lookup_sql(oids: &[u32]) -> String {
    let mut sql = String::from(
        "SELECT oid::text, format_type(oid, NULL) FROM pg_catalog.pg_type WHERE oid IN (",
    );
    for (i, oid) in oids.iter().enumerate() {
        if i > 0 {
            sql.push(',');
        }
        sql.push_str(&oid.to_string());
    }
    sql.push(')');
    sql
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

    #[test]
    fn only_a_string_with_a_semicolon_is_checked_for_several_statements() {
        assert!(!may_hold_several("SELECT 1"));
        assert!(!may_hold_several("SELECT 1;"));
        assert!(!may_hold_several("  SELECT 1 ; \n"));
        assert!(may_hold_several("SELECT 1; DELETE FROM t"));
        assert!(may_hold_several("COMMIT; DELETE FROM t"));
        // A semicolon in a literal costs a check, never a miss.
        assert!(may_hold_several("SELECT ';'"));
    }

    #[test]
    fn transaction_poolers_are_recognized_from_the_configured_host() {
        assert!(is_transaction_pooler(
            "aws-0-eu-central-1.pooler.supabase.com",
            6543
        ));
        assert!(!is_transaction_pooler(
            "aws-0-eu-central-1.pooler.supabase.com",
            5432
        ));
        assert!(is_transaction_pooler(
            "db.abcdefghijklmnopqrst.supabase.co",
            6543
        ));
        assert!(!is_transaction_pooler(
            "db.abcdefghijklmnopqrst.supabase.co",
            5432
        ));
        assert!(is_transaction_pooler(
            "ep-cool-darkness-pooler.us-east-2.aws.neon.tech",
            5432
        ));
        assert!(!is_transaction_pooler(
            "ep-cool-darkness.us-east-2.aws.neon.tech",
            5432
        ));
        assert!(is_transaction_pooler("EP-ABC-POOLER.neon.tech.", 5432));
        assert!(!is_transaction_pooler("ep-name.pooler.neon.tech", 5432));
        assert!(is_transaction_pooler("127.0.0.1", 6543));
        assert!(is_transaction_pooler("localhost", 6543));
        assert!(!is_transaction_pooler("127.0.0.1", 5432));
        assert!(!is_transaction_pooler("db.supabase.co", 5432));
    }

    #[test]
    fn pooler_hosts_keep_a_small_pool_even_in_session_mode() {
        let small = Some(Duration::from_secs(60));
        assert_eq!(
            pool_settings("aws-0-us-east-1.pooler.supabase.com", 5432),
            (3, small)
        );
        assert_eq!(
            pool_settings("aws-0-us-east-1.pooler.supabase.com", 6543),
            (3, small)
        );
        assert_eq!(pool_settings("db.abc.supabase.co", 6543), (3, small));
        assert_eq!(pool_settings("db.abc.supabase.co", 5432), (8, None));
        assert_eq!(
            pool_settings("ep-x-pooler.c-3.us-east-1.aws.neon.tech", 5432),
            (3, small)
        );
        assert_eq!(
            pool_settings("ep-x.c-3.us-east-1.aws.neon.tech", 5432),
            (8, None)
        );
        // Port 6543 is transaction mode, but only the named pooler hosts shrink the pool.
        assert_eq!(pool_settings("127.0.0.1", 6543), (8, None));
        assert_eq!(pool_settings("localhost", 5432), (8, None));
    }

    fn direct_ctx<'a>(pool: &'a PgPool, cancelled: &'a AtomicBool) -> RunCtx<'a> {
        RunCtx {
            pool,
            pid: None,
            cancelled,
            stop: None,
            transaction_pooler: false,
        }
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
        let cancelled = AtomicBool::new(false);
        let ctx = direct_ctx(&pool, &cancelled);
        let r = run_statements(
            &mut conn,
            &[
                "SELECT label, amount, happened_on, at, flag, payload, absent FROM row_json_probe"
                    .into(),
            ],
            &RunOptions::default(),
            &ctx,
        )
        .await
        .response;
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
            &["SELECT label, amount FROM row_json_probe WHERE false".into()],
            &RunOptions::default(),
            &ctx,
        )
        .await
        .response;
        assert_eq!(empty.results[0].columns, vec!["label", "amount"]);

        // A failed statement in a transaction rolls the run back.
        let tx = run_statements(
            &mut conn,
            &[
                "UPDATE row_json_probe SET label = 'changed'".into(),
                "SELECT nope FROM row_json_probe".into(),
            ],
            &RunOptions {
                transaction: true,
                ..Default::default()
            },
            &ctx,
        )
        .await
        .response;
        assert!(tx.rolled_back);
        assert!(
            tx.errors[0].position.is_some(),
            "error position is reported"
        );
        let label: String = sqlx::query_scalar("SELECT label FROM row_json_probe")
            .persistent(false)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(label, "hello");

        // max_rows keeps the first rows and flags the rest.
        let many = run_statements(
            &mut conn,
            &["SELECT generate_series(1, 5000)".into()],
            &RunOptions {
                max_rows: Some(10),
                ..Default::default()
            },
            &ctx,
        )
        .await
        .response;
        assert_eq!(many.results[0].rows.len(), 10);
        assert!(many.results[0].truncated);

        // A read-only run reads, and refuses writes however they are dressed.
        let read_only = RunOptions {
            read_only: true,
            ..Default::default()
        };
        let read = run_read_only(
            &mut conn,
            &["SELECT label FROM row_json_probe".into()],
            &read_only,
            &ctx,
        )
        .await
        .response;
        assert!(read.errors.is_empty(), "{:?}", read.errors);
        assert_eq!(read.results[0].rows[0][0], json!("hello"));
        for sql in [
            "DELETE FROM row_json_probe",
            "COMMIT; DELETE FROM row_json_probe",
            "SELECT 1; DELETE FROM row_json_probe",
        ] {
            let refused = run_read_only(&mut conn, &[sql.into()], &read_only, &ctx)
                .await
                .response;
            assert_eq!(refused.errors.len(), 1, "{sql} was not refused");
        }
        let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM row_json_probe")
            .persistent(false)
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
        let over = run_statements(&mut conn, &statements, &limited(1), &ctx)
            .await
            .response;
        assert!(over.rolled_back);
        assert_eq!(over.errors[0].code.as_deref(), Some("TooManyChanges"));
        let within = run_statements(&mut conn, &statements, &limited(2), &ctx)
            .await
            .response;
        assert!(within.errors.is_empty(), "{:?}", within.errors);
        let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM row_json_probe")
            .persistent(false)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(rows, 3);

        // float4 must not widen into the f32 binary expansion.
        let real = run_statements(
            &mut conn,
            &["SELECT 0.1::real".into()],
            &RunOptions::default(),
            &ctx,
        )
        .await
        .response;
        assert!(real.errors.is_empty(), "{:?}", real.errors);
        assert_eq!(real.results[0].rows[0][0], json!(0.1));

        // An enum's type name is "?" on the simple protocol until the catalog lookup.
        pool.execute(
            "DROP TYPE IF EXISTS pooler_direct_mood;
             CREATE TYPE pooler_direct_mood AS ENUM ('ok', 'no');",
        )
        .await
        .unwrap();
        // Outside the editor the name is left blank, never "?", and no lookup runs.
        let plain = run_statements(
            &mut conn,
            &["SELECT 'ok'::pooler_direct_mood".into()],
            &RunOptions::default(),
            &ctx,
        )
        .await
        .response;
        assert!(plain.errors.is_empty(), "{:?}", plain.errors);
        assert_eq!(plain.results[0].column_types, vec![String::new()]);
        let mood = run_statements(
            &mut conn,
            &["SELECT 'ok'::pooler_direct_mood".into()],
            &RunOptions {
                session: true,
                ..Default::default()
            },
            &ctx,
        )
        .await
        .response;
        assert!(mood.errors.is_empty(), "{:?}", mood.errors);
        assert!(
            mood.results[0].column_types[0].contains("pooler_direct_mood"),
            "{:?}",
            mood.results[0].column_types
        );

        drop(conn);
        pool.execute("DROP TABLE row_json_probe").await.unwrap();
        pool.execute("DROP TYPE pooler_direct_mood").await.unwrap();
    }

    /// Skipped unless EVAL_POOLER_URL points at a transaction-mode pooler.
    ///
    /// Proves the three things that break on Supabase port 6543: opening still
    /// reports the server version, a row-limit stop does not cancel another
    /// client's statement, and Cancel returns without signalling any backend.
    #[tokio::test]
    async fn transaction_pooler_does_not_cancel_another_client() {
        let Ok(url) = std::env::var("EVAL_POOLER_URL") else {
            eprintln!("skipping: EVAL_POOLER_URL not set");
            return;
        };
        crate::install_crypto_provider();
        let config = config_from_url(&url);
        let known_hosts = std::env::temp_dir().join("litedb-pooler-known-hosts");
        let (conn, info) = PgConn::open(config, known_hosts).await.unwrap();
        assert!(
            info.server_version
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_digit()),
            "open did not report a server version: {info:?}"
        );
        assert!(
            info.notices
                .iter()
                .any(|n| n.contains("transaction pooler")),
            "{:?}",
            info.notices
        );

        let state = DbState::default();
        let setup = conn
            .run(
                &state,
                &[
                    "DROP TYPE IF EXISTS pooler_mood".into(),
                    "CREATE TYPE pooler_mood AS ENUM ('ok', 'no')".into(),
                ],
                &RunOptions::default(),
                Arc::new(AtomicBool::new(false)),
            )
            .await
            .unwrap();
        assert!(setup.errors.is_empty(), "{:?}", setup.errors);

        let typed = conn
            .run(
                &state,
                &["SELECT 'ok'::pooler_mood AS mood, 0.1::real AS amount".into()],
                &RunOptions {
                    session: true,
                    ..Default::default()
                },
                Arc::new(AtomicBool::new(false)),
            )
            .await
            .unwrap();
        assert!(typed.errors.is_empty(), "{:?}", typed.errors);
        assert!(
            typed.results[0].column_types[0].contains("pooler_mood"),
            "{:?}",
            typed.results[0].column_types
        );
        assert_eq!(typed.results[0].rows[0][1], json!(0.1));

        let empty = conn
            .run(
                &state,
                &["SELECT 1 AS n WHERE false".into()],
                &RunOptions::default(),
                Arc::new(AtomicBool::new(false)),
            )
            .await
            .unwrap();
        assert!(empty.errors.is_empty(), "{:?}", empty.errors);
        assert!(
            empty.results[0].columns.is_empty(),
            "a pooler cannot prepare, so an empty result has no column names: {empty:?}"
        );

        let refused = conn
            .run(
                &state,
                &["SELECT 1; SELECT 2".into()],
                &RunOptions {
                    read_only: true,
                    ..Default::default()
                },
                Arc::new(AtomicBool::new(false)),
            )
            .await
            .unwrap();
        assert_eq!(refused.errors.len(), 1, "{:?}", refused.errors);
        assert!(
            refused.errors[0].message.contains("one statement"),
            "{:?}",
            refused.errors[0].message
        );

        // The editor session's early stop must not land on the other client.
        // rows_affected is the server's completion count: a pid cancel ends
        // the stream before CommandComplete and leaves it at 0.
        let rows = 3_000_000u64;
        let victim = tokio::spawn({
            let url = url.clone();
            async move { sleep_on(&url, 3).await }
        });
        tokio::time::sleep(Duration::from_millis(300)).await;
        let limited = conn
            .run(
                &state,
                &[format!("SELECT generate_series(1, {rows})")],
                &RunOptions {
                    session: true,
                    max_rows: Some(10),
                    stop_at_limit: true,
                    query_id: Some("pooler-limit".into()),
                    ..Default::default()
                },
                Arc::new(AtomicBool::new(false)),
            )
            .await
            .unwrap();
        assert!(limited.errors.is_empty(), "{:?}", limited.errors);
        assert_eq!(limited.results[0].rows.len(), 10);
        assert!(limited.results[0].truncated);
        assert_eq!(
            limited.results[0].rows_affected, rows,
            "the select must run to completion; cancelling it leaves no row count"
        );
        let (slept, sleep_error) = victim.await.unwrap();
        assert!(
            sleep_error.is_none(),
            "row-limit stop cancelled another client: {sleep_error:?}"
        );
        assert!(
            slept >= Duration::from_secs(2),
            "the other client's sleep returned early: {slept:?}"
        );

        // Cancel on a pooled run returns without signalling any backend.
        let victim = tokio::spawn({
            let url = url.clone();
            async move { sleep_on(&url, 3).await }
        });
        tokio::time::sleep(Duration::from_millis(200)).await;
        let query_id = "pooler-cancel";
        let statements = vec!["SELECT pg_sleep(30)".to_string()];
        let opts = RunOptions {
            query_id: Some(query_id.to_string()),
            ..Default::default()
        };
        let run = conn.run(&state, &statements, &opts, Arc::new(AtomicBool::new(false)));
        tokio::pin!(run);
        let deadline = tokio::time::sleep(Duration::from_secs(5));
        tokio::pin!(deadline);
        loop {
            if state.is_running(query_id) {
                break;
            }
            tokio::select! {
                biased;
                result = &mut run => panic!("run ended before it could be cancelled: {result:?}"),
                _ = &mut deadline => panic!("canceller was not registered"),
                _ = tokio::time::sleep(Duration::from_millis(10)) => {}
            }
        }
        // Keep polling so the statement is actually sent, then let it sit on the server.
        let settle = tokio::time::sleep(Duration::from_millis(300));
        tokio::pin!(settle);
        tokio::select! {
            biased;
            result = &mut run => panic!("pg_sleep ended before cancel: {result:?}"),
            _ = &mut settle => {}
        }
        let started = Instant::now();
        assert!(state.cancel(query_id).await.unwrap());
        let response = run.await.unwrap();
        let waited = started.elapsed();
        assert!(
            waited < Duration::from_secs(2),
            "cancel did not return promptly: {waited:?}"
        );
        assert_eq!(response.errors.len(), 1, "{:?}", response.errors);
        assert!(response.errors[0].cancelled);
        assert!(
            response.errors[0].message.contains("stopped waiting"),
            "{:?}",
            response.errors[0].message
        );
        let (slept, sleep_error) = victim.await.unwrap();
        assert!(
            sleep_error.is_none(),
            "cancel cancelled another client: {sleep_error:?}"
        );
        assert!(
            slept >= Duration::from_secs(2),
            "the other client's sleep returned early: {slept:?}"
        );

        let _ = conn
            .run(
                &state,
                &["DROP TYPE IF EXISTS pooler_mood".into()],
                &RunOptions::default(),
                Arc::new(AtomicBool::new(false)),
            )
            .await;
        conn.close().await;
    }

    fn config_from_url(raw: &str) -> PgConnectConfig {
        let parsed = url::Url::parse(raw).expect("postgres url");
        PgConnectConfig {
            host: parsed.host_str().unwrap_or("localhost").to_string(),
            port: parsed.port().unwrap_or(5432),
            database: parsed.path().trim_start_matches('/').to_string(),
            username: parsed.username().to_string(),
            password: parsed.password().unwrap_or("").to_string(),
            ssl: Some(false),
            // `?sslmode=require` runs this against a TLS pooler (Supabase's is one).
            ssl_mode: Some(
                parsed
                    .query_pairs()
                    .find(|(key, _)| key == "sslmode")
                    .map(|(_, value)| value.into_owned())
                    .unwrap_or_else(|| "disable".into()),
            ),
            ssl_root_cert: None,
            ssh: None,
        }
    }

    async fn sleep_on(url: &str, seconds: u64) -> (Duration, Option<String>) {
        let started = Instant::now();
        let mut conn = match PgConnection::connect(url).await {
            Ok(conn) => conn,
            Err(e) => return (started.elapsed(), Some(e.to_string())),
        };
        // Simple query. A named prepared statement is what the pooler rejects.
        let error = (&mut conn)
            .execute(format!("SELECT pg_sleep({seconds})").as_str())
            .await
            .err()
            .map(|e| e.to_string());
        (started.elapsed(), error)
    }
}

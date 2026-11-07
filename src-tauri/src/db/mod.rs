//! Database connections held by the app, addressed by id.
//!
//! SQLite runs natively through rusqlite, on the file in place. It used to be
//! loaded whole into the webview through sql.js and saved by rewriting the
//! file, which capped database size at what fits in memory twice and made
//! sharing the file with an agent a matter of careful locking.
//!
//! Postgres keeps a small pool for the grid and metadata, plus one dedicated
//! session per connection for the SQL editor, so a `BEGIN` typed in the editor
//! stays on the connection that will see the `COMMIT`.

pub mod postgres;
pub mod sqlite;
pub mod ssh;
pub mod value;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};
use tokio::sync::RwLock;

/// How a run behaves. Every field defaults, so metadata queries send nothing.
#[derive(Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct RunOptions {
    /// Rows kept per result set. The rest are counted as truncated, not held.
    pub max_rows: Option<usize>,
    /// Lets `db_cancel` find this run.
    pub query_id: Option<String>,
    /// Wrap every statement in one transaction, rolled back on the first error.
    pub transaction: bool,
    /// Keep going after a failed statement. Ignored inside a transaction.
    pub continue_on_error: bool,
    /// Ask the server to stop producing rows once `max_rows` is reached.
    /// Only honoured for a single statement, where nothing else can be hit.
    pub stop_at_limit: bool,
    /// Send blobs whole rather than as a size (exports).
    pub full_blobs: bool,
    /// Postgres: run on the editor's own session instead of the pool.
    pub session: bool,
}

#[derive(Serialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StatementResult {
    /// Index into the statements the request carried.
    pub statement: usize,
    pub columns: Vec<String>,
    pub column_types: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    /// Whether the statement produces a result set, even an empty one.
    pub returns_rows: bool,
    /// Rows changed, as the engine reports them.
    pub rows_affected: u64,
    /// More rows existed than `max_rows`.
    pub truncated: bool,
    pub elapsed_ms: u64,
}

impl StatementResult {
    pub fn new(statement: usize) -> Self {
        Self {
            statement,
            ..Default::default()
        }
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RunError {
    pub statement: usize,
    pub message: String,
    /// SQLSTATE for Postgres, the extended result code name for SQLite.
    pub code: Option<String>,
    pub cancelled: bool,
    /// 1-based character offset of the error in the statement, when known.
    pub position: Option<usize>,
}

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RunResponse {
    pub results: Vec<StatementResult>,
    pub errors: Vec<RunError>,
    /// The run's own transaction was rolled back after an error.
    pub rolled_back: bool,
    /// A transaction the user opened is still open on this connection.
    pub in_transaction: bool,
    pub elapsed_ms: u64,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct OpenInfo {
    pub id: String,
    pub engine: String,
    pub server_version: String,
    /// Opened read-only because the file or role refuses writes.
    pub read_only: bool,
    /// Where an agent should connect: the tunnel's local end when there is one.
    pub agent_host: Option<String>,
    pub agent_port: Option<u16>,
    /// Things the user should know about how the connection was made.
    pub notices: Vec<String>,
}

pub enum Connection {
    Sqlite(sqlite::SqliteConn),
    Postgres(Box<postgres::PgConn>),
}

/// What `db_cancel` needs to stop a run.
pub enum Canceller {
    Sqlite {
        interrupt: Arc<rusqlite::InterruptHandle>,
        cancelled: Arc<AtomicBool>,
    },
    Postgres {
        pool: sqlx::PgPool,
        pid: i32,
        cancelled: Arc<AtomicBool>,
    },
}

#[derive(Default)]
pub struct DbState {
    connections: RwLock<HashMap<String, Arc<Connection>>>,
    running: std::sync::Mutex<HashMap<String, Canceller>>,
}

impl DbState {
    async fn get(&self, id: &str) -> Result<Arc<Connection>, String> {
        self.connections
            .read()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| "That connection is closed. Open it again.".to_string())
    }

    async fn insert(&self, id: String, conn: Connection) {
        let previous = self.connections.write().await.insert(id, Arc::new(conn));
        if let Some(previous) = previous {
            close_connection(previous).await;
        }
    }

    pub fn register(&self, query_id: &Option<String>, canceller: Canceller) {
        if let Some(id) = query_id {
            if let Ok(mut running) = self.running.lock() {
                running.insert(id.clone(), canceller);
            }
        }
    }

    pub fn unregister(&self, query_id: &Option<String>) {
        if let Some(id) = query_id {
            if let Ok(mut running) = self.running.lock() {
                running.remove(id);
            }
        }
    }
}

async fn close_connection(conn: Arc<Connection>) {
    if let Connection::Postgres(pg) = conn.as_ref() {
        pg.close().await;
    }
    // SQLite closes when the last Arc drops; a query still running holds one.
}

// --- SQLite file access -----------------------------------------------------

const ALLOWLIST_FILE: &str = "sqlite-files.json";
const ALLOWLIST_MAX: usize = 200;

fn allowlist_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_local_data_dir()
        .ok()
        .map(|dir| dir.join(ALLOWLIST_FILE))
}

fn normalized(path: &Path) -> String {
    std::fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string()
}

fn read_allowlist(app: &AppHandle) -> Vec<String> {
    allowlist_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
}

fn remember_file(app: &AppHandle, path: &Path) {
    let Some(file) = allowlist_path(app) else {
        return;
    };
    let key = normalized(path);
    let mut list = read_allowlist(app);
    list.retain(|p| p != &key);
    list.insert(0, key);
    list.truncate(ALLOWLIST_MAX);
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string(&list) {
        let _ = std::fs::write(file, json);
    }
}

/// Only files the user picked (dialog, drop) are reachable, as plugin-fs
/// enforces for the webview. A file picked once stays reachable after a
/// restart through a remembered list, so saved connections can reopen it
/// without widening access to anything the user never chose.
fn check_sqlite_path(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    use tauri_plugin_fs::FsExt;
    let path = PathBuf::from(path);
    if app.fs_scope().is_allowed(&path) {
        remember_file(app, &path);
        return Ok(path);
    }
    let key = normalized(&path);
    if read_allowlist(app).iter().any(|p| p == &key) {
        return Ok(path);
    }
    Err("LiteDB does not have access to that file. Open it again from the file picker.".into())
}

// --- Commands ---------------------------------------------------------------

#[tauri::command]
pub async fn db_open_sqlite(
    app: AppHandle,
    state: State<'_, DbState>,
    id: String,
    path: String,
    create: Option<bool>,
) -> Result<OpenInfo, String> {
    let path = check_sqlite_path(&app, &path)?;
    let create = create.unwrap_or(false);
    let (conn, info) =
        tauri::async_runtime::spawn_blocking(move || sqlite::SqliteConn::open(&path, create))
            .await
            .map_err(|e| e.to_string())??;
    let info = OpenInfo {
        id: id.clone(),
        ..info
    };
    state.insert(id, Connection::Sqlite(conn)).await;
    Ok(info)
}

#[tauri::command]
pub async fn db_open_postgres(
    app: AppHandle,
    state: State<'_, DbState>,
    id: String,
    config: postgres::PgConnectConfig,
) -> Result<OpenInfo, String> {
    let known_hosts = app
        .path()
        .app_local_data_dir()
        .map(|d| d.join("known_hosts"))
        .map_err(|e| e.to_string())?;
    let (conn, info) = postgres::PgConn::open(config, known_hosts).await?;
    let info = OpenInfo {
        id: id.clone(),
        ..info
    };
    state.insert(id, Connection::Postgres(Box::new(conn))).await;
    Ok(info)
}

#[tauri::command]
pub async fn db_close(state: State<'_, DbState>, id: String) -> Result<(), String> {
    let removed = state.connections.write().await.remove(&id);
    if let Some(conn) = removed {
        close_connection(conn).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn db_run(
    state: State<'_, DbState>,
    id: String,
    statements: Vec<String>,
    options: Option<RunOptions>,
) -> Result<RunResponse, String> {
    let options = options.unwrap_or_default();
    let conn = state.get(&id).await?;
    let started = std::time::Instant::now();
    let cancelled = Arc::new(AtomicBool::new(false));

    let mut response = match conn.as_ref() {
        Connection::Sqlite(sqlite) => {
            state.register(
                &options.query_id,
                Canceller::Sqlite {
                    interrupt: sqlite.interrupt.clone(),
                    cancelled: cancelled.clone(),
                },
            );
            let handle = sqlite.conn.clone();
            let opts = options.clone();
            let flag = cancelled.clone();
            let outcome = tauri::async_runtime::spawn_blocking(move || {
                let guard = handle
                    .lock()
                    .map_err(|_| "SQLite connection poisoned".to_string())?;
                Ok::<_, String>(sqlite::run(&guard, &statements, &opts, &flag))
            })
            .await
            .map_err(|e| e.to_string());
            state.unregister(&options.query_id);
            outcome??
        }
        Connection::Postgres(pg) => {
            let outcome = pg
                .run(&state, &statements, &options, cancelled.clone())
                .await;
            state.unregister(&options.query_id);
            outcome?
        }
    };
    response.elapsed_ms = started.elapsed().as_millis() as u64;
    Ok(response)
}

/// Stop a run. True when something was running under that id.
#[tauri::command]
pub async fn db_cancel(state: State<'_, DbState>, query_id: String) -> Result<bool, String> {
    let canceller = state
        .running
        .lock()
        .map_err(|_| "cancel registry poisoned".to_string())?
        .remove(&query_id);
    match canceller {
        None => Ok(false),
        Some(Canceller::Sqlite {
            interrupt,
            cancelled,
        }) => {
            cancelled.store(true, Ordering::SeqCst);
            interrupt.interrupt();
            Ok(true)
        }
        Some(Canceller::Postgres {
            pool,
            pid,
            cancelled,
        }) => {
            cancelled.store(true, Ordering::SeqCst);
            postgres::cancel_backend(&pool, pid).await?;
            Ok(true)
        }
    }
}

/// SQLite's `data_version`: changes when another connection writes the file.
/// None for Postgres, and while a query holds the connection.
#[tauri::command]
pub async fn db_data_version(state: State<'_, DbState>, id: String) -> Result<Option<i64>, String> {
    let conn = state.get(&id).await?;
    match conn.as_ref() {
        Connection::Sqlite(sqlite) => Ok(sqlite.data_version()),
        Connection::Postgres(_) => Ok(None),
    }
}

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use futures_util::TryStreamExt;
use keyring::Entry;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sqlx::postgres::{PgPool, PgPoolOptions, PgRow};
use sqlx::{Column, Either, Row, ValueRef};
use std::collections::HashMap;
use tauri::State;
use tokio::sync::Mutex;

struct PostgresState {
    pool: Mutex<Option<PgPool>>,
}

#[derive(Serialize, Deserialize)]
struct PgConfig {
    host: String,
    port: u16,
    database: String,
    username: String,
    password: String,
    ssl: Option<bool>,
}

#[derive(Serialize)]
struct QueryResult {
    success: bool,
    columns: Vec<String>,
    rows: Vec<Value>,
    /// Rows returned by the statement. Zero for an UPDATE or DELETE.
    row_count: u64,
    /// Rows the statement changed, as reported by the server.
    ///
    /// Distinct from `row_count`, and the only honest answer to "did my write
    /// do anything?". An UPDATE whose WHERE matches nothing succeeds and
    /// returns no rows, which is indistinguishable from one that changed
    /// thousands unless the server is asked.
    rows_affected: u64,
    error: Option<String>,
}

#[tauri::command]
async fn connect_postgres(
    state: State<'_, PostgresState>,
    config: PgConfig,
) -> Result<QueryResult, String> {
    let mut pool_guard = state.pool.lock().await;

    if let Some(pool) = pool_guard.take() {
        pool.close().await;
    }

    let url = format!(
        "postgres://{}:{}@{}:{}/{}",
        config.username, config.password, config.host, config.port, config.database
    );

    let pool = PgPoolOptions::new()
        .max_connections(20)
        .connect(&url)
        .await
        .map_err(|e| e.to_string())?;

    *pool_guard = Some(pool);

    Ok(QueryResult {
        success: true,
        columns: vec![],
        rows: vec![],
        row_count: 0,
        rows_affected: 0,
        error: None,
    })
}

#[tauri::command]
async fn execute_postgres_query(
    state: State<'_, PostgresState>,
    query: String,
) -> Result<QueryResult, String> {
    let pool = {
        let pool_guard = state.pool.lock().await;
        pool_guard
            .as_ref()
            .ok_or("No PostgreSQL connection")?
            .clone()
    };

    // Streaming the results rather than fetch_all: this yields the server's
    // own rows_affected alongside any returned rows, from a single execution.
    // The alternative — choosing between execute() and fetch_all() by
    // inspecting the statement — would mean re-deriving in Rust what the
    // classifier already knows, and getting it wrong for anything unusual.
    //
    // raw_sql rather than query: these are complete statements with no bind
    // parameters, which is exactly what raw_sql is for. It is also what
    // sqlx 0.7.4 points to now that query().fetch_many() is deprecated.
    let mut rows: Vec<PgRow> = Vec::new();
    let mut rows_affected: u64 = 0;
    {
        let mut stream = sqlx::raw_sql(&query).fetch_many(&pool);
        while let Some(item) = stream.try_next().await.map_err(|e| e.to_string())? {
            match item {
                Either::Left(result) => rows_affected += result.rows_affected(),
                Either::Right(row) => rows.push(row),
            }
        }
    }

    let mut columns = Vec::new();
    let mut json_rows = Vec::new();

    if !rows.is_empty() {
        columns = rows[0]
            .columns()
            .iter()
            .map(|c| c.name().to_string())
            .collect();

        for row in rows {
            json_rows.push(Value::Object(pg_row_to_json(&row)));
        }
    }

    let row_count = json_rows.len() as u64;
    Ok(QueryResult {
        success: true,
        columns,
        rows: json_rows,
        row_count,
        rows_affected,
        error: None,
    })
}

/// Convert one Postgres row to JSON for the frontend.
///
/// Extracted from the command so it can be tested against a real server —
/// which is the only way to know whether a `numeric` or `date` column comes
/// back as a value or as null. See the tests at the bottom of this file.
fn pg_row_to_json(row: &PgRow) -> Map<String, Value> {
    let mut json_row = Map::new();
    for (i, col) in row.columns().iter().enumerate() {
        let col_name = col.name();

        // Try to get as various types
        if let Ok(v) = row.try_get::<String, _>(i) {
            json_row.insert(col_name.to_string(), Value::String(v));
        } else if let Ok(v) = row.try_get::<i64, _>(i) {
            json_row.insert(col_name.to_string(), Value::Number(v.into()));
        } else if let Ok(v) = row.try_get::<i32, _>(i) {
            json_row.insert(col_name.to_string(), Value::Number(v.into()));
        } else if let Ok(v) = row.try_get::<i16, _>(i) {
            json_row.insert(col_name.to_string(), Value::Number(v.into()));
        } else if let Ok(v) = row.try_get::<f64, _>(i) {
            if let Some(n) = serde_json::Number::from_f64(v) {
                json_row.insert(col_name.to_string(), Value::Number(n));
            } else {
                json_row.insert(col_name.to_string(), Value::Null);
            }
        } else if let Ok(v) = row.try_get::<f32, _>(i) {
            if let Some(n) = serde_json::Number::from_f64(v as f64) {
                json_row.insert(col_name.to_string(), Value::Number(n));
            } else {
                json_row.insert(col_name.to_string(), Value::Null);
            }
        } else if let Ok(v) = row.try_get::<bool, _>(i) {
            json_row.insert(col_name.to_string(), Value::Bool(v));
        } else {
            // Everything the typed paths above do not recognise —
            // date, timestamp, numeric, uuid, json, arrays, enums —
            // used to land here as Null. A `numeric` column therefore
            // displayed as NULL whatever it held, which makes a
            // successful write look like it did nothing.
            //
            // The simple query protocol returns every value in text
            // form, so the raw bytes are the server's own rendering of
            // the value. Showing that beats inventing a null, and for
            // numeric it is exact where f64 would not be.
            let text = row
                .try_get_raw(i)
                .ok()
                .filter(|raw| !raw.is_null())
                .and_then(|raw| raw.as_str().ok().map(|s| s.to_string()));

            json_row.insert(
                col_name.to_string(),
                match text {
                    Some(s) => Value::String(s),
                    None => Value::Null,
                },
            );
        }
    }
    json_row
}

#[tauri::command]
async fn disconnect_postgres(state: State<'_, PostgresState>) -> Result<QueryResult, String> {
    let mut pool_guard = state.pool.lock().await;
    if let Some(pool) = pool_guard.take() {
        pool.close().await;
    }
    Ok(QueryResult {
        success: true,
        columns: vec![],
        rows: vec![],
        row_count: 0,
        rows_affected: 0,
        error: None,
    })
}

#[derive(Serialize)]
struct ProxyResponse {
    status: u16,
    #[serde(rename = "statusText")]
    status_text: String,
    headers: HashMap<String, String>,
    body: String,
}

// Hosts that proxy_request is allowed to reach. Keeps the proxy from being a
// general-purpose SSRF tool. Localhost is for Ollama; the rest are the AI
// providers advertised in the README.
fn is_proxy_host_allowed(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    matches!(
        host.as_str(),
        "localhost" | "127.0.0.1" | "::1" | "models.github.ai" | "api.openai.com"
    ) || host.ends_with(".openai.azure.com")
}

#[tauri::command]
async fn proxy_request(
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
) -> Result<ProxyResponse, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|e| format!("invalid url: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        s => return Err(format!("scheme not allowed: {s}")),
    }
    let host = parsed.host_str().ok_or("url has no host")?;
    if !is_proxy_host_allowed(host) {
        return Err(format!("host not allowed: {host}"));
    }

    let client = reqwest::Client::new();

    let mut header_map = HeaderMap::new();
    for (key, value) in headers {
        if let (Ok(k), Ok(v)) = (
            HeaderName::from_bytes(key.as_bytes()),
            HeaderValue::from_str(&value),
        ) {
            header_map.insert(k, v);
        }
    }

    let mut request_builder = client
        .request(method.parse().unwrap_or(reqwest::Method::GET), parsed)
        .headers(header_map);

    if let Some(b) = body {
        request_builder = request_builder.body(b);
    }

    let response = request_builder.send().await.map_err(|e| e.to_string())?;

    let status = response.status().as_u16();
    let status_text = response
        .status()
        .canonical_reason()
        .unwrap_or("")
        .to_string();

    let mut response_headers = HashMap::new();
    for (key, value) in response.headers() {
        if let Ok(v) = value.to_str() {
            response_headers.insert(key.to_string(), v.to_string());
        }
    }

    let body_text = response.text().await.map_err(|e| e.to_string())?;

    Ok(ProxyResponse {
        status,
        status_text,
        headers: response_headers,
        body: body_text,
    })
}

#[tauri::command]
fn store_secret(service: String, account: String, secret: String) -> Result<(), String> {
    let entry = Entry::new(&service, &account).map_err(|e| e.to_string())?;
    entry.set_password(&secret).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_secret(service: String, account: String) -> Result<Option<String>, String> {
    let entry = Entry::new(&service, &account).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn delete_secret(service: String, account: String) -> Result<(), String> {
    let entry = Entry::new(&service, &account).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(PostgresState {
            pool: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            connect_postgres,
            execute_postgres_query,
            disconnect_postgres,
            proxy_request,
            store_secret,
            get_secret,
            delete_secret
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Executor;

    /// Skipped unless EVAL_POSTGRES_URL points at a throwaway database.
    ///
    /// This is the only way to answer the question that matters here: whether
    /// a `numeric` or `date` column reaches the frontend as its value or as
    /// null. Both used to come back null — the type chain handled neither —
    /// so a numeric column displayed as NULL whatever it held, and a
    /// successful write looked like it had done nothing.
    #[tokio::test]
    async fn non_primitive_columns_are_not_reported_as_null() {
        let Ok(url) = std::env::var("EVAL_POSTGRES_URL") else {
            eprintln!("skipping: EVAL_POSTGRES_URL not set");
            return;
        };

        let pool = PgPoolOptions::new().connect(&url).await.unwrap();
        pool.execute(
            "DROP TABLE IF EXISTS row_json_probe;
             CREATE TABLE row_json_probe (
                 id          serial PRIMARY KEY,
                 label       text,
                 amount      numeric(10,2),
                 happened_on date,
                 at          timestamptz,
                 flag        boolean,
                 payload     jsonb,
                 absent      text
             );
             INSERT INTO row_json_probe (label, amount, happened_on, at, flag, payload, absent)
             VALUES ('hello', 200.00, '2026-09-01', '2026-09-01T10:30:00Z', true,
                     '{\"a\":1}'::jsonb, NULL);",
        )
        .await
        .unwrap();

        let mut rows: Vec<PgRow> = Vec::new();
        {
            let mut stream = sqlx::raw_sql("SELECT * FROM row_json_probe").fetch_many(&pool);
            while let Some(item) = stream.try_next().await.unwrap() {
                if let Either::Right(row) = item {
                    rows.push(row);
                }
            }
        }
        assert_eq!(rows.len(), 1, "probe row was not returned");

        let json = pg_row_to_json(&rows[0]);
        let text = |k: &str| json.get(k).map(|v| v.to_string()).unwrap_or_default();

        // The two that regressed to null in the reported bug.
        assert_eq!(
            json["amount"],
            Value::String("200.00".into()),
            "numeric came back as {} — the text fallback is not working",
            text("amount")
        );
        assert_eq!(
            json["happened_on"],
            Value::String("2026-09-01".into()),
            "date came back as {}",
            text("happened_on")
        );

        // Everything else must keep working.
        assert_eq!(json["label"], Value::String("hello".into()));
        assert!(
            json["at"].is_string(),
            "timestamptz came back as {}",
            text("at")
        );
        assert!(
            json["payload"].is_string(),
            "jsonb came back as {}",
            text("payload")
        );
        assert_eq!(json["absent"], Value::Null, "a real NULL must stay null");
        assert!(
            !json["id"].is_null() && !json["flag"].is_null(),
            "primitives regressed: id={} flag={}",
            text("id"),
            text("flag")
        );

        pool.execute("DROP TABLE row_json_probe").await.unwrap();
    }
}

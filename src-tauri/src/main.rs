#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sqlx::postgres::{PgPool, PgPoolOptions};
use sqlx::{Column, Row};
use std::collections::HashMap;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
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
    row_count: u64,
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
        error: None,
    })
}

#[tauri::command]
async fn execute_postgres_query(
    state: State<'_, PostgresState>,
    query: String,
    _values: Option<Vec<Value>>,
) -> Result<QueryResult, String> {
    let pool = {
        let pool_guard = state.pool.lock().await;
        pool_guard
            .as_ref()
            .ok_or("No PostgreSQL connection")?
            .clone()
    };

    let rows = sqlx::query(&query)
        .fetch_all(&pool)
        .await
        .map_err(|e| e.to_string())?;

    let mut columns = Vec::new();
    let mut json_rows = Vec::new();

    if !rows.is_empty() {
        columns = rows[0]
            .columns()
            .iter()
            .map(|c| c.name().to_string())
            .collect();

        for row in rows {
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
                    json_row.insert(col_name.to_string(), Value::Null);
                }
            }
            json_rows.push(Value::Object(json_row));
        }
    }

    Ok(QueryResult {
        success: true,
        columns,
        rows: json_rows,
        row_count: 0,
        error: None,
    })
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
        error: None,
    })
}

#[derive(Serialize)]
struct ProxyResponse {
    status: u16,
    statusText: String,
    headers: HashMap<String, String>,
    body: String,
}

#[tauri::command]
async fn proxy_request(
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
) -> Result<ProxyResponse, String> {
    let client = reqwest::Client::new();
    
    let mut header_map = HeaderMap::new();
    for (key, value) in headers {
        if let (Ok(k), Ok(v)) = (HeaderName::from_bytes(key.as_bytes()), HeaderValue::from_str(&value)) {
            header_map.insert(k, v);
        }
    }

    let mut request_builder = client
        .request(method.parse().unwrap_or(reqwest::Method::GET), &url)
        .headers(header_map);

    if let Some(b) = body {
        request_builder = request_builder.body(b);
    }

    let response = request_builder
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status().as_u16();
    let status_text = response.status().canonical_reason().unwrap_or("").to_string();
    
    let mut response_headers = HashMap::new();
    for (key, value) in response.headers() {
        if let Ok(v) = value.to_str() {
            response_headers.insert(key.to_string(), v.to_string());
        }
    }

    let body_text = response.text().await.map_err(|e| e.to_string())?;

    Ok(ProxyResponse {
        status,
        statusText: status_text,
        headers: response_headers,
        body: body_text,
    })
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .manage(PostgresState {
            pool: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            connect_postgres,
            execute_postgres_query,
            disconnect_postgres,
            proxy_request
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

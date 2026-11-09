#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod db;
mod mcp;

use keyring::Entry;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::redirect;
use serde::Serialize;
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use tauri::Manager;

#[derive(Serialize)]
struct ProxyResponse {
    status: u16,
    #[serde(rename = "statusText")]
    status_text: String,
    headers: HashMap<String, String>,
    body: String,
}

const AWS_IMDS_V4: Ipv4Addr = Ipv4Addr::new(169, 254, 169, 254);
const AZURE_IMDS_V4: Ipv4Addr = Ipv4Addr::new(168, 63, 129, 16);
const ALIYUN_IMDS_V4: Ipv4Addr = Ipv4Addr::new(100, 100, 100, 200);
const AWS_IMDS_V6: Ipv6Addr = Ipv6Addr::new(0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x254);

fn is_imds_v4(ip: Ipv4Addr) -> bool {
    ip == AWS_IMDS_V4 || ip == AZURE_IMDS_V4 || ip == ALIYUN_IMDS_V4 || ip.is_link_local()
}

fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_imds_v4(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_imds_v4(v4);
            }
            v6 == AWS_IMDS_V6
        }
    }
}

fn is_metadata_domain(host: &str) -> bool {
    let host = host.trim_end_matches('.');
    host == "metadata.google.internal"
        || host == "metadata"
        || host.ends_with(".metadata.google.internal")
}

fn is_loopback(url: &reqwest::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => {
            ip.is_loopback() || ip.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback())
        }
        None => false,
    }
}

fn is_lan_http(url: &reqwest::Url) -> bool {
    if is_loopback(url) {
        return true;
    }
    match url.host() {
        Some(url::Host::Domain(d)) => d.to_ascii_lowercase().ends_with(".local"),
        Some(url::Host::Ipv4(ip)) => ip.is_private(),
        Some(url::Host::Ipv6(ip)) => (ip.segments()[0] & 0xfe00) == 0xfc00,
        None => false,
    }
}

// OpenAI-compatible endpoints are user-typed, so this cannot be a fixed
// hostname list. http is limited to this machine / LAN so keys are not sent
// in the clear. Redirects are disabled — an allowed https URL must not be
// able to bounce into IMDS.
fn is_proxy_url_allowed(url: &reqwest::Url) -> Result<(), String> {
    match url.scheme() {
        "http" | "https" => {}
        s => return Err(format!("scheme not allowed: {s}")),
    }
    match url.host() {
        Some(url::Host::Domain(d)) if is_metadata_domain(&d.to_ascii_lowercase()) => {
            return Err(format!("host not allowed: {d}"));
        }
        Some(url::Host::Ipv4(ip)) if is_blocked_ip(IpAddr::V4(ip)) => {
            return Err("host not allowed".into());
        }
        Some(url::Host::Ipv6(ip)) if is_blocked_ip(IpAddr::V6(ip)) => {
            return Err("host not allowed".into());
        }
        Some(_) => {}
        None => return Err("url has no host".into()),
    }
    if url.scheme() == "https" || is_lan_http(url) {
        return Ok(());
    }
    Err("http host not allowed".into())
}

#[tauri::command]
async fn proxy_request(
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
) -> Result<ProxyResponse, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|e| format!("invalid url: {e}"))?;
    is_proxy_url_allowed(&parsed)?;

    let client = reqwest::Client::builder()
        .redirect(redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;

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

/// Must match `HANDOFF_FILENAME` in src/lib/mcpHandoff.ts — a test holds them together.
const MCP_HANDOFF_FILENAME: &str = "mcp-handoff.json";

fn clear_mcp_handoff(app: &tauri::AppHandle) {
    if let Ok(dir) = app.path().app_local_data_dir() {
        let _ = std::fs::remove_file(dir.join(MCP_HANDOFF_FILENAME));
    }
}

/// The updater plugin turns on rustls' ring backend; reqwest and sqlx turn on
/// aws-lc-rs. With both compiled in, rustls cannot pick a default and panics
/// wherever a caller relies on one, such as the verifier sqlx builds for
/// Postgres "Verify CA". Choose aws-lc-rs once, before any TLS starts.
fn install_crypto_provider() {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
}

fn main() {
    let context = tauri::generate_context!();

    // Started by an MCP host as its server: a bridge to the running app, with
    // no window and no Tauri.
    if mcp::requested() {
        if let Some(dir) = mcp::data_dir(&context.config().identifier) {
            mcp::run_bridge(dir);
        }
        return;
    }

    install_crypto_provider();

    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(db::DbState::default())
        .manage(mcp::McpState::default())
        .setup(|app| {
            // A crash or a killed process never reaches the window and exit
            // events below, which would leave the last connection — Postgres
            // password included — advertised to agents indefinitely. Start
            // clean; connecting writes it again.
            clear_mcp_handoff(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db::db_open_sqlite,
            db::db_open_postgres,
            db::db_close,
            db::db_run,
            db::db_cancel,
            db::db_data_version,
            mcp::mcp_listen,
            mcp::mcp_send,
            mcp::mcp_close,
            mcp::mcp_command,
            proxy_request,
            store_secret,
            get_secret,
            delete_secret
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                clear_mcp_handoff(window.app_handle());
                mcp::clear_endpoint(window.app_handle());
            }
        })
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| {
            // Second delete after every window is gone, in case a plugin-fs
            // write that was already in flight completed after Destroyed.
            if let tauri::RunEvent::Exit = event {
                clear_mcp_handoff(app);
                mcp::clear_endpoint(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> reqwest::Url {
        reqwest::Url::parse(s).unwrap()
    }

    #[test]
    fn proxy_allows_openai_and_compatible_https() {
        assert!(is_proxy_url_allowed(&url("https://api.openai.com/v1/models")).is_ok());
        assert!(is_proxy_url_allowed(&url("https://api.groq.com/openai/v1/models")).is_ok());
        assert!(is_proxy_url_allowed(&url("https://models.github.ai/inference")).is_ok());
    }

    #[test]
    fn proxy_allows_local_http() {
        assert!(is_proxy_url_allowed(&url("http://localhost:11434/v1")).is_ok());
        assert!(is_proxy_url_allowed(&url("http://127.0.0.1:1234/v1")).is_ok());
        assert!(is_proxy_url_allowed(&url("http://[::1]:11434/v1")).is_ok());
        assert!(is_proxy_url_allowed(&url("http://192.168.1.10:8080/v1")).is_ok());
        assert!(is_proxy_url_allowed(&url("http://lmstudio.local:1234/v1")).is_ok());
    }

    #[test]
    fn proxy_blocks_cleartext_public_and_metadata() {
        assert!(is_proxy_url_allowed(&url("http://api.openai.com/v1")).is_err());
        assert!(is_proxy_url_allowed(&url("https://169.254.169.254/latest")).is_err());
        assert!(is_proxy_url_allowed(&url("http://169.254.169.254/latest")).is_err());
        assert!(is_proxy_url_allowed(&url("https://[::ffff:169.254.169.254]/latest")).is_err());
        assert!(is_proxy_url_allowed(&url("https://metadata.google.internal/")).is_err());
        assert!(is_proxy_url_allowed(&url("ftp://localhost/x")).is_err());
    }

    #[test]
    fn tls_verifiers_have_a_crypto_provider() {
        // What sqlx does for "Verify CA": a verifier built without naming a
        // provider. It panics when the default was never installed.
        super::install_crypto_provider();
        let roots = std::sync::Arc::new(rustls::RootCertStore::empty());
        let built = rustls::client::WebPkiServerVerifier::builder(roots).build();
        assert!(
            built.is_err(),
            "no roots, so building fails, but without a panic"
        );
    }

    #[test]
    fn secrets_go_to_a_store_that_keeps_them() {
        // Without a store feature for this OS, keyring falls back to its mock,
        // which keeps a secret only inside the Entry that set it. Every command
        // opens a new Entry, so nothing saved would ever be read back.
        let persistence = keyring::default::default_credential_builder().persistence();
        assert!(
            matches!(
                persistence,
                keyring::credential::CredentialPersistence::UntilDelete
            ),
            "keyring has no lasting store for this OS; enable one in Cargo.toml"
        );
    }

    /// Deletes the test entry even when an assertion fails.
    struct DeleteSecretOnDrop(String, String);

    impl Drop for DeleteSecretOnDrop {
        fn drop(&mut self) {
            let _ = delete_secret(self.0.clone(), self.1.clone());
        }
    }

    #[test]
    fn secrets_round_trip_through_the_os_store() {
        // A service name of its own, so the app's entries are never touched.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let service = format!("LiteDB test {}-{nanos}", std::process::id());
        let account = "round-trip";
        let secret = "made-up value, not a credential";

        if let Err(e) = store_secret(service.clone(), account.into(), secret.into()) {
            // Windows and macOS always have a store. Linux needs a Secret
            // Service (GNOME Keyring, KWallet), and CI runners have none.
            if cfg!(any(target_os = "windows", target_os = "macos")) {
                panic!("could not store a secret: {e}");
            }
            eprintln!("skipped: no Secret Service to store in ({e})");
            return;
        }
        let _cleanup = DeleteSecretOnDrop(service.clone(), account.into());

        // Each command opens its own Entry, so this reads from the store
        // itself, as the app does after a restart.
        let read = get_secret(service.clone(), account.into()).unwrap();
        assert_eq!(read.as_deref(), Some(secret));
        delete_secret(service.clone(), account.into()).unwrap();
        assert_eq!(get_secret(service.clone(), account.into()).unwrap(), None);
        // Deleting again, as removing a connection with no password does.
        delete_secret(service, account.into()).unwrap();
    }

    #[test]
    fn handoff_filename_matches_the_app() {
        let ts = include_str!("../../src/lib/mcpHandoff.ts");
        let expected = format!("HANDOFF_FILENAME = '{MCP_HANDOFF_FILENAME}'");
        assert!(
            ts.contains(&expected),
            "src/lib/mcpHandoff.ts no longer declares {expected}; quitting would leave the handoff behind"
        );
    }
}

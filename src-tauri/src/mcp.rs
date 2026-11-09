//! Agents talk to the running app: `LiteDB --mcp`.
//!
//! An MCP host starts `LiteDB --mcp` and speaks JSON-RPC to it, one message
//! per line, over stdin and stdout. That process is only a bridge. It finds
//! the running app through an endpoint file in the app's data directory,
//! connects over loopback with the token written there, and copies lines both
//! ways. The app hands each line to the webview, where the same tools the npm
//! server registers run against the connection the app has open, and an
//! approval is the app's own dialog. Nothing else has to be installed: no
//! Node, no package, and no second copy of the safety rules.
//!
//! When the app is not running, the bridge answers the handshake itself from
//! the description the app last left (its tools and instructions), and every
//! tool call says to open LiteDB. It keeps looking, and once the app is up it
//! replays the host's handshake to it, forwards from then on, and tells the
//! host its tool list may have changed.
//!
//! Both ends prove they read the endpoint file: the bridge sends the token,
//! the app answers with a second secret. A process that only found the port
//! learns nothing and is told nothing.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

/// The argument that makes this process a bridge rather than the app.
pub const FLAG: &str = "--mcp";
/// How to reach the running app. Removed when it quits.
pub const ENDPOINT_FILENAME: &str = "mcp-endpoint.json";
/// What the server says about itself, for the bridge to repeat while the app
/// is closed. Kept after it quits.
pub const DESCRIPTION_FILENAME: &str = "mcp-server.json";

/// How long either end waits for the other's secret.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(3);
/// How often a bridge with no app looks for one.
const RECONNECT_EVERY: Duration = Duration::from_secs(2);
/// Used only when the app has never described itself and the host named no version.
const FALLBACK_PROTOCOL: &str = "2025-06-18";

const CLOSED_TEXT: &str = "LiteDB is not open, so nothing ran. Open the LiteDB app and \
connect a database; the agent follows whatever is connected there.";
const INTERRUPTED_TEXT: &str = "LiteDB closed before this call finished. If it was \
execute_approved, open LiteDB and check the audit log before trying again: the write may \
have run.";

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct Endpoint {
    port: u16,
    /// What the bridge says first.
    token: String,
    /// What the app says back.
    answer: String,
}

impl Endpoint {
    fn read(dir: &Path) -> Option<Self> {
        let bytes = std::fs::read(dir.join(ENDPOINT_FILENAME)).ok()?;
        serde_json::from_slice(&bytes).ok()
    }
}

fn secret() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Compares in time that does not depend on where they differ.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

/// Written whole, and on Unix readable only by this user: the secrets in it
/// are what stands between another account on the machine and the database.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let partial = path.with_extension("partial");
    {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(&partial)?.write_all(bytes)?;
    }
    std::fs::rename(&partial, path)
}

/// One line, at most `limit` bytes, without the line ending.
fn read_short_line(reader: &mut impl BufRead, limit: u64) -> Option<String> {
    let mut line = String::new();
    reader.take(limit).read_line(&mut line).ok()?;
    Some(line.trim_end_matches(['\r', '\n']).to_string())
}

/// Each line from `reader`, without its ending, until it closes.
fn each_line(reader: &mut impl BufRead, mut f: impl FnMut(String) -> bool) {
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => return,
            Ok(_) => {
                let text = line.trim_end_matches(['\r', '\n']);
                if !text.is_empty() && !f(text.to_string()) {
                    return;
                }
            }
        }
    }
}

// --- In the app ----------------------------------------------------------------

/// What the webview hears about agents' connections.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum McpEvent {
    Open { session: u64 },
    Message { session: u64, message: String },
    Close { session: u64 },
}

type Sink = Box<dyn Fn(McpEvent) -> bool + Send + Sync>;

struct Session {
    /// Messages are written whole; the lock keeps two from interleaving.
    writer: Mutex<TcpStream>,
    /// For hanging up without waiting on a write.
    control: TcpStream,
}

#[derive(Default)]
struct Hub {
    /// The webview, once it is ready to serve. Replaced when it reloads.
    sink: Mutex<Option<Sink>>,
    sessions: Mutex<HashMap<u64, Arc<Session>>>,
    next: AtomicU64,
}

impl Hub {
    fn emit(&self, event: McpEvent) -> bool {
        lock(&self.sink).as_ref().is_some_and(|sink| sink(event))
    }

    fn hang_up_all(&self) {
        for (_, session) in lock(&self.sessions).drain() {
            let _ = session.control.shutdown(Shutdown::Both);
        }
    }

    fn send(&self, session: u64, message: &str) -> Result<(), String> {
        let target = lock(&self.sessions)
            .get(&session)
            .cloned()
            .ok_or_else(|| "That agent has disconnected.".to_string())?;
        let mut line = Vec::with_capacity(message.len() + 1);
        line.extend_from_slice(message.as_bytes());
        line.push(b'\n');
        let mut writer = lock(&target.writer);
        writer
            .write_all(&line)
            .and_then(|_| writer.flush())
            .map_err(|e| e.to_string())
    }
}

/// Take connections on `listener` for as long as the app runs.
fn accept(listener: TcpListener, endpoint: Endpoint, hub: Arc<Hub>) {
    for stream in listener.incoming().flatten() {
        let hub = hub.clone();
        let endpoint = endpoint.clone();
        let _ = std::thread::Builder::new()
            .name("mcp-session".into())
            .spawn(move || serve(stream, &endpoint, &hub));
    }
}

/// One bridge: check its token, answer, then hand its lines to the webview.
fn serve(stream: TcpStream, endpoint: &Endpoint, hub: &Hub) {
    let (Ok(reading), Ok(writing), Ok(control)) =
        (stream.try_clone(), stream.try_clone(), stream.try_clone())
    else {
        return;
    };
    let mut reader = BufReader::new(reading);
    let _ = stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT));
    let token = read_short_line(&mut reader, 256);
    if !token.is_some_and(|t| same(&t, &endpoint.token)) {
        let _ = stream.shutdown(Shutdown::Both);
        return;
    }
    let _ = stream.set_read_timeout(None);
    let _ = stream.set_nodelay(true);

    let id = hub.next.fetch_add(1, Ordering::Relaxed) + 1;
    let session = Arc::new(Session {
        writer: Mutex::new(writing),
        control,
    });
    lock(&hub.sessions).insert(id, session);
    let answered = hub.send(id, &endpoint.answer).is_ok();

    if answered && hub.emit(McpEvent::Open { session: id }) {
        each_line(&mut reader, |message| {
            hub.emit(McpEvent::Message {
                session: id,
                message,
            })
        });
    }
    lock(&hub.sessions).remove(&id);
    let _ = stream.shutdown(Shutdown::Both);
    hub.emit(McpEvent::Close { session: id });
}

#[derive(Default)]
pub struct McpState {
    hub: Arc<Hub>,
    endpoint: Mutex<Option<Endpoint>>,
}

/// Start taking agents' connections, and tell the webview about them.
///
/// The webview calls this once it can serve, with its server's description
/// for the bridge to repeat while the app is closed. It calls again after a
/// reload, which loses every session it was serving: those are hung up, so
/// their bridges reconnect and introduce themselves again.
#[tauri::command]
pub async fn mcp_listen(
    app: AppHandle,
    state: State<'_, McpState>,
    description: String,
    on_event: Channel<McpEvent>,
) -> Result<(), String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    state.hub.hang_up_all();
    *lock(&state.hub.sink) = Some(Box::new(move |event| on_event.send(event).is_ok()));
    write_private(&dir.join(DESCRIPTION_FILENAME), description.as_bytes())
        .map_err(|e| e.to_string())?;

    let mut endpoint = lock(&state.endpoint);
    if endpoint.is_none() {
        // This machine only, on a port the system picks.
        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
        let next = Endpoint {
            port: listener.local_addr().map_err(|e| e.to_string())?.port(),
            token: secret()?,
            answer: secret()?,
        };
        let hub = state.hub.clone();
        let accepting = next.clone();
        std::thread::Builder::new()
            .name("mcp-accept".into())
            .spawn(move || accept(listener, accepting, hub))
            .map_err(|e| e.to_string())?;
        *endpoint = Some(next);
    }
    // Every time: a second LiteDB, or a crash's leftover, may have replaced it.
    let json =
        serde_json::to_vec(endpoint.as_ref().expect("set above")).map_err(|e| e.to_string())?;
    write_private(&dir.join(ENDPOINT_FILENAME), &json).map_err(|e| e.to_string())
}

/// Send one message to an agent.
#[tauri::command]
pub async fn mcp_send(
    state: State<'_, McpState>,
    session: u64,
    message: String,
) -> Result<(), String> {
    let hub = state.hub.clone();
    tauri::async_runtime::spawn_blocking(move || hub.send(session, &message))
        .await
        .map_err(|e| e.to_string())?
}

/// Hang up on an agent.
#[tauri::command]
pub fn mcp_close(state: State<'_, McpState>, session: u64) {
    if let Some(session) = lock(&state.hub.sessions).remove(&session) {
        let _ = session.control.shutdown(Shutdown::Both);
    }
}

#[derive(Serialize, Debug, PartialEq)]
pub struct McpCommand {
    command: String,
    args: Vec<String>,
}

/// How an MCP host starts this app as its server: what "Connect an agent"
/// writes into the host's configuration.
#[tauri::command]
pub fn mcp_command() -> Result<McpCommand, String> {
    // Inside the sandbox, the binary's path means nothing to a host outside it.
    if let Ok(id) = std::env::var("FLATPAK_ID") {
        return Ok(McpCommand {
            command: "flatpak".into(),
            args: vec!["run".into(), "--command=litedb".into(), id, FLAG.into()],
        });
    }
    // An AppImage runs from a mount that goes away when it exits; the image stays.
    if let Some(image) = std::env::var_os("APPIMAGE") {
        return Ok(McpCommand {
            command: image.to_string_lossy().into_owned(),
            args: vec![FLAG.into()],
        });
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    Ok(McpCommand {
        command: exe.to_string_lossy().into_owned(),
        args: vec![FLAG.into()],
    })
}

/// Remove the endpoint file if it is still this app's.
pub fn clear_endpoint(app: &AppHandle) {
    let Some(state) = app.try_state::<McpState>() else {
        return;
    };
    let Some(ours) = lock(&state.endpoint).clone() else {
        return;
    };
    let Ok(dir) = app.path().app_local_data_dir() else {
        return;
    };
    if Endpoint::read(&dir).is_some_and(|theirs| theirs == ours) {
        let _ = std::fs::remove_file(dir.join(ENDPOINT_FILENAME));
    }
}

// --- As `LiteDB --mcp` -----------------------------------------------------------

/// Whether this process was started as a bridge.
pub fn requested() -> bool {
    std::env::args_os().skip(1).any(|arg| arg == FLAG)
}

/// The app's data directory, as Tauri resolves `app_local_data_dir`, without
/// starting Tauri, which a bridge never does.
pub fn data_dir(identifier: &str) -> Option<PathBuf> {
    dirs::data_local_dir().map(|dir| dir.join(identifier))
}

enum Event {
    Host(String),
    HostClosed,
    App { link: u64, line: String },
    AppClosed { link: u64 },
    Tick,
}

struct Bridge {
    dir: PathBuf,
    host: Box<dyn Write + Send>,
    events: Sender<Event>,
    /// The connection to the app, when there is one.
    app: Option<TcpStream>,
    /// Which connection is current; lines from an earlier one are dropped.
    link: u64,
    /// The host's initialize, to make again to an app that was not there for it.
    initialize: Option<Value>,
    /// The host has said `notifications/initialized`.
    initialized: bool,
    /// The id a replayed initialize went out under, until the app answers it.
    replaying: Option<Value>,
    /// Host lines held while the replay is answered.
    held: Vec<String>,
    /// Requests the app has not answered, by id.
    pending: HashMap<String, Value>,
    /// The host was given a tool list while the app was closed.
    listed_offline: bool,
}

impl Bridge {
    fn new(dir: PathBuf, host: Box<dyn Write + Send>, events: Sender<Event>) -> Self {
        Self {
            dir,
            host,
            events,
            app: None,
            link: 0,
            initialize: None,
            initialized: false,
            replaying: None,
            held: Vec::new(),
            pending: HashMap::new(),
            listed_offline: false,
        }
    }

    /// False once the host has gone.
    fn handle(&mut self, event: Event) -> bool {
        match event {
            Event::Host(line) => self.on_host_line(line),
            Event::HostClosed => return false,
            Event::App { link, line } if link == self.link => self.on_app_line(&line),
            Event::AppClosed { link } if link == self.link => self.lost_app(),
            Event::Tick if self.app.is_none() => self.connect(),
            _ => {}
        }
        true
    }

    fn connect(&mut self) {
        let Some(endpoint) = Endpoint::read(&self.dir) else {
            return;
        };
        let address = SocketAddr::from(([127, 0, 0, 1], endpoint.port));
        let Ok(mut stream) = TcpStream::connect_timeout(&address, HANDSHAKE_TIMEOUT) else {
            return;
        };
        let Ok(reading) = stream.try_clone() else {
            return;
        };
        let _ = stream.set_nodelay(true);
        if stream
            .write_all(format!("{}\n", endpoint.token).as_bytes())
            .is_err()
        {
            return;
        }
        // Nothing is forwarded to a listener that cannot say the answer: it
        // could be anything that took the port after LiteDB let it go.
        let mut reader = BufReader::new(reading);
        let _ = stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT));
        let answer = read_short_line(&mut reader, 256);
        if !answer.is_some_and(|a| same(&a, &endpoint.answer)) {
            let _ = stream.shutdown(Shutdown::Both);
            return;
        }
        let _ = stream.set_read_timeout(None);

        self.link += 1;
        let link = self.link;
        let events = self.events.clone();
        let reading = std::thread::Builder::new()
            .name("mcp-app".into())
            .spawn(move || {
                each_line(&mut reader, |line| {
                    events.send(Event::App { link, line }).is_ok()
                });
                let _ = events.send(Event::AppClosed { link });
            });
        if reading.is_err() {
            let _ = stream.shutdown(Shutdown::Both);
            return;
        }
        self.app = Some(stream);

        // The host made its handshake before this app was here. Make it again
        // under an id of our own, and keep the answer from the host, which
        // already has one.
        if let Some(mut replay) = self.initialize.clone() {
            let id = json!(format!("litedb-bridge-{link}"));
            replay["id"] = id.clone();
            self.replaying = Some(id);
            self.send_app(&replay.to_string());
        }
    }

    fn on_host_line(&mut self, line: String) {
        let message: Option<Value> = serde_json::from_str(&line).ok();
        let method = message
            .as_ref()
            .and_then(|m| m.get("method"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        // The app may have started since the last look. Before the
        // initialize below is remembered, so it is sent once, not replayed.
        if self.app.is_none() {
            self.connect();
        }
        match method.as_deref() {
            Some("initialize") => self.initialize = message.clone(),
            Some("notifications/initialized") => self.initialized = true,
            _ => {}
        }
        if self.app.is_some() {
            if self.replaying.is_some() {
                self.held.push(line);
            } else {
                self.forward(line, message);
            }
        } else if let Some(message) = message {
            self.answer(&message, false);
        }
    }

    fn forward(&mut self, line: String, message: Option<Value>) {
        if let Some(message) = message {
            if message.get("method").is_some() {
                if let Some(id) = message.get("id") {
                    self.pending.insert(id.to_string(), message.clone());
                }
            }
        }
        self.send_app(&line);
    }

    fn send_app(&mut self, line: &str) {
        let Some(stream) = self.app.as_mut() else {
            return;
        };
        if stream.write_all(format!("{line}\n").as_bytes()).is_err() {
            self.lost_app();
        }
    }

    fn on_app_line(&mut self, line: &str) {
        let message: Option<Value> = serde_json::from_str(line).ok();
        let is_response = message
            .as_ref()
            .is_some_and(|m| m.get("method").is_none() && m.get("id").is_some());
        let id = message.as_ref().and_then(|m| m.get("id")).cloned();

        if is_response && self.replaying.is_some() && id == self.replaying {
            self.replaying = None;
            if self.initialized {
                self.send_app(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#);
            }
            if std::mem::take(&mut self.listed_offline) {
                self.write_host(r#"{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}"#);
            }
            for held in std::mem::take(&mut self.held) {
                let message = serde_json::from_str(&held).ok();
                self.forward(held, message);
            }
            return;
        }
        if is_response {
            if let Some(id) = &id {
                self.pending.remove(&id.to_string());
            }
        }
        self.write_host(line);
    }

    /// The app went away. What it took and never answered is answered here,
    /// so the host is not left waiting on a call that cannot come back.
    fn lost_app(&mut self) {
        if let Some(stream) = self.app.take() {
            let _ = stream.shutdown(Shutdown::Both);
        }
        self.replaying = None;
        let pending: Vec<Value> = std::mem::take(&mut self.pending).into_values().collect();
        for request in pending {
            self.answer(&request, true);
        }
        for held in std::mem::take(&mut self.held) {
            if let Ok(request) = serde_json::from_str::<Value>(&held) {
                self.answer(&request, false);
            }
        }
    }

    fn description(&self) -> Option<Value> {
        let bytes = std::fs::read(self.dir.join(DESCRIPTION_FILENAME)).ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    /// Answer `request` without the app: the handshake and the lists from its
    /// last description, and every call with why nothing ran.
    fn answer(&mut self, request: &Value, interrupted: bool) {
        let (Some(id), Some(method)) = (
            request.get("id").cloned(),
            request.get("method").and_then(Value::as_str),
        ) else {
            return;
        };
        let described = self.description();
        let listed = |field: &str| {
            described
                .as_ref()
                .and_then(|d| d.get(field))
                .cloned()
                .unwrap_or_else(|| json!([]))
        };
        let result = match method {
            "initialize" => handshake(request, described.as_ref()),
            "ping" => json!({}),
            "tools/list" => {
                self.listed_offline = true;
                json!({ "tools": listed("tools") })
            }
            "resources/list" => json!({ "resources": listed("resources") }),
            "resources/templates/list" => json!({ "resourceTemplates": [] }),
            "prompts/list" => json!({ "prompts": [] }),
            "tools/call" => json!({
                "content": [{
                    "type": "text",
                    "text": if interrupted { INTERRUPTED_TEXT } else { CLOSED_TEXT },
                }],
                "isError": true,
            }),
            _ => {
                let error = if method == "resources/read" {
                    json!({ "code": -32603, "message": CLOSED_TEXT })
                } else {
                    json!({ "code": -32601, "message": format!("Method not found: {method}") })
                };
                self.write_host(&json!({ "jsonrpc": "2.0", "id": id, "error": error }).to_string());
                return;
            }
        };
        self.write_host(&json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string());
    }

    fn write_host(&mut self, line: &str) {
        let written = self
            .host
            .write_all(format!("{line}\n").as_bytes())
            .and_then(|_| self.host.flush());
        if written.is_err() {
            // The host is gone; so is the reason to run.
            std::process::exit(0);
        }
    }

    fn hang_up(&mut self) {
        if let Some(stream) = self.app.take() {
            let _ = stream.shutdown(Shutdown::Both);
        }
    }
}

/// What the app would answer to `initialize`, from its description.
///
/// The protocol version is chosen as the SDK in the app chooses it, so the
/// host is not told one thing now and the replay another later.
fn handshake(request: &Value, described: Option<&Value>) -> Value {
    let asked = request
        .pointer("/params/protocolVersion")
        .and_then(Value::as_str);
    let supported: Vec<&str> = described
        .and_then(|d| d.get("protocolVersions"))
        .and_then(Value::as_array)
        .map(|versions| versions.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let latest = described
        .and_then(|d| d.get("latestProtocolVersion"))
        .and_then(Value::as_str)
        .or_else(|| supported.first().copied());
    let version = match (asked, latest) {
        (Some(asked), _) if supported.contains(&asked) => asked,
        (_, Some(latest)) => latest,
        (Some(asked), None) => asked,
        (None, None) => FALLBACK_PROTOCOL,
    };

    let field = |name: &str| described.and_then(|d| d.get(name)).cloned();
    let mut result = json!({
        "protocolVersion": version,
        "capabilities": field("capabilities").unwrap_or_else(|| json!({ "tools": { "listChanged": true } })),
        "serverInfo": field("serverInfo").unwrap_or_else(|| json!({
            "name": "litedb",
            "version": env!("CARGO_PKG_VERSION"),
        })),
    });
    if let Some(instructions) = field("instructions") {
        result["instructions"] = instructions;
    }
    result
}

/// Run as a bridge until the host closes stdin.
pub fn run_bridge(dir: PathBuf) {
    let (events, received) = mpsc::channel();

    let from_host = events.clone();
    std::thread::spawn(move || {
        each_line(&mut std::io::stdin().lock(), |line| {
            from_host.send(Event::Host(line)).is_ok()
        });
        let _ = from_host.send(Event::HostClosed);
    });

    let ticks = events.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(RECONNECT_EVERY);
        if ticks.send(Event::Tick).is_err() {
            return;
        }
    });

    let mut bridge = Bridge::new(dir, Box::new(std::io::stdout()), events);
    bridge.connect();
    while let Ok(event) = received.recv() {
        if !bridge.handle(event) {
            break;
        }
    }
    bridge.hang_up();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::Receiver;
    use std::time::Instant;

    /// stdout, as the tests see it.
    #[derive(Clone, Default)]
    struct Captured(Arc<Mutex<Vec<u8>>>);

    impl Write for Captured {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            lock(&self.0).extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Captured {
        /// Every message written since the last call.
        fn take(&self) -> Vec<Value> {
            let bytes = std::mem::take(&mut *lock(&self.0));
            String::from_utf8(bytes)
                .unwrap()
                .lines()
                .map(|l| serde_json::from_str(l).unwrap())
                .collect()
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("litedb-mcp-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn bridge(dir: &Path) -> (Bridge, Captured, Receiver<Event>) {
        let (events, received) = mpsc::channel();
        let out = Captured::default();
        (
            Bridge::new(dir.to_path_buf(), Box::new(out.clone()), events),
            out,
            received,
        )
    }

    /// Feed the bridge what its threads report until `done`, or fail.
    fn pump(
        bridge: &mut Bridge,
        received: &Receiver<Event>,
        mut done: impl FnMut(&Bridge) -> bool,
    ) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !done(bridge) {
            let left = deadline.saturating_duration_since(Instant::now());
            let event = received.recv_timeout(left).expect("timed out");
            bridge.handle(event);
        }
    }

    fn request(id: u64, method: &str, params: Value) -> String {
        json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string()
    }

    fn describe(dir: &Path) {
        let description = json!({
            "protocolVersions": ["2025-06-18", "2025-03-26"],
            "latestProtocolVersion": "2025-06-18",
            "capabilities": { "tools": { "listChanged": true } },
            "serverInfo": { "name": "litedb", "version": "test" },
            "instructions": "Talks to the database open in LiteDB.",
            "tools": [{ "name": "query" }],
        });
        std::fs::write(dir.join(DESCRIPTION_FILENAME), description.to_string()).unwrap();
    }

    /// The app's end, with a sink the test can read.
    fn listen(dir: &Path) -> (Arc<Hub>, Arc<Mutex<Vec<McpEvent>>>, Endpoint) {
        let hub = Arc::new(Hub::default());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let record = seen.clone();
        *lock(&hub.sink) = Some(Box::new(move |event| {
            lock(&record).push(event);
            true
        }));
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let endpoint = Endpoint {
            port: listener.local_addr().unwrap().port(),
            token: secret().unwrap(),
            answer: secret().unwrap(),
        };
        std::fs::write(
            dir.join(ENDPOINT_FILENAME),
            serde_json::to_vec(&endpoint).unwrap(),
        )
        .unwrap();
        let accepting = (endpoint.clone(), hub.clone());
        std::thread::spawn(move || accept(listener, accepting.0, accepting.1));
        (hub, seen, endpoint)
    }

    fn wait_for(seen: &Arc<Mutex<Vec<McpEvent>>>, count: usize) -> Vec<McpEvent> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let events = lock(seen).clone();
            if events.len() >= count {
                return events;
            }
            assert!(Instant::now() < deadline, "only saw {events:?}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn with_the_app_closed_it_answers_from_the_description() {
        let dir = temp_dir("closed");
        describe(&dir);
        let (mut bridge, out, _received) = bridge(&dir);

        bridge.handle(Event::Host(request(
            1,
            "initialize",
            json!({ "protocolVersion": "2025-03-26" }),
        )));
        bridge.handle(Event::Host(
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#.into(),
        ));
        bridge.handle(Event::Host(request(2, "tools/list", json!({}))));
        bridge.handle(Event::Host(request(
            3,
            "tools/call",
            json!({ "name": "query" }),
        )));
        bridge.handle(Event::Host(request(4, "completion/complete", json!({}))));

        let said = out.take();
        assert_eq!(said.len(), 4, "the notification gets no answer: {said:?}");
        assert_eq!(
            said[0]["result"]["protocolVersion"], "2025-03-26",
            "a supported version is kept"
        );
        assert_eq!(
            said[0]["result"]["instructions"],
            "Talks to the database open in LiteDB."
        );
        assert_eq!(said[1]["result"]["tools"][0]["name"], "query");
        assert_eq!(said[2]["result"]["isError"], true);
        assert!(said[2]["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("not open"));
        assert_eq!(said[3]["error"]["code"], -32601);

        let unknown = handshake(
            &serde_json::from_str(&request(
                9,
                "initialize",
                json!({ "protocolVersion": "1999-01-01" }),
            ))
            .unwrap(),
            bridge.description().as_ref(),
        );
        assert_eq!(
            unknown["protocolVersion"], "2025-06-18",
            "an unknown version gets the latest"
        );
    }

    #[test]
    fn it_follows_the_app_once_it_opens() {
        let dir = temp_dir("opens");
        describe(&dir);
        let (mut bridge, out, received) = bridge(&dir);

        bridge.handle(Event::Host(request(
            1,
            "initialize",
            json!({ "protocolVersion": "2025-06-18" }),
        )));
        bridge.handle(Event::Host(
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#.into(),
        ));
        bridge.handle(Event::Host(request(2, "tools/list", json!({}))));
        out.take();

        let (hub, seen, _) = listen(&dir);
        bridge.handle(Event::Tick);
        assert!(bridge.app.is_some(), "connected");

        // The app is introduced to the host it never saw.
        let events = wait_for(&seen, 2);
        assert_eq!(events[0], McpEvent::Open { session: 1 });
        let McpEvent::Message { message, .. } = &events[1] else {
            panic!("{events:?}")
        };
        let replay: Value = serde_json::from_str(message).unwrap();
        assert_eq!(replay["method"], "initialize");
        assert_eq!(replay["id"], "litedb-bridge-1");

        // A call while the replay is unanswered waits for it.
        bridge.handle(Event::Host(request(
            3,
            "tools/call",
            json!({ "name": "list_tables" }),
        )));
        assert_eq!(lock(&seen).len(), 2, "held");

        hub.send(
            1,
            &json!({ "jsonrpc": "2.0", "id": "litedb-bridge-1", "result": {} }).to_string(),
        )
        .unwrap();
        pump(&mut bridge, &received, |b| b.replaying.is_none());
        let said = out.take();
        assert_eq!(
            said,
            vec![json!({ "jsonrpc": "2.0", "method": "notifications/tools/list_changed" })],
            "the replay's answer stays with the bridge"
        );

        let events = wait_for(&seen, 4);
        assert!(
            matches!(&events[2], McpEvent::Message { message, .. } if message.contains("notifications/initialized"))
        );
        assert!(
            matches!(&events[3], McpEvent::Message { message, .. } if message.contains("list_tables"))
        );

        hub.send(
            1,
            &json!({ "jsonrpc": "2.0", "id": 3, "result": { "content": [] } }).to_string(),
        )
        .unwrap();
        pump(&mut bridge, &received, |b| b.pending.is_empty());
        assert_eq!(out.take()[0]["id"], 3);

        // A call the app takes and never answers is answered when it goes.
        bridge.handle(Event::Host(request(
            4,
            "tools/call",
            json!({ "name": "execute_approved" }),
        )));
        wait_for(&seen, 5);
        hub.hang_up_all();
        pump(&mut bridge, &received, |b| b.app.is_none());
        let said = out.take();
        assert_eq!(said[0]["id"], 4);
        assert!(said[0]["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("check the audit log"));
    }

    #[test]
    fn neither_end_trusts_a_stranger() {
        let dir = temp_dir("strangers");
        let (_hub, seen, endpoint) = listen(&dir);

        // A wrong token is hung up on, unanswered and unannounced.
        let mut stranger = TcpStream::connect(("127.0.0.1", endpoint.port)).unwrap();
        stranger.write_all(b"guess\n").unwrap();
        let mut reply = String::new();
        let _ = BufReader::new(stranger).read_line(&mut reply);
        assert!(reply.is_empty(), "told a stranger {reply:?}");
        assert!(lock(&seen).is_empty());

        // A listener that does not know the answer gets nothing forwarded.
        let impostor = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let fake = Endpoint {
            port: impostor.local_addr().unwrap().port(),
            ..endpoint
        };
        std::fs::write(
            dir.join(ENDPOINT_FILENAME),
            serde_json::to_vec(&fake).unwrap(),
        )
        .unwrap();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = impostor.accept() {
                let _ = stream.write_all(b"not the answer\n");
                std::thread::sleep(Duration::from_secs(1));
            }
        });
        let (mut bridge, out, _received) = bridge(&dir);
        bridge.handle(Event::Tick);
        assert!(bridge.app.is_none());
        bridge.handle(Event::Host(request(1, "tools/call", json!({}))));
        assert!(out.take()[0]["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("not open"));
    }
}

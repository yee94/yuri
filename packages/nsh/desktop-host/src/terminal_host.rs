//! Narrow native terminal registry/catalog. TS terminal-core remains the only
//! tab/workspace owner. This module only proves native session ownership and
//! supplies terminal.* over captured HTTP/SSE and native direct WebSocket authority.
use crate::{
    policy::{self, Result},
    terminal_transport::{self as io, Captured, Request},
};
use nsh_engine::{HostChannel, Network};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
};

pub type Capture = Arc<dyn Fn(&Value) -> Result<Captured> + Send + Sync>;
pub(crate) enum CatalogSource {
    Closed,
    SyntheticPath(PathBuf),
    Granted(crate::notifications::Store),
}
impl From<PathBuf> for CatalogSource {
    fn from(path: PathBuf) -> Self {
        Self::SyntheticPath(path)
    }
}
const NAMES: &[&str] = &[
    "terminal.capabilities",
    "terminal.catalog.read",
    "terminal.catalog.write",
    "terminal.restore",
    "terminal.create",
    "terminal.attach",
    "terminal.detach",
    "terminal.input",
    "terminal.resize",
    "terminal.close",
    "terminal.forceKill",
    "terminal.probe",
    "terminal.discovery.file",
    "terminal.discovery.port",
];
struct Session {
    scope: Value,
    owner: String,
    directory: String,
    id: Mutex<Option<String>>,
    unknown: AtomicBool,
    attachment: AtomicU64,
    output: AtomicU64,
    bound: AtomicBool,
    stop: Mutex<Arc<AtomicBool>>,
    mutating: AtomicBool,
    socket: Mutex<Option<io::ws::Port>>,
    prefer_sse: AtomicBool,
    http_input: AtomicBool,
    input_unknown: AtomicBool,
    replay: AtomicU64,
    sse: AtomicBool,
}
impl Session {
    fn new(scope: Value, owner: String, directory: String, id: Option<String>) -> Self {
        Self {
            scope,
            owner,
            directory,
            id: Mutex::new(id),
            unknown: AtomicBool::new(false),
            attachment: AtomicU64::new(0),
            output: AtomicU64::new(0),
            bound: AtomicBool::new(false),
            stop: Mutex::new(Arc::new(AtomicBool::new(false))),
            mutating: AtomicBool::new(false),
            socket: Mutex::new(None),
            prefer_sse: AtomicBool::new(false),
            http_input: AtomicBool::new(false),
            input_unknown: AtomicBool::new(false),
            replay: AtomicU64::new(0),
            sse: AtomicBool::new(false),
        }
    }
    fn pause(&self) {
        self.bound.store(false, Ordering::Release);
        if let Ok(stop) = self.stop.lock() {
            stop.store(true, Ordering::Release);
        }
        if let Ok(mut socket) = self.socket.lock() {
            socket.take();
        }
    }
}
struct State {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    catalog: Mutex<Catalog>,
    network: Arc<dyn Network>,
    capture: Capture,
    host: HostChannel,
    stopped: Arc<AtomicBool>,
    jobs: AtomicUsize,
}
pub struct Owner {
    state: Arc<State>,
}
impl Drop for Owner {
    fn drop(&mut self) {
        self.state.stopped.store(true, Ordering::Release);
        if let Ok(mut catalog) = self.state.catalog.lock() {
            catalog.source = CatalogSource::Closed;
        }
        if let Ok(book) = self.state.sessions.lock() {
            for session in book.values() {
                session.pause();
            }
        }
    }
}
impl Owner {
    /// Called by the runtime actor only after it has retired this exact lease.
    /// Detaches streams, never kills the remote PTY or deletes durable metadata.
    pub fn retire_scope(&self, scope: &Value) {
        if let Ok(mut book) = self.state.sessions.lock() {
            book.retain(|_, session| {
                if &session.scope == scope {
                    session.pause();
                    false
                } else {
                    true
                }
            });
        }
    }
}
/// Install AFTER bridge::install, otherwise its unsupported handlers overwrite
/// these. `capture` comes from the same native runtime authority, MUST reject
/// Relay until its existing authenticated tunnel can implement this I/O, and
/// must never read credentials from JS or an independent environment variable.
pub fn install(
    host: &HostChannel,
    network: Arc<dyn Network>,
    capture: Capture,
    catalog: impl Into<CatalogSource>,
) -> Owner {
    let state = Arc::new(State {
        sessions: Mutex::new(HashMap::new()),
        catalog: Mutex::new(Catalog {
            source: catalog.into(),
            unknown: false,
        }),
        network,
        capture,
        host: host.clone(),
        stopped: Arc::new(AtomicBool::new(false)),
        jobs: AtomicUsize::new(0),
    });
    for &name in NAMES {
        let state = state.clone();
        host.handle(name, move |mut call| {
            let value = call.take_data();
            let Some(reply) = call.into_reply() else {
                return;
            };
            if state.stopped.load(Ordering::Acquire) {
                reply.reject("terminal_host_unavailable");
                return;
            }
            if state.jobs.fetch_add(1, Ordering::AcqRel) >= 8 {
                state.jobs.fetch_sub(1, Ordering::AcqRel);
                reply.reject("terminal_host_busy");
                return;
            }
            let state = state.clone();
            let worker = state.clone();
            // Fetch callbacks never block the QuickJS/NSH engine thread.
            if std::thread::Builder::new()
                .name("yuri-terminal-io".into())
                .spawn(move || {
                    if name == "terminal.attach" {
                        match worker.attachment(&value) {
                            Ok((capture, session, stop, attachment)) => {
                                reply.resolve(json!(true));
                                worker.receive(
                                    capture,
                                    session,
                                    stop,
                                    attachment,
                                    value["cursor"].as_u64().unwrap_or(0),
                                );
                            }
                            Err(error) => reply.reject(error),
                        }
                    } else {
                        reply.reply(worker.call(name, &value));
                    }
                    worker.jobs.fetch_sub(1, Ordering::AcqRel);
                })
                .is_err()
            {
                state.jobs.fetch_sub(1, Ordering::AcqRel);
            }
        });
    }
    Owner { state }
}
fn key(scope: &Value, owner: &str) -> String {
    format!("{}:{owner}", scope)
}
fn text<'a>(value: &'a Value, name: &str) -> Result<&'a str> {
    policy::string(value, name)
}
fn common(value: &Value) -> Result<(Value, &str, &str)> {
    let scope = policy::scope(&value["expectedHost"])?;
    let owner = text(value, "owner")?;
    let directory = text(value, "directory")?;
    if !io::identifier(owner) || !io::directory(directory) {
        return Err("terminal_request_invalid".into());
    }
    Ok((scope, owner, directory))
}
impl State {
    fn capture(&self, value: &Value) -> Result<Captured> {
        let expected = policy::scope(&value["expectedHost"])?;
        if self.stopped.load(Ordering::Acquire) {
            return Err("terminal_host_unavailable".into());
        }
        let capture = (self.capture)(&expected)?;
        if capture.scope != expected || !capture.valid() {
            return Err("terminal_scope_stale".into());
        }
        Ok(capture.with_shutdown(self.stopped.clone()))
    }
    fn session(&self, value: &Value) -> Result<Arc<Session>> {
        let (scope, owner, directory) = common(value)?;
        let session = self
            .sessions
            .lock()
            .map_err(|_| "terminal_registry_unavailable")?
            .get(&key(&scope, owner))
            .cloned()
            .ok_or("terminal_session_unregistered")?;
        if session.directory != directory
            || value.get("sessionId").is_some_and(|v| {
                !v.is_null()
                    && session
                        .id
                        .lock()
                        .is_ok_and(|id| id.as_deref() != v.as_str())
            })
        {
            return Err("terminal_session_mismatch".into());
        }
        Ok(session)
    }
    fn forget_session(&self, session: &Arc<Session>) -> Result<()> {
        let mut book = self
            .sessions
            .lock()
            .map_err(|_| "terminal_registry_unavailable")?;
        let host = text(&session.scope, "hostID")?;
        let mut storage = self
            .catalog
            .lock()
            .map_err(|_| "terminal_catalog_unavailable")?;
        let mut catalog = storage.read(host)?;
        forget(&mut catalog, &session.owner);
        storage.write(host, catalog)?;
        let owner = key(&session.scope, &session.owner);
        if book
            .get(&owner)
            .is_some_and(|current| Arc::ptr_eq(current, session))
        {
            book.remove(&owner);
        }
        Ok(())
    }
    fn call(&self, name: &str, value: &Value) -> Result<Value> {
        match name {
            "terminal.detach" => policy::keys(
                value,
                &["expectedHost", "owner", "attachment"],
                &["expectedHost", "owner", "attachment"],
            ),
            "terminal.capabilities" | "terminal.catalog.read" => {
                policy::keys(value, &["expectedHost"], &["expectedHost"])
            }
            "terminal.catalog.write" => policy::keys(
                value,
                &["expectedHost", "catalog"],
                &["expectedHost", "catalog"],
            ),
            "terminal.create" | "terminal.resize" => policy::keys(
                value,
                &[
                    "expectedHost",
                    "owner",
                    "directory",
                    "sessionId",
                    "cols",
                    "rows",
                ],
                &["expectedHost", "owner", "directory", "cols", "rows"],
            ),
            "terminal.input" => policy::keys(
                value,
                &["expectedHost", "owner", "directory", "sessionId", "data"],
                &["expectedHost", "owner", "directory", "data"],
            ),
            "terminal.restore" | "terminal.close" | "terminal.forceKill" => policy::keys(
                value,
                &["expectedHost", "owner", "directory", "sessionId"],
                &["expectedHost", "owner", "directory"],
            ),
            _ => Ok(()),
        }?;
        if name == "terminal.detach" {
            let expected = policy::scope(&value["expectedHost"])?;
            let owner = text(value, "owner")?;
            let attachment = value["attachment"]
                .as_u64()
                .filter(|n| *n > 0)
                .ok_or("terminal_attachment_invalid")?;
            if !io::identifier(owner) {
                return Err("terminal_owner_invalid".into());
            }
            if let Some(session) = self
                .sessions
                .lock()
                .map_err(|_| "terminal_registry_unavailable")?
                .get(&key(&expected, owner))
                && session.attachment.load(Ordering::Acquire) == attachment
            {
                session.pause();
            }
            return Ok(json!(true));
        }
        let capture = self.capture(value)?;
        match name {
            "terminal.capabilities" => Ok(
                json!({"schema":1,"scope":"native-opaque","wsVersion":2,"wsAvailable":true,"httpInput":true,"sseOutput":true,"durableMetadata":true,"actionDiscovery":false}),
            ),
            "terminal.catalog.read" => self
                .catalog
                .lock()
                .map_err(|_| "terminal_catalog_unavailable")?
                .read(text(&capture.scope, "hostID")?),
            "terminal.catalog.write" => {
                let host = text(&capture.scope, "hostID")?;
                let mut catalog = value["catalog"].clone();
                validate_catalog(&catalog, host)?;
                // Native receipts win over an older JS createUnknown snapshot.
                let book = self
                    .sessions
                    .lock()
                    .map_err(|_| "terminal_registry_unavailable")?;
                for session in book.values().filter(|s| s.scope == capture.scope) {
                    if let Some(id) = session
                        .id
                        .lock()
                        .map_err(|_| "terminal_registry_unavailable")?
                        .clone()
                    {
                        remember(&mut catalog, &session.directory, &session.owner, &id);
                    }
                }
                self.catalog
                    .lock()
                    .map_err(|_| "terminal_catalog_unavailable")?
                    .write(host, catalog)?;
                Ok(json!(true))
            }
            "terminal.restore" => {
                let (scope, owner, directory) = common(value)?;
                let id = text(value, "sessionId")?;
                if !io::identifier(id) {
                    return Err("terminal_session_invalid".into());
                }
                let catalog = self
                    .catalog
                    .lock()
                    .map_err(|_| "terminal_catalog_unavailable")?
                    .read(text(&scope, "hostID")?)?;
                if !catalog["directories"].as_array().is_some_and(|dirs| {
                    dirs.iter().any(|entry| {
                        entry["directory"] == directory
                            && entry["tabs"].as_array().is_some_and(|tabs| {
                                tabs.iter()
                                    .any(|tab| tab["id"] == owner && tab["sessionId"] == id)
                            })
                    })
                }) {
                    return Err("terminal_restore_unproven".into());
                }
                let mut book = self
                    .sessions
                    .lock()
                    .map_err(|_| "terminal_registry_unavailable")?;
                if let Some(session) = book.get(&key(&scope, owner)) {
                    if session.directory != directory
                        || session
                            .id
                            .lock()
                            .map_err(|_| "terminal_registry_unavailable")?
                            .as_deref()
                            != Some(id)
                    {
                        return Err("terminal_session_mismatch".into());
                    }
                    return Ok(json!({"sessionId":id}));
                }
                if book.len() >= 256 {
                    return Err("terminal_registry_full".into());
                }
                book.entry(key(&scope, owner)).or_insert_with(|| {
                    Arc::new(Session::new(
                        scope.clone(),
                        owner.into(),
                        directory.into(),
                        Some(id.into()),
                    ))
                });
                Ok(json!({"sessionId":id}))
            }
            "terminal.create" => {
                let (scope, owner, directory) = common(value)?;
                let (cols, rows) = dimensions(value)?;
                let session = Arc::new(Session::new(
                    scope.clone(),
                    owner.into(),
                    directory.into(),
                    None,
                ));
                session.unknown.store(true, Ordering::Release);
                {
                    let mut book = self
                        .sessions
                        .lock()
                        .map_err(|_| "terminal_registry_unavailable")?;
                    if book.len() >= 256 || book.contains_key(&key(&scope, owner)) {
                        return Err("terminal_create_not_repeatable".into());
                    }
                    book.insert(key(&scope, owner), session.clone());
                }
                let response = io::request(
                    &*self.network,
                    &capture,
                    Request::Create {
                        directory,
                        cols,
                        rows,
                    },
                )?;
                let id = text(&response, "sessionId")?;
                if !io::identifier(id) {
                    return Err("terminal_response_invalid".into());
                }
                *session
                    .id
                    .lock()
                    .map_err(|_| "terminal_registry_unavailable")? = Some(id.into());
                session.unknown.store(false, Ordering::Release);
                session.prefer_sse.store(
                    explicitly_non_ws(response.get("capabilities").and_then(|v| v.get("stream"))),
                    Ordering::Release,
                );
                session.http_input.store(
                    explicitly_non_ws(response.get("capabilities").and_then(|v| v.get("input"))),
                    Ordering::Release,
                );
                let mut storage = self
                    .catalog
                    .lock()
                    .map_err(|_| "terminal_catalog_unavailable")?;
                let host = text(&scope, "hostID")?;
                let mut catalog = storage.read(host)?;
                remember(&mut catalog, directory, owner, id);
                storage.write(host, catalog)?;
                Ok(json!({"sessionId":id}))
            }
            "terminal.input" | "terminal.resize" | "terminal.close" | "terminal.forceKill" => {
                let session = self.session(value)?;
                let guarded = name != "terminal.resize";
                if guarded && session.mutating.swap(true, Ordering::AcqRel) {
                    return Err("terminal_mutation_busy".into());
                }
                let result = (|| {
                    let id = session
                        .id
                        .lock()
                        .map_err(|_| "terminal_registry_unavailable")?
                        .clone()
                        .ok_or("terminal_create_unknown")?;
                    let closing = matches!(name, "terminal.close" | "terminal.forceKill");
                    if name == "terminal.input" {
                        if session.input_unknown.load(Ordering::Acquire) {
                            return Err("input_unknown".into());
                        }
                        if !session.bound.load(Ordering::Acquire) {
                            return Err("terminal_not_bound".into());
                        }
                        let data = text(value, "data")?;
                        if data.is_empty() || data.len() > 65_536 {
                            return Err("terminal_request_invalid".into());
                        }
                        let socket = session
                            .socket
                            .lock()
                            .map_err(|_| "terminal_registry_unavailable")?
                            .clone();
                        if let Some(socket) = socket
                            && !session.http_input.load(Ordering::Acquire)
                        {
                            let result = socket.input(data);
                            if result.as_ref().is_err_and(|e| e == "input_unknown") {
                                session.input_unknown.store(true, Ordering::Release);
                                session.pause();
                            }
                            return result.map(|_| json!(true));
                        }
                        if !session.sse.load(Ordering::Acquire)
                            && !session.http_input.load(Ordering::Acquire)
                        {
                            return Err("terminal_not_bound".into());
                        }
                    }
                    let request = match name {
                        "terminal.input" if session.bound.load(Ordering::Acquire) => {
                            Request::Input {
                                session: &id,
                                data: text(value, "data")?,
                            }
                        }
                        "terminal.resize" if session.bound.load(Ordering::Acquire) => {
                            let (cols, rows) = dimensions(value)?;
                            Request::Resize {
                                session: &id,
                                cols,
                                rows,
                            }
                        }
                        "terminal.close" => {
                            session.pause();
                            Request::Close { session: &id }
                        }
                        "terminal.forceKill" => {
                            session.pause();
                            Request::ForceKill { session: &id }
                        }
                        _ => return Err("terminal_not_bound".into()),
                    };
                    let response = io::request(&*self.network, &capture, request);
                    if !matches!(&response,Ok(value) if value["success"]==true)
                        && !(closing
                            && matches!(&response,Err(error) if error=="session_not_found"))
                    {
                        if name == "terminal.input" {
                            session.input_unknown.store(true, Ordering::Release);
                            session.pause();
                        }
                        return Err(if name == "terminal.input" {
                            "input_unknown"
                        } else {
                            "terminal_mutation_unconfirmed"
                        }
                        .into());
                    }
                    if closing {
                        self.forget_session(&session)?;
                        Ok(json!({"closed":true}))
                    } else {
                        Ok(json!(true))
                    }
                })();
                if guarded {
                    session.mutating.store(false, Ordering::Release);
                }
                result
            }
            _ => Err("unsupported_desktop_terminal_capability".into()),
        }
    }
    fn attachment(&self, value: &Value) -> Result<(Captured, Arc<Session>, Arc<AtomicBool>, u64)> {
        policy::keys(
            value,
            &[
                "expectedHost",
                "owner",
                "directory",
                "sessionId",
                "cursor",
                "attachment",
            ],
            &["expectedHost", "owner", "directory", "attachment"],
        )?;
        let capture = self.capture(value)?;
        let session = self.session(value)?;
        let cursor = value
            .get("cursor")
            .map(|v| v.as_u64().filter(|c| *c <= io::ws::SAFE_CURSOR))
            .unwrap_or(Some(0))
            .ok_or("terminal_replay_cursor_invalid")?;
        if cursor > session.replay.load(Ordering::Acquire) {
            return Err("terminal_replay_cursor_invalid".into());
        }
        let attachment = value["attachment"]
            .as_u64()
            .filter(|n| *n > 0)
            .ok_or("terminal_attachment_invalid")?;
        if session
            .id
            .lock()
            .map_err(|_| "terminal_registry_unavailable")?
            .is_none()
        {
            return Err("terminal_create_unknown".into());
        }
        let mut stop = session
            .stop
            .lock()
            .map_err(|_| "terminal_registry_unavailable")?;
        if attachment <= session.attachment.load(Ordering::Acquire) {
            return Err("terminal_attachment_stale".into());
        }
        stop.store(true, Ordering::Release);
        *stop = Arc::new(AtomicBool::new(false));
        session.bound.store(false, Ordering::Release);
        session.sse.store(false, Ordering::Release);
        session
            .socket
            .lock()
            .map_err(|_| "terminal_registry_unavailable")?
            .take();
        session.attachment.store(attachment, Ordering::Release);
        let current = stop.clone();
        drop(stop);
        Ok((capture, session, current, attachment))
    }
    fn receive(
        &self,
        capture: Captured,
        session: Arc<Session>,
        stop: Arc<AtomicBool>,
        attachment: u64,
        cursor: u64,
    ) {
        let id = session
            .id
            .lock()
            .ok()
            .and_then(|id| id.clone())
            .unwrap_or_default();
        let emit = |mut value: Value| -> Result<()> {
            if !capture.valid()
                || self.stopped.load(Ordering::Acquire)
                || stop.load(Ordering::Acquire)
                || session.attachment.load(Ordering::Acquire) != attachment
            {
                return Err("terminal_scope_stale".into());
            }
            if value["type"] == "connected" {
                session
                    .sse
                    .store(value["transport"] != "ws", Ordering::Release);
                session.bound.store(true, Ordering::Release);
            }
            if value["type"] == "exit" {
                session.bound.store(false, Ordering::Release);
                self.forget_session(&session)?;
            }
            if value["type"] == "data" {
                value["id"] = json!(session.output.fetch_add(1, Ordering::AcqRel) + 1);
                if let Some(cursor) = value["cursor"].as_u64() {
                    session.replay.fetch_max(cursor, Ordering::AcqRel);
                } else {
                    value["cursor"] = json!(session.replay.load(Ordering::Acquire));
                }
            }
            value["expectedHost"] = session.scope.clone();
            value["owner"] = json!(session.owner);
            value["sessionId"] = json!(id);
            value["attachment"] = json!(attachment);
            if value.get("transport").is_none() {
                value["transport"] = json!("sse");
            }
            self.host.send("terminal.event", value)
        };
        let result = if session.prefer_sse.load(Ordering::Acquire) {
            io::stream(&*self.network, &capture, &id, &stop, emit)
        } else {
            let result = io::ws::stream(
                &capture,
                &id,
                cursor,
                stop.clone(),
                |port| {
                    if !stop.load(Ordering::Acquire)
                        && session.attachment.load(Ordering::Acquire) == attachment
                        && let Ok(mut socket) = session.socket.lock()
                    {
                        *socket = Some(port);
                    }
                },
                emit,
            );
            if result
                .as_ref()
                .is_err_and(|error| error == "terminal_ws_prebind_failed")
                && capture.valid()
                && !stop.load(Ordering::Acquire)
            {
                io::stream(&*self.network, &capture, &id, &stop, emit)
            } else {
                result
            }
        };
        if let Err(mut error) = result {
            if error == "input_unknown" {
                session.input_unknown.store(true, Ordering::Release);
            }
            if error == "session_not_found"
                && capture.valid()
                && !stop.load(Ordering::Acquire)
                && session.attachment.load(Ordering::Acquire) == attachment
                && self.forget_session(&session).is_err()
            {
                error = "terminal_catalog_write_failed".into();
            }
            let _ = emit(json!({"type":"error","code":error}));
        }
        if session.attachment.load(Ordering::Acquire) == attachment {
            session.bound.store(false, Ordering::Release);
            if let Ok(mut socket) = session.socket.lock() {
                socket.take();
            }
        }
    }
}
fn explicitly_non_ws(value: Option<&Value>) -> bool {
    value.is_some_and(|value| {
        value.is_object()
            && value["preferred"] != "ws"
            && !value["transports"]
                .as_array()
                .is_some_and(|values| values.iter().any(|v| v == "ws"))
    })
}
fn dimensions(value: &Value) -> Result<(u64, u64)> {
    let cols = value["cols"].as_u64().ok_or("terminal_size_invalid")?;
    let rows = value["rows"].as_u64().ok_or("terminal_size_invalid")?;
    if !(2..=1000).contains(&cols) || !(1..=1000).contains(&rows) {
        return Err("terminal_size_invalid".into());
    }
    Ok((cols, rows))
}
struct Catalog {
    source: CatalogSource,
    unknown: bool,
}
impl Catalog {
    fn all(&mut self) -> Result<Value> {
        if self.unknown {
            return Err("terminal_catalog_unknown".into());
        }
        if matches!(&self.source, CatalogSource::Closed) {
            return Err("terminal_catalog_closed".into());
        }
        if let CatalogSource::Granted(store) = &mut self.source {
            let value = store.load()?.unwrap_or_else(|| json!({}));
            let map = value
                .as_object()
                .filter(|map| map.len() <= 64)
                .ok_or("terminal_catalog_invalid")?;
            for (host, value) in map {
                validate_catalog(value, host)?;
            }
            return Ok(value);
        }
        let CatalogSource::SyntheticPath(path) = &self.source else {
            unreachable!()
        };
        match std::fs::read(path) {
            Ok(bytes) if bytes.len() <= 4_194_304 => {
                let value: Value =
                    serde_json::from_slice(&bytes).map_err(|_| "terminal_catalog_invalid")?;
                if value.as_object().is_none_or(|v| v.len() > 64) {
                    return Err("terminal_catalog_invalid".into());
                }
                Ok(value)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
            _ => Err("terminal_catalog_unavailable".into()),
        }
    }
    fn read(&mut self, host: &str) -> Result<Value> {
        let all = self.all()?;
        let value = all
            .get(host)
            .cloned()
            .unwrap_or_else(|| json!({"schema":1,"hostID":host,"directories":[]}));
        validate_catalog(&value, host)?;
        Ok(value)
    }
    fn write(&mut self, host: &str, value: Value) -> Result<()> {
        validate_catalog(&value, host)?;
        let mut all = self.all()?;
        all[host] = value;
        if all.as_object().is_none_or(|v| v.len() > 64) {
            return Err("terminal_catalog_full".into());
        }
        let bytes = serde_json::to_vec(&all).map_err(|_| "terminal_catalog_invalid")?;
        if bytes.len() > 4_194_304 {
            return Err("terminal_catalog_full".into());
        }
        if let CatalogSource::Granted(store) = &mut self.source {
            let result = store.commit(&all);
            if result
                .as_ref()
                .is_err_and(|error| error == "notification_store_unknown")
            {
                self.unknown = true;
            }
            return result.map_err(|error| {
                if self.unknown {
                    "terminal_catalog_unknown".into()
                } else {
                    error
                }
            });
        }
        let CatalogSource::SyntheticPath(path) = &self.source else {
            unreachable!()
        };
        let parent = path.parent().ok_or("terminal_catalog_path_invalid")?;
        std::fs::create_dir_all(parent).map_err(|_| "terminal_catalog_write_failed")?;
        let temporary = path.with_extension("terminal-tmp");
        std::fs::write(&temporary, bytes).map_err(|_| "terminal_catalog_write_failed")?;
        std::fs::rename(temporary, path).map_err(|_| "terminal_catalog_write_failed".into())
    }
}
fn validate_catalog(value: &Value, host: &str) -> Result<()> {
    policy::keys(
        value,
        &["schema", "hostID", "directories"],
        &["schema", "hostID", "directories"],
    )?;
    if value["schema"] != 1 || value["hostID"] != host {
        return Err("terminal_catalog_invalid".into());
    }
    let dirs = value["directories"]
        .as_array()
        .filter(|v| v.len() <= 128)
        .ok_or("terminal_catalog_invalid")?;
    let mut paths = HashSet::new();
    let mut ids = HashSet::new();
    for dir in dirs {
        policy::keys(
            dir,
            &["directory", "activeId", "tabs"],
            &["directory", "activeId", "tabs"],
        )?;
        let path = text(dir, "directory")?;
        if !io::directory(path) || !paths.insert(path) {
            return Err("terminal_catalog_invalid".into());
        }
        let tabs = dir["tabs"]
            .as_array()
            .filter(|v| !v.is_empty() && v.len() <= 64)
            .ok_or("terminal_catalog_invalid")?;
        let mut selected = false;
        for tab in tabs {
            policy::keys(
                tab,
                &[
                    "id",
                    "sessionId",
                    "label",
                    "iconKey",
                    "lifecycle",
                    "createUnknown",
                ],
                &["id", "lifecycle"],
            )?;
            let id = text(tab, "id")?;
            if !io::identifier(id)
                || !ids.insert(id)
                || !matches!(
                    tab["lifecycle"].as_str(),
                    Some("idle" | "running" | "exited")
                )
                || tab
                    .get("sessionId")
                    .is_some_and(|v| v.as_str().is_none_or(|v| !io::identifier(v)))
                || tab
                    .get("label")
                    .is_some_and(|v| v.as_str().is_none_or(|v| v.len() > 1024))
                || tab
                    .get("iconKey")
                    .is_some_and(|v| v.as_str().is_none_or(|v| v.len() > 256))
                || tab.get("createUnknown").is_some_and(|v| !v.is_boolean())
            {
                return Err("terminal_catalog_invalid".into());
            }
            selected |= tab["id"] == dir["activeId"];
        }
        if !selected {
            return Err("terminal_catalog_invalid".into());
        }
    }
    Ok(())
}
fn remember(catalog: &mut Value, directory: &str, owner: &str, id: &str) {
    let dirs = catalog["directories"]
        .as_array_mut()
        .expect("validated catalog");
    let index = dirs
        .iter()
        .position(|dir| dir["directory"] == directory)
        .unwrap_or_else(|| {
            dirs.push(json!({"directory":directory,"activeId":owner,"tabs":[]}));
            dirs.len() - 1
        });
    let tabs = dirs[index]["tabs"].as_array_mut().expect("validated tabs");
    if let Some(tab) = tabs.iter_mut().find(|tab| tab["id"] == owner) {
        tab["sessionId"] = json!(id);
        tab["lifecycle"] = json!("running");
        if let Some(value) = tab.as_object_mut() {
            value.remove("createUnknown");
        }
    } else {
        tabs.push(json!({"id":owner,"sessionId":id,"lifecycle":"running"}));
    }
}
fn forget(catalog: &mut Value, owner: &str) {
    for dir in catalog["directories"]
        .as_array_mut()
        .expect("validated catalog")
    {
        for tab in dir["tabs"].as_array_mut().expect("validated tabs") {
            if tab["id"] == owner {
                tab["lifecycle"] = json!("exited");
                if let Some(value) = tab.as_object_mut() {
                    value.remove("sessionId");
                    value.remove("createUnknown");
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "terminal_host_tests.rs"]
mod tests;

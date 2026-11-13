//! A bounded actor owns the secure store, connection authority, HTTP jobs and SSE streams.
//! Host callbacks only move payloads/replies into this queue; no I/O runs on the engine thread.
use crate::{
    appearance, attachments, host_services,
    policy::{self, BODY_LIMIT, Result},
    resources,
    vault::{self, Vault},
};
use nsh_core::platform::{FetchEvent, HttpHead, HttpRequest};
use nsh_engine::{FetchTask, HostChannel, HostReply, Network};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, SyncSender},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const METHODS: &[&str] = &["GET", "POST", "PUT", "PATCH", "DELETE"];
const HANDLED: &[&str] = &[
    "connection.list",
    "connection.connect",
    "connection.editor",
    "connection.rename",
    "connection.edit",
    "connection.select",
    "connection.remove",
    "authorization.cache.ready",
    "authorization.cache.list",
    "authorization.cache.claim",
    "authorization.cache.ack",
    "authorization.cache.retry",
    "runtime.request",
    "runtime.stream",
    "runtime.stop",
    "runtime.stream.capabilities",
    "runtime.http.capabilities",
    "runtime.http.request",
    "runtime.http.cancel",
    "desktop.writer.capabilities",
    "desktop.writer.acquire",
    "desktop.writer.release",
    "desktop.writer.renew",
    "appearance.reset",
    "appearance.apply",
    "native.clientMetadata",
    "native.diagnostics.status",
    "native.diagnostics.setEnabled",
    "resources.read",
    "resources.release",
    "resources.cancel",
    "resources.close",
];
const QUEUE: usize = 64;
const MAX_HTTP: usize = 8;
#[path = "attachment_transport.rs"]
mod attachment_transport;
#[path = "connection_actor.rs"]
mod connection_actor;
#[path = "connection_actor_http.rs"]
mod connection_actor_http;
#[path = "connection_actor_storage.rs"]
mod connection_actor_storage;
#[path = "connection_editor.rs"]
mod editor;
#[path = "http_jobs.rs"]
mod http_jobs;
#[path = "http_receipts.rs"]
mod http_receipts;
#[path = "notification_retirement.rs"]
mod notification_retirement;
#[path = "history_retirement.rs"]
mod history_retirement;
#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "Staged native process/context API; public writable-window producer awaits journal and writer grants"
    )
)]
#[path = "window_process.rs"]
pub(crate) mod process;
#[path = "runtime_stream.rs"]
mod runtime_stream;
#[path = "window_writer.rs"]
mod writer;

enum Message {
    Call(String, Value, HostReply),
    Event(u64, FetchEvent),
    Upload(attachment_transport::Pending),
    Shutdown,
    RefreshNotifications,
    Native(crate::connection_actor_port::Command),
    NativeHttp(crate::connection_actor_http_port::Pending),
}
pub struct Owner {
    shutting_down: bool,
    shared_lane: bool,
    tx: SyncSender<Message>,
    stop: Arc<AtomicBool>,
    actor_stop: Arc<AtomicBool>,
    actor_done: Arc<AtomicBool>,
    services: host_services::Port,
    attachments: Option<attachments::Owner>,
    native_port: crate::connection_actor_port::Port,
    #[cfg_attr(
        not(test),
        allow(
            dead_code,
            reason = "Retained Rust-only sync port for the separately owned sensitive-sync adapter"
        )
    )]
    native_http_port: crate::connection_actor_http_port::Port,
    ssh: Option<crate::native_ssh_bridge::Control>,
}
impl Owner {
    pub(crate) fn window_coordination(&self) -> &'static str {
        if self.shared_lane {
            "multi-engine"
        } else {
            "single-engine"
        }
    }
    pub(crate) fn begin_shutdown(&mut self) {
        if std::mem::replace(&mut self.shutting_down, true) {
            return;
        }
        self.stop.store(true, Ordering::Release);
        self.services.shutdown();
        self.attachments.take();
        let stopped = self.actor_stop.clone();
        let tx = self.tx.clone();
        let finish = Box::new(move || {
            stopped.store(true, Ordering::Release);
            let _ = tx.try_send(Message::Shutdown);
        });
        if let Some(ssh) = self.ssh.take() {
            ssh.after_stopped(finish);
            ssh.shutdown();
        } else {
            finish();
        }
    }
    pub(crate) fn stopped(&self) -> bool {
        self.actor_done.load(Ordering::Acquire)
    }
    #[cfg_attr(
        not(test),
        allow(
            dead_code,
            reason = "Sensitive-sync adapter is blocked on a verified native local-service source"
        )
    )]
    pub(crate) fn connection_actor_http_port(&self) -> crate::connection_actor_http_port::Port {
        self.native_http_port.clone()
    }
    pub(crate) fn install_ssh(
        &mut self,
        driver: crate::ssh::Result<Arc<dyn crate::ssh::Driver>>,
        version: String,
    ) -> Result<()> {
        if self.shared_lane {
            return Err("ssh_process_singleton_required".into());
        }
        if self.ssh.is_some() {
            return Err("ssh_install_not_available".into());
        }
        let control =
            crate::native_ssh_bridge::install(self.connection_actor_port(), driver, version)?;
        self.services.install_ssh(control.clone())?;
        self.ssh = Some(control);
        Ok(())
    }
    #[cfg_attr(
        not(test),
        allow(
            dead_code,
            reason = "native SSH adapter obtains this Rust-only port when installed"
        )
    )]
    pub(crate) fn connection_actor_port(&self) -> crate::connection_actor_port::Port {
        self.native_port.clone()
    }
    pub(crate) fn install_notifications(
        &self,
        host: &HostChannel,
        storage: crate::notifications::Store,
        factory: crate::notifications::Factory,
    ) -> Result<crate::notifications::UiInbox> {
        let inbox = self
            .services
            .install_notifications(host, storage, factory)?;
        self.tx
            .try_send(Message::RefreshNotifications)
            .map_err(|_| "notification_host_busy")?;
        Ok(inbox)
    }
    pub(crate) fn services(&self) -> host_services::Port {
        self.services.clone()
    }
    pub(crate) fn install_attachments(
        &mut self,
        host: &HostChannel,
        picker: attachments::Port,
    ) -> Result<()> {
        if self.attachments.is_some() {
            return Err("attachment_install_not_available".into());
        }
        let transport = Arc::new(attachment_transport::NativeTransport {
            tx: self.tx.clone(),
            authority: self.services.reader(),
            stop: self.stop.clone(),
        });
        self.attachments = Some(attachments::install(host, transport, picker));
        Ok(())
    }
}
impl Drop for Owner {
    fn drop(&mut self) {
        self.begin_shutdown();
    }
}

#[cfg(test)]
fn install_with(
    host: &HostChannel,
    capabilities: &Value,
    vault: Box<dyn Vault>,
    network: Arc<dyn Network>,
    loopback: bool,
) -> Result<Owner> {
    install_configured(
        host,
        capabilities,
        vault,
        network,
        loopback,
        appearance::metadata(&Value::Null),
        appearance::Port::unavailable(),
    )
}
#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "Injected legacy synthetic harness; production owns one Process"
    )
)]
pub(crate) fn install_configured(
    host: &HostChannel,
    capabilities: &Value,
    vault: Box<dyn Vault>,
    network: Arc<dyn Network>,
    loopback: bool,
    metadata: Value,
    ui: appearance::Port,
) -> Result<Owner> {
    install_target(
        host,
        capabilities,
        vault,
        network,
        loopback,
        metadata,
        ui,
        None,
    )
}
#[allow(clippy::too_many_arguments)]
#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "Injected legacy synthetic harness; production owns one Process"
    )
)]
fn install_target(
    host: &HostChannel,
    capabilities: &Value,
    vault: Box<dyn Vault>,
    network: Arc<dyn Network>,
    loopback: bool,
    metadata: Value,
    ui: appearance::Port,
    target: Option<String>,
) -> Result<Owner> {
    let Built {
        mut actor,
        rx,
        owner,
    } = assemble_target(
        host,
        capabilities,
        vault,
        network,
        loopback,
        metadata,
        ui,
        target,
    )?;
    let stopped = owner.actor_stop.clone();
    let admission = owner.stop.clone();
    let done = owner.actor_done.clone();
    let worker = std::thread::Builder::new()
        .name("yuri-native-host".into())
        .spawn(move || {
            while !stopped.load(Ordering::Acquire) {
                if actor.native_poison.load(Ordering::Acquire) && !actor.quarantined {
                    actor.native_quarantine();
                }
                match rx.recv_timeout(Duration::from_millis(100)) {
                    Ok(message) => {
                        if !actor.receive(message, admission.load(Ordering::Acquire)) {
                            break;
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }
                actor.tick();
            }
            actor.quarantined = true;
            actor.invalidate();
        })
        .map_err(|_| "host_worker_failed")?;
    let failed_start = owner.actor_stop.clone();
    std::thread::Builder::new()
        .name("yuri-native-host-join".into())
        .spawn(move || {
            // The next Dock-open must not start another Vault writer while the prior actor's
            // fields or thread-local destructors still own its transaction lane.
            if worker.join().is_ok() {
                done.store(true, Ordering::Release);
            }
        })
        .map_err(|_| {
            failed_start.store(true, Ordering::Release);
            "host_join_worker_failed"
        })?;
    Ok(owner)
}
struct Built {
    actor: Actor,
    rx: mpsc::Receiver<Message>,
    owner: Owner,
}
#[allow(clippy::too_many_arguments)]
fn assemble_target(
    host: &HostChannel,
    capabilities: &Value,
    vault: Box<dyn Vault>,
    network: Arc<dyn Network>,
    loopback: bool,
    metadata: Value,
    ui: appearance::Port,
    target: Option<String>,
) -> Result<Built> {
    let names = capabilities
        .get("host")
        .and_then(Value::as_array)
        .ok_or("host_capabilities_missing")?;
    if names.iter().any(|v| v.as_str().is_none()) {
        return Err("host_capabilities_invalid".into());
    }
    let (tx, rx) = mpsc::sync_channel(QUEUE);
    let stop = Arc::new(AtomicBool::new(false));
    let actor_stop = Arc::new(AtomicBool::new(false));
    let actor_done = Arc::new(AtomicBool::new(false));
    let mut actor = Actor::new(host.clone(), tx.clone(), vault, network);
    actor.restore_target = target;
    actor.loopback = loopback;
    actor.metadata = metadata;
    actor.ui = ui;
    let services = actor.services.clone();
    services.bind_admission(stop.clone())?;
    let native_poison = actor.native_poison.clone();
    let poison = native_poison.clone();
    let poisoned_services = services.clone();
    let native_tx = tx.clone();
    let native_stop = stop.clone();
    let submit_poison = native_poison.clone();
    let native_port = crate::connection_actor_port::Port::with_poison(
        Arc::new(move |command| {
            // Poisoned calls still traverse the original FIFO: an admitted durable write
            // ahead of them may finish. The actor returns CommitUnknown without new I/O;
            // an eager reply here would falsely appear to ACK that write's retirement.
            if native_stop.load(Ordering::Acquire)
                && !submit_poison.load(Ordering::Acquire)
                && !matches!(
                    &command,
                    crate::connection_actor_port::Command::Retire { .. }
                        | crate::connection_actor_port::Command::Quarantine(_)
                )
            {
                return Err(crate::connection_actor_port::Error::Unavailable);
            }
            native_tx
                .try_send(Message::Native(command))
                .map_err(|e| match e {
                    mpsc::TrySendError::Full(_) => crate::connection_actor_port::Error::Busy,
                    mpsc::TrySendError::Disconnected(_) => {
                        crate::connection_actor_port::Error::Unavailable
                    }
                })
        }),
        Arc::new(move || {
            poison.store(true, Ordering::Release);
            poisoned_services.shutdown();
        }),
    );
    let raw_tx = tx.clone();
    let raw_stop = stop.clone();
    let native_http_port = crate::connection_actor_http_port::Port::new(Arc::new(move |work| {
        use crate::connection_actor_http_port::Error;
        if raw_stop.load(Ordering::Acquire) {
            return Err(Error::Unavailable);
        }
        raw_tx
            .try_send(Message::NativeHttp(work))
            .map_err(|e| match e {
                mpsc::TrySendError::Full(_) => Error::Busy,
                mpsc::TrySendError::Disconnected(_) => Error::Unavailable,
            })
    }));
    for name in names {
        let name = name.as_str().ok_or("host_capabilities_invalid")?;
        if HANDLED.contains(&name) || crate::native_ssh_bridge::METHODS.contains(&name) || crate::open_in_apps::METHODS.contains(&name) {
            let tx = tx.clone();
            host.handle(name, move |mut call| {
                let name = call.name().to_owned();
                let value = call.take_data();
                if let Some(reply) = call.into_reply()
                    && let Err(
                        mpsc::TrySendError::Full(Message::Call(_, _, reply))
                        | mpsc::TrySendError::Disconnected(Message::Call(_, _, reply)),
                    ) = tx.try_send(Message::Call(name, value, reply))
                {
                    reply.reject("native_host_busy");
                }
            });
        } else {
            host.handle(name, |call| call.reject("unsupported_desktop_capability"));
        }
    }
    let owner = Owner {
        shutting_down: false,
        shared_lane: false,
        tx,
        stop,
        actor_stop,
        actor_done,
        services,
        attachments: None,
        native_port,
        native_http_port,
        ssh: None,
    };
    Ok(Built { actor, rx, owner })
}

#[derive(Clone)]
struct Connection {
    id: String,
    label: String,
    url: String,
    token: String,
    used: f64,
    authorization: String,
    editor_version: Option<String>,
}
impl Connection {
    fn public(&self) -> Value {
        json!({"id":self.id,"label":self.label,"url":self.url,"transport":"direct","lastUsedAt":self.used,"authorizationID":self.authorization})
    }
    fn saved(&self) -> Value {
        let mut v = self.public();
        v["token"] = json!(self.token);
        if let Some(version) = &self.editor_version {
            v["editorVersion"] = json!(version);
        }
        v
    }
    fn read(value: &Value, loopback: bool) -> Result<Self> {
        policy::keys(
            value,
            &[
                "id",
                "label",
                "url",
                "transport",
                "lastUsedAt",
                "authorizationID",
                "token",
                "editorVersion",
            ],
            &[
                "id",
                "label",
                "url",
                "transport",
                "lastUsedAt",
                "authorizationID",
                "token",
            ],
        )?;
        if value["transport"] != "direct" {
            return Err("secure_store_invalid".into());
        }
        let id = policy::string(value, "id")?.to_owned();
        let authorization = policy::string(value, "authorizationID")?.to_owned();
        if id.len() > 128
            || authorization.len() > 128
            || !id
                .bytes()
                .chain(authorization.bytes())
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err("secure_store_invalid".into());
        }
        let token = policy::optional_string(value, "token")?.to_owned();
        policy::token(&token)?;
        let label = policy::optional_string(value, "label")?.to_owned();
        if label.len() > 512 || label.chars().any(char::is_control) {
            return Err("secure_store_invalid".into());
        }
        let editor_version = match value.get("editorVersion") {
            None | Some(Value::Null) => None,
            Some(Value::String(version))
                if !version.is_empty()
                    && version.len() <= 128
                    && version
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') =>
            {
                Some(version.clone())
            }
            _ => return Err("secure_store_invalid".into()),
        };
        Ok(Self {
            id,
            authorization,
            editor_version,
            label,
            token,
            url: policy::origin(policy::string(value, "url")?, loopback)?,
            used: value["lastUsedAt"]
                .as_f64()
                .filter(|n| *n >= 0.0)
                .ok_or("secure_store_invalid")?,
        })
    }
}

#[derive(Clone, Default)]
struct State {
    connections: Vec<Connection>,
    selected: Option<String>,
    scope: Option<Value>,
    notification_retirements: notification_retirement::Pending,
    notification_error: Option<String>,
    native: connection_actor_storage::Native,
    extra: serde_json::Map<String, Value>,
}
impl State {
    fn current(&self) -> Result<Connection> {
        self.connections
            .iter()
            .find(|c| Some(&c.id) == self.selected.as_ref())
            .cloned()
            .ok_or_else(|| "runtime_host_unavailable".into())
    }
    fn snapshot(&self) -> Value {
        let mut records = self.connections.clone();
        records.sort_by(|a, b| b.used.total_cmp(&a.used));
        let mut snapshot = json!({"connections": records.iter().map(Connection::public).collect::<Vec<_>>(), "selected":self.selected, "runtimeScope":self.scope});
        if !self.notification_retirements.is_empty() || self.notification_error.is_some() {
            snapshot["notificationRetirement"] = json!({"pending":self.notification_retirements.len(),"error":self.notification_error});
        }
        snapshot
    }
    fn admit(&self, expected: Option<&Value>, required: bool) -> Result<Value> {
        if required && expected.is_none() {
            return Err("runtime_host_scope_required".into());
        }
        let expected = expected.map(policy::scope).transpose()?;
        let current = self.scope.as_ref().ok_or("runtime_host_unavailable")?;
        if expected.as_ref().is_some_and(|s| s != current) {
            return Err("runtime_host_scope_stale".into());
        }
        self.current()?;
        Ok(current.clone())
    }
    fn rotate(&mut self) -> Result<()> {
        self.scope = self
            .selected
            .as_ref()
            .map(|id| vault::id().map(|lease| json!({"hostID":id,"lease":lease})))
            .transpose()?;
        Ok(())
    }
    fn persist(&self, vault: &dyn Vault) -> Result<()> {
        let mut record = Value::Object(self.extra.clone());
        record["version"] = json!(1);
        record["connections"] = json!(
            self.connections
                .iter()
                .map(Connection::saved)
                .collect::<Vec<_>>()
        );
        record["selected"] = json!(self.selected);
        self.native.write(&mut record);
        if !self.notification_retirements.is_empty() {
            record["notificationRetirements"] =
                notification_retirement::encoded(&self.notification_retirements);
        }
        let bytes = serde_json::to_vec(&record).map_err(|_| "secure_store_encode_failed")?;
        if bytes.len() > 64 * 1024 {
            return Err("secure_store_capacity".into());
        }
        vault.write(&bytes)
    }
    fn load(vault: &dyn Vault, loopback: bool) -> Result<Self> {
        let Some(bytes) = vault.read()? else {
            return Ok(Self::default());
        };
        if bytes.len() > 64 * 1024 {
            return Err("secure_store_invalid".into());
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| "secure_store_invalid")?;
        let mut extra = policy::object(&value)?.clone();
        for key in [
            "version",
            "connections",
            "selected",
            "notificationRetirements",
            "sshRegistry",
            "sshNative",
        ] {
            extra.remove(key);
        }
        let native =
            connection_actor_storage::Native::read(&value).map_err(|_| "secure_store_invalid")?;
        if value["version"] != 1 {
            return Err("secure_store_invalid".into());
        }
        let records = value["connections"]
            .as_array()
            .filter(|r| r.len() <= 32)
            .ok_or("secure_store_invalid")?;
        let connections = records
            .iter()
            .map(|v| {
                Connection::read(
                    v,
                    loopback
                        || v["id"]
                            .as_str()
                            .is_some_and(|id| native.binding(id).is_some()),
                )
            })
            .collect::<Result<Vec<_>>>()?;
        let selected = match &value["selected"] {
            Value::Null => None,
            Value::String(s) => Some(s.clone()),
            _ => return Err("secure_store_invalid".into()),
        };
        if connections.iter().enumerate().any(|(i, c)| {
            connections[..i].iter().any(|prior| {
                prior.id == c.id
                    || (prior.url == c.url
                        && native.binding(&prior.id).is_none()
                        && native.binding(&c.id).is_none())
            })
        }) || selected
            .as_ref()
            .is_some_and(|s| !connections.iter().any(|c| &c.id == s))
        {
            return Err("secure_store_invalid".into());
        }
        let mut state = Self {
            connections,
            selected,
            scope: None,
            notification_retirements: notification_retirement::read(
                value.get("notificationRetirements"),
            )?,
            notification_error: None,
            native,
            extra,
        };
        if history_retirement::pending(&state)?.iter().any(|(host, authorization)|
            state.connections.iter().any(|c| &c.id == host && &c.authorization == authorization)) {
            return Err("secure_store_invalid".into());
        }
        if state
            .notification_retirements
            .iter()
            .any(|(host, authorization)| {
                state
                    .connections
                    .iter()
                    .any(|c| &c.id == host && &c.authorization == authorization)
            })
        {
            return Err("secure_store_invalid".into());
        }
        state.rotate()?;
        state.native.check(&state.connections)?;
        // Persisted SSH loopback endpoints are not live forward grants.
        if state
            .selected
            .as_deref()
            .is_some_and(|id| state.native.binding(id).is_some())
        {
            state.scope = None;
        }
        Ok(state)
    }
}

enum Completion {
    NativeHttp(Box<connection_actor_http::Pending>),
    HttpReceipt {
        key: http_receipts::Key,
        ticket: u64,
        writer_grant: Option<String>,
    },
    Native(Box<connection_actor::Pending>),
    Request {
        scope: Value,
        writer_grant: Option<String>,
    },
    Upload {
        scope: Value,
        reply: SyncSender<attachments::UploadResult>,
    },
    Resource {
        read: resources::Read,
        stat: bool,
    },
    Connect {
        candidate: Connection,
        attempt: u64,
        epoch: u64,
        unlock: bool,
        editing: Option<editor::Target>,
    },
}
struct Job {
    writer: Option<writer::Guard>,
    task: Box<dyn FetchTask>,
    reply: HostReply,
    completion: Completion,
    path: String,
    url: String,
    head: Option<HttpHead>,
    bytes: Vec<u8>,
    deadline: Instant,
    overflow: Arc<AtomicBool>,
    limit: usize,
}
struct Stream {
    path: String,
    scope: Value,
    task: Option<Box<dyn FetchTask>>,
    ticket: u64,
    ready: bool,
    parser: Sse,
    retry: Instant,
    failures: u32,
    permanent: bool,
    overflow: Arc<AtomicBool>,
}
struct Actor {
    writer: Option<writer::Port>,
    process_view: bool,
    restore_target: Option<String>,
    restore_failed: bool,
    host: HostChannel,
    tx: SyncSender<Message>,
    vault: Box<dyn Vault>,
    network: Arc<dyn Network>,
    state: Option<State>,
    epoch: u64,
    attempt: u64,
    ticket: u64,
    jobs: HashMap<u64, Job>,
    streams: HashMap<String, Stream>,
    loopback: bool,
    resources: resources::Book,
    ui: appearance::Port,
    appearance_revision: u64,
    metadata: Value,
    quarantined: bool,
    native_receipts: std::collections::HashSet<String>,
    native_poison: Arc<AtomicBool>,
    http_receipts: http_receipts::Book,
    history_cleanup: history_retirement::Cleanup,
    #[cfg(test)]
    browser: crate::browser_view::Port,
    services: host_services::Port,
}
impl Actor {
    fn receive(&mut self, message: Message, admission_closed: bool) -> bool {
        match message {
            Message::Shutdown => return false,
            Message::Call(name, value, reply) => {
                if admission_closed && (self.process_view || name != "desktop.ssh.capabilities") {
                    reply.reject("native_host_unavailable");
                } else {
                    self.call(&name, value, reply);
                }
            }
            Message::Event(id, event) => self.event(id, event),
            Message::Upload(upload) => self.upload(upload),
            Message::Native(command) => self.native_command(command),
            Message::NativeHttp(work) => self.native_http(work),
            Message::RefreshNotifications => {
                if self.state.is_some() {
                    self.recover_notification_retirements();
                    self.authorize_services();
                }
            }
        }
        true
    }
    fn new(
        host: HostChannel,
        tx: SyncSender<Message>,
        vault: Box<dyn Vault>,
        network: Arc<dyn Network>,
    ) -> Self {
        let services = host_services::Port::new(network.clone());
        Self {
            writer: None,
            process_view: false,
            restore_target: None,
            restore_failed: false,
            host,
            tx,
            vault,
            #[cfg(test)]
            browser: services.browser(),
            services,
            network,
            state: None,
            epoch: 0,
            attempt: 0,
            ticket: 0,
            jobs: HashMap::new(),
            streams: HashMap::new(),
            loopback: false,
            resources: resources::Book::default(),
            ui: appearance::Port::unavailable(),
            appearance_revision: 0,
            metadata: appearance::metadata(&Value::Null),
            quarantined: false,
            native_receipts: std::collections::HashSet::new(),
            native_poison: Arc::new(AtomicBool::new(false)),
            http_receipts: Default::default(),
            history_cleanup: Default::default(),
        }
    }
    fn load(&mut self) -> Result<()> {
        self.load_with_native(None)
    }
    fn load_with_native(&mut self, native: Option<&connection_actor_storage::Native>) -> Result<()> {
        if self.quarantined {
            return Err(vault::COMMIT_UNKNOWN.into());
        }
        if self.state.is_none() {
            let mut state = State::load(&*self.vault, self.loopback)?;
            if let Some(native) = native { state.native.inherit_live(native); }
            if let Some(target) = &self.restore_target {
                if state.connections.iter().any(|c| &c.id == target) {
                    state.selected = Some(target.clone());
                    state.rotate()?;
                    // SSH loopback authority is never recovered from a saved endpoint alone.
                    if !self.native_selected_live(&state) {
                        state.scope = None;
                    }
                    self.restore_failed = state.scope.is_none();
                } else {
                    state.selected = None;
                    state.scope = None;
                    self.restore_failed = true;
                }
            }
            self.state = Some(state);
            if self.restore_failed {
                return Err("window_restore_target_unavailable".into());
            }
            self.recover_notification_retirements();
            self.authorize_services();
        }
        if self.restore_failed {
            return Err("window_restore_target_unavailable".into());
        }
        Ok(())
    }
    fn authorize_services(&self) {
        if self.restore_failed
            || self.quarantined
            || self.native_poison.load(Ordering::Acquire)
            || (self.services.notifications().is_some()
                && (!self.state().notification_retirements.is_empty()
                    || self.state().notification_error.as_deref()
                        == Some("notification_store_unknown")))
        {
            return;
        }
        if let Some(scope) = self.state().scope.as_ref()
            && let Ok(connection) = self.state().current()
        {
            // Native-only, after durable restoration/commit. Browser failure cannot roll back
            // a valid connection; its component reports unavailable authority independently.
            self.services.publish(
                scope,
                &connection.url,
                &connection.token,
                &connection.authorization,
                self.loopback || self.state().native.binding(&connection.id).is_some(),
            );
        }
    }
    fn state(&self) -> &State {
        self.state.as_ref().expect("loaded before admission")
    }
    fn next(&mut self) -> u64 {
        self.ticket += 1;
        self.ticket
    }
    fn invalidate(&mut self) {
        self.services.invalidate();
        self.epoch += 1;
        self.attempt += 1;
        self.resources.invalidate();
        self.appearance_revision += 1;
        self.ui.invalidate();
        for (ticket, job) in std::mem::take(&mut self.jobs) {
            if !self.quarantined
                && matches!(&job.completion,Completion::Native(p) if p.scope_independent())
            {
                self.jobs.insert(ticket, job);
                continue;
            }
            if !self.quarantined
                && matches!(&job.completion, Completion::NativeHttp(p) if p.valid(self))
            {
                self.jobs.insert(ticket, job);
                continue;
            }
            if let Completion::NativeHttp(pending) = job.completion {
                job.task.cancel();
                pending.fail(crate::connection_actor_http_port::Error::Stale);
                continue;
            }
            if let Completion::Upload { reply, .. } = &job.completion {
                let _ = reply.try_send(attachments::UploadResult::Unknown);
            }
            if let Completion::HttpReceipt { ticket, .. } = &job.completion {
                self.http_receipts.finish(*ticket);
            }
            if let Completion::Native(pending) = job.completion {
                pending.fail(crate::connection_actor_port::Error::Cancelled);
            }
            job.task.cancel();
            job.reply.reject("runtime_host_scope_stale");
        }
        for (_, stream) in self.streams.drain() {
            if let Some(task) = stream.task {
                task.cancel();
            }
        }
    }
    fn commit(&mut self, mut next: State, invalidates: bool) -> Result<Value> {
        next.native.prune(&next.connections);
        notification_retirement::extend(self.state(), &mut next)?;
        let history_pending = history_retirement::extend(self.state(), &mut next)?;
        if invalidates {
            next.rotate()?;
            if !self.native_selected_live(&next) {
                next.scope = None;
            }
        }
        if let Err(error) = next.persist(&*self.vault) {
            if vault::invalidates_authority(&error) {
                self.quarantined = true;
                self.invalidate();
                self.state = None;
            }
            return Err(error);
        }
        if invalidates {
            self.invalidate();
        }
        self.state = Some(next);
        if history_pending { let _ = self.host.send("authorization.cache.pending", json!({})); }
        let retained: std::collections::HashSet<_> = self
            .state()
            .native
            .bindings
            .iter()
            .map(|b| b.receipt.clone())
            .collect();
        self.native_receipts.retain(|r| retained.contains(r));
        self.retire_native_http_stale();
        self.recover_notification_retirements();
        if invalidates {
            self.authorize_services();
        }
        Ok(self.state().snapshot())
    }
    fn call(&mut self, name: &str, value: Value, reply: HostReply) {
        if crate::open_in_apps::METHODS.contains(&name) {
            let catalog = crate::open_in_apps::Catalog::native();
            match name {
                "desktop.openInApps.scan" => catalog.scan(&value, reply),
                "desktop.openInApps.capabilities" => reply.reply(crate::open_in_apps::Catalog::capabilities(&value)),
                "desktop.openInApps.read" => reply.reply(catalog.read(&value)),
                "desktop.openInApps.select" => reply.reply(catalog.select(&value)),
                _ => reply.reply(catalog.denied_open(&value, self.state.as_ref().and_then(|state| state.scope.as_ref()))),
            }
            return;
        }
        if writer::METHODS.contains(&name) {
            reply.reply(self.writer_call(name, &value));
            return;
        }
        if crate::native_ssh_bridge::METHODS.contains(&name) {
            if let Some(ssh) = self.services.ssh() {
                ssh.call(name, value, reply);
            } else {
                reply.reject("ssh_unavailable");
            }
            return;
        }
        if name == "runtime.http.capabilities" {
            reply.reply(self.http_capabilities(&value));
            return;
        }
        if name == "runtime.stream.capabilities" {
            reply.reply(policy::keys(&value, &[], &[]).map(|_| runtime_stream::capabilities()));
            return;
        }
        if name.starts_with("native.") {
            reply.reply(match name {
                "native.clientMetadata" => {
                    policy::keys(&value, &[], &[]).map(|_| self.metadata.clone())
                }
                "native.diagnostics.status" => {
                    policy::keys(&value, &[], &[]).map(|_| appearance::disabled_diagnostics())
                }
                "native.diagnostics.setEnabled" => (|| {
                    policy::keys(&value, &["enabled"], &["enabled"])?;
                    if value["enabled"] != false {
                        return Err("unsupported_desktop_diagnostics_recording".into());
                    }
                    Ok(appearance::disabled_diagnostics())
                })(),
                _ => Err("unsupported_desktop_capability".into()),
            });
            return;
        }
        if name.starts_with("appearance.") {
            let selected = self.state.as_ref().and_then(|s| s.selected.as_deref());
            let command = match name {
                "appearance.reset" => appearance::reset(&value, selected).map(|_| {
                    self.appearance_revision += 1;
                    self.ui.invalidate();
                    appearance::Command::Reset {
                        revision: self.appearance_revision,
                    }
                }),
                "appearance.apply" => {
                    appearance::decode(&value, selected, self.appearance_revision)
                        .map(appearance::Command::Apply)
                }
                _ => Err("unsupported_desktop_capability".into()),
            };
            match command {
                Ok(command) => self.ui.submit(command, reply),
                Err(e) => reply.reject(e),
            }
            return;
        }
        if ["resources.release", "resources.close", "resources.cancel"].contains(&name) {
            let result = if name == "resources.cancel" {
                self.resources.cancel(&value).map(|id| {
                    if let Some(id)=id {
                        let jobs:Vec<_>=self.jobs.iter().filter(|(_,job)|matches!(&job.completion,Completion::Resource {read,..} if read.request==id)).map(|(ticket,_)|*ticket).collect();
                        for ticket in jobs {if let Some(job)=self.jobs.remove(&ticket) {self.fail_job(job,"resource_read_cancelled");}}
                    } json!(true)
                })
            } else {
                self.resources.cleanup(name, &value)
            };
            reply.reply(result);
            return;
        }
        if let Err(e) = self.load() {
            reply.reject(e);
            return;
        }
        // Serialization and validation are off the engine thread. No caller-defined headers/URL auth.
        if serde_json::to_vec(&value).map_or(true, |v| v.len() > BODY_LIMIT) {
            reply.reject("request_body_limit");
            return;
        }
        match name {
            "runtime.http.request" => self.http_request(value, reply),
            "runtime.request" => self.request(value, reply),
            "connection.connect" => self.connect(value, reply),
            "resources.read" => self.resource_read(value, reply),
            _ => reply.reply(self.immediate(name, &value)),
        }
    }
    fn immediate(&mut self, name: &str, value: &Value) -> Result<Value> {
        match name {
            name if name.starts_with("authorization.cache.") => self.history_cleanup(name, value),
            "runtime.http.cancel" => self.http_cancel(value),
            "connection.editor" => editor::descriptor(self.state(), value),
            "connection.rename" | "connection.edit" => {
                if name == "connection.edit"
                    && value.get("url").is_some()
                    && value["id"]
                        .as_str()
                        .is_some_and(|id| self.state().native.binding(id).is_some())
                {
                    return Err("ssh_authorization_required".into());
                }
                match editor::editing(self.state(), name, value)? {
                    Some(next) => self.commit(next, false).map_err(editor::storage),
                    None => Ok(self.state().snapshot()),
                }
            }
            "connection.list" => {
                policy::keys(value, &[], &[])?;
                self.recover_notification_retirements();
                self.authorize_services();
                Ok(self.state().snapshot())
            }
            "connection.select" | "connection.remove" => {
                policy::keys(value, &["id"], &["id"])?;
                let id = policy::string(value, "id")?;
                let mut next = self.state().clone();
                let index = next
                    .connections
                    .iter()
                    .position(|c| c.id == id)
                    .ok_or("connection_not_found")?;
                let invalidates =
                    name == "connection.select" || next.selected.as_deref() == Some(id);
                if name == "connection.select" {
                    if !self.native_connection_live(id) {
                        return Err("ssh_authorization_required".into());
                    }
                    next.selected = Some(id.into());
                    next.connections[index].used = now();
                } else {
                    next.connections.remove(index);
                    if invalidates {
                        next.selected = None;
                    }
                }
                self.commit(next, invalidates)
            }
            "runtime.stream" => {
                policy::keys(
                    value,
                    &["path", "key", "expectedHost"],
                    &["path", "key", "expectedHost"],
                )?;
                let key = runtime_stream::key(value)?;
                let path = policy::string(value, "path")?;
                policy::route(path, false)?;
                if path != "/api/yuri/events" && !path.starts_with("/api/event?") {
                    return Err("unsupported_event_stream".into());
                }
                let scope = self.state().admit(value.get("expectedHost"), true)?;
                if runtime_stream::is_panel(key) {
                    runtime_stream::panel_path(path)?;
                    if let Some(prior) = self.streams.get(key) {
                        if prior.path != path || prior.scope != scope {
                            return Err("runtime_stream_target_mismatch".into());
                        }
                        return Ok(json!(true));
                    }
                    if self
                        .streams
                        .keys()
                        .filter(|key| runtime_stream::is_panel(key))
                        .count()
                        >= runtime_stream::MAX_PANEL_STREAMS
                    {
                        return Err("runtime_stream_capacity".into());
                    }
                }
                if let Some(prior) = self.streams.remove(key)
                    && let Some(task) = prior.task
                {
                    task.cancel();
                }
                self.streams.insert(
                    key.into(),
                    Stream {
                        path: path.into(),
                        scope,
                        task: None,
                        ticket: 0,
                        ready: false,
                        parser: Sse::default(),
                        retry: Instant::now(),
                        failures: 0,
                        permanent: false,
                        overflow: Arc::new(AtomicBool::new(false)),
                    },
                );
                self.start_stream(key)?;
                Ok(json!(true))
            }
            "runtime.stop" => {
                policy::keys(value, &["key", "expectedHost"], &["key", "expectedHost"])?;
                let key = runtime_stream::key(value)?;
                let expected = policy::scope(&value["expectedHost"])?;
                if runtime_stream::is_panel(key) {
                    self.state().admit(Some(&expected), true)?;
                }
                // Cleanup has no authority to cancel the same key belonging to a newer lease.
                if self.streams.get(key).is_some_and(|s| s.scope == expected)
                    && let Some(s) = self.streams.remove(key)
                    && let Some(task) = s.task
                {
                    task.cancel();
                }
                Ok(json!(true))
            }
            _ => Err("unsupported_desktop_capability".into()),
        }
    }
    fn request(&mut self, value: Value, reply: HostReply) {
        let parsed = (|| -> Result<_> {
            policy::keys(
                &value,
                &["path", "method", "body", "expectedHost", "writerGrant"],
                &["path"],
            )?;
            let path = policy::string(&value, "path")?.to_owned();
            let method = match value.get("method") {
                None => "GET",
                Some(Value::String(s)) => s,
                _ => return Err("invalid_http_method".into()),
            };
            if !METHODS.contains(&method) {
                return Err("invalid_http_method".into());
            }
            let scope = self
                .state()
                .admit(value.get("expectedHost"), method != "GET")?;
            let request = make_request(
                &self.state().current()?,
                &path,
                method,
                value.get("body"),
                false,
            )?;
            Ok((path, scope, request, writer::grant(&value)?))
        })();
        match parsed {
            Ok((path, scope, request, writer_grant)) => self.start_job(
                path,
                request,
                Completion::Request {
                    scope,
                    writer_grant,
                },
                reply,
            ),
            Err(e) => reply.reject(e),
        }
    }
    fn connect(&mut self, value: Value, reply: HostReply) {
        let parsed: Result<(
            Connection,
            bool,
            String,
            HttpRequest,
            Option<editor::Target>,
        )> = (|| {
            // Pairing/Relay are explicit unsupported transports, never silently made direct.
            policy::keys(
                &value,
                &[
                    "url",
                    "token",
                    "password",
                    "label",
                    "pairingLink",
                    "id",
                    "version",
                ],
                &[],
            )?;
            if !policy::optional_string(&value, "pairingLink")?.is_empty() {
                return Err("unsupported_desktop_pairing".into());
            }
            let editing = editor::replacement(self.state(), &value)?;
            if editing
                .as_ref()
                .is_some_and(|target| self.state().native.binding(&target.id).is_some())
            {
                return Err("ssh_authorization_required".into());
            }
            let url = policy::origin(policy::string(&value, "url")?, self.loopback)?;
            let token = policy::optional_string(&value, "token")?.to_owned();
            policy::token(&token)?;
            let raw_label = policy::optional_string(&value, "label")?;
            let label = if editing.is_some() && value.get("label").is_some() {
                editor::label(raw_label)?
            } else {
                raw_label.to_owned()
            };
            if label.len() > 512 || label.chars().any(char::is_control) {
                return Err("invalid_label".into());
            }
            let candidate = Connection {
                id: String::new(),
                label: if label.is_empty() { url.clone() } else { label },
                url,
                token,
                used: now(),
                authorization: vault::id()?,
                editor_version: Some(vault::id()?),
            };
            let password = policy::optional_string(&value, "password")?;
            if password.len() > 8192 {
                return Err("invalid_password".into());
            }
            let unlock = !password.is_empty();
            let path = if unlock {
                "/auth/session"
            } else {
                "/api/config/settings"
            };
            let body = unlock.then(|| json!({"password":password,"issueClientToken":true,"trustDevice":true,"clientKind":"desktop","clientLabel":"Yuri Native Desktop","devicePlatform":std::env::consts::OS,"appVersion":"0.1.0"}));
            let mut auth_candidate = candidate.clone();
            if unlock {
                auth_candidate.token.clear();
            }
            let request = make_request(
                &auth_candidate,
                path,
                if unlock { "POST" } else { "GET" },
                body.as_ref(),
                unlock,
            )?;
            Ok((candidate, unlock, path.to_owned(), request, editing))
        })();
        match parsed {
            Ok((candidate, unlock, path, request, editing)) => {
                self.attempt += 1;
                self.start_job(
                    path,
                    request,
                    Completion::Connect {
                        candidate,
                        attempt: self.attempt,
                        epoch: self.epoch,
                        unlock,
                        editing,
                    },
                    reply,
                );
            }
            Err(e) => reply.reject(e),
        }
    }
    fn fetch(
        &self,
        ticket: u64,
        request: HttpRequest,
        overflow: Arc<AtomicBool>,
    ) -> Box<dyn FetchTask> {
        let tx = self.tx.clone();
        self.network.fetch(
            request,
            Box::new(move |event| {
                // No blocking callback, including Network implementations that synchronously fail in fetch().
                // A dropped chunk invalidates the whole job; it is never reported as complete success.
                if !overflow.load(Ordering::Acquire)
                    && tx.try_send(Message::Event(ticket, event)).is_err()
                {
                    overflow.store(true, Ordering::Release);
                }
            }),
        )
    }
    fn start_job(
        &mut self,
        path: String,
        request: HttpRequest,
        mut completion: Completion,
        reply: HostReply,
    ) {
        if self.jobs.len() >= MAX_HTTP {
            if let Completion::NativeHttp(pending) = completion {
                pending.fail(crate::connection_actor_http_port::Error::Busy);
                return;
            }
            if let Completion::Native(pending) = completion {
                pending.fail(crate::connection_actor_port::Error::Busy);
                return;
            }
            if let Completion::Upload { reply, .. } = &completion {
                let _ = reply.try_send(attachments::UploadResult::Denied);
            }
            if let Completion::Resource { read, .. } = &completion {
                self.resources.finish(read);
            }
            reply.reject("native_host_busy");
            return;
        }
        let ticket = self.next();
        if let Completion::HttpReceipt {
            key, ticket: bound, ..
        } = &mut completion
        {
            match self.http_receipts.bind(key, ticket) {
                Ok(true) => *bound = ticket,
                Ok(false) => {
                    reply.reject("http_request_cancelled");
                    return;
                }
                Err(e) => {
                    reply.reject(e);
                    return;
                }
            }
        }
        let limit = match &completion {
            Completion::NativeHttp(pending) => pending.limit(),
            Completion::Upload { .. } => attachments::WIRE_LIMIT,
            Completion::Resource { stat: true, .. } => resources::STAT_LIMIT,
            Completion::Resource { stat: false, .. } => resources::TEXT_LIMIT,
            _ => BODY_LIMIT,
        };
        let overflow = Arc::new(AtomicBool::new(false));
        let url = request.url.clone();
        if let Completion::NativeHttp(pending) = &completion
            && let Err(error) = pending.dispatched()
        {
            if let Completion::NativeHttp(pending) = completion {
                pending.fail(error);
            }
            return;
        }
        let timeout = if matches!(&completion, Completion::NativeHttp(_)) {
            crate::connection_actor_http_port::TIMEOUT
        } else {
            Duration::from_secs(30)
        };
        let writer = if let Completion::Request { writer_grant, .. }
        | Completion::HttpReceipt { writer_grant, .. } = &completion
        {
            match self
                .writer
                .as_ref()
                .map(|port| port.admit(self, &path, &request, writer_grant.as_deref()))
                .transpose()
            {
                Ok(guard) => guard.flatten(),
                Err(error) => {
                    reply.reject(error);
                    return;
                }
            }
        } else {
            None
        };
        let task = self.fetch(ticket, request, overflow.clone());
        self.jobs.insert(
            ticket,
            Job {
                writer,
                task,
                reply,
                completion,
                path,
                url,
                head: None,
                bytes: Vec::new(),
                deadline: Instant::now() + timeout,
                overflow,
                limit,
            },
        );
    }
    fn event(&mut self, ticket: u64, event: FetchEvent) {
        if let Some(mut job) = self.jobs.remove(&ticket) {
            if !self.valid_completion(&job.completion) || job.overflow.load(Ordering::Acquire) {
                self.fail_job(job, "runtime_host_scope_stale_or_overflow");
                return;
            }
            let result = match event {
                FetchEvent::Head(head) => {
                    if job.head.is_some() && matches!(&job.completion, Completion::NativeHttp(_)) {
                        Err("raw_sync_duplicate_head".into())
                    } else if head.url != job.url {
                        Err("host_response_origin_mismatch".into())
                    } else {
                        (match &job.completion {
                            Completion::NativeHttp(pending) => pending.head(&head),
                            _ => response_head(&head, &job.path, false),
                        })
                        .and_then(|_| {
                            if head
                                .headers
                                .iter()
                                .filter(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                                .any(|(_, v)| v.parse::<usize>().map_or(true, |v| v > job.limit))
                            {
                                return Err("resource_response_limit".into());
                            }
                            job.head = Some(head);
                            Ok(false)
                        })
                    }
                }
                FetchEvent::Data(data) => {
                    if job.head.is_none() {
                        Err("invalid_host_response".into())
                    } else if data.len() > job.limit - job.bytes.len() {
                        Err("response_body_limit".into())
                    } else {
                        job.bytes.extend(data);
                        Ok(false)
                    }
                }
                FetchEvent::End => Ok(true),
                FetchEvent::Failed(_) => Err("host_network_failed".into()),
                FetchEvent::BodyWanted => Err("invalid_host_response".into()),
            };
            match result {
                Ok(false) => {
                    self.jobs.insert(ticket, job);
                }
                Ok(true) => {
                    self.finish(job);
                }
                Err(e) => {
                    self.fail_job(job, &e);
                }
            }
        } else if let Some(key) = self
            .streams
            .iter()
            .find(|(_, s)| s.ticket == ticket && s.task.is_some())
            .map(|(k, _)| k.clone())
        {
            self.stream_event(&key, event);
        }
    }
    fn valid_completion(&self, completion: &Completion) -> bool {
        match completion {
            Completion::NativeHttp(pending) => pending.valid(self),
            Completion::HttpReceipt { key, ticket, .. } => {
                self.state
                    .as_ref()
                    .is_some_and(|s| s.scope.as_ref() == Some(&key.scope))
                    && self
                        .services
                        .window_id()
                        .is_ok_and(|id| id == key.window_id)
                    && self.http_receipts.current(key, *ticket)
            }
            Completion::Native(pending) => pending.valid(self),
            Completion::Request { scope, .. } | Completion::Upload { scope, .. } => {
                self.state().scope.as_ref() == Some(scope)
            }
            Completion::Resource { read, .. } => {
                self.state().scope.as_ref() == Some(&read.scope) && self.resources.current(read)
            }
            Completion::Connect { attempt, epoch, .. } => {
                *attempt == self.attempt && *epoch == self.epoch
            }
        }
    }
    fn finish(&mut self, mut job: Job) {
        if let Completion::NativeHttp(pending) = job.completion {
            pending.finish(job.head, job.bytes);
            return;
        }
        let parsed = decode(job.head.as_ref(), &job.path, &job.bytes);
        let (status, body) = match parsed {
            Ok(v) => v,
            Err(e) => {
                self.fail_job(job, &e);
                return;
            }
        };
        if (200..300).contains(&status)
            && let Some(writer) = &mut job.writer
        {
            writer.complete();
        }
        match job.completion {
            Completion::NativeHttp(_) => {
                unreachable!("raw HTTP is completed before the JSON decoder")
            }
            Completion::HttpReceipt { ticket, .. } => {
                if self.http_receipts.finish(ticket).is_some() {
                    job.reply.resolve(json!({"status":status,"body":body}));
                } else {
                    job.reply.reject("http_receipt_stale");
                }
            }
            Completion::Native(pending) => self.native_finish(*pending, status, body),
            Completion::Upload { reply, .. } => {
                let _ = reply.try_send(attachments::UploadResult::Response { status, body });
            }
            Completion::Request { .. } => job.reply.resolve(json!({"status":status,"body":body})),
            Completion::Resource { read, stat } => {
                if stat {
                    let result = (|| {
                        if !(200..300).contains(&status) {
                            return Err("resource_stat_failed".into());
                        }
                        resources::stat(&body, &read.path)?;
                        make_request(
                            &self.state().current()?,
                            &format!("/api/fs/read?path={}", resources::encoded(&read.path)),
                            "GET",
                            None,
                            false,
                        )
                    })();
                    match result {
                        Ok(request) => self.start_job(
                            request
                                .url
                                .strip_prefix(&self.state().current().expect("admitted").url)
                                .expect("same origin")
                                .to_owned(),
                            request,
                            Completion::Resource { read, stat: false },
                            job.reply,
                        ),
                        Err(e) => {
                            self.resources.finish(&read);
                            job.reply.reject(e);
                        }
                    }
                } else {
                    let result = (|| {
                        let head = job.head.as_ref().ok_or("resource_read_failed")?;
                        if status != 200
                            || !mime(head).eq_ignore_ascii_case("text/plain")
                            || head.headers.iter().any(|(k, v)| {
                                k.eq_ignore_ascii_case("x-yuri-file-exists") && v == "false"
                            })
                        {
                            return Err("unsupported_resource_renderer".into());
                        }
                        let text = body
                            .as_str()
                            .ok_or("unsupported_resource_renderer")?
                            .to_owned();
                        self.resources.retain(&read, text)
                    })();
                    self.resources.finish(&read);
                    job.reply.reply(result);
                }
            }
            Completion::Connect {
                mut candidate,
                attempt,
                epoch,
                unlock,
                editing,
            } => {
                if let Some(target) = &editing
                    && let Err(error) = editor::check(self.state(), target)
                {
                    job.reply.reject(error);
                    return;
                }
                if status != 200 {
                    job.reply.reject("connection_authorization_failed");
                    return;
                }
                if unlock {
                    let token = match policy::string(&body, "clientToken").and_then(|s| {
                        policy::token(s)?;
                        Ok(s.to_owned())
                    }) {
                        Ok(s) => s,
                        Err(_) => {
                            job.reply.reject("connection_authorization_failed");
                            return;
                        }
                    };
                    candidate.token = token;
                    match make_request(&candidate, "/api/config/settings", "GET", None, false) {
                        Ok(request) => self.start_job(
                            "/api/config/settings".into(),
                            request,
                            Completion::Connect {
                                candidate,
                                attempt,
                                epoch,
                                unlock: false,
                                editing,
                            },
                            job.reply,
                        ),
                        Err(e) => job.reply.reject(e),
                    }
                } else {
                    let result = (|| {
                        if let Some(target) = editing {
                            let (next, invalidated) =
                                editor::replacing(self.state(), &target, candidate)?;
                            let mut snapshot =
                                self.commit(next, invalidated).map_err(editor::storage)?;
                            snapshot["runtimeInvalidated"] = json!(invalidated);
                            return Ok(snapshot);
                        }
                        let mut next = self.state().clone();
                        candidate.id = next
                            .connections
                            .iter()
                            .find(|c| {
                                c.url == candidate.url
                                    && self.state().native.binding(&c.id).is_none()
                            })
                            .map(|c| c.id.clone())
                            .unwrap_or(vault::id()?);
                        next.connections.retain(|c| c.id != candidate.id);
                        if next.connections.len() >= 32 {
                            return Err("connection_capacity".into());
                        }
                        next.selected = Some(candidate.id.clone());
                        next.connections.push(candidate);
                        let mut snapshot = self.commit(next, true)?;
                        snapshot["runtimeInvalidated"] = json!(true);
                        Ok(snapshot)
                    })();
                    job.reply.reply(result);
                }
            }
        }
    }
    fn start_stream(&mut self, key: &str) -> Result<()> {
        let stream = self.streams.get(key).ok_or("stream_missing")?;
        self.state().admit(Some(&stream.scope), true)?;
        let mut request = make_request(&self.state().current()?, &stream.path, "GET", None, false)?;
        request.headers.retain(|(name, _)| name != "Accept");
        request
            .headers
            .push(("Accept".into(), "text/event-stream".into()));
        let ticket = self.next();
        let overflow = Arc::new(AtomicBool::new(false));
        let task = self.fetch(ticket, request, overflow.clone());
        let stream = self.streams.get_mut(key).expect("stream exists");
        stream.ticket = ticket;
        stream.task = Some(task);
        stream.ready = false;
        stream.parser = Sse::default();
        stream.permanent = false;
        stream.overflow = overflow;
        Ok(())
    }
    fn stream_event(&mut self, key: &str, event: FetchEvent) {
        let origin = self.state().current().map(|c| c.url).unwrap_or_default();
        let Some(stream) = self.streams.get_mut(key) else {
            return;
        };
        if self.state.as_ref().and_then(|s| s.scope.as_ref()) != Some(&stream.scope) {
            return;
        }
        let result = if stream.overflow.load(Ordering::Acquire) {
            Err("native_host_overflow".into())
        } else {
            match event {
                FetchEvent::Head(head) => {
                    stream.permanent =
                        (400..500).contains(&head.status) && ![408, 429].contains(&head.status);
                    (if head.url != format!("{origin}{}", stream.path) {
                        Err("host_response_origin_mismatch".into())
                    } else {
                        response_head(&head, &stream.path, true)
                    })
                    .map(|_| {
                        stream.ready = true;
                        let _ = self.host.send(
                            "runtime.event",
                            json!({"type":"reconnected","key":key,"expectedHost":stream.scope}),
                        );
                    })
                }
                FetchEvent::Data(bytes) if stream.ready => {
                    stream.parser.consume(&bytes).map(|events| {
                        for data in events {
                            stream.failures = 0;
                            let _ = self.host.send(
                                "runtime.event",
                                json!({"data":data,"key":key,"expectedHost":stream.scope}),
                            );
                        }
                    })
                }
                _ => Err("stream_disconnected".into()),
            }
        };
        if result.is_err() {
            if let Some(task) = stream.task.take() {
                task.cancel();
            }
            let delay = if stream.permanent {
                60
            } else {
                1u64 << stream.failures.min(5)
            };
            stream.failures = stream.failures.saturating_add(1);
            stream.retry = Instant::now() + Duration::from_secs(delay.min(60));
            let _ = self.host.send(
                "runtime.disconnected",
                json!({"key":key,"expectedHost":stream.scope}),
            );
        }
    }
    fn tick(&mut self) {
        self.retire_native_http_stale();
        let now = Instant::now();
        let expired: Vec<_> = self
            .jobs
            .iter()
            .filter(|(_, j)| j.deadline <= now || j.overflow.load(Ordering::Acquire))
            .map(|(id, _)| *id)
            .collect();
        for id in expired {
            if let Some(job) = self.jobs.remove(&id) {
                self.fail_job(job, "host_request_timeout_or_overflow");
            }
        }
        let overflowed: Vec<_> = self
            .streams
            .iter()
            .filter(|(_, s)| s.task.is_some() && s.overflow.load(Ordering::Acquire))
            .map(|(key, _)| key.clone())
            .collect();
        for key in overflowed {
            self.stream_event(&key, FetchEvent::Failed(String::new()));
        }
        let retries: Vec<_> = self
            .streams
            .iter()
            .filter(|(_, s)| s.task.is_none() && s.retry <= now)
            .map(|(key, _)| key.clone())
            .collect();
        for key in retries {
            if self.start_stream(&key).is_err() {
                self.streams.remove(&key);
            }
        }
    }
    fn fail_job(&mut self, job: Job, error: &str) {
        if let Completion::NativeHttp(pending) = job.completion {
            job.task.cancel();
            pending.fail(crate::connection_actor_http_port::Error::Unavailable);
            return;
        }
        if let Completion::HttpReceipt { ticket, .. } = &job.completion {
            self.http_receipts.finish(*ticket);
        }
        if let Completion::Native(pending) = job.completion {
            job.task.cancel();
            pending.fail(connection_actor::error(error));
            return;
        }
        if let Completion::Upload { reply, .. } = &job.completion {
            let _ = reply.try_send(attachments::UploadResult::Unknown);
        }
        if let Completion::Resource { read, .. } = &job.completion {
            self.resources.finish(read);
        }
        job.task.cancel();
        job.reply.reject(error);
    }
    fn resource_read(&mut self, value: Value, reply: HostReply) {
        let parsed: Result<(resources::Read, String, HttpRequest)> = (|| {
            let read = resources::parse(&value)?;
            self.state().admit(Some(&read.scope), true)?;
            let path = format!("/api/fs/stat?path={}", resources::encoded(&read.path));
            let request = make_request(&self.state().current()?, &path, "GET", None, false)?;
            self.resources.begin(&read)?;
            Ok((read, path, request))
        })();
        match parsed {
            Ok((read, path, request)) => self.start_job(
                path,
                request,
                Completion::Resource { read, stat: true },
                reply,
            ),
            Err(e) => reply.reject(e),
        }
    }
    fn upload(&mut self, pending: attachment_transport::Pending) {
        let parsed: Result<_> = (|| {
            if pending.cancelled.load(Ordering::Acquire) {
                return Err("attachment_cancelled".into());
            }
            self.load()?;
            let scope = self.state().admit(Some(&pending.scope), true)?;
            let (path, request) =
                attachment_transport::request(&self.state().current()?, pending.upload)?;
            Ok((scope, path, request))
        })();
        match parsed {
            Ok((scope, path, request)) => self.start_job(
                path,
                request,
                Completion::Upload {
                    scope,
                    reply: pending.reply,
                },
                HostReply::default(),
            ),
            Err(_) => {
                let _ = pending.reply.try_send(attachments::UploadResult::Denied);
            }
        }
    }
}
fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
        * 1000.0
}
fn make_request(
    connection: &Connection,
    path: &str,
    method: &str,
    body: Option<&Value>,
    auth: bool,
) -> Result<HttpRequest> {
    policy::route(path, auth)?;
    policy::token(&connection.token)?;
    let mut request = HttpRequest::new(method, format!("{}{path}", connection.url))
        .header("Accept", "application/json");
    request.follow_redirects = false;
    if !connection.token.is_empty() {
        request = request.header("Authorization", format!("Bearer {}", connection.token));
    }
    if let Some(body) = body {
        let bytes = serde_json::to_vec(body).map_err(|_| "invalid_request_body")?;
        if bytes.len() > BODY_LIMIT {
            return Err("request_body_limit".into());
        }
        request = request
            .header("Content-Type", "application/json")
            .body(bytes);
    }
    Ok(request)
}
fn mime(head: &HttpHead) -> &str {
    head.headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
        .map(|(_, v)| v.split(';').next().unwrap_or("").trim())
        .unwrap_or("")
}
fn response_head(head: &HttpHead, path: &str, stream: bool) -> Result<()> {
    if !(100..600).contains(&head.status) || (300..400).contains(&head.status) || head.redirected {
        return Err("host_redirect_or_invalid_response".into());
    }
    if head
        .headers
        .iter()
        .filter(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .any(|(_, v)| {
            v.parse::<usize>()
                .map_or(true, |n| !stream && n > BODY_LIMIT)
        })
    {
        return Err("response_body_limit".into());
    }
    let mime = mime(head);
    let valid = if stream {
        head.status == 200 && mime.eq_ignore_ascii_case("text/event-stream")
    } else {
        mime.eq_ignore_ascii_case("application/json")
            || [204, 205].contains(&head.status)
            || (path.split('?').next() == Some("/api/fs/read")
                && mime.eq_ignore_ascii_case("text/plain"))
    };
    if !valid {
        return Err("unexpected_host_content_type".into());
    }
    Ok(())
}
fn decode(head: Option<&HttpHead>, path: &str, bytes: &[u8]) -> Result<(u16, Value)> {
    let head = head.ok_or("invalid_host_response")?;
    response_head(head, path, false)?;
    let value = if path.split('?').next() == Some("/api/fs/read")
        && mime(head).eq_ignore_ascii_case("text/plain")
    {
        json!(std::str::from_utf8(bytes).map_err(|_| "invalid_utf8_response")?)
    } else if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(bytes).map_err(|_| "invalid_json_response")?
    };
    Ok((head.status, value))
}

#[derive(Default)]
struct Sse {
    line: Vec<u8>,
    lines: Vec<String>,
    size: usize,
    cr: bool,
}
impl Sse {
    fn consume(&mut self, bytes: &[u8]) -> Result<Vec<String>> {
        let mut events = Vec::new();
        for &byte in bytes {
            if self.cr && byte == 10 {
                self.cr = false;
                continue;
            }
            self.cr = false;
            if byte == 10 || byte == 13 {
                self.cr = byte == 13;
                let line = std::str::from_utf8(&self.line).map_err(|_| "invalid_sse_utf8")?;
                if line.is_empty() {
                    if !self.lines.is_empty() {
                        events.push(self.lines.join("\n"));
                    }
                    self.lines.clear();
                    self.size = 0;
                } else if let Some(data) = line.strip_prefix("data:") {
                    self.size += self.line.len() + 1;
                    if self.size > 2_000_000 {
                        return Err("sse_event_limit".into());
                    }
                    self.lines
                        .push(data.strip_prefix(' ').unwrap_or(data).to_owned());
                }
                self.line.clear();
            } else {
                if self.line.len() >= 2_000_000 {
                    return Err("sse_line_limit".into());
                }
                self.line.push(byte);
            }
        }
        Ok(events)
    }
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;

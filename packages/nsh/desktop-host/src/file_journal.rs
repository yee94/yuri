//! Private window document journal. No connection credentials, Host filesystem access,
//! UI, logging or JS-selected local paths. Install AFTER the generic bridge.
//! Retain Owner until window teardown; namespace must be stable across cold starts.
//! Three capabilities: desktop.files.journal.{snapshot,commit,sync}.
use nsh_engine::{HostChannel, HostReply};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::Duration,
};

#[path = "file_journal_disk.rs"]
mod disk;
#[path = "file_journal_hash.rs"]
mod hash;
#[cfg(test)]
#[path = "file_journal_tests.rs"]
mod tests;

pub type Result<T> = std::result::Result<T, &'static str>;
pub const METHODS: &[&str] = &[
    "desktop.files.journal.snapshot",
    "desktop.files.journal.commit",
    "desktop.files.journal.sync",
];
pub const BYTES: usize = 4 * 1024 * 1024;
pub const WIRE: usize = 2 * BYTES + 65536;
/// Native stable-key projection; never use a receipt, lease or lossy punctuation replacement.
pub(crate) fn window_namespace(key: &str) -> Result<String> {
    if key.is_empty()
        || key.len() > 128
        || !key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b':'))
    {
        return Err("window_identity_invalid");
    }
    if key == "primary" {
        return Ok(key.into());
    }
    let mut input = b"yuri-native-window-v1\0".to_vec();
    input.extend_from_slice(key.as_bytes());
    Ok(hash::sha256(&input)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}
const PREFIX: &str = "desktop-file-journal-v1:";
const MAX_VERSION: u64 = 9_007_199_254_740_991;

fn exact(value: &Value, fields: &[&str]) -> Result<()> {
    let map = value.as_object().ok_or("file_journal_schema")?;
    if map.len() != fields.len() || fields.iter().any(|key| !map.contains_key(*key)) {
        return Err("file_journal_schema");
    }
    Ok(())
}
fn string<'a>(v: &'a Value, key: &str, limit: usize) -> Result<&'a str> {
    let s = v[key].as_str().ok_or("file_journal_schema")?;
    if s.is_empty() || s.len() > limit || s.chars().any(char::is_control) {
        return Err("file_journal_schema");
    }
    Ok(s)
}
fn token(value: &Value) -> Result<&str> {
    let s = value.as_str().ok_or("file_journal_schema")?;
    if s.is_empty()
        || s.len() > 128
        || !s
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("file_journal_schema");
    }
    Ok(s)
}
fn version(value: &Value) -> Result<u64> {
    value
        .as_u64()
        .filter(|v| *v <= MAX_VERSION)
        .ok_or("file_journal_schema")
}
fn canonical(path: &str) -> bool {
    let absolute = path.starts_with('/') || path.as_bytes().get(1..3) == Some(b":/");
    absolute
        && !path.contains('\\')
        && !path.chars().any(char::is_control)
        && !path.split('/').any(|p| p == "." || p == "..")
        && !path.trim_start_matches('/').contains("//")
        && (path == "/" || !path.ends_with('/') || path.len() == 3 && path.as_bytes()[1] == b':')
}
fn record(key: &str, raw: &str) -> Result<()> {
    if key.starts_with("desktop-file-operation-v1:") {
        return operation_record(key, raw);
    }
    let v: Value = serde_json::from_str(raw).map_err(|_| "file_journal_schema")?;
    exact(
        &v,
        &[
            "version", "scope", "path", "text", "base", "wire", "eol", "bom", "pending", "conflict",
        ],
    )?;
    if v["version"] != 1 || !v["conflict"].is_boolean() {
        return Err("file_journal_schema");
    }
    let scope = &v["scope"];
    exact(scope, &["host", "authorityKey", "sessionID", "directory"])?;
    exact(&scope["host"], &["hostID"])?;
    let host = string(&scope["host"], "hostID", 1024)?;
    let authority = string(scope, "authorityKey", 8192)?;
    if !scope["sessionID"].is_null() {
        string(scope, "sessionID", 1024)?;
    }
    let directory = string(scope, "directory", 16384)?;
    let path = string(&v, "path", 16384)?;
    if !canonical(directory)
        || !canonical(path)
        || path == directory
        || !path.starts_with(&format!("{}/", directory.trim_end_matches('/')))
    {
        return Err("file_journal_identity");
    }
    let scope_key = json!([host, authority, scope["sessionID"], directory]).to_string();
    if key != format!("{PREFIX}{}", json!([scope_key, path])) {
        return Err("file_journal_identity");
    }
    let text = |name: &str| -> Result<&str> {
        v[name]
            .as_str()
            .filter(|s| s.encode_utf16().count() <= 1_000_000 && !s.contains('\r'))
            .ok_or("file_journal_schema")
    };
    text("text")?;
    let base = text("base")?;
    let eol = v["eol"]
        .as_str()
        .filter(|s| ["\n", "\r\n", "\r"].contains(s))
        .ok_or("file_journal_schema")?;
    let bom = v["bom"].as_bool().ok_or("file_journal_schema")?;
    let wire = |s: &str| {
        format!(
            "{}{}",
            if bom { "\u{feff}" } else { "" },
            s.replace('\n', eol)
        )
    };
    if v["wire"].as_str() != Some(wire(base).as_str())
        || v["wire"]
            .as_str()
            .is_none_or(|s| s.encode_utf16().count() > 1_000_000)
    {
        return Err("file_journal_schema");
    }
    if !v["pending"].is_null() {
        let p = &v["pending"];
        exact(p, &["text", "wire"])?;
        let t = p["text"]
            .as_str()
            .filter(|s| s.encode_utf16().count() <= 1_000_000 && !s.contains('\r'))
            .ok_or("file_journal_schema")?;
        if p["wire"].as_str() != Some(wire(t).as_str())
            || p["wire"]
                .as_str()
                .is_none_or(|s| s.encode_utf16().count() > 1_000_000)
        {
            return Err("file_journal_schema");
        }
    }
    Ok(())
}
fn operation_record(key: &str, raw: &str) -> Result<()> {
    let v: Value = serde_json::from_str(raw).map_err(|_| "file_journal_schema")?;
    exact(&v, &["version", "scope", "command", "phase"])?;
    if v["version"] != 1
        || ![Some("prepared"), Some("confirmed"), Some("rejected")].contains(&v["phase"].as_str())
    {
        return Err("file_journal_schema");
    }
    let scope = &v["scope"];
    exact(scope, &["host", "authorityKey", "sessionID", "directory"])?;
    exact(&scope["host"], &["hostID"])?;
    let host = string(&scope["host"], "hostID", 1024)?;
    let authority = string(scope, "authorityKey", 8192)?;
    if !scope["sessionID"].is_null() {
        string(scope, "sessionID", 1024)?;
    }
    let root = string(scope, "directory", 16384)?;
    if !canonical(root)
        || key
            != format!(
                "desktop-file-operation-v1:{}",
                json!([host, authority, Value::Null, root])
            )
    {
        return Err("file_journal_identity");
    }
    let c = &v["command"];
    let kind = string(c, "kind", 16)?;
    let path = match kind {
        "file" | "directory" => {
            exact(c, &["kind", "parent", "name"])?;
            string(c, "parent", 16384)?
        }
        "rename" => {
            exact(c, &["kind", "path", "name"])?;
            string(c, "path", 16384)?
        }
        "delete" => {
            exact(c, &["kind", "path"])?;
            string(c, "path", 16384)?
        }
        _ => return Err("file_journal_schema"),
    };
    if !canonical(path)
        || path != root && !path.starts_with(&format!("{}/", root.trim_end_matches('/')))
        || path == root && ["delete", "rename"].contains(&kind)
    {
        return Err("file_journal_identity");
    }
    if kind != "delete" {
        let name = string(c, "name", 1024)?;
        if name.trim() != name
            || [".", ".."].contains(&name)
            || name.contains(['/', '\\'])
            || name.encode_utf16().count() > 255
        {
            return Err("file_journal_schema");
        }
    }
    Ok(())
}
fn records(value: &Value) -> Result<BTreeMap<String, String>> {
    let map = value
        .as_object()
        .filter(|m| m.len() <= 20)
        .ok_or("file_journal_capacity")?;
    let mut size = 0usize;
    let mut rows = BTreeMap::new();
    for (key, raw) in map {
        let raw = raw.as_str().ok_or("file_journal_schema")?;
        size = size
            .checked_add(key.len() + raw.len())
            .ok_or("file_journal_capacity")?;
        if size > BYTES {
            return Err("file_journal_capacity");
        }
        record(key, raw)?;
        rows.insert(key.clone(), raw.into());
    }
    Ok(rows)
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    version: u64,
    request: Option<String>,
    records: BTreeMap<String, String>,
}
impl Snapshot {
    fn empty() -> Self {
        Self {
            version: 0,
            request: None,
            records: BTreeMap::new(),
        }
    }
    fn value(&self) -> Value {
        json!({"version":self.version,"requestID":self.request,"records":self.records})
    }
    fn ready(&self) -> Value {
        let mut v = self.value();
        v["status"] = json!("ready");
        v
    }
    fn parse(value: &Value) -> Result<Self> {
        exact(value, &["version", "requestID", "records"])?;
        let version = version(&value["version"])?;
        let request = if value["requestID"].is_null() {
            None
        } else {
            Some(token(&value["requestID"])?.into())
        };
        if (version == 0) != request.is_none() {
            return Err("file_journal_corrupt");
        }
        Ok(Self {
            version,
            request,
            records: records(&value["records"])?,
        })
    }
}
trait Disk {
    fn read(&mut self) -> Result<Snapshot>;
    fn write(&mut self, snapshot: &Snapshot) -> Result<()>;
    fn sync(&mut self) -> Result<()>;
}
struct Store<D> {
    disk: D,
    current: Snapshot,
    uncertain: Option<(Snapshot, Snapshot)>,
    denied: Option<String>,
}
impl<D: Disk> Store<D> {
    fn new(mut disk: D) -> Result<Self> {
        let current = disk.read()?;
        disk.sync()?;
        Ok(Self {
            disk,
            current,
            uncertain: None,
            denied: None,
        })
    }
    fn call(&mut self, method: &str, body: &Value) -> Result<Value> {
        match method {
            "desktop.files.journal.snapshot" => {
                exact(body, &[])?;
                self.reconcile()?;
                if self.disk.read()? != self.current {
                    return Err("file_journal_owner_conflict");
                }
                self.disk.sync()?;
                Ok(self.current.ready())
            }
            "desktop.files.journal.commit" => {
                exact(body, &["expectedVersion", "requestID", "records"])?;
                let id = token(&body["requestID"])?.to_string();
                let expected = version(&body["expectedVersion"])?;
                let rows = records(&body["records"])?;
                if self.uncertain.is_some() {
                    return Err("file_journal_commit_unknown");
                }
                if expected != self.current.version || self.disk.read()? != self.current {
                    self.denied = Some(id);
                    return Err("file_journal_owner_conflict");
                }
                if self.current.request.as_ref() == Some(&id) || expected == MAX_VERSION {
                    self.denied = Some(id);
                    return Err("file_journal_receipt_reused");
                }
                let next = Snapshot {
                    version: expected + 1,
                    request: Some(id),
                    records: rows,
                };
                // No blind rollback or repeated write after this point. A failed write may
                // already have published the candidate; sync resolves only by reading it.
                self.uncertain = Some((self.current.clone(), next.clone()));
                self.disk
                    .write(&next)
                    .map_err(|_| "file_journal_commit_unknown")?;
                self.disk
                    .sync()
                    .map_err(|_| "file_journal_commit_unknown")?;
                self.current = next;
                self.uncertain = None;
                self.denied = None;
                Ok(self.current.ready())
            }
            "desktop.files.journal.sync" => {
                exact(body, &["version", "requestID"])?;
                let version = version(&body["version"])?;
                let request = if body["requestID"].is_null() {
                    None
                } else {
                    Some(token(&body["requestID"])?.to_string())
                };
                if let Some((prior, next)) = self.uncertain.clone() {
                    if request != next.request || version != next.version {
                        return Err("file_journal_commit_unknown");
                    }
                    self.reconcile()?;
                    if self.current == prior {
                        self.denied = request;
                        return Ok(json!({"status":"denied","code":"file_journal_not_committed"}));
                    }
                }
                if self
                    .denied
                    .as_ref()
                    .is_some_and(|id| Some(id) == request.as_ref())
                {
                    return Ok(json!({"status":"denied","code":"file_journal_not_committed"}));
                }
                if version != self.current.version
                    || request != self.current.request
                    || self.disk.read()? != self.current
                {
                    return Err("file_journal_commit_unknown");
                }
                self.disk
                    .sync()
                    .map_err(|_| "file_journal_commit_unknown")?;
                Ok(self.current.ready())
            }
            _ => Err("file_journal_method"),
        }
    }
    fn reconcile(&mut self) -> Result<()> {
        if let Some((prior, next)) = self.uncertain.clone() {
            let actual = self.disk.read()?;
            if actual != prior && actual != next {
                return Err("file_journal_commit_unknown");
            }
            self.disk
                .sync()
                .map_err(|_| "file_journal_commit_unknown")?;
            self.denied = if actual == prior { next.request } else { None };
            self.current = actual;
            self.uncertain = None;
        }
        Ok(())
    }
}

#[derive(Clone)]
pub(crate) struct Retirement {
    stop: Arc<AtomicBool>,
    done: Arc<AtomicBool>,
}
impl Retirement {
    pub fn stopped(&self) -> bool {
        self.done.load(Ordering::Acquire)
    }
}
pub struct Owner(Retirement);
impl Owner {
    pub(crate) fn shutdown(&self) -> Retirement {
        self.0.stop.store(true, Ordering::Release);
        self.0.clone()
    }
}
impl Drop for Owner {
    fn drop(&mut self) {
        self.0.stop.store(true, Ordering::Release);
    }
}
struct Job {
    method: &'static str,
    body: Value,
    reply: HostReply,
}
fn bounded_message(body: &Value) -> bool {
    let Some(fields) = body.as_object().filter(|v| v.len() <= 3) else {
        return false;
    };
    fields.iter().all(|(key, value)| {
        if key == "records" {
            value.as_object().is_some_and(|rows| {
                rows.len() <= 20
                    && rows
                        .iter()
                        .try_fold(0usize, |size, (key, raw)| {
                            raw.as_str()
                                .and_then(|raw| size.checked_add(key.len() + raw.len()))
                                .filter(|size| *size <= BYTES)
                        })
                        .is_some()
            })
        } else {
            key.len() <= 32
                && (value.is_null()
                    || value.is_number()
                    || value.as_str().is_some_and(|s| s.len() <= 128))
        }
    })
}
fn failure(code: &str) -> Value {
    json!({"status":if code == "file_journal_commit_unknown" { "unknown" } else { "denied" },"code":code})
}
/// Native-only namespace (e.g. "primary"); never connection URL, Host path or JS data.
/// Creates private subdirectories beneath the supplied app data directory, not NSH Storage.
pub fn install(host: &HostChannel, data_dir: &Path, namespace: &str) -> Result<Owner> {
    let files = disk::Files::open(data_dir, namespace)?;
    let mut store = Store::new(files)?;
    let stopped = Arc::new(AtomicBool::new(false));
    let done = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::sync_channel::<Job>(2);
    let stop = stopped.clone();
    let worker = std::thread::Builder::new()
        .name("yuri-file-journal".into())
        .spawn(move || {
            while !stop.load(Ordering::Acquire) {
                match rx.recv_timeout(Duration::from_millis(50)) {
                    Ok(job) => {
                        let result = if stop.load(Ordering::Acquire) {
                            Err("file_journal_closed")
                        } else {
                            store.call(job.method, &job.body)
                        };
                        job.reply.resolve(result.unwrap_or_else(|code| {
                            failure(if store.uncertain.is_some() {
                                "file_journal_commit_unknown"
                            } else {
                                code
                            })
                        }));
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
        })
        .map_err(|_| "file_journal_worker")?;
    let joined = done.clone();
    std::thread::Builder::new()
        .name("yuri-file-journal-join".into())
        .spawn(move || {
            if worker.join().is_ok() {
                joined.store(true, Ordering::Release);
            }
        })
        .map_err(|_| {
            stopped.store(true, Ordering::Release);
            "file_journal_join"
        })?;
    for &method in METHODS {
        let tx = tx.clone();
        let stop = stopped.clone();
        host.handle(method, move |mut call| {
            let body = call.take_data();
            let Some(reply) = call.into_reply() else {
                return;
            };
            if !bounded_message(&body) || stop.load(Ordering::Acquire) {
                reply.resolve(failure("file_journal_capacity_or_closed"));
                return;
            }
            if let Err(mpsc::TrySendError::Full(job) | mpsc::TrySendError::Disconnected(job)) = tx
                .try_send(Job {
                    method,
                    body,
                    reply,
                })
            {
                job.reply.resolve(failure("file_journal_busy"));
            }
        });
    }
    Ok(Owner(Retirement {
        stop: stopped,
        done,
    }))
}

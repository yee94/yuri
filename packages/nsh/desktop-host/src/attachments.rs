//! Desktop-only pick -> bounded native bytes -> captured bridge transport -> real Attachment.
//! Register AFTER bridge::install (which rejects unknown manifest methods), retain Owner, and
//! pump Inbox::try_recv().show(window) on the UI thread. Transport must enqueue into the existing
//! bridge actor: admit exact scope, make_request with its captured Connection, then Network::fetch.
//! It must not read credentials here or serialize Upload.bytes through HostChannel.
use crate::{
    policy::{self, Result},
    vault,
};
use nsh_engine::HostChannel;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::Duration,
};

pub const FILE_LIMIT: usize = 25 * 1024 * 1024;
pub const TOTAL_LIMIT: usize = 50 * 1024 * 1024;
pub const COUNT_LIMIT: usize = 64;
// <=8 MiB retained JSON metadata; no receipt eviction/reuse. Bytes never enter the book.
const RECEIPT_LIMIT: usize = 128;
pub const WIRE_LIMIT: usize = 64 * 1024;
pub const METHODS: &[&str] = &[
    "desktop.attachments.pick",
    "desktop.attachments.status",
    "desktop.attachments.cancel",
    "desktop.attachments.release",
];

#[derive(Clone, Debug, PartialEq, Eq)]
enum Target {
    Session,
    Assistant(String),
}
use crate::file_download_attachment_validation::{opaque_id, validate};
pub(crate) fn assistant_upload_path(path: &str) -> bool {
    let Some((assistant_id, upload_id)) = path
        .strip_prefix("/api/yuri/assistants/")
        .and_then(|rest| rest.split_once("/contact/attachments/"))
    else {
        return false;
    };
    opaque_id(assistant_id)
        && policy::scope(&json!({"hostID":"attachment","lease":upload_id})).is_ok()
}
impl Target {
    fn parse(value: Option<&Value>) -> Result<Self> {
        let Some(value) = value else {
            return Ok(Self::Session);
        };
        match value["kind"].as_str() {
            Some("session") => {
                policy::keys(value, &["kind"], &["kind"])?;
                Ok(Self::Session)
            }
            Some("assistant") => {
                policy::keys(value, &["kind", "assistantID"], &["kind", "assistantID"])?;
                let id = policy::string(value, "assistantID")?;
                if !opaque_id(id) {
                    return Err("attachment_invalid_target".into());
                }
                Ok(Self::Assistant(id.into()))
            }
            _ => Err("attachment_invalid_target".into()),
        }
    }
    fn result(
        &self,
        id: &str,
        state: &str,
        files: Vec<Value>,
        orphaned: usize,
        error: Option<&str>,
    ) -> Value {
        let mut output = result(id, state, files, orphaned, error);
        if let Self::Assistant(assistant_id) = self {
            output["target"] = json!({"kind":"assistant","assistantID":assistant_id});
        }
        output
    }
}

/// Deliberately not HttpRequest: origin and Authorization belong to the bridge actor only.
/// Copy budget: one <=25 MiB Vec, moved (not cloned) into HttpRequest::body and NSH
/// Network::fetch; a 64 KiB read chunk and <=64 KiB JSON response/receipt. Sequential
/// upload keeps the 50 MiB batch budget out of resident content memory. No JS bytes.
pub struct Upload {
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub bytes: Vec<u8>,
}
pub enum UploadResult {
    Response {
        status: u16,
        body: Value,
    },
    /// Rejected before Network::fetch; no write was attempted. Safe only with positive evidence.
    Denied,
    /// Timeout, disconnect, malformed response, cancellation after dispatch: never auto replay.
    Unknown,
}
pub trait Transport: Send + Sync + 'static {
    /// Nonblocking native authority snapshot (no I/O or credentials). Updated on every lease
    /// rotation and quarantine, not just TS Host selection. Also gates receipt readback.
    fn current(&self, scope: &Value) -> bool;
    /// Return known success even after cancellation so late temporary files can be accounted for.
    /// Bound response to 64 KiB; disable redirects; use existing captured scope/auth/Network job.
    fn upload(&self, scope: &Value, upload: Upload, cancelled: &AtomicBool) -> UploadResult;
}

#[derive(Clone)]
pub struct Port(mpsc::SyncSender<PickJob>);
pub struct Inbox(mpsc::Receiver<PickJob>);
pub struct PickJob {
    images: bool,
    cancelled: Arc<AtomicBool>,
    scope: Value,
    transport: Arc<dyn Transport>,
    reply: mpsc::SyncSender<Result<Vec<Selected>>>,
}
/// There is intentionally no public path constructor; only the OS dialog grants a local path.
pub struct Selected {
    name: String,
    mime: String,
    source: Source,
}
enum Source {
    Path(std::path::PathBuf),
    #[cfg(test)]
    Bytes(Vec<u8>),
}
impl Inbox {
    pub fn try_recv(&self) -> Option<PickJob> {
        self.0.try_recv().ok()
    }
}
pub fn channel() -> (Port, Inbox) {
    let (tx, rx) = mpsc::sync_channel(1);
    (Port(tx), Inbox(rx))
}

#[path = "attachments_native.rs"]
mod native;

/// True while the native dialog slot is reserved, including scheduled presentation until completion.
pub fn is_presenting() -> bool {
    native::is_presenting()
}

impl PickJob {
    #[cfg(test)]
    pub(crate) fn complete_private_file_for_test(self, path: std::path::PathBuf) {
        let name = path.file_name().unwrap().to_str().unwrap().to_owned();
        let mime = native::mime(&name).into();
        self.reply
            .send(Ok(vec![Selected {
                name,
                mime,
                source: Source::Path(path),
            }]))
            .unwrap();
    }
    fn current(&self) -> bool {
        !self.cancelled.load(Ordering::Acquire) && self.transport.current(&self.scope)
    }
    /// Main/UI thread only; `window` is the live owning NSWindow*/HWND, never a JS value.
    /// A cancelled queued job never presents. An open system dialog may finish after logical
    /// cancellation; its selected paths are discarded without opening them.
    pub unsafe fn show(self, window: *mut std::ffi::c_void) {
        if !self.current() {
            return;
        }
        // Never enter a nested native modal loop inside the UI mailbox's borrowed pump.
        // AppKit defers to the main queue; Win32 uses its own dialog thread, like NSH.
        unsafe {
            native::schedule(self, window);
        }
    }
    unsafe fn finish(self, window: *mut std::ffi::c_void) {
        if !self.current() {
            return;
        }
        let selected = unsafe { native::pick(window, self.images) }.and_then(|paths| {
            if paths.len() > COUNT_LIMIT {
                return Err("attachment_count_limit".into());
            }
            paths
                .into_iter()
                .map(|path| {
                    let name = path
                        .file_name()
                        .and_then(|v| v.to_str())
                        .ok_or("attachment_invalid_name")?
                        .to_owned();
                    let mime = native::mime(&name).to_owned();
                    validate(&name, &mime, self.images)?;
                    Ok(Selected {
                        name,
                        mime,
                        source: Source::Path(path),
                    })
                })
                .collect()
        });
        if self.current() {
            let _ = self.reply.try_send(selected);
        }
    }
}
struct Receipt {
    scope: Value,
    target: Target,
    cancelled: Arc<AtomicBool>,
    result: Value,
}
#[derive(Default)]
struct Book {
    receipts: HashMap<String, Receipt>,
    active: bool,
}
pub struct Owner {
    stopped: Arc<AtomicBool>,
    book: Arc<Mutex<Book>>,
}
impl Drop for Owner {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        let book = self.book.lock().unwrap_or_else(|e| e.into_inner());
        for receipt in book.receipts.values() {
            receipt.cancelled.store(true, Ordering::Release);
        }
    }
}
fn result(id: &str, state: &str, files: Vec<Value>, orphaned: usize, error: Option<&str>) -> Value {
    let mut result = json!({"requestID":id,"state":state,"attachments":files,"orphaned":orphaned});
    if let Some(error) = error {
        result["error"] = json!(error);
    }
    result
}
fn parse(value: &Value, pick: bool) -> Result<(String, Value, Target)> {
    policy::keys(
        value,
        if pick {
            &["requestID", "expectedHost", "kind", "target"]
        } else {
            &["requestID", "expectedHost", "target"]
        },
        if pick {
            &["requestID", "expectedHost", "kind"]
        } else {
            &["requestID", "expectedHost"]
        },
    )?;
    let id = policy::string(value, "requestID")?;
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("attachment_invalid_request".into());
    }
    if pick && value["kind"] != "files" && value["kind"] != "images" {
        return Err("attachment_invalid_kind".into());
    }
    Ok((
        id.into(),
        policy::scope(&value["expectedHost"])?,
        Target::parse(value.get("target"))?,
    ))
}

pub fn install(host: &HostChannel, transport: Arc<dyn Transport>, picker: Port) -> Owner {
    let book = Arc::new(Mutex::new(Book::default()));
    let stopped = Arc::new(AtomicBool::new(false));
    for &method in METHODS {
        let book = book.clone();
        let transport = transport.clone();
        let picker = picker.clone();
        let stopped = stopped.clone();
        host.handle(method, move |mut call| {
            let value = call.take_data();
            let Some(reply) = call.into_reply() else {
                return;
            };
            if stopped.load(Ordering::Acquire) {
                reply.reject("attachment_owner_unavailable");
                return;
            }
            let (id, scope, target) = match parse(&value, method == METHODS[0]) {
                Ok(v) => v,
                Err(e) => {
                    reply.reject(e);
                    return;
                }
            };
            let mut locked = book.lock().unwrap_or_else(|e| e.into_inner());
            if method != METHODS[0] {
                let Some(receipt) = locked
                    .receipts
                    .get_mut(&id)
                    .filter(|r| r.scope == scope && r.target == target)
                else {
                    reply.reject("attachment_receipt_missing");
                    return;
                };
                if method == METHODS[2] || method == METHODS[3] || !transport.current(&scope) {
                    receipt.cancelled.store(true, Ordering::Release);
                    let count = receipt.result["attachments"].as_array().map_or(0, Vec::len);
                    receipt.result["orphaned"] =
                        json!(receipt.result["orphaned"].as_u64().unwrap_or(0) + count as u64);
                    receipt.result["attachments"] = json!([]);
                    if receipt.result["state"] != "pending" {
                        receipt.result["state"] = json!("retired");
                    }
                }
                reply.resolve(receipt.result.clone());
                return;
            }
            // Never reuse a receipt, including failed/unknown ones. Only a new explicit pick grants
            // new bytes. Metadata tombstones are bounded without unsafe ID reuse after eviction.
            if locked.active
                || locked.receipts.contains_key(&id)
                || locked.receipts.len() >= RECEIPT_LIMIT
            {
                reply.reject("attachment_busy_or_receipt_reused");
                return;
            }
            let cancelled = Arc::new(AtomicBool::new(false));
            locked.active = true;
            locked.receipts.insert(
                id.clone(),
                Receipt {
                    scope: scope.clone(),
                    target: target.clone(),
                    cancelled: cancelled.clone(),
                    result: target.result(&id, "pending", vec![], 0, None),
                },
            );
            drop(locked);
            let worker_book = book.clone();
            let transport = transport.clone();
            let picker = picker.clone();
            let spawn_id = id.clone();
            let spawn_target = target.clone();
            let reply = Arc::new(Mutex::new(Some(reply)));
            let worker_reply = reply.clone();
            if std::thread::Builder::new()
                .name("yuri-attachment".into())
                .spawn(move || {
                    let output =
                        stage_target(&id, &scope, &target, &cancelled, &*transport, || {
                            let (tx, rx) = mpsc::sync_channel(1);
                            picker
                                .0
                                .try_send(PickJob {
                                    images: value["kind"] == "images",
                                    cancelled: cancelled.clone(),
                                    scope: scope.clone(),
                                    transport: transport.clone(),
                                    reply: tx,
                                })
                                .map_err(|_| "attachment_picker_busy")?;
                            for _ in 0..1200 {
                                if cancelled.load(Ordering::Acquire) || !transport.current(&scope) {
                                    cancelled.store(true, Ordering::Release);
                                    return Err("attachment_cancelled".into());
                                }
                                match rx.recv_timeout(Duration::from_millis(100)) {
                                    Ok(v) => return v,
                                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                                    Err(_) => return Err("attachment_picker_failed".into()),
                                }
                            }
                            cancelled.store(true, Ordering::Release);
                            Err("attachment_picker_timeout".into())
                        });
                    let mut locked = worker_book.lock().unwrap_or_else(|e| e.into_inner());
                    let mut output = output;
                    if (cancelled.load(Ordering::Acquire) || !transport.current(&scope))
                        && !output["attachments"].as_array().is_none_or(Vec::is_empty)
                    {
                        let count = output["attachments"].as_array().map_or(0, Vec::len);
                        output["orphaned"] =
                            json!(output["orphaned"].as_u64().unwrap_or(0) + count as u64);
                        output["attachments"] = json!([]);
                        output["state"] = json!("retired");
                    }
                    if serde_json::to_vec(&output).map_or(true, |v| v.len() > WIRE_LIMIT) {
                        let count = output["attachments"].as_array().map_or(0, Vec::len);
                        output = target.result(
                            &id,
                            "failed",
                            vec![],
                            count,
                            Some("attachment_receipt_limit"),
                        );
                    }
                    if let Some(receipt) = locked.receipts.get_mut(&id) {
                        receipt.result = output.clone();
                    }
                    locked.active = false;
                    if let Some(reply) = worker_reply
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .take()
                    {
                        reply.resolve(output);
                    }
                })
                .is_err()
            {
                let mut locked = book.lock().unwrap_or_else(|e| e.into_inner());
                locked.active = false;
                if let Some(receipt) = locked.receipts.get_mut(&spawn_id) {
                    receipt.result = spawn_target.result(
                        &spawn_id,
                        "failed",
                        vec![],
                        0,
                        Some("attachment_worker_failed"),
                    );
                }
                if let Some(reply) = reply.lock().unwrap_or_else(|e| e.into_inner()).take() {
                    reply.reject("attachment_worker_failed");
                }
            }
        });
    }
    Owner { stopped, book }
}

fn encode(value: &str, path: bool) -> String {
    let mut result = String::new();
    for b in value.bytes() {
        if b.is_ascii_alphanumeric()
            || b"-_.!~*'()".contains(&b)
            || path && (b == b'/' || b == b':')
        {
            result.push(b as char);
        } else {
            result.push_str(&format!("%{b:02X}"));
        }
    }
    result
}
fn descriptor(body: &Value, digest: &str, size: usize, file: &Selected) -> Result<Value> {
    if body["success"] != true
        || body["sha256"] != digest
        || body["size"].as_u64() != Some(size as u64)
        || body["mime"] != file.mime
    {
        return Err("attachment_invalid_upload_receipt".into());
    }
    let path = body["path"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 8192 && !s.chars().any(char::is_control))
        .ok_or("attachment_invalid_host_path")?;
    let path = if path.starts_with('/') && !path.starts_with("//") {
        path.to_owned()
    } else if path.len() > 2
        && path.as_bytes()[0].is_ascii_alphabetic()
        && path.as_bytes()[1] == b':'
        && b"/\\".contains(&path.as_bytes()[2])
    {
        format!("/{}", path.replace('\\', "/"))
    } else {
        return Err("attachment_invalid_host_path".into());
    };
    Ok(json!({"uri": format!("file://{}", encode(&path, true)), "name":file.name,"mime":file.mime}))
}
fn assistant_descriptor(
    body: &Value,
    assistant_id: &str,
    digest: &str,
    size: usize,
    file: &Selected,
) -> Result<Value> {
    policy::keys(
        body,
        &["type", "attachmentID", "sha256", "size", "mime", "filename"],
        &["type", "attachmentID", "sha256", "size", "mime"],
    )?;
    let attachment_id = policy::string(body, "attachmentID")?;
    if body["type"] != "file"
        || !opaque_id(attachment_id)
        || body["sha256"] != digest
        || body["size"].as_u64() != Some(size as u64)
        || body["mime"] != file.mime
    {
        return Err("attachment_invalid_upload_receipt".into());
    }
    if let Some(filename) = body.get("filename") {
        let name = filename
            .as_str()
            .ok_or("attachment_invalid_upload_receipt")?;
        validate(name, &file.mime, false)?;
        if name.encode_utf16().count() > 512 || name.contains("..") {
            return Err("attachment_invalid_upload_receipt".into());
        }
    }
    let mut contact = body.clone();
    contact["assistantID"] = json!(assistant_id);
    Ok(
        json!({"uri":format!("/api/yuri/assistants/{assistant_id}/contact/attachments/{attachment_id}"),"name":file.name,"mime":file.mime,"contact":contact}),
    )
}
#[cfg(test)]
fn stage(
    id: &str,
    scope: &Value,
    cancelled: &AtomicBool,
    transport: &dyn Transport,
    pick: impl FnOnce() -> Result<Vec<Selected>>,
) -> Value {
    stage_target(id, scope, &Target::Session, cancelled, transport, pick)
}
fn stage_target(
    id: &str,
    scope: &Value,
    target: &Target,
    cancelled: &AtomicBool,
    transport: &dyn Transport,
    pick: impl FnOnce() -> Result<Vec<Selected>>,
) -> Value {
    let result =
        |id: &str, state: &str, files: Vec<Value>, orphaned: usize, error: Option<&str>| {
            target.result(id, state, files, orphaned, error)
        };
    let current = || !cancelled.load(Ordering::Acquire) && transport.current(scope);
    if !current() {
        return result(id, "retired", vec![], 0, Some("attachment_scope_stale"));
    }
    let files = match pick() {
        Ok(v) => v,
        Err(_) if !current() => {
            return result(id, "retired", vec![], 0, Some("attachment_cancelled"));
        }
        Err(e) => return result(id, "failed", vec![], 0, Some(&e)),
    };
    if files.len() > COUNT_LIMIT {
        return result(id, "failed", vec![], 0, Some("attachment_count_limit"));
    }
    if files.is_empty() {
        return result(id, "cancelled", vec![], 0, None);
    }
    let mut attachments = Vec::new();
    let mut total = 0;
    for file in files {
        if !current() {
            return result(
                id,
                "retired",
                vec![],
                attachments.len(),
                Some("attachment_scope_stale"),
            );
        }
        let prepared: Result<(Upload, String, usize)> = (|| {
            validate(&file.name, &file.mime, false)?;
            let bytes = native::read(&file.source, cancelled)?;
            if bytes.is_empty() || bytes.len() > FILE_LIMIT || bytes.len() > TOTAL_LIMIT - total {
                return Err("attachment_size_limit".into());
            }
            let digest = native::sha256(&bytes)?;
            let identifier = vault::id()?;
            let size = bytes.len();
            let (path, headers) = match target {
                Target::Session => (
                    format!("/api/fs/prompt-attachments/{identifier}?storage=temporary"),
                    vec![
                        ("Content-Type".into(), file.mime.clone()),
                        ("X-Yuri-Content-Length".into(), size.to_string()),
                        ("X-Yuri-Sha256".into(), digest.clone()),
                        ("X-Yuri-Mime".into(), file.mime.clone()),
                        ("X-Yuri-Filename".into(), encode(&file.name, false)),
                    ],
                ),
                Target::Assistant(assistant_id) => (
                    format!("/api/yuri/assistants/{assistant_id}/contact/attachments/{identifier}"),
                    vec![
                        ("Content-Type".into(), file.mime.clone()),
                        ("X-Content-Size".into(), size.to_string()),
                        ("X-Content-SHA256".into(), digest.clone()),
                        ("X-Attachment-Filename".into(), encode(&file.name, false)),
                    ],
                ),
            };
            Ok((
                Upload {
                    path,
                    headers,
                    bytes,
                },
                digest,
                size,
            ))
        })();
        let (upload, digest, size) = match prepared {
            Ok(v) => v,
            Err(e) => return result(id, "failed", attachments, 0, Some(&e)),
        };
        if !current() {
            return result(
                id,
                "retired",
                vec![],
                attachments.len(),
                Some("attachment_scope_stale"),
            );
        }
        let uploaded = transport.upload(scope, upload, cancelled);
        let attachment = match uploaded {
            UploadResult::Response { status, body }
                if match target {
                    Target::Session => status == 200,
                    Target::Assistant(_) => status == 201,
                } =>
            {
                let parsed = match target {
                    Target::Session => descriptor(&body, &digest, size, &file),
                    Target::Assistant(assistant_id) => {
                        assistant_descriptor(&body, assistant_id, &digest, size, &file)
                    }
                };
                match parsed {
                    Ok(v) => v,
                    Err(_) => {
                        return result(
                            id,
                            "unknown",
                            if current() {
                                attachments.clone()
                            } else {
                                vec![]
                            },
                            if current() { 0 } else { attachments.len() },
                            Some("attachment_invalid_upload_receipt"),
                        );
                    }
                }
            }
            UploadResult::Response { status, .. }
                if (400..500).contains(&status) && ![408, 499].contains(&status) =>
            {
                return result(
                    id,
                    "failed",
                    if current() {
                        attachments.clone()
                    } else {
                        vec![]
                    },
                    if current() { 0 } else { attachments.len() },
                    Some("attachment_upload_rejected"),
                );
            }
            UploadResult::Denied => {
                return result(
                    id,
                    "failed",
                    attachments,
                    0,
                    Some("attachment_upload_denied"),
                );
            }
            _ => {
                return result(
                    id,
                    "unknown",
                    if current() {
                        attachments.clone()
                    } else {
                        vec![]
                    },
                    if current() { 0 } else { attachments.len() },
                    Some("attachment_upload_unknown"),
                );
            }
        };
        attachments.push(attachment);
        total += size;
    }
    if !current() {
        return result(
            id,
            "retired",
            vec![],
            attachments.len(),
            Some("attachment_scope_stale"),
        );
    }
    result(id, "ready", attachments, 0, None)
}

#[cfg(test)]
#[path = "attachments_tests.rs"]
mod tests;

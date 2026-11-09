//! Local Markdown export only. Register AFTER bridge::install; no network or credentials.
//! UI owner drains channel().1 and calls Job::show(live_native_window) on the UI thread,
//! outside any RefCell borrow. Retain Owner; invalidate it synchronously BEFORE publishing
//! a replacement Host/lease/window scope, and drop it before stopping the native view.
use crate::policy::{self, Result};
use nsh_engine::{HostChannel, HostReply};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
    mpsc,
};

pub const CONTENT_LIMIT: usize = 8 * 1024 * 1024;
pub const METHODS: &[&str] = &[
    "desktop.documents.save",
    "desktop.documents.status",
    "desktop.documents.cancel",
];
const RECEIPTS: usize = 128;
/// Native, synchronous, credential-free authority predicate. Invalidation must ALSO call
/// Owner::invalidate(): it serializes retirement against the final local rename.
pub type Authority = Arc<dyn Fn(&Value) -> bool + Send + Sync>;
#[path = "documents_files.rs"]
mod files;
#[path = "documents_native.rs"]
mod native;
#[cfg(any(target_os = "windows", test))]
#[path = "documents_windows_abi.rs"]
mod windows_abi;

struct Receipt {
    scope: Value,
    owner: String,
    cancelled: Arc<AtomicBool>,
    result: Value,
    verify: Option<Verification>,
    verifying: bool,
}
struct Verification {
    grant: files::Grant,
    content: String,
}
#[derive(Default)]
struct Book {
    receipts: HashMap<String, Receipt>,
    active: bool,
}
#[derive(Clone)]
pub struct Port(mpsc::SyncSender<Job>);
pub struct Inbox(mpsc::Receiver<Job>);
impl Inbox {
    pub fn try_recv(&self) -> Option<Job> {
        self.0.try_recv().ok()
    }
}
pub fn channel() -> (Port, Inbox) {
    let (tx, rx) = mpsc::sync_channel(1);
    (Port(tx), Inbox(rx))
}
pub fn is_presenting() -> bool {
    native::presenting()
}
pub struct Owner {
    book: Arc<Mutex<Book>>,
    stopped: Arc<AtomicBool>,
}
impl Owner {
    pub fn invalidate(&self) {
        let mut book = self.book.lock().unwrap_or_else(|e| e.into_inner());
        let mut released = false;
        for receipt in book.receipts.values_mut() {
            receipt.cancelled.store(true, Ordering::Release);
            released |= receipt.verify.take().is_some();
        }
        if released {
            book.active = false;
        }
    }
}
impl Drop for Owner {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        self.invalidate();
    }
}

fn receipt(id: &str, state: &str, error: Option<&str>) -> Value {
    let mut value = json!({"requestID": id, "state": state});
    if let Some(error) = error {
        value["error"] = json!(error);
    }
    value
}
fn token(value: &Value, field: &str) -> Result<String> {
    let value = policy::string(value, field)?;
    if value.len() > 128
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("documents_invalid_id".into());
    }
    Ok(value.into())
}
fn parse(value: &Value, save: bool) -> Result<(String, String, Value)> {
    let fields: &[&str] = if save {
        &[
            "requestID",
            "ownerID",
            "expectedHost",
            "filename",
            "content",
            "format",
        ]
    } else {
        &["requestID", "ownerID", "expectedHost"]
    };
    policy::keys(value, fields, fields)?;
    if save {
        let name = policy::string(value, "filename")?;
        let content = policy::string(value, "content")?;
        if value["format"] != "markdown"
            || name.len() > 240
            || !name.ends_with(".md")
            || name.starts_with('.')
            || name
                .chars()
                .any(|c| c.is_control() || "/\\:*?\"<>|".contains(c))
        {
            return Err("documents_invalid_metadata".into());
        }
        if content.len() > CONTENT_LIMIT || content.contains('\0') {
            return Err("documents_content_limit".into());
        }
    }
    Ok((
        token(value, "requestID")?,
        token(value, "ownerID")?,
        policy::scope(&value["expectedHost"])?,
    ))
}

/// One queued/presented/writing job, <=8 MiB content. Receipts never retain successful
/// content or paths; only an uncertain commit retains its original native grant for GET verification.
pub struct Job {
    id: String,
    filename: String,
    content: Option<String>,
    scope: Value,
    cancelled: Arc<AtomicBool>,
    stopped: Arc<AtomicBool>,
    authority: Authority,
    book: Arc<Mutex<Book>>,
    reply: Option<HostReply>,
    finished: bool,
}
impl Job {
    fn current(&self) -> bool {
        !self.stopped.load(Ordering::Acquire)
            && !self.cancelled.load(Ordering::Acquire)
            && (self.authority)(&self.scope)
    }
    fn complete(&mut self, value: Value, verification: Option<Verification>) {
        let mut book = self.book.lock().unwrap_or_else(|e| e.into_inner());
        let verification = verification.filter(|_| {
            !self.stopped.load(Ordering::Acquire) && !self.cancelled.load(Ordering::Acquire)
        });
        book.active = verification.is_some();
        if let Some(row) = book.receipts.get_mut(&self.id) {
            row.result = value.clone();
            row.verify = verification;
        }
        self.finished = true;
        if let Some(reply) = self.reply.take() {
            reply.resolve(value);
        }
    }
    fn fail(&mut self, code: &str) {
        self.complete(receipt(&self.id, "error", Some(code)), None);
    }
    fn cancel(&mut self) {
        self.complete(receipt(&self.id, "cancelled", None), None);
    }
    /// Main thread only, native owning NSWindow*/HWND, never supplied by JS.
    /// Mac defers out of a borrowed timer pump before entering AppKit's nested modal loop.
    pub unsafe fn show(mut self, window: *mut std::ffi::c_void) {
        if !self.current() {
            self.cancel();
            return;
        }
        unsafe {
            native::schedule(self, window);
        }
    }
    unsafe fn present(mut self, window: *mut std::ffi::c_void) {
        if !self.current() {
            self.cancel();
            return;
        }
        match unsafe { native::choose(window, &self.filename) } {
            Ok(Some(path)) if self.current() => self.write_selected(path),
            Ok(_) => self.cancel(),
            Err(error) => self.fail(&error),
        }
    }
    #[cfg(test)]
    fn test_panel(mut self, choose: impl FnOnce() -> Result<Option<std::path::PathBuf>>) {
        if !self.current() {
            self.cancel();
            return;
        }
        match choose() {
            Ok(Some(path)) if self.current() => self.write(path),
            Ok(_) => self.cancel(),
            Err(e) => self.fail(&e),
        }
    }
    fn write_selected(self, path: std::path::PathBuf) {
        // If spawn fails, the closure/Job is dropped and releases the exact receipt.
        let _ = std::thread::Builder::new()
            .name("yuri-document-save".into())
            .spawn(move || self.write(path));
    }
    fn write(mut self, path: std::path::PathBuf) {
        if !self.current() {
            self.cancel();
            return;
        }
        let grant = match files::Grant::selected(&path) {
            Ok(v) => v,
            Err(e) => {
                self.fail(&e);
                return;
            }
        };
        let content = self.content.take().expect("validated document content");
        let mut stage = match grant.stage(content.as_bytes(), || self.current()) {
            Ok(v) => v,
            Err(e) => {
                if self.current() {
                    self.fail(&e);
                } else {
                    self.cancel();
                }
                return;
            }
        };
        // Only rename is in this gate. cancel/invalidate takes the same mutex: retirement
        // cannot acknowledge before an already-admitted commit, or permit a later one.
        let result = {
            let _guard = self.book.lock().unwrap_or_else(|e| e.into_inner());
            // Do not re-enter the authority publisher while holding this gate. Native
            // invalidation MUST take this gate before publishing its replacement scope.
            if self.stopped.load(Ordering::Acquire) || self.cancelled.load(Ordering::Acquire) {
                Err("documents_cancelled".into())
            } else {
                grant.commit(&mut stage)
            }
        };
        match result {
            Ok(()) => self.complete(receipt(&self.id, "saved", None), None),
            Err(error) if error == "documents_write_unknown" => {
                if grant.verify(content.as_bytes()).unwrap_or(false) {
                    self.complete(receipt(&self.id, "saved", None), None);
                } else {
                    self.complete(
                        receipt(&self.id, "error", Some("documents_write_unknown")),
                        Some(Verification { grant, content }),
                    );
                }
            }
            Err(error) if error == "documents_cancelled" => self.cancel(),
            Err(error) => self.fail(&error),
        }
    }
}
impl Drop for Job {
    fn drop(&mut self) {
        if !self.finished {
            self.fail("documents_owner_unavailable");
        }
    }
}

/// Register last: the bridge's fallback must not replace these exact local methods.
pub fn install(host: &HostChannel, authority: Authority, port: Port) -> Owner {
    let book = Arc::new(Mutex::new(Book::default()));
    let stopped = Arc::new(AtomicBool::new(false));
    for &method in METHODS {
        let book = book.clone();
        let stopped = stopped.clone();
        let authority = authority.clone();
        let port = port.clone();
        host.handle(method, move |mut call| {
            let mut value = call.take_data();
            let Some(reply) = call.into_reply() else {
                return;
            };
            if stopped.load(Ordering::Acquire) {
                reply.reject("documents_owner_unavailable");
                return;
            }
            let (id, owner, scope) = match parse(&value, method == METHODS[0]) {
                Ok(v) => v,
                Err(e) => {
                    reply.reject(e);
                    return;
                }
            };
            if !(authority)(&scope) {
                reply.reject("documents_scope_retired");
                return;
            }
            let mut locked = book.lock().unwrap_or_else(|e| e.into_inner());
            if method != METHODS[0] {
                let Some(row) = locked
                    .receipts
                    .get_mut(&id)
                    .filter(|r| r.owner == owner && r.scope == scope)
                else {
                    reply.reject("documents_receipt_missing");
                    return;
                };
                if method == METHODS[2] {
                    row.cancelled.store(true, Ordering::Release);
                    // Cancellation cannot undo/claim failure of an uncertain commit. Keep
                    // its exact unknown receipt, but retire the private grant/content.
                    let released = row.verify.take().is_some();
                    let result = row.result.clone();
                    if released {
                        locked.active = false;
                    }
                    reply.resolve(result);
                    return;
                }
                if row.verifying || row.verify.is_none() {
                    reply.resolve(row.result.clone());
                    return;
                }
                let verify = row.verify.take().expect("checked verification");
                row.verifying = true;
                let work = Arc::new(Mutex::new(Some((verify, reply))));
                let worker = work.clone();
                let worker_book = book.clone();
                let worker_id = id.clone();
                // Read ONLY the original selected target. Never present or write from status.
                let spawned = std::thread::Builder::new()
                    .name("yuri-document-status".into())
                    .spawn(move || {
                        let (verify, reply) = worker
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .take()
                            .expect("single verifier");
                        let matches = verify
                            .grant
                            .verify(verify.content.as_bytes())
                            .unwrap_or(false);
                        let id = worker_id;
                        let mut book = worker_book.lock().unwrap_or_else(|e| e.into_inner());
                        let retired = book
                            .receipts
                            .get(&id)
                            .is_none_or(|row| row.cancelled.load(Ordering::Acquire));
                        if matches || retired {
                            book.active = false;
                        }
                        if let Some(row) = book.receipts.get_mut(&id) {
                            row.verifying = false;
                            if matches {
                                row.result = receipt(&id, "saved", None);
                            } else if !retired {
                                row.verify = Some(verify);
                            }
                            reply.resolve(row.result.clone());
                        } else {
                            reply.reject("documents_receipt_missing");
                        }
                    });
                if spawned.is_err()
                    && let Some((verify, reply)) =
                        work.lock().unwrap_or_else(|e| e.into_inner()).take()
                {
                    if let Some(row) = locked.receipts.get_mut(&id) {
                        row.verify = Some(verify);
                        row.verifying = false;
                    }
                    reply.reject("documents_status_unavailable");
                }
                return;
            }
            if locked.active
                || locked.receipts.contains_key(&id)
                || locked.receipts.len() >= RECEIPTS
            {
                reply.reject("documents_busy_or_request_reused");
                return;
            }
            let cancelled = Arc::new(AtomicBool::new(false));
            locked.active = true;
            locked.receipts.insert(
                id.clone(),
                Receipt {
                    scope: scope.clone(),
                    owner,
                    cancelled: cancelled.clone(),
                    result: receipt(&id, "pending", None),
                    verify: None,
                    verifying: false,
                },
            );
            drop(locked);
            let Value::String(content) = value["content"].take() else {
                unreachable!("validated content")
            };
            let job = Job {
                id,
                filename: value["filename"].as_str().unwrap_or_default().into(),
                content: Some(content),
                scope,
                cancelled,
                stopped: stopped.clone(),
                authority: authority.clone(),
                book: book.clone(),
                reply: Some(reply),
                finished: false,
            };
            // sync_channel(1), try_send never blocks the JS engine or launches a native window.
            if let Err(
                mpsc::TrySendError::Full(mut job) | mpsc::TrySendError::Disconnected(mut job),
            ) = port.0.try_send(job)
            {
                job.fail("documents_ui_unavailable");
            }
        });
    }
    Owner { book, stopped }
}

#[cfg(test)]
#[path = "documents_tests.rs"]
mod tests;

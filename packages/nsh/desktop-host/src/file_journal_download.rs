//! Standalone Host-file download. Reuses documents' OS-selected destination grant;
//! JS never supplies a local path or receives native bytes / credentials.
//! Install AFTER generic bridge; UI drains Inbox, Job::show(real NSWindow/HWND).
//! Invalidate Owner synchronously BEFORE Host/window retirement. Source must be
//! the connection actor's bounded, authenticated binary GET, NEVER local fs::read.
use crate::policy::{self, Result};
use nsh_engine::{HostChannel, HostReply};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
};
#[path = "documents_files.rs"]
mod files;
#[path = "file_journal_download_native.rs"]
mod native;
#[cfg(test)]
#[path = "file_journal_download_tests.rs"]
mod tests;
#[path = "documents_windows_abi.rs"]
mod windows_abi;

pub const LIMIT: usize = 25 * 1024 * 1024;
pub const METHODS: &[&str] = &[
    "desktop.files.download.capabilities",
    "desktop.files.download.save",
    "desktop.files.download.status",
    "desktop.files.download.cancel",
];
pub type Authority = Arc<dyn Fn(&Value) -> bool + Send + Sync>;
/// Exact captured Host scope + Host source path + hard byte limit; no native destination.
pub type Source = Arc<dyn Fn(&Value, &str, usize) -> Result<Vec<u8>> + Send + Sync>;
struct Verification {
    grant: files::Grant,
    bytes: Vec<u8>,
}
struct Receipt {
    owner: String,
    scope: Value,
    cancelled: Arc<AtomicBool>,
    result: Value,
    verify: Option<Verification>,
}
#[derive(Default)]
struct Book {
    receipts: HashMap<String, Receipt>,
    active: bool,
}
pub struct Owner {
    book: Arc<Mutex<Book>>,
    stopped: Arc<AtomicBool>,
}
impl Owner {
    pub fn invalidate(&self) {
        let mut book = self.book.lock().unwrap_or_else(|e| e.into_inner());
        for row in book.receipts.values_mut() {
            row.cancelled.store(true, Ordering::Release);
            row.verify = None;
        }
        book.active = false;
    }
}
impl Drop for Owner {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        self.invalidate();
    }
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
fn result(id: &str, state: &str, error: Option<&str>) -> Value {
    let mut v = json!({"requestID":id,"state":state});
    if let Some(e) = error {
        v["error"] = json!(e);
    }
    v
}
fn token(value: &Value, field: &str) -> Result<String> {
    let text = policy::string(value, field)?;
    if text.len() > 128
        || !text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("download_invalid_id".into());
    }
    Ok(text.into())
}
fn parse(v: &Value, save: bool) -> Result<(String, String, Value)> {
    let fields: &[&str] = if save {
        &["requestID", "ownerID", "expectedHost", "path"]
    } else {
        &["requestID", "ownerID", "expectedHost"]
    };
    policy::keys(v, fields, fields)?;
    if save {
        let path = policy::string(v, "path")?;
        if path.len() > 16384
            || path.chars().any(char::is_control)
            || path.contains('\0')
            || path.starts_with("file:")
            || path.starts_with("http:")
            || path.starts_with("https:")
        {
            return Err("download_invalid_source".into());
        }
    }
    Ok((
        token(v, "requestID")?,
        token(v, "ownerID")?,
        policy::scope(&v["expectedHost"])?,
    ))
}
pub struct Job {
    id: String,
    filename: String,
    path: String,
    scope: Value,
    source: Source,
    authority: Authority,
    cancelled: Arc<AtomicBool>,
    stopped: Arc<AtomicBool>,
    book: Arc<Mutex<Book>>,
    reply: Option<HostReply>,
    finished: bool,
}
impl Job {
    fn current(&self) -> bool {
        !self.cancelled.load(Ordering::Acquire)
            && !self.stopped.load(Ordering::Acquire)
            && (self.authority)(&self.scope)
    }
    fn complete(&mut self, value: Value, verification: Option<Verification>) {
        let mut book = self.book.lock().unwrap_or_else(|e| e.into_inner());
        let verification = verification.filter(|_| {
            !self.cancelled.load(Ordering::Acquire) && !self.stopped.load(Ordering::Acquire)
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
    fn fail(&mut self, error: &str) {
        self.complete(result(&self.id, "error", Some(error)), None);
    }
    /// Only a trusted native UI owner supplies this window pointer.
    pub unsafe fn show(mut self, window: *mut std::ffi::c_void) {
        if !self.current() {
            self.complete(result(&self.id, "cancelled", None), None);
            return;
        }
        unsafe {
            native::schedule(self, window);
        }
    }
    unsafe fn present(mut self, window: *mut std::ffi::c_void) {
        if !self.current() {
            self.complete(result(&self.id, "cancelled", None), None);
            return;
        }
        match unsafe { native::choose(window, &self.filename, &|| self.current()) } {
            Ok(Some(path)) if self.current() => {
                let _ = std::thread::Builder::new()
                    .name("yuri-file-download".into())
                    .spawn(move || self.write(path));
            }
            Ok(_) => self.complete(result(&self.id, "cancelled", None), None),
            Err(e) => self.fail(&e),
        }
    }
    fn write(mut self, selected: std::path::PathBuf) {
        if !self.current() {
            self.complete(result(&self.id, "cancelled", None), None);
            return;
        }
        let grant = match files::Grant::selected(&selected) {
            Ok(v) => v,
            Err(e) => {
                self.fail(&e);
                return;
            }
        };
        let bytes = match (self.source)(&self.scope, &self.path, LIMIT) {
            Ok(v) if v.len() <= LIMIT => v,
            _ => {
                self.fail("download_read_failed_or_limit");
                return;
            }
        };
        if !self.current() {
            self.complete(result(&self.id, "cancelled", None), None);
            return;
        }
        let mut stage = match grant.stage(&bytes, || self.current()) {
            Ok(v) => v,
            Err(_) => {
                self.fail("download_stage_failed");
                return;
            }
        };
        // Authority predicate is evaluated OUTSIDE Book: native invalidation takes
        // this gate before publishing a replacement scope, with no lock inversion.
        if !self.current() {
            self.complete(result(&self.id, "cancelled", None), None);
            return;
        }
        let commit = {
            let _gate = self.book.lock().unwrap_or_else(|e| e.into_inner());
            if self.cancelled.load(Ordering::Acquire) || self.stopped.load(Ordering::Acquire) {
                Err("download_cancelled".into())
            } else {
                grant.commit(&mut stage)
            }
        };
        if commit.is_err() {
            self.complete(
                result(&self.id, "unknown", Some("download_write_unknown")),
                Some(Verification { grant, bytes }),
            );
        } else {
            self.complete(result(&self.id, "saved", None), None);
        }
    }
}
impl Drop for Job {
    fn drop(&mut self) {
        if !self.finished {
            self.fail("download_interrupted");
        }
    }
}

pub fn install(host: &HostChannel, authority: Authority, source: Source, port: Port) -> Owner {
    let owner = Owner {
        book: Arc::new(Mutex::new(Book::default())),
        stopped: Arc::new(AtomicBool::new(false)),
    };
    for &method in METHODS {
        let book = owner.book.clone();
        let stopped = owner.stopped.clone();
        let authority = authority.clone();
        let source = source.clone();
        let port = port.clone();
        host.handle(method, move |mut call| {
            let value = call.take_data();
            let Some(reply) = call.into_reply() else {
                return;
            };
            let mut reply = Some(reply);
            let parsed = (|| -> Result<()> {
                if stopped.load(Ordering::Acquire) {
                    return Err("download_closed".into());
                }
                if method.ends_with("capabilities") {
                    policy::keys(&value, &[], &[])?;
                    reply
                        .take()
                        .unwrap()
                        .resolve(json!({"save":true,"maxBytes":LIMIT}));
                    return Ok(());
                }
                let save = method.ends_with("save");
                let (id, who, scope) = parse(&value, save)?;
                if !(authority)(&scope) {
                    return Err("download_scope_stale".into());
                }
                if save {
                    let path = policy::string(&value, "path")?.to_string();
                    let name = path.rsplit(['/', '\\']).next().unwrap_or("download");
                    let filename = if name.is_empty()
                        || name.len() > 240
                        || name
                            .chars()
                            .any(|c| c.is_control() || "<>:\"|?*".contains(c))
                    {
                        "download".into()
                    } else {
                        name.into()
                    };
                    let cancelled = Arc::new(AtomicBool::new(false));
                    {
                        let mut b = book.lock().map_err(|_| "download_unavailable")?;
                        if b.active || b.receipts.contains_key(&id) || b.receipts.len() >= 128 {
                            return Err("download_busy_or_receipt_capacity".into());
                        }
                        b.active = true;
                        b.receipts.insert(
                            id.clone(),
                            Receipt {
                                owner: who,
                                scope: scope.clone(),
                                cancelled: cancelled.clone(),
                                result: result(&id, "pending", None),
                                verify: None,
                            },
                        );
                    }
                    let job = Job {
                        id,
                        filename,
                        path,
                        scope,
                        source: source.clone(),
                        authority: authority.clone(),
                        cancelled,
                        stopped: stopped.clone(),
                        book: book.clone(),
                        reply: reply.take(),
                        finished: false,
                    };
                    if let Err(e) = port.0.try_send(job) {
                        drop(e);
                    }
                } else {
                    let mut b = book.lock().map_err(|_| "download_unavailable")?;
                    let row = b
                        .receipts
                        .get_mut(&id)
                        .filter(|r| r.owner == who && r.scope == scope)
                        .ok_or("download_receipt_mismatch")?;
                    if method.ends_with("cancel") {
                        row.cancelled.store(true, Ordering::Release);
                        let released = row.verify.take().is_some();
                        let value = row.result.clone();
                        if released {
                            b.active = false;
                        }
                        reply.take().unwrap().resolve(value);
                    } else if let Some(verification) = row.verify.take() {
                        let book = book.clone();
                        let cancelled = row.cancelled.clone();
                        let stopped = stopped.clone();
                        let old = row.result.clone();
                        let reply = reply.take().unwrap();
                        let _ = std::thread::Builder::new()
                            .name("yuri-download-verify".into())
                            .spawn(move || {
                                let verified = verification
                                    .grant
                                    .verify(&verification.bytes)
                                    .unwrap_or(false);
                                let mut b = book.lock().unwrap_or_else(|e| e.into_inner());
                                let live = !cancelled.load(Ordering::Acquire)
                                    && !stopped.load(Ordering::Acquire);
                                // Contents matching after a failed rename/directory flush is
                                // only an observation, not a new durable destination ACK.
                                let value = if live && verified {
                                    result(
                                        &id,
                                        "unknown",
                                        Some("download_contents_observed_durability_unconfirmed"),
                                    )
                                } else {
                                    old
                                };
                                if let Some(row) = b.receipts.get_mut(&id) {
                                    row.result = value.clone();
                                    if live {
                                        row.verify = Some(verification);
                                    }
                                }
                                b.active = live;
                                reply.resolve(value);
                            });
                    } else {
                        reply.take().unwrap().resolve(row.result.clone());
                    }
                }
                Ok(())
            })();
            if let Err(error) = parsed
                && let Some(reply) = reply
            {
                reply.reject(&error);
            }
        });
    }
    owner
}

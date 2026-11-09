//! Window-private file download owner. Install only with the actor's capture
//! and the documents owner's streaming target adapter; no buffered fallback.
use crate::policy::{self, Result};
use nsh_engine::{HostChannel, Network};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
};
// Reuse the owner's private safe-save source; its optional slice stage/verify
// API is intentionally unused by this streaming consumer, not dead product API.
#[allow(dead_code, clippy::duplicate_mod)]
#[path = "documents_files.rs"]
mod files;
#[path = "file_download_hash.rs"]
mod hash;
#[path = "file_journal_download_native.rs"]
mod native;
#[path = "file_download_target.rs"]
mod target;
#[path = "file_download_transport.rs"]
pub mod transport;
#[cfg(any(target_os = "windows", test))]
#[allow(clippy::duplicate_mod)]
#[path = "documents_windows_abi.rs"]
mod windows_abi;
#[cfg(test)]
use transport::HostFile;
use transport::{Captured, Checkpoint, Consumer, Source};

pub const METHODS: &[&str] = &[
    "desktop.files.download.capabilities",
    "desktop.files.download.save",
    "desktop.files.download.status",
    "desktop.files.download.cancel",
    "desktop.files.download.resume",
];
pub type Capture = Arc<dyn Fn(&Value, &str) -> Result<Captured> + Send + Sync>;
/// Native-only adapter over documents' pinned Grant + private same-dir Stage.
/// append errors may have partially written: rewind restores the known prefix.
/// commit executes once, under the retire gate; Unknown is NEVER replayable.
pub trait Target: Send {
    fn append(&mut self, bytes: &[u8]) -> Result<()>;
    fn rewind(&mut self, received: u64) -> Result<()>;
    fn seal(&mut self) -> Result<()>;
    fn commit(&mut self) -> Commit;
    fn inspect(&mut self, _current: &dyn Fn() -> bool) -> Verification {
        Verification::Unconfirmed
    }
}
pub enum Verification {
    Durable,
    Observed,
    Unconfirmed,
}
pub enum Commit {
    Saved,
    Failed,
    Unknown,
}
pub type Targets = Arc<dyn Fn(&Path) -> Result<Box<dyn Target>> + Send + Sync>;
struct Transfer {
    captured: Captured,
    file: Source,
    target: Box<dyn Target>,
    checkpoint: Checkpoint,
    complete: bool,
    usable: bool,
    hash: Option<hash::Hash>,
}
struct Receipt {
    owner: String,
    scope: Value,
    cancel: Arc<AtomicBool>,
    state: &'static str,
    error: Option<String>,
    checkpoint: Checkpoint,
    transfer: Option<Transfer>,
    running: bool,
    attachment: Option<Value>,
}
#[derive(Default)]
struct Book {
    rows: HashMap<String, Receipt>,
}
pub struct Owner {
    book: Arc<Mutex<Book>>,
    stop: Arc<AtomicBool>,
}
impl Owner {
    /// Called synchronously under the actor's publication gate, BEFORE changing
    /// authority/window/suspension. This serializes with the final local commit.
    pub fn invalidate(&self) {
        let mut book = self.book.lock().unwrap_or_else(|e| e.into_inner());
        for row in book.rows.values_mut() {
            row.cancel.store(true, Ordering::Release);
            row.transfer = None;
            if row.state == "verifying" {
                row.state = "unknown";
            }
            if row.state != "saved" && row.state != "unknown" {
                row.state = "cancelled";
            }
        }
    }
}
impl Drop for Owner {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
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
fn token(value: &Value, field: &str) -> Result<String> {
    let text = policy::string(value, field)?;
    if text.len() > 128
        || !text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        return Err("download_invalid_id".into());
    }
    Ok(text.into())
}
fn snapshot(id: &str, window: &str, row: &Receipt) -> Value {
    let mut value = json!({"requestID":id,"windowID":window,"state":row.state,"received":row.checkpoint.received,
        "total":row.checkpoint.total,"resumable":resumable(row),"error":row.error});
    if let Some(attachment) = &row.attachment {
        value["source"] = json!("assistantAttachment");
        value["attachment"] = attachment.clone();
    }
    value
}
fn resumable(row: &Receipt) -> bool {
    row.state == "error"
        && !row.cancel.load(Ordering::Acquire)
        && row.transfer.as_ref().is_some_and(|transfer| {
            transfer.usable
                && (transfer.complete
                    || transfer.checkpoint.received == 0
                    || row.checkpoint.resumable())
        })
}
pub struct Job {
    id: String,
    window: String,
    filename: String,
    file: Source,
    captured: Option<Captured>,
    targets: Targets,
    network: Arc<dyn Network>,
    book: Arc<Mutex<Book>>,
    cancel: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    finished: bool,
}
impl Job {
    #[cfg(test)]
    pub(crate) fn complete_private_file_for_test(self, selected: &Path) {
        self.write(selected);
    }
    fn current(&self) -> bool {
        !self.cancel.load(Ordering::Acquire)
            && !self.stop.load(Ordering::Acquire)
            && self.captured.as_ref().is_some_and(Captured::valid)
    }
    fn fail(&mut self, code: &str) {
        let mut book = self.book.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(row) = book.rows.get_mut(&self.id) {
            if row.state != "cancelled" {
                row.state =
                    if self.cancel.load(Ordering::Acquire) || self.stop.load(Ordering::Acquire) {
                        "cancelled"
                    } else {
                        "error"
                    };
                row.error = Some(code.into());
            }
            row.running = false;
        }
        self.finished = true;
    }
    /// Only the trusted native UI owner supplies the actual NSWindow/HWND.
    pub unsafe fn show(mut self, window_id: &str, window: *mut std::ffi::c_void) {
        if window_id != self.window || !self.current() {
            self.fail("download_scope_stale");
            return;
        }
        unsafe {
            native::schedule(self, window);
        }
    }
    unsafe fn present(mut self, window: *mut std::ffi::c_void) {
        if !self.current() {
            self.fail("download_scope_stale");
            return;
        }
        match unsafe { native::choose(window, &self.filename, &|| self.current()) } {
            Ok(Some(path)) if self.current() => {
                let _ = std::thread::Builder::new()
                    .name("yuri-download-write".into())
                    .spawn(move || self.write(&path));
            }
            Ok(_) => {
                self.cancel.store(true, Ordering::Release);
                self.fail("download_cancelled");
            }
            Err(code) => self.fail(&code),
        }
    }
    fn write(mut self, selected: &Path) {
        if !self.current() {
            self.fail("download_scope_stale");
            return;
        }
        if let Some(row) = self
            .book
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .rows
            .get_mut(&self.id)
        {
            row.state = "pending";
        }
        let target = match (self.targets)(selected) {
            Ok(target) => target,
            Err(_) => {
                self.fail("download_destination_unavailable");
                return;
            }
        };
        if !self.current() {
            self.fail("download_scope_stale");
            return;
        }
        let hash = if matches!(self.file, Source::AssistantAttachment(_)) {
            match hash::Hash::new() {
                Ok(hash) => Some(hash),
                Err(code) => {
                    self.fail(&code);
                    return;
                }
            }
        } else {
            None
        };
        let transfer = Transfer {
            captured: self.captured.take().unwrap(),
            file: self.file.clone(),
            target,
            checkpoint: Checkpoint::default(),
            complete: false,
            usable: true,
            hash,
        };
        self.finished = true;
        run(
            &self.id,
            transfer,
            self.network.clone(),
            self.book.clone(),
            self.cancel.clone(),
            self.stop.clone(),
        );
    }
}
impl Drop for Job {
    fn drop(&mut self) {
        if !self.finished {
            self.fail("download_interrupted");
        }
    }
}

struct Writer<'a> {
    id: &'a str,
    target: &'a mut dyn Target,
    book: Arc<Mutex<Book>>,
    hash: &'a mut Option<hash::Hash>,
}
impl Consumer for Writer<'_> {
    fn begin(&mut self, _: &Checkpoint) -> Result<()> {
        Ok(())
    }
    fn append(&mut self, bytes: &[u8]) -> Result<()> {
        self.target
            .append(bytes)
            .map_err(|_| "download_stage_failed")?;
        if let Some(hash) = self.hash {
            hash.update(bytes)?;
        }
        Ok(())
    }
    fn progress(&mut self, value: &Checkpoint) {
        if let Some(row) = self
            .book
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .rows
            .get_mut(self.id)
        {
            row.checkpoint = value.clone();
        }
    }
}
fn run(
    id: &str,
    mut transfer: Transfer,
    network: Arc<dyn Network>,
    book: Arc<Mutex<Book>>,
    cancel: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
) {
    let live = || !cancel.load(Ordering::Acquire) && !stop.load(Ordering::Acquire);
    let result = (|| -> Result<()> {
        if !live() || !transfer.captured.valid() {
            return Err("download_scope_stale".into());
        }
        transfer
            .target
            .rewind(transfer.checkpoint.received)
            .map_err(|_| "download_stage_failed")?;
        let mut writer = Writer {
            id,
            target: transfer.target.as_mut(),
            book: book.clone(),
            hash: &mut transfer.hash,
        };
        if !live() || !transfer.captured.valid() {
            return Err("download_scope_stale".into());
        }
        if !transfer.complete {
            match &transfer.file {
                Source::File(file) => transport::receive(
                    network,
                    &transfer.captured,
                    file,
                    &mut transfer.checkpoint,
                    live,
                    &mut writer,
                ),
                Source::AssistantAttachment(_) => transport::receive_source(
                    network,
                    &transfer.captured,
                    &transfer.file,
                    &mut transfer.checkpoint,
                    live,
                    &mut writer,
                ),
            }?;
            if let Source::AssistantAttachment(file) = &transfer.file
                && (transfer.checkpoint.received != file.size()
                    || transfer
                        .hash
                        .as_ref()
                        .ok_or("download_digest_failed")?
                        .finish()?
                        != file.digest())
            {
                return Err("download_integrity_mismatch".into());
            }
            transfer.complete = true;
        }
        if !live() || !transfer.captured.valid() {
            return Err("download_scope_stale".into());
        }
        transfer
            .target
            .seal()
            .map_err(|_| "download_stage_sync_failed")?;
        Ok(())
    })();
    // Never call capture/Reader under Book: actor retirement takes Book under
    // its publication lock. The native invalidate hook is mandatory at install.
    let current = live() && transfer.captured.valid();
    if result.as_ref().is_err_and(|code| {
        code == "download_integrity_mismatch" || code == "download_digest_failed"
    }) {
        transfer.usable = false;
    }
    // Repair partial append failures on the worker, not while a status handler
    // waits for Book. An unrepairable prefix stays retained but not resumable.
    if result.is_err()
        && !transfer.complete
        && current
        && transfer
            .target
            .rewind(transfer.checkpoint.received)
            .is_err()
    {
        transfer.checkpoint.etag = None;
        transfer.usable = false;
    }
    let mut book = book.lock().unwrap_or_else(|e| e.into_inner());
    let Some(row) = book.rows.get_mut(id) else {
        return;
    };
    row.running = false;
    row.checkpoint = transfer.checkpoint.clone();
    if !current || !live() {
        row.state = "cancelled";
        row.error = Some("download_scope_stale".into());
        return;
    }
    match result {
        Ok(()) => match transfer.target.commit() {
            Commit::Saved => {
                row.state = "saved";
                row.error = None;
            }
            Commit::Failed => {
                row.state = "error";
                row.error = Some("download_destination_not_committed".into());
            }
            Commit::Unknown => {
                row.state = "unknown";
                row.error = Some("download_destination_durability_unconfirmed".into());
                row.transfer = Some(transfer);
            }
        },
        Err(code) => {
            row.state = "error";
            row.error = Some(code);
            row.transfer = Some(transfer);
        }
    }
}

fn inspect(
    id: &str,
    mut transfer: Transfer,
    book: Arc<Mutex<Book>>,
    cancel: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
) {
    let current = || {
        !cancel.load(Ordering::Acquire)
            && !stop.load(Ordering::Acquire)
            && transfer.captured.valid()
    };
    let verdict = transfer.target.inspect(&current);
    let live = current();
    let mut book = book.lock().unwrap_or_else(|e| e.into_inner());
    let Some(row) = book.rows.get_mut(id) else {
        return;
    };
    row.running = false;
    // The verification contains no rename or GET. Even a successful new barrier
    // cannot publish after native cancellation/retirement acknowledged the gate.
    if !live || cancel.load(Ordering::Acquire) || stop.load(Ordering::Acquire) {
        row.state = "unknown";
        row.error = Some("download_destination_durability_unconfirmed".into());
        return;
    }
    match verdict {
        Verification::Durable => {
            row.state = "saved";
            row.error = None;
        }
        Verification::Observed | Verification::Unconfirmed => {
            row.state = "unknown";
            row.error = Some(
                match verdict {
                    Verification::Observed => "download_contents_observed_durability_unconfirmed",
                    _ => "download_destination_durability_unconfirmed",
                }
                .into(),
            );
            row.transfer = Some(transfer);
        }
    }
}

/// Production install: system-selected targets use documents' pinned streaming
/// Grant/Stage. The ONLY external factory is the actor's authenticated capture.
pub fn install(
    host: &HostChannel,
    window: &str,
    network: Arc<dyn Network>,
    capture: Capture,
    port: Port,
) -> Result<Owner> {
    install_with_targets(host, window, network, capture, target::factory(), port)
}
fn install_with_targets(
    host: &HostChannel,
    window: &str,
    network: Arc<dyn Network>,
    capture: Capture,
    targets: Targets,
    port: Port,
) -> Result<Owner> {
    if window.is_empty() || window.len() > 128 {
        return Err("download_window_unavailable".into());
    }
    let owner = Owner {
        book: Arc::new(Mutex::new(Book::default())),
        stop: Arc::new(AtomicBool::new(false)),
    };
    for &method in METHODS {
        let window = window.to_owned();
        let book = owner.book.clone();
        let stop = owner.stop.clone();
        let network = network.clone();
        let capture = capture.clone();
        let targets = targets.clone();
        let port = port.clone();
        host.handle(method, move |mut call| {
            let input = call.take_data(); let Some(reply) = call.into_reply() else { return; };
            let answer = (|| -> Result<Value> {
                if stop.load(Ordering::Acquire) { return Err("download_closed".into()); }
                if method.ends_with("capabilities") {
                    policy::keys(&input, &["source"], &[])?;
                    let mut capability = json!({"version":2,"save":true,"windowID":window,"maxBytes":transport::MAX_BYTES});
                    if let Some(source) = input.get("source") {
                        if source != "assistantAttachment" { return Err("download_invalid_source".into()); }
                        capability["assistantAttachment"] = json!({"supported":true,"maxBytes":transport::attachment::MAX_BYTES,"integrity":"sha256"});
                    }
                    return Ok(capability);
                }
                let save = method.ends_with("save");
                let keys: &[&str] = &["ownerID","requestID","windowID","expectedHost"];
                if save {
                    policy::keys(&input, &["ownerID","requestID","windowID","expectedHost","directory","path","source","attachment"], keys)?;
                } else { policy::keys(&input, keys, keys)?; }
                let id = token(&input,"requestID")?; let who = token(&input,"ownerID")?;
                let scope = policy::scope(&input["expectedHost"])?;
                if input["windowID"] != window { return Err("download_window_mismatch".into()); }
                let captured = capture(&scope, &window).map_err(|_| "download_scope_stale")?;
                if !captured.matches(&scope, &window) { return Err("download_scope_stale".into()); }
                if save {
                    let file = match input.get("source") {
                        None if !input.as_object().unwrap().contains_key("attachment") => Source::File(transport::HostFile { directory:policy::string(&input,"directory")?.into(), path:policy::string(&input,"path")?.into() }),
                        Some(source) if source == "assistantAttachment" && input.get("directory").is_none() && input.get("path").is_none() => Source::AssistantAttachment(transport::attachment::Attachment::parse(&input["attachment"])?),
                        _ => return Err("download_invalid_source".into()),
                    };
                    file.validate()?;
                    let attachment = match &file { Source::AssistantAttachment(file) => Some(file.descriptor().clone()), _ => None };
                    let name = file.filename();
                    let filename = if name.len() > 240 || name.chars().any(|c| c.is_control() || "<>:\"|?*".contains(c)) { "download".into() } else { name.into() };
                    let cancel = Arc::new(AtomicBool::new(false));
                    {
                        let mut b = book.try_lock().map_err(|_| "download_busy")?;
                        if b.rows.contains_key(&id) || b.rows.len() >= 128 || b.rows.values().any(|row| row.running) { return Err("download_busy_or_capacity".into()); }
                         b.rows.insert(id.clone(), Receipt { owner:who, scope, cancel:cancel.clone(), state:"selecting", error:None, checkpoint:Checkpoint::default(), transfer:None, running:true, attachment });
                    }
                    let job = Job { id:id.clone(), window:window.clone(), filename, file, captured:Some(captured), targets:targets.clone(), network:network.clone(), book:book.clone(), cancel, stop:stop.clone(), finished:false };
                    if let Err(error) = port.0.try_send(job) { drop(error); }
                } else {
                    let mut b = book.try_lock().map_err(|_| "download_busy")?;
                    let row = b.rows.get_mut(&id).filter(|row| row.owner == who && row.scope == scope).ok_or("download_receipt_mismatch")?;
                    if method.ends_with("cancel") {
                        row.cancel.store(true, Ordering::Release); row.transfer = None;
                        if row.state == "verifying" { row.state = "unknown"; }
                        if row.state != "saved" && row.state != "unknown" { row.state = "cancelled"; }
                    } else if method.ends_with("resume") {
                        if row.running || !resumable(row) { return Err("download_resume_unsupported".into()); }
                        let transfer = row.transfer.take().ok_or("download_resume_unsupported")?;
                        row.running = true; row.state = "pending"; row.error = None;
                        let id = id.clone(); let network = network.clone(); let book = book.clone(); let cancel = row.cancel.clone(); let stop = stop.clone();
                        let retained = Arc::new(Mutex::new(Some(transfer))); let work = retained.clone();
                        if std::thread::Builder::new().name("yuri-download-resume".into()).spawn(move || {
                            if let Some(transfer) = work.lock().unwrap_or_else(|e| e.into_inner()).take() { run(&id,transfer,network,book,cancel,stop); }
                        }).is_err() {
                            row.running = false; row.state = "error"; row.error = Some("download_worker_unavailable".into());
                            row.transfer = retained.lock().unwrap_or_else(|e| e.into_inner()).take();
                        }
                    } else if row.state == "unknown" && !row.running && !row.cancel.load(Ordering::Acquire) && let Some(transfer) = row.transfer.take() {
                            row.running = true; row.state = "verifying";
                            let id = id.clone(); let book = book.clone(); let cancel = row.cancel.clone(); let stop = stop.clone();
                            let retained = Arc::new(Mutex::new(Some(transfer))); let work = retained.clone();
                            if std::thread::Builder::new().name("yuri-download-inspect".into()).spawn(move || {
                                if let Some(transfer) = work.lock().unwrap_or_else(|e| e.into_inner()).take() { inspect(&id, transfer, book, cancel, stop); }
                            }).is_err() {
                                row.running = false; row.state = "unknown"; row.transfer = retained.lock().unwrap_or_else(|e| e.into_inner()).take();
                                row.error = Some("download_worker_unavailable".into());
                            }
                    }
                }
                let b = book.try_lock().map_err(|_| "download_busy")?;
                Ok(snapshot(&id,&window,b.rows.get(&id).ok_or("download_receipt_mismatch")?))
            })();
            match answer { Ok(value) => reply.resolve(value), Err(code) => reply.reject(&code) }
        });
    }
    Ok(owner)
}

#[cfg(test)]
#[path = "file_download_attachment_tests.rs"]
mod attachment_tests;
#[cfg(test)]
#[path = "file_download_tests.rs"]
mod tests;

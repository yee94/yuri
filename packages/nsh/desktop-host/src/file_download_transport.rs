//! Download-only authenticated GET over the connection actor's injected Network.
//! Native capture and disk consumer stay off JS. Two 64-KiB queued chunks plus
//! the producer/consumer chunks bound buffering independently of file size.
use crate::policy::{self, Result};
use nsh_core::platform::{FetchEvent, HttpHead, HttpRequest};
use nsh_engine::{FetchTask, Network};
use serde_json::Value;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::time::{Duration, Instant};
#[path = "file_download_attachment.rs"]
pub mod attachment;
use attachment::Attachment;

#[derive(Clone)]
pub enum Source {
    File(HostFile),
    AssistantAttachment(Attachment),
}
impl Source {
    pub fn validate(&self) -> Result<()> {
        match self {
            Self::File(file) => file.validate(),
            Self::AssistantAttachment(file) => Attachment::parse(file.descriptor()).map(|_| ()),
        }
    }
    pub fn filename(&self) -> &str {
        match self {
            Self::File(file) => file.path.rsplit('/').next().unwrap_or("download"),
            Self::AssistantAttachment(file) => file.filename(),
        }
    }
}

pub const CHUNK: usize = 65_536;
pub const MAX_BYTES: u64 = 1 << 40;
pub type Current = Arc<dyn Fn() -> bool + Send + Sync>;

pub struct Captured {
    scope: Value,
    window: String,
    origin: String,
    token: String,
    current: Current,
}
impl Captured {
    /// Reader must capture all fields under its publication lock. `current`
    /// checks live + !suspended + exact scope/window/origin/authorization. It
    /// must not lock the download book; invalidate uses the opposite lock order.
    pub fn direct(
        scope: &Value,
        window: &str,
        origin: &str,
        token: &str,
        loopback: bool,
        current: Current,
    ) -> Result<Self> {
        let scope = policy::scope(scope)?;
        if window.is_empty()
            || window.len() > 128
            || window.chars().any(char::is_control)
            || !current()
        {
            return Err("download_scope_stale".into());
        }
        policy::token(token)?;
        Ok(Self {
            scope,
            window: window.into(),
            origin: policy::origin(origin, loopback)?,
            token: token.into(),
            current,
        })
    }
    pub fn matches(&self, scope: &Value, window: &str) -> bool {
        self.scope == *scope && self.window == window && (self.current)()
    }
    pub fn valid(&self) -> bool {
        (self.current)()
    }
    fn request(&self, file: &Source, checkpoint: &Checkpoint) -> Result<HttpRequest> {
        if !self.valid() {
            return Err("download_scope_stale".into());
        }
        file.validate()?;
        checkpoint.validate()?;
        let path = match file {
            Source::File(file) => format!(
                "/api/fs/raw?path={}&directory={}&download=true",
                encoded(&file.path),
                encoded(&file.directory)
            ),
            Source::AssistantAttachment(file) => file.path(),
        };
        let mut request = HttpRequest::new("GET", format!("{}{path}", self.origin))
            .header("Authorization", format!("Bearer {}", self.token))
            .header("Accept-Encoding", "identity")
            .header("Cache-Control", "no-store");
        request.follow_redirects = false;
        if checkpoint.received > 0 {
            request = request
                .header("Range", format!("bytes={}-", checkpoint.received))
                .header(
                    "If-Range",
                    checkpoint
                        .etag
                        .as_deref()
                        .ok_or("download_resume_unsupported")?,
                );
        }
        Ok(request)
    }
}
#[derive(Clone)]
pub struct HostFile {
    pub directory: String,
    pub path: String,
}
impl HostFile {
    pub fn validate(&self) -> Result<()> {
        fn absolute(s: &str) -> bool {
            let bytes = s.as_bytes();
            (s.starts_with('/') && !s.starts_with("//")
                || s.starts_with("//")
                    && !s.starts_with("//?/")
                    && s.split('/').filter(|part| !part.is_empty()).count() >= 2
                || bytes.len() >= 3 && bytes[0].is_ascii_uppercase() && &bytes[1..3] == b":/")
                && s.len() <= 16_384
                && !s.contains('\\')
                && !s.chars().any(char::is_control)
                && !s.split('/').any(|part| part == "." || part == "..")
                && !s.strip_prefix("//").unwrap_or(s).contains("//")
        }
        let root = self.directory.trim_end_matches('/');
        let prefix = format!("{root}/");
        if !absolute(&self.directory)
            || !absolute(&self.path)
            || self.path.ends_with('/')
            || !self.path.starts_with(&prefix)
            || self.path.len() <= prefix.len()
        {
            return Err("download_invalid_source".into());
        }
        Ok(())
    }
}
fn encoded(s: &str) -> String {
    let mut out = String::new();
    for byte in s.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}
#[derive(Clone, Default, Debug, PartialEq, Eq)]
pub struct Checkpoint {
    pub received: u64,
    pub total: Option<u64>,
    pub etag: Option<String>,
}
fn strong_etag(value: &str) -> bool {
    value.len() >= 2
        && value.len() <= 512
        && value.starts_with('"')
        && value.ends_with('"')
        && value.as_bytes()[1..value.len() - 1]
            .iter()
            .all(|b| *b == 0x21 || (0x23..=0x7e).contains(b))
}
impl Checkpoint {
    fn validate(&self) -> Result<()> {
        if self.received > MAX_BYTES
            || self
                .total
                .is_some_and(|n| n > MAX_BYTES || n < self.received)
        {
            return Err("download_size_invalid".into());
        }
        if self.received > 0
            && (self.total.is_none_or(|n| n <= self.received)
                || self.etag.as_deref().is_none_or(|s| !strong_etag(s)))
        {
            return Err("download_resume_unsupported".into());
        }
        Ok(())
    }
    pub fn resumable(&self) -> bool {
        self.received > 0 && self.validate().is_ok()
    }
}
fn header<'a>(head: &'a HttpHead, key: &str) -> Result<Option<&'a str>> {
    let mut values = head
        .headers
        .iter()
        .filter(|(name, _)| name.eq_ignore_ascii_case(key));
    let value = values.next().map(|(_, value)| value.as_str());
    if values.next().is_some() {
        return Err("download_duplicate_header".into());
    }
    Ok(value)
}
fn size(value: &str) -> Result<u64> {
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return Err("download_size_invalid".into());
    }
    let n = value.parse::<u64>().map_err(|_| "download_size_invalid")?;
    if n > MAX_BYTES {
        return Err("download_size_invalid".into());
    }
    Ok(n)
}
fn response(head: &HttpHead, url: &str, checkpoint: &Checkpoint) -> Result<Checkpoint> {
    if head.redirected || head.url != url || (300..400).contains(&head.status) {
        return Err("download_redirect_rejected".into());
    }
    if header(head, "content-encoding")?.is_some_and(|s| !s.eq_ignore_ascii_case("identity")) {
        return Err("download_encoding_rejected".into());
    }
    let length = header(head, "content-length")?.map(size).transpose()?;
    let etag = header(head, "etag")?
        .filter(|s| strong_etag(s))
        .map(str::to_owned);
    let range = header(head, "content-range")?;
    if checkpoint.received == 0 {
        if head.status != 200 || range.is_some() {
            return Err("download_response_rejected".into());
        }
        return Ok(Checkpoint {
            received: 0,
            total: length,
            etag,
        });
    }
    // A 200/416, weak/new ETag or shortened/shifted range never resets or
    // appends to the retained partial. User must explicitly start a new save.
    if head.status != 206 || etag != checkpoint.etag {
        return Err("download_resume_identity_unconfirmed".into());
    }
    let total = checkpoint.total.ok_or("download_resume_unsupported")?;
    let expected = format!("bytes {}-{}/{total}", checkpoint.received, total - 1);
    if range != Some(expected.as_str()) || length.is_some_and(|n| n != total - checkpoint.received)
    {
        return Err("download_resume_range_unconfirmed".into());
    }
    Ok(checkpoint.clone())
}

type TaskSlot = Arc<Mutex<Option<Box<dyn FetchTask>>>>;
struct Stream {
    rx: Option<mpsc::Receiver<FetchEvent>>,
    task: TaskSlot,
    stop: Arc<AtomicBool>,
}
impl Drop for Stream {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        // Unblock a producer BEFORE cancellation: an injected task may join it.
        self.rx.take();
        let task = self.task.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(task) = task {
            task.cancel();
        }
    }
}
impl Stream {
    fn open(network: Arc<dyn Network>, request: HttpRequest) -> Result<Self> {
        let (tx, rx) = mpsc::sync_channel(2);
        let stop = Arc::new(AtomicBool::new(false));
        let task: TaskSlot = Arc::new(Mutex::new(None));
        let stopped = stop.clone();
        let slot = task.clone();
        // fetch and callbacks may be synchronous. The launcher keeps both off
        // the engine/UI thread while a bounded send supplies real backpressure.
        std::thread::Builder::new()
            .name("yuri-download-fetch".into())
            .spawn(move || {
                let late = stopped.clone();
                let mut failed = false;
                let handle = network.fetch(
                    request,
                    Box::new(move |event| {
                        if failed || late.load(Ordering::Acquire) {
                            return;
                        }
                        let event = match event {
                            FetchEvent::Data(bytes) if bytes.len() > CHUNK => {
                                failed = true;
                                FetchEvent::Failed("download_chunk_limit".into())
                            }
                            FetchEvent::Head(ref h)
                                if h.headers.len() > 128
                                    || h.headers
                                        .iter()
                                        .map(|(k, v)| k.len() + v.len())
                                        .sum::<usize>()
                                        > CHUNK
                                    || h.url.len() > CHUNK
                                    || h.status_text.len() > 1024 =>
                            {
                                failed = true;
                                FetchEvent::Failed("download_head_limit".into())
                            }
                            FetchEvent::Failed(_) => {
                                failed = true;
                                FetchEvent::Failed("download_connection_failed".into())
                            }
                            other => other,
                        };
                        if tx.send(event).is_err() {
                            failed = true;
                        }
                    }),
                );
                let mut slot = slot.lock().unwrap_or_else(|e| e.into_inner());
                if stopped.load(Ordering::Acquire) {
                    drop(slot);
                    handle.cancel();
                } else {
                    *slot = Some(handle);
                }
            })
            .map_err(|_| "download_worker_unavailable")?;
        Ok(Self {
            rx: Some(rx),
            task,
            stop,
        })
    }
    fn pause(&self, value: bool) {
        if let Some(task) = self.task.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
            task.pause(value);
        }
    }
}

/// Disk owner implements this on its private Stage. `append` must finish its
/// bounded write before returning; metadata never contains a destination path.
pub trait Consumer {
    fn begin(&mut self, metadata: &Checkpoint) -> Result<()>;
    fn append(&mut self, bytes: &[u8]) -> Result<()>;
    fn progress(&mut self, checkpoint: &Checkpoint);
}
/// Worker-only. No retry, destination commit or readback-success inference here.
/// On error, caller keeps the Stage and last successfully written checkpoint.
pub fn receive(
    network: Arc<dyn Network>,
    captured: &Captured,
    file: &HostFile,
    checkpoint: &mut Checkpoint,
    current: impl Fn() -> bool,
    consumer: &mut dyn Consumer,
) -> Result<()> {
    receive_source(
        network,
        captured,
        &Source::File(file.clone()),
        checkpoint,
        current,
        consumer,
    )
}
pub fn receive_source(
    network: Arc<dyn Network>,
    captured: &Captured,
    file: &Source,
    checkpoint: &mut Checkpoint,
    current: impl Fn() -> bool,
    consumer: &mut dyn Consumer,
) -> Result<()> {
    checkpoint.validate()?;
    if !captured.valid() || !current() {
        return Err("download_scope_stale".into());
    }
    let request = captured.request(file, checkpoint)?;
    let url = request.url.clone();
    let stream = Stream::open(network, request)?;
    let mut accepted = false;
    let mut last = Instant::now();
    loop {
        if !captured.valid() || !current() {
            return Err("download_scope_stale".into());
        }
        let event = match stream
            .rx
            .as_ref()
            .unwrap()
            .recv_timeout(Duration::from_millis(50))
        {
            Ok(event) => event,
            Err(mpsc::RecvTimeoutError::Timeout) if last.elapsed() < Duration::from_secs(90) => {
                continue;
            }
            Err(_) => return Err("download_connection_failed".into()),
        };
        last = Instant::now();
        if !captured.valid() || !current() {
            return Err("download_scope_stale".into());
        }
        match event {
            FetchEvent::Head(head) if !accepted => {
                let mut next = response(&head, &url, checkpoint)?;
                if let Source::AssistantAttachment(file) = file {
                    let mime = header(&head, "content-type")?.ok_or("download_mime_mismatch")?;
                    let actual = mime.split(';').next().unwrap_or("").trim();
                    if mime.chars().any(char::is_control)
                        || !actual.eq_ignore_ascii_case(file.mime())
                    {
                        return Err("download_mime_mismatch".into());
                    }
                    if next.total.is_some_and(|n| n != file.size()) {
                        return Err("download_size_mismatch".into());
                    }
                    next.total = Some(file.size());
                }
                consumer.begin(&next)?;
                *checkpoint = next;
                accepted = true;
                consumer.progress(checkpoint);
            }
            FetchEvent::Data(bytes) if accepted => {
                let next = checkpoint
                    .received
                    .checked_add(bytes.len() as u64)
                    .ok_or("download_size_invalid")?;
                if next > MAX_BYTES || checkpoint.total.is_some_and(|n| next > n) {
                    return Err("download_size_mismatch".into());
                }
                stream.pause(true);
                consumer.append(&bytes)?;
                checkpoint.received = next;
                consumer.progress(checkpoint);
                stream.pause(false);
            }
            FetchEvent::End if accepted => {
                if checkpoint.total.is_some_and(|n| checkpoint.received != n) {
                    return Err("download_size_mismatch".into());
                }
                return Ok(());
            }
            FetchEvent::Failed(code)
                if code == "download_chunk_limit" || code == "download_head_limit" =>
            {
                return Err(code);
            }
            FetchEvent::Failed(_) => return Err("download_connection_failed".into()),
            _ => return Err("download_event_order".into()),
        }
    }
}

#[cfg(test)]
#[path = "file_download_transport_tests.rs"]
mod tests;

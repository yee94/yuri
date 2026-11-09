//! Native terminal HTTP/SSE over NSH Network and direct WS-v2 in focused child modules.
//! Both capture the Host actor's authority/credentials; no new Vault or JS transport.
use crate::policy::{self, Result};
use nsh_core::platform::{FetchEvent, HttpHead, HttpRequest};
use nsh_engine::{FetchTask, Network};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};
#[path = "terminal_socket.rs"]
pub mod socket;
#[path = "terminal_transport_ws.rs"]
pub mod ws;

pub struct Captured {
    pub scope: Value,
    origin: String,
    token: String,
    current: Arc<dyn Fn() -> bool + Send + Sync>,
}
impl Captured {
    /// Native-only. `current` MUST test the captured lease and authorization,
    /// not just hostID. This type must never be serialized or exposed in JS.
    pub fn direct(
        scope: Value,
        origin: &str,
        token: &str,
        loopback: bool,
        current: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Result<Self> {
        let scope = policy::scope(&scope)?;
        let origin = policy::origin(origin, loopback)?;
        policy::token(token)?;
        if !current() {
            return Err("terminal_scope_stale".into());
        }
        Ok(Self {
            scope,
            origin,
            token: token.into(),
            current,
        })
    }
    pub fn valid(&self) -> bool {
        (self.current)()
    }
    pub fn with_shutdown(mut self, stop: Arc<AtomicBool>) -> Self {
        let current = self.current.clone();
        self.current = Arc::new(move || !stop.load(Ordering::Acquire) && current());
        self
    }
    fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<Vec<u8>>,
        content_type: &str,
    ) -> Result<HttpRequest> {
        if !self.valid() {
            return Err("terminal_scope_stale".into());
        }
        let mut request = HttpRequest::new(method, format!("{}{path}", self.origin))
            .header("Authorization", format!("Bearer {}", self.token))
            .header("Content-Type", content_type)
            .header("Cache-Control", "no-store");
        request.follow_redirects = false;
        if let Some(body) = body {
            request = request.body(body);
        }
        Ok(request)
    }
}
pub enum Request<'a> {
    Create {
        directory: &'a str,
        cols: u64,
        rows: u64,
    },
    Input {
        session: &'a str,
        data: &'a str,
    },
    Resize {
        session: &'a str,
        cols: u64,
        rows: u64,
    },
    Close {
        session: &'a str,
    },
    ForceKill {
        session: &'a str,
    },
}
pub fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
pub fn directory(value: &str) -> bool {
    // Validation of already canonical TS resourcePath output, never another
    // normalizer. Drive/UNC paths are Host paths, not client filesystem access.
    let absolute = value.starts_with('/')
        || (value.len() >= 3
            && value.as_bytes()[0].is_ascii_uppercase()
            && &value.as_bytes()[1..3] == b":/");
    absolute
        && !value.contains('\\')
        && !value.starts_with("//?/")
        && !value.strip_prefix("//").unwrap_or(value).contains("//")
        && !value.chars().any(char::is_control)
        && value.len() <= 16_384
        && !value.split('/').any(|p| p == "." || p == "..")
        && (!value.starts_with("//") || value.split('/').filter(|p| !p.is_empty()).count() >= 2)
}
fn size(cols: u64, rows: u64) -> bool {
    (2..=1000).contains(&cols) && (1..=1000).contains(&rows)
}
impl Request<'_> {
    fn wire(&self, capture: &Captured) -> Result<HttpRequest> {
        let (method, path, body, kind) = match self {
            Self::Create {
                directory: cwd,
                cols,
                rows,
            } if directory(cwd) && size(*cols, *rows) => (
                "POST",
                "/api/terminal/create".into(),
                Some(
                    serde_json::to_vec(&json!({"cwd":cwd,"cols":cols,"rows":rows}))
                        .map_err(|_| "terminal_request_invalid")?,
                ),
                "application/json",
            ),
            Self::Input { session, data }
                if identifier(session) && !data.is_empty() && data.len() <= 65_536 =>
            {
                (
                    "POST",
                    format!("/api/terminal/{session}/input"),
                    Some(data.as_bytes().to_vec()),
                    "text/plain; charset=utf-8",
                )
            }
            Self::Resize {
                session,
                cols,
                rows,
            } if identifier(session) && size(*cols, *rows) => (
                "POST",
                format!("/api/terminal/{session}/resize"),
                Some(
                    serde_json::to_vec(&json!({"cols":cols,"rows":rows}))
                        .map_err(|_| "terminal_request_invalid")?,
                ),
                "application/json",
            ),
            Self::Close { session } if identifier(session) => (
                "DELETE",
                format!("/api/terminal/{session}"),
                None,
                "application/json",
            ),
            Self::ForceKill { session } if identifier(session) => (
                "POST",
                "/api/terminal/force-kill".into(),
                Some(
                    serde_json::to_vec(&json!({"sessionId":session}))
                        .map_err(|_| "terminal_request_invalid")?,
                ),
                "application/json",
            ),
            _ => return Err("terminal_request_invalid".into()),
        };
        capture.request(method, &path, body, kind)
    }
}
struct Inbox {
    rx: mpsc::Receiver<FetchEvent>,
    task: Option<Box<dyn FetchTask>>,
    overflow: Arc<AtomicBool>,
    bytes: Arc<AtomicUsize>,
    url: String,
}
impl Drop for Inbox {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.cancel();
        }
    }
}
impl Inbox {
    fn open(network: &dyn Network, request: HttpRequest) -> Self {
        let url = request.url.clone();
        let (tx, rx) = mpsc::sync_channel(64);
        let overflow = Arc::new(AtomicBool::new(false));
        let bytes = Arc::new(AtomicUsize::new(0));
        let full = overflow.clone();
        let total = bytes.clone();
        let task = network.fetch(
            request,
            Box::new(move |event| {
                let length = if let FetchEvent::Data(data) = &event {
                    data.len()
                } else {
                    0
                };
                if total
                    .fetch_add(length, Ordering::AcqRel)
                    .saturating_add(length)
                    > 2_097_152
                    || tx.try_send(event).is_err()
                {
                    full.store(true, Ordering::Release);
                }
            }),
        );
        Self {
            rx,
            task: Some(task),
            overflow,
            bytes,
            url,
        }
    }
    fn next(&self, capture: &Captured, stop: &AtomicBool, deadline: Instant) -> Result<FetchEvent> {
        loop {
            if !capture.valid() || stop.load(Ordering::Acquire) {
                return Err("terminal_scope_stale".into());
            }
            if self.overflow.load(Ordering::Acquire) {
                return Err("terminal_response_overflow".into());
            }
            if Instant::now() >= deadline {
                return Err("terminal_io_timeout".into());
            }
            match self.rx.recv_timeout(Duration::from_millis(50)) {
                Ok(event) => {
                    if let FetchEvent::Data(data) = &event {
                        self.bytes.fetch_sub(data.len(), Ordering::AcqRel);
                    }
                    return Ok(event);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(_) => return Err("terminal_connection_failed".into()),
            }
        }
    }
    fn head(&self, head: &HttpHead, mime: &str) -> Result<()> {
        if head.redirected || head.url != self.url || (300..400).contains(&head.status) {
            return Err("terminal_redirect_refused".into());
        }
        if head.status == 404 {
            return Err("session_not_found".into());
        }
        if !(200..300).contains(&head.status) {
            return Err("terminal_http_failed".into());
        }
        if !head.headers.iter().any(|(k, v)| {
            k.eq_ignore_ascii_case("content-type")
                && v.split(';')
                    .next()
                    .is_some_and(|s| s.trim().eq_ignore_ascii_case(mime))
        }) {
            return Err("terminal_mime_invalid".into());
        }
        Ok(())
    }
}
pub fn request(network: &dyn Network, capture: &Captured, request: Request<'_>) -> Result<Value> {
    let inbox = Inbox::open(network, request.wire(capture)?);
    let deadline = Instant::now() + Duration::from_secs(15);
    let stop = AtomicBool::new(false);
    let mut head = false;
    let mut bytes = Vec::new();
    loop {
        match inbox.next(capture, &stop, deadline)? {
            FetchEvent::Head(value) => {
                inbox.head(&value, "application/json")?;
                if value.headers.iter().any(|(k, v)| {
                    k.eq_ignore_ascii_case("content-length")
                        && v.parse::<usize>().is_ok_and(|n| n > 65_536)
                }) {
                    return Err("terminal_response_overflow".into());
                }
                head = true;
            }
            FetchEvent::Data(data) if head => {
                if bytes.len() + data.len() > 65_536 {
                    return Err("terminal_response_overflow".into());
                }
                bytes.extend(data);
            }
            FetchEvent::End if head => {
                if !capture.valid() {
                    return Err("terminal_scope_stale".into());
                }
                return serde_json::from_slice(&bytes)
                    .map_err(|_| "terminal_response_invalid".into());
            }
            FetchEvent::Failed(_) => return Err("terminal_connection_failed".into()),
            _ => return Err("terminal_response_invalid".into()),
        }
    }
}

/// SSE is an explicit transport capability, not a fake WS-v2 implementation.
/// It has no historical replay; its connected event MUST say replayUnavailable.
pub fn stream(
    network: &dyn Network,
    capture: &Captured,
    session: &str,
    stop: &AtomicBool,
    mut emit: impl FnMut(Value) -> Result<()>,
) -> Result<()> {
    if !identifier(session) {
        return Err("terminal_request_invalid".into());
    }
    let inbox = Inbox::open(
        network,
        capture.request(
            "GET",
            &format!("/api/terminal/{session}/stream"),
            None,
            "application/json",
        )?,
    );
    let mut decoder = Sse::default();
    let mut head = false;
    let mut connected = false;
    let mut deadline = Instant::now() + Duration::from_secs(15);
    loop {
        match inbox.next(capture, stop, deadline)? {
            FetchEvent::Head(value) => {
                inbox.head(&value, "text/event-stream")?;
                head = true;
            }
            FetchEvent::Data(data) if head => {
                if connected {
                    deadline = Instant::now() + Duration::from_secs(60);
                }
                for text in decoder.consume(&data)? {
                    let mut value: Value =
                        serde_json::from_str(&text).map_err(|_| "terminal_stream_invalid")?;
                    match value["type"].as_str() {
                        Some("connected") => {
                            connected = true;
                            deadline = Instant::now() + Duration::from_secs(60);
                            value["replayUnavailable"] = json!(true);
                        }
                        Some("data")
                            if connected
                                && value["data"].as_str().is_some_and(|s| {
                                    s.len() <= 1_048_576 && s.encode_utf16().count() <= 1_000_000
                                }) => {}
                        Some("exit") if connected => {
                            emit(value)?;
                            return Ok(());
                        }
                        _ => return Err("terminal_stream_invalid".into()),
                    }
                    emit(value)?;
                }
            }
            FetchEvent::End | FetchEvent::Failed(_) => {
                return Err("terminal_stream_disconnected".into());
            }
            _ => return Err("terminal_stream_invalid".into()),
        }
    }
}
#[derive(Default)]
struct Sse {
    line: Vec<u8>,
    data: Vec<String>,
    length: usize,
    cr: bool,
}
impl Sse {
    fn consume(&mut self, bytes: &[u8]) -> Result<Vec<String>> {
        let mut output = Vec::new();
        for &byte in bytes {
            if self.cr && byte == 10 {
                self.cr = false;
                continue;
            }
            self.cr = false;
            if byte == 10 || byte == 13 {
                self.cr = byte == 13;
                let line = std::str::from_utf8(&self.line).map_err(|_| "terminal_utf8_invalid")?;
                if line.is_empty() {
                    if !self.data.is_empty() {
                        output.push(self.data.join("\n"));
                    }
                    self.data.clear();
                    self.length = 0;
                } else if let Some(data) = line.strip_prefix("data:") {
                    self.length += self.line.len() + 1;
                    if self.length > 1_048_576 {
                        return Err("terminal_stream_overflow".into());
                    }
                    self.data
                        .push(data.strip_prefix(' ').unwrap_or(data).into());
                }
                self.line.clear();
            } else {
                if self.line.len() >= 1_048_576 {
                    return Err("terminal_stream_overflow".into());
                }
                self.line.push(byte);
            }
        }
        Ok(output)
    }
}

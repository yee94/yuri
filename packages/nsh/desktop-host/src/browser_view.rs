//! Isolated workbench browser authority. This module never registers a JS Host method.
//! The connection actor publishes ONLY committed authority; UI callbacks capture it once.
use crate::policy::{self, Result};
use nsh_engine::{FetchEvent, FetchTask, HttpBody, HttpRequest, Network};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(target_os = "macos")]
#[path = "browser_view_macos.rs"]
pub mod macos;
#[cfg(target_os = "windows")]
#[path = "browser_view_windows.rs"]
pub mod windows;

pub const COMPONENT: &str = "yuri.desktop.browser";
pub const LIMIT: usize = 8 * 1024 * 1024;
pub const TOTAL: usize = 32 * 1024 * 1024;
pub const CSP: &str = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
pub fn public_error(value: &str) -> &str {
    if value.starts_with("browser_") && value.bytes().all(|b| b.is_ascii_lowercase() || b == b'_') { value }
    else { "browser_native_request_rejected" }
}

#[derive(Clone)]
pub struct Port(Arc<Shared>);
struct Shared {
    epoch: AtomicU64,
    authority: Mutex<Option<Authority>>,
    network: Arc<dyn Network>,
    owners: Mutex<HashSet<String>>,
}
#[derive(Clone)]
struct Authority {
    scope: Value,
    origin: String,
    bearer: String,
    epoch: u64,
}
impl Port {
    pub fn new(network: Arc<dyn Network>) -> Self {
        Self(Arc::new(Shared {
            epoch: AtomicU64::new(1),
            authority: Mutex::new(None),
            network,
            owners: Mutex::new(HashSet::new()),
        }))
    }
    /// Native-only. Call after durable connection commit, and on cold-start selected restoration.
    /// No credentials enter nativeComponent props, events, URLs, diagnostics or app Storage.
    pub fn authorize(
        &self,
        scope: &Value,
        origin: &str,
        bearer: &str,
        allow_loopback: bool,
    ) -> Result<()> {
        let scope = policy::scope(scope)?;
        let origin = policy::origin(origin, allow_loopback)?;
        policy::token(bearer)?;
        if bearer.is_empty() {
            return Err("browser_device_bearer_required".into());
        }
        let mut authority = self
            .0
            .authority
            .lock()
            .map_err(|_| "browser_authority_unavailable")?;
        let epoch = self.0.epoch.fetch_add(1, Ordering::AcqRel) + 1;
        *authority = Some(Authority {
            scope,
            origin,
            bearer: bearer.into(),
            epoch,
        });
        Ok(())
    }
    /// Synchronous fence, BEFORE a Host lease changes. UI pump removes old native surfaces.
    pub fn invalidate(&self) {
        self.0.epoch.fetch_add(1, Ordering::AcqRel);
        if let Ok(mut a) = self.0.authority.lock() {
            *a = None;
        }
    }
    pub fn capture(&self, expected: &Value) -> Result<Capture> {
        let scope = policy::scope(expected)?;
        let a = self
            .0
            .authority
            .lock()
            .map_err(|_| "browser_authority_unavailable")?;
        let a = a
            .as_ref()
            .filter(|a| a.scope == scope && a.epoch == self.0.epoch.load(Ordering::Acquire))
            .ok_or("browser_host_scope_stale")?;
        Ok(Capture {
            authority: a.clone(),
            port: self.clone(),
            alive: Arc::new(AtomicBool::new(true)),
        })
    }
    fn claim(&self, scope: &Value, owner: &str) -> Result<()> {
        let mut owners = self
            .0
            .owners
            .lock()
            .map_err(|_| "browser_authority_unavailable")?;
        if owners.len() >= 4096 || !owners.insert(format!("{scope}:{owner}")) {
            return Err("browser_owner_closed_or_capacity".into());
        }
        Ok(())
    }
}
#[derive(Clone)]
pub struct Capture {
    authority: Authority,
    port: Port,
    alive: Arc<AtomicBool>,
}
impl Capture {
    pub fn current(&self) -> bool {
        self.alive.load(Ordering::Acquire)
            && self.authority.epoch == self.port.0.epoch.load(Ordering::Acquire)
    }
    pub fn close(&self) {
        self.alive.store(false, Ordering::Release);
    }
    fn fetch(
        &self,
        route: &str,
        body: Option<Value>,
        preview_token: Option<&str>,
        limit: usize,
    ) -> Result<Read> {
        if !self.current() {
            return Err("browser_host_scope_stale".into());
        }
        // Four native-owned routes only. A generic runtime path validator cannot
        // be used here: valid Host filenames can contain an encoded # or ?.
        let (path, query) = route.split_once('?').unwrap_or((route, ""));
        let decoded = decode(path)?;
        let stat = path == "/api/fs/stat"
            && query.starts_with("path=")
            && canonical(&decode(&query[5..])?);
        let serve = decoded.starts_with("/api/fs/serve/") && query.is_empty();
        let proxy = decoded
            .strip_prefix("/api/preview/proxy/")
            .and_then(|p| p.split_once('/'))
            .is_some_and(|(id, _)| {
                (16..=64).contains(&id.len())
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            });
        let checked = if decoded.ends_with('/') && decoded.len() > 1 {
            &decoded[..decoded.len() - 1]
        } else {
            &decoded
        };
        if route.len() > 32768
            || !route.is_ascii()
            || route.contains('#')
            || route.bytes().any(|b| b <= 32 || b == 127)
            || !canonical(checked)
            || !stat && !safe_query(&decode(query)?)
            || !(body.is_some() && route == "/api/preview/targets" && preview_token.is_none()
                || body.is_none() && (stat || serve || proxy && preview_token.is_some()))
        {
            return Err("browser_unsafe_host_route".into());
        }
        let mut request = HttpRequest::get(format!("{}{}", self.authority.origin, route));
        request.follow_redirects = false;
        request.headers = vec![
            (
                "Authorization".into(),
                format!("Bearer {}", self.authority.bearer),
            ),
            ("X-Yuri-Native-Preview".into(), "1".into()),
        ];
        if let Some(token) = preview_token {
            request
                .headers
                .push(("X-Yuri-Preview-Token".into(), token.into()));
        }
        if let Some(body) = body {
            request.method = "POST".into();
            request
                .headers
                .push(("Content-Type".into(), "application/json".into()));
            request.body = HttpBody::Bytes(body.to_string().into_bytes());
        }
        Ok(Read::start(self.clone(), request, limit))
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Intent {
    Html { directory: String, path: String },
    Loopback(String),
    Browser(String),
}
impl Intent {
    pub fn parse(value: &Value) -> Result<Self> {
        match value["kind"].as_str() {
            Some("html") => {
                policy::keys(
                    value,
                    &["kind", "directory", "path"],
                    &["kind", "directory", "path"],
                )?;
                let directory = policy::string(value, "directory")?;
                let path = policy::string(value, "path")?;
                if !canonical(directory)
                    || !canonical(path)
                    || !within(path, directory)
                    || !(path.to_ascii_lowercase().ends_with(".html")
                        || path.to_ascii_lowercase().ends_with(".htm"))
                {
                    return Err("browser_invalid_html_scope".into());
                }
                Ok(Self::Html {
                    directory: directory.into(),
                    path: path.into(),
                })
            }
            Some("loopback") | Some("browser") => {
                policy::keys(value, &["kind", "url"], &["kind", "url"])?;
                let url = policy::string(value, "url")?;
                let (_, local) = web_url(url)?;
                if local {
                    Ok(Self::Loopback(url.into()))
                } else if value["kind"] == "browser" {
                    Ok(Self::Browser(url.into()))
                } else {
                    Err("browser_invalid_loopback".into())
                }
            }
            _ => Err("browser_invalid_intent".into()),
        }
    }
}
fn canonical(path: &str) -> bool {
    path.starts_with('/')
        && !path.contains(['\\', '%'])
        && !path.chars().any(char::is_control)
        && (path == "/"
            || !path[1..]
                .split('/')
                .any(|p| p.is_empty() || p == "." || p == ".."))
}
fn within(path: &str, root: &str) -> bool {
    root == "/" || path.starts_with(&format!("{root}/"))
}
pub fn encode(value: &str, slash: bool) -> String {
    let mut out = String::new();
    for b in value.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) || slash && b == b'/' {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}
fn decode(value: &str) -> Result<String> {
    let mut out = Vec::new();
    let mut bytes = value.bytes();
    while let Some(b) = bytes.next() {
        out.push(if b == b'%' {
            let a = bytes
                .next()
                .and_then(|v| (v as char).to_digit(16))
                .ok_or("browser_invalid_url")?;
            let b = bytes
                .next()
                .and_then(|v| (v as char).to_digit(16))
                .ok_or("browser_invalid_url")?;
            (a * 16 + b) as u8
        } else {
            b
        });
    }
    String::from_utf8(out).map_err(|_| "browser_invalid_url".into())
}
fn safe_query(query: &str) -> bool {
    query.split('&').all(|v| {
        let key = v.split('=').next().unwrap_or("").to_ascii_lowercase();
        ![
            "oc_client_token",
            "yuri_client_token",
            "yuri_url_token",
            "yuri_preview_token",
            "authorization",
            "access_token",
            "token",
            "password",
            "secret",
        ]
        .contains(&key.as_str())
    })
}
/// Deliberately does not depend on QuickJS's absent URL global. Both sides validate.
/// Reject numeric/encoded aliases rather than accidentally treating Host localhost as client localhost.
pub fn web_url(url: &str) -> Result<(String, bool)> {
    if url.len() > 8192
        || !url.is_ascii()
        || url.bytes().any(|b| b <= 32 || b == 127)
        || url.contains('\\')
    {
        return Err("browser_invalid_url".into());
    }
    let (scheme, rest) = url.split_once("://").ok_or("browser_invalid_url")?;
    if scheme != "http" && scheme != "https" {
        return Err("browser_unsafe_scheme".into());
    }
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    let origin = policy::origin(&format!("https://{authority}"), false)?;
    let host = if authority.starts_with('[') {
        authority.split(']').next().unwrap_or("").to_owned() + "]"
    } else {
        authority
            .split(':')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase()
    };
    let local = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"].contains(&host.as_str());
    if !local
        && (host.ends_with(".localhost")
            || host.ends_with('.')
            || host.parse::<std::net::IpAddr>().is_ok()
            || host
                .split('.')
                .all(|v| v.bytes().all(|b| b.is_ascii_digit()))
            || host.starts_with("0x"))
    {
        return Err("browser_ambiguous_ip".into());
    }
    let decoded = decode(&rest[end..])?;
    if decoded.contains(['\\', '%'])
        || decoded.chars().any(char::is_control)
        || !safe_query(
            decoded
                .split_once('?')
                .map(|(_, q)| q.split('#').next().unwrap_or(""))
                .unwrap_or(""),
        )
    {
        return Err("browser_invalid_url".into());
    }
    // Preserve the real scheme and explicit port; origin() above was validation only.
    let _ = origin;
    Ok((
        format!("{scheme}://{}", authority.to_ascii_lowercase()),
        local,
    ))
}

pub struct Response {
    pub status: u16,
    pub mime: String,
    pub data: Vec<u8>,
    pub csp: Option<String>,
}
struct Receiving {
    response: Option<Response>,
    done: bool,
    error: Option<String>,
}
pub struct Read {
    task: Option<Box<dyn FetchTask>>,
    state: Arc<Mutex<Receiving>>,
    capture: Capture,
    started: Instant,
}
impl Read {
    fn start(capture: Capture, request: HttpRequest, limit: usize) -> Self {
        let state = Arc::new(Mutex::new(Receiving {
            response: None,
            done: false,
            error: None,
        }));
        let sink = state.clone();
        let expected = request.url.clone();
        let current = capture.clone();
        let task = capture.port.0.network.fetch(
            request,
            Box::new(move |event| {
                let Ok(mut s) = sink.lock() else {
                    return;
                };
                if s.done || s.error.is_some() {
                    return;
                }
                if !current.current() {
                    s.error = Some("browser_host_scope_stale".into());
                    return;
                }
                match event {
                    FetchEvent::Head(head) => {
                        let header = |name: &str| {
                            head.headers
                                .iter()
                                .find(|(k, _)| k.eq_ignore_ascii_case(name))
                                .map(|(_, v)| v.clone())
                        };
                        let mime = header("content-type").unwrap_or_default();
                        let csp = header("content-security-policy");
                        if head.redirected
                            || head.url != expected
                            || !(200..300).contains(&head.status)
                            || mime.is_empty()
                            || mime.contains(['\r', '\n'])
                            || csp.as_ref().is_some_and(|v| v.contains(['\r', '\n']))
                            || header("content-length")
                                .is_some_and(|v| v.parse::<usize>().map_or(true, |v| v > limit))
                        {
                            s.error = Some("browser_invalid_response".into());
                        } else {
                            s.response = Some(Response {
                                status: head.status,
                                mime,
                                data: Vec::new(),
                                csp,
                            });
                        }
                    }
                    FetchEvent::Data(bytes) => {
                        if let Some(r) = &mut s.response {
                            if bytes.len() > limit.saturating_sub(r.data.len()) {
                                s.error = Some("browser_response_limit".into());
                            } else {
                                r.data.extend(bytes);
                            }
                        } else {
                            s.error = Some("browser_invalid_response".into());
                        }
                    }
                    FetchEvent::End => s.done = true,
                    FetchEvent::Failed(_) => s.error = Some("browser_network_failed".into()),
                    _ => {}
                }
            }),
        );
        Self {
            task: Some(task),
            state,
            capture,
            started: Instant::now(),
        }
    }
    pub fn poll(&mut self) -> Option<Result<Response>> {
        if !self.capture.current() || self.started.elapsed() > Duration::from_secs(30) {
            self.cancel();
            return Some(Err("browser_cancelled_or_timeout".into()));
        }
        let mut s = self.state.lock().ok()?;
        if let Some(e) = s.error.take() {
            drop(s);
            self.cancel();
            return Some(Err(e));
        }
        if !s.done {
            return None;
        }
        Some(
            s.response
                .take()
                .ok_or_else(|| "browser_invalid_response".into()),
        )
    }
    pub fn cancel(&mut self) {
        if let Some(task) = self.task.take() {
            task.cancel();
        }
    }
}
impl Drop for Read {
    fn drop(&mut self) {
        self.cancel();
    }
}

#[derive(Clone)]
pub struct Document {
    pub entry: String,
    pub display: String,
    pub owner: String,
    directory: Option<String>,
    proxy: Option<(String, String, u64)>,
    pub capture: Capture,
}
impl Document {
    pub fn route(&self, url: &str) -> Result<String> {
        if !self.capture.current() {
            return Err("browser_host_scope_stale".into());
        }
        let prefix = format!("yuri-resource://{}", self.owner);
        let tail = url
            .strip_prefix(&prefix)
            .filter(|s| s.starts_with('/'))
            .ok_or("browser_route_outside_owner")?;
        let tail = tail.split('#').next().unwrap_or("");
        let (path, query) = tail.split_once('?').unwrap_or((tail, ""));
        let path = decode(path)?;
        let checked = if path.ends_with('/') && path.len() > 1 {
            &path[..path.len() - 1]
        } else {
            &path
        };
        // Existing Host rewrites can include their short-lived target token. Strip it,
        // never trust/forward a page-supplied value; the captured token is header-only.
        let query = query
            .split('&')
            .filter(|field| {
                decode(field.split('=').next().unwrap_or(""))
                    .map_or(true, |k| !k.eq_ignore_ascii_case("yuri_preview_token"))
            })
            .collect::<Vec<_>>()
            .join("&");
        if !canonical(checked) || !safe_query(&decode(&query)?) {
            return Err("browser_unsafe_route".into());
        }
        if let Some(directory) = &self.directory {
            if !within(&path, directory) || !query.is_empty() {
                return Err("browser_route_outside_directory".into());
            }
            return Ok(format!("/api/fs/serve{}", encode(&path, true)));
        }
        let (base, _, expiry) = self.proxy.as_ref().ok_or("browser_invalid_document")?;
        if *expiry <= now_ms() || !path.starts_with(&format!("{base}/")) {
            return Err("browser_proxy_expired_or_outside_target".into());
        }
        Ok(format!(
            "{}{}",
            encode(&path, true),
            if query.is_empty() {
                String::new()
            } else {
                format!("?{query}")
            }
        ))
    }
    pub fn read(&self, url: &str, limit: usize) -> Result<Read> {
        let route = self.route(url)?;
        self.capture.fetch(
            &route,
            None,
            self.proxy.as_ref().map(|(_, t, _)| t.as_str()),
            limit.min(LIMIT),
        )
    }
    pub fn display_url(&self, url: &str) -> Result<String> {
        let route = self.route(url)?;
        if let Some((base, _, _)) = &self.proxy {
            let (origin, _) = web_url(&self.display)?;
            return Ok(format!(
                "{origin}{}{}",
                route.strip_prefix(base).ok_or("browser_invalid_url")?,
                url.split_once('#')
                    .map(|(_, hash)| format!("#{hash}"))
                    .unwrap_or_default()
            ));
        }
        decode(
            url.strip_prefix(&format!("yuri-resource://{}", self.owner))
                .ok_or("browser_invalid_url")?,
        )
    }
    pub fn refresh_intent(&self, display: &str) -> Result<Intent> {
        if let Some(directory) = &self.directory {
            Intent::parse(
                &json!({"kind":"html","directory":directory,"path":display.split('#').next().unwrap_or(display)}),
            )
        } else {
            Intent::parse(&json!({"kind":"loopback","url":display}))
        }
    }
}
pub struct Preparing {
    capture: Capture,
    owner: String,
    intent: Intent,
    read: Read,
}
pub enum Prepared {
    External(String),
    Resource(Box<Document>),
}
impl Preparing {
    pub fn begin(
        capture: Capture,
        owner: String,
        intent: Intent,
    ) -> Result<std::result::Result<Self, Prepared>> {
        if !owner_valid(&owner) {
            return Err("browser_invalid_owner".into());
        }
        if let Intent::Browser(url) = &intent {
            return Ok(Err(Prepared::External(url.clone())));
        }
        let read = match &intent {
            Intent::Html { path, .. } => capture.fetch(
                &format!("/api/fs/stat?path={}", encode(path, false)),
                None,
                None,
                65536,
            )?,
            Intent::Loopback(url) => capture.fetch(
                "/api/preview/targets",
                Some(json!({"url":url,"ttlMs":300000,"allowExternal":false})),
                None,
                65536,
            )?,
            _ => unreachable!(),
        };
        Ok(Ok(Self {
            capture,
            owner,
            intent,
            read,
        }))
    }
    pub fn poll(&mut self) -> Option<Result<Prepared>> {
        let response = match self.read.poll()? {
            Ok(v) => v,
            Err(e) => return Some(Err(e)),
        };
        let result = (|| {
            if response.mime.split(';').next() != Some("application/json") {
                return Err("browser_invalid_metadata".into());
            }
            let value: Value =
                serde_json::from_slice(&response.data).map_err(|_| "browser_invalid_metadata")?;
            let mut document = Document {
                entry: String::new(),
                display: String::new(),
                owner: self.owner.clone(),
                directory: None,
                proxy: None,
                capture: self.capture.clone(),
            };
            match &self.intent {
                Intent::Html { directory, path } => {
                    if value["isFile"] != true
                        || value["size"].as_u64().is_none_or(|s| s > LIMIT as u64)
                    {
                        return Err("browser_invalid_file".into());
                    }
                    document.directory = Some(directory.clone());
                    document.entry = encode(path, true);
                    document.display = path.clone();
                }
                Intent::Loopback(url) => {
                    let id = policy::string(&value, "id")?;
                    let base = policy::string(&value, "proxyBasePath")?;
                    let token = policy::string(&value, "previewToken")?;
                    let expiry = value["expiresAt"]
                        .as_u64()
                        .ok_or("browser_invalid_preview_target")?;
                    if !(16..=64).contains(&id.len())
                        || !id
                            .bytes()
                            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                        || base != format!("/api/preview/proxy/{id}")
                        || token.len() != 32
                        || !token
                            .bytes()
                            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                        || expiry <= now_ms()
                        || expiry > now_ms() + 300000
                    {
                        return Err("browser_invalid_preview_target".into());
                    }
                    let (origin, _) = web_url(url)?;
                    let suffix = &url[origin.len()..];
                    document.entry = format!(
                        "{base}{}{suffix}",
                        if suffix.starts_with('/') { "" } else { "/" }
                    );
                    document.proxy = Some((base.into(), token.into(), expiry));
                    document.display = url.clone();
                }
                _ => unreachable!(),
            }
            document.entry = format!("yuri-resource://{}{}", document.owner, document.entry);
            document.route(&document.entry)?;
            Ok(Prepared::Resource(Box::new(document)))
        })();
        Some(result)
    }
}
pub fn owner_valid(owner: &str) -> bool {
    !owner.is_empty()
        && owner.len() <= 128
        && owner
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn urls_and_html_do_not_escape_the_owner() {
        for url in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "https://u:p@a.test/",
            "http://127.1/",
            "http://2130706433/",
            "http://0x7f000001/",
            "https://a.test/?%74oken=x",
            "http://localhost/%5c",
            "https://a.test/%252e",
        ] {
            assert!(web_url(url).is_err(), "{url}");
        }
        assert!(matches!(
            Intent::parse(&json!({"kind":"browser","url":"http://localhost:3000/"})).unwrap(),
            Intent::Loopback(_)
        ));
        for path in ["/else/index.html", "/work/../index.html", "/work/a.eficy"] {
            assert!(
                Intent::parse(&json!({"kind":"html","directory":"/work","path":path})).is_err()
            );
        }
    }
    struct Task;
    impl FetchTask for Task {
        fn send(&mut self, _: Vec<u8>) {}
        fn finish(&mut self) {}
        fn pause(&mut self, _: bool) {}
        fn cancel(self: Box<Self>) {}
    }
    struct Fixture {
        requests: Mutex<Vec<HttpRequest>>,
        status: u16,
        oversized: bool,
    }
    impl Network for Fixture {
        fn fetch(
            &self,
            request: HttpRequest,
            mut events: nsh_engine::FetchEvents,
        ) -> Box<dyn FetchTask> {
            let (mime, body) = if request.url.ends_with("/targets") {
                ("application/json",json!({"id":"0123456789abcdef","proxyBasePath":"/api/preview/proxy/0123456789abcdef","previewToken":"0123456789abcdef0123456789abcdef","expiresAt":now_ms()+60000}).to_string().into_bytes())
            } else if request.url.contains("/stat?") {
                (
                    "application/json",
                    br#"{"isFile":true,"size":100}"#.to_vec(),
                )
            } else {
                ("text/html", b"<h1>synthetic</h1>".to_vec())
            };
            let url = request.url.clone();
            self.requests.lock().unwrap().push(request);
            let mut headers = vec![("Content-Type".into(), mime.into())];
            if self.oversized {
                headers.push(("Content-Length".into(), (LIMIT + 1).to_string()));
            }
            events(FetchEvent::Head(nsh_engine::HttpHead {
                status: self.status,
                url,
                headers,
                ..Default::default()
            }));
            events(FetchEvent::Data(body));
            events(FetchEvent::End);
            Box::new(Task)
        }
    }
    fn fixture(status: u16, oversized: bool) -> (Port, Arc<Fixture>, Value) {
        let network = Arc::new(Fixture {
            requests: Mutex::new(Vec::new()),
            status,
            oversized,
        });
        let port = Port::new(network.clone());
        let scope = json!({"hostID":"synthetic","lease":"00000000-0000-4000-8000-000000000001"});
        port.authorize(
            &scope,
            "https://synthetic.invalid",
            "synthetic-bearer",
            false,
        )
        .unwrap();
        (port, network, scope)
    }
    fn resource(capture: Capture, intent: Intent) -> Document {
        let Ok(mut pending) = Preparing::begin(capture, "fixture-owner".into(), intent).unwrap()
        else {
            panic!("not resource")
        };
        let Prepared::Resource(doc) = pending.poll().unwrap().unwrap() else {
            panic!("not resource")
        };
        *doc
    }
    #[test]
    fn target_token_is_captured_in_native_header_not_url_and_routes_are_exact() {
        let (port, network, scope) = fixture(200, false);
        let doc = resource(
            port.capture(&scope).unwrap(),
            Intent::Loopback("http://localhost:3000/page?q=one#two".into()),
        );
        assert_eq!(
            doc.entry,
            "yuri-resource://fixture-owner/api/preview/proxy/0123456789abcdef/page?q=one#two"
        );
        let mut read = doc.read(&(doc.entry.clone() + "&ignored"), LIMIT).unwrap();
        assert!(read.poll().unwrap().is_ok());
        let old = "yuri-resource://fixture-owner/api/preview/proxy/0123456789abcdef/a.js?yuri_preview_token=old&x=1";
        assert_eq!(
            doc.display_url(old).unwrap(),
            "http://localhost:3000/a.js?x=1"
        );
        assert_eq!(
            doc.route(old).unwrap(),
            "/api/preview/proxy/0123456789abcdef/a.js?x=1"
        );
        for url in [
            "yuri-resource://other/api/preview/proxy/0123456789abcdef/a",
            "yuri-resource://fixture-owner/api/fs/read",
            "yuri-resource://fixture-owner/api/preview/proxy/ffffffffffffffff/a",
            "yuri-resource://fixture-owner/api/preview/proxy/0123456789abcdef/%2e%2e/a",
            "yuri-resource://fixture-owner/api/preview/proxy/0123456789abcdef/a?token=x",
        ] {
            assert!(doc.route(url).is_err(), "{url}");
        }
        let requests = network.requests.lock().unwrap();
        assert_eq!(requests[0].method, "POST");
        assert!(
            matches!(&requests[0].body,HttpBody::Bytes(body) if serde_json::from_slice::<Value>(body).unwrap()["allowExternal"] == false)
        );
        assert!(requests[1].headers.contains(&(
            "X-Yuri-Preview-Token".into(),
            "0123456789abcdef0123456789abcdef".into()
        )));
        for request in requests.iter() {
            assert!(!request.url.contains("synthetic-bearer"));
            assert!(!request.url.contains("0123456789abcdef0123456789abcdef"));
            assert!(!request.follow_redirects);
            assert!(!request.headers.iter().any(|(k, _)| {
                ["cookie", "origin", "referer"].contains(&k.to_ascii_lowercase().as_str())
            }));
        }
    }
    #[test]
    fn html_is_host_file_serve_not_client_file_and_scope_close_is_exact() {
        let (port, network, scope) = fixture(200, false);
        let old = port.capture(&scope).unwrap();
        let other = port.capture(&scope).unwrap();
        let doc = resource(
            old.clone(),
            Intent::Html {
                directory: "/work".into(),
                path: "/work/index.html".into(),
            },
        );
        assert_eq!(
            doc.route("yuri-resource://fixture-owner/work/style.css")
                .unwrap(),
            "/api/fs/serve/work/style.css"
        );
        assert!(
            doc.route("yuri-resource://fixture-owner/work2/secret.css")
                .is_err()
        );
        old.close();
        assert!(doc.read(&doc.entry, LIMIT).is_err());
        assert!(other.current());
        assert_eq!(network.requests.lock().unwrap().len(), 1);
        let other_doc = resource(
            other.clone(),
            Intent::Html {
                directory: "/work".into(),
                path: "/work/报告 #.html".into(),
            },
        );
        let mut read = other_doc.read(&other_doc.entry, LIMIT).unwrap();
        assert!(read.poll().unwrap().is_ok());
        port.invalidate();
        assert!(!other.current());
        assert!(port.capture(&scope).is_err());
    }
    #[test]
    fn new_authority_fences_old_jobs_and_reused_owner_never_readmits() {
        let (port, _, scope) = fixture(200, false);
        let old = port.capture(&scope).unwrap();
        port.claim(&scope, "fixture").unwrap();
        assert!(port.claim(&scope, "fixture").is_err());
        let mut changed = scope.clone();
        changed["lease"] = json!("00000000-0000-4000-8000-000000000002");
        port.authorize(&changed, "https://other.invalid", "synthetic-other", false)
            .unwrap();
        assert!(!old.current());
        assert!(port.capture(&scope).is_err());
        assert!(port.capture(&changed).is_ok());
    }
    #[test]
    fn redirect_and_declared_oversize_never_become_success() {
        for (status, oversized) in [(302, false), (200, true)] {
            let (port, _, scope) = fixture(status, oversized);
            let capture = port.capture(&scope).unwrap();
            let mut read = capture
                .fetch("/api/fs/serve/work/index.html", None, None, LIMIT)
                .unwrap();
            assert!(read.poll().unwrap().is_err());
        }
    }
}

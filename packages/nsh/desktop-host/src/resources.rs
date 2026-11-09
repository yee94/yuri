//! Host files are HTTP resources, never client filesystem paths. Leases own bounded UTF-8 bytes.
use crate::{
    policy::{self, Result},
    vault,
};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
pub const TEXT_LIMIT: usize = 1_000_000;
pub const STAT_LIMIT: usize = 64 * 1024;
const LEASE_BYTES: usize = 8 * TEXT_LIMIT;
#[derive(Clone)]
pub struct Read {
    pub path: String,
    pub request: String,
    pub scope: Value,
}
pub fn parse(value: &Value) -> Result<Read> {
    policy::keys(
        value,
        &["path", "requestId", "expectedHost"],
        &["path", "expectedHost"],
    )?;
    let path = policy::string(value, "path")?;
    if !path.starts_with('/')
        || path.len() > 16_384
        || path.contains('\\')
        || path.chars().any(char::is_control)
        || path.split('/').any(|p| p == "." || p == "..")
    {
        return Err("resource_request_invalid".into());
    }
    let request = match value.get("requestId") {
        None => vault::id()?,
        Some(Value::String(s))
            if !s.is_empty() && s.len() <= 128 && !s.chars().any(char::is_control) =>
        {
            s.clone()
        }
        _ => return Err("resource_request_invalid".into()),
    };
    Ok(Read {
        path: path.into(),
        request,
        scope: policy::scope(&value["expectedHost"])?,
    })
}
pub fn encoded(value: &str) -> String {
    let mut out = String::new();
    for b in value.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}
pub fn text_path(path: &str) -> bool {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    ![
        "png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "tiff", "pdf", "mp4", "m4v",
        "webm", "mov", "ogv", "ogg", "mp3", "m4a", "aac", "wav", "wave", "aif", "aiff", "caf",
        "flac", "oga", "opus", "m3u", "m3u8", "pls", "mpd",
    ]
    .contains(&ext.as_str())
}
pub fn stat(value: &Value, path: &str) -> Result<()> {
    if value["isFile"] != true {
        return Err("resource_not_file".into());
    }
    if value.get("isBinary").is_some_and(|v| !v.is_boolean()) {
        return Err("resource_stat_invalid".into());
    }
    if value["isBinary"] == true || !text_path(path) {
        return Err("unsupported_resource_renderer".into());
    }
    if let Some(size) = value.get("size") {
        let size = size.as_u64().ok_or("resource_stat_invalid")?;
        if size > TEXT_LIMIT as u64 {
            return Err("resource_text_limit".into());
        }
    }
    Ok(())
}
struct Lease {
    scope: Value,
    text: String,
}
#[derive(Default)]
pub struct Book {
    pending: HashMap<String, Value>,
    seen: HashSet<String>,
    leases: HashMap<String, Lease>,
    bytes: usize,
}
impl Book {
    pub fn begin(&mut self, read: &Read) -> Result<()> {
        if self.pending.len() >= 2 {
            return Err("resource_read_busy".into());
        }
        // Never reuse caller ids: a late unscoped cancel cannot acquire another owner's new read.
        // Fail closed at a bounded process-lifetime tombstone ceiling rather than evicting ownership proof.
        if self.seen.contains(&read.request) {
            return Err("resource_request_id_reused".into());
        }
        if self.seen.len() >= 4096 {
            return Err("resource_request_id_capacity".into());
        }
        if self.leases.len() >= 32 {
            return Err("resource_lease_capacity".into());
        }
        self.seen.insert(read.request.clone());
        self.pending
            .insert(read.request.clone(), read.scope.clone());
        Ok(())
    }
    pub fn current(&self, read: &Read) -> bool {
        self.pending.get(&read.request) == Some(&read.scope)
    }
    pub fn finish(&mut self, read: &Read) {
        if self.current(read) {
            self.pending.remove(&read.request);
        }
    }
    pub fn cancel(&mut self, value: &Value) -> Result<Option<String>> {
        policy::keys(value, &["requestId", "expectedHost"], &["requestId"])?;
        let id = policy::string(value, "requestId")?;
        let expected = value.get("expectedHost").map(policy::scope).transpose()?;
        if self
            .pending
            .get(id)
            .is_some_and(|scope| expected.as_ref().is_none_or(|v| v == scope))
        {
            self.pending.remove(id);
            Ok(Some(id.into()))
        } else {
            Ok(None)
        }
    }
    pub fn retain(&mut self, read: &Read, text: String) -> Result<Value> {
        if !self.current(read) {
            return Err("resource_read_cancelled".into());
        }
        if text.len() > TEXT_LIMIT || text.contains('\0') {
            return Err("unsupported_resource_renderer".into());
        }
        if self.leases.len() >= 32 || self.bytes + text.len() > LEASE_BYTES {
            return Err("resource_lease_capacity".into());
        }
        let lease = vault::id()?;
        let result = json!({"kind":"text","lease":lease,"size":text.len(),"text":text});
        self.bytes += text.len();
        self.leases.insert(
            lease,
            Lease {
                scope: read.scope.clone(),
                text,
            },
        );
        self.finish(read);
        Ok(result)
    }
    pub fn cleanup(&mut self, name: &str, value: &Value) -> Result<Value> {
        policy::keys(value, &["lease", "expectedHost"], &["lease"])?;
        let id = policy::string(value, "lease")?;
        let expected = value.get("expectedHost").map(policy::scope).transpose()?;
        if self
            .leases
            .get(id)
            .is_some_and(|lease| expected.as_ref().is_some_and(|s| s != &lease.scope))
        {
            return Ok(json!(true));
        }
        // Text has no native presentation to close. close is an idempotent operation on this exact lease,
        // not a release of its bytes and not a cancellation of an unrelated read.
        if name == "resources.release"
            && let Some(lease) = self.leases.remove(id)
        {
            self.bytes -= lease.text.len();
        }
        Ok(json!(true))
    }
    pub fn invalidate(&mut self) {
        self.pending.clear();
        self.leases.clear();
        self.bytes = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn read(id: &str) -> Read {
        Read {
            path: "/synthetic/source.md".into(),
            request: id.into(),
            scope: json!({"hostID":"synthetic-host","lease":"00000000-0000-4000-8000-000000000001"}),
        }
    }
    #[test]
    fn leases_retain_real_bytes_and_cleanup_is_exact_owner_only() {
        let mut book = Book::default();
        let a = read("a");
        let b = read("b");
        book.begin(&a).unwrap();
        book.begin(&b).unwrap();
        let first = book.retain(&a, "synthetic-a".into()).unwrap();
        let second = book.retain(&b, "synthetic-b".into()).unwrap();
        assert_eq!(book.bytes, 22);
        assert_eq!(book.leases.len(), 2);
        book.cleanup("resources.close", &json!({"lease":first["lease"]}))
            .unwrap();
        assert_eq!(book.leases.len(), 2);
        let wrong =
            json!({"hostID":"synthetic-host","lease":"00000000-0000-4000-8000-000000000002"});
        book.cleanup(
            "resources.release",
            &json!({"lease":first["lease"],"expectedHost":wrong}),
        )
        .unwrap();
        assert_eq!(book.leases.len(), 2);
        book.cleanup("resources.release", &json!({"lease":first["lease"]}))
            .unwrap();
        assert_eq!(book.bytes, 11);
        assert!(book.leases.contains_key(second["lease"].as_str().unwrap()));
        book.cleanup("resources.release", &json!({"lease":first["lease"]}))
            .unwrap();
        assert_eq!(book.bytes, 11);
        book.invalidate();
        assert_eq!(book.bytes, 0);
        assert!(book.leases.is_empty());
        assert!(book.begin(&a).is_err());
    }
    #[test]
    fn cancellation_never_releases_completed_lease_or_reused_request_owner() {
        let mut book = Book::default();
        let a = read("a");
        book.begin(&a).unwrap();
        book.cancel(&json!({"requestId":"a"})).unwrap();
        assert!(book.retain(&a, "late".into()).is_err());
        assert!(book.begin(&a).is_err());
        let b = read("b");
        book.begin(&b).unwrap();
        book.retain(&b, "owned".into()).unwrap();
        book.cancel(&json!({"requestId":"b"})).unwrap();
        assert_eq!(book.leases.len(), 1);
        assert!(parse(&json!({"path":"/../secret","expectedHost":a.scope})).is_err());
        assert!(stat(&json!({"isFile":true,"isBinary":true}), "/test.md").is_err());
        assert!(stat(&json!({"isFile":true,"size":1_000_001}), "/test.md").is_err());
        assert!(stat(&json!({"isFile":true}), "/test.pdf").is_err());
    }
}

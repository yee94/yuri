//! Native file-transfer contract. Bodies are private Rust bytes, never HostChannel/JS values.
use super::*;
use std::{
    collections::{BTreeMap, HashSet},
    path::PathBuf,
};
#[path = "file_journal_hash.rs"]
#[allow(clippy::duplicate_mod, reason = "Test-only SSH I/O reuses the journal's private digest source without changing journal ownership or copying SHA-256")]
mod digest;
#[path = "ssh_io_local.rs"]
mod local;
#[path = "ssh_io_remote.rs"]
mod remote;
pub use local::Local;
pub use remote::{ProgramTransport, Remote};
pub(crate) fn file_program() -> &'static str {
    remote::PROGRAM
}

pub const MAX_BYTES: usize = 512 * 1024 * 1024;
pub const MAX_FILES: usize = 20_000;
pub const CONFIG: [&str; 3] = ["config.json", "opencode.json", "opencode.jsonc"];
pub const SINGLE: [&str; 2] = ["AGENTS.md", "cursor-models.json"];
pub const DIRECTORIES: [(&str, Option<&str>); 6] = [
    ("agents", Some("agent")),
    ("commands", Some("command")),
    ("skills", Some("skill")),
    ("snippet", None),
    ("snippets", None),
    ("plugins", None),
];
pub const AGENTS: &str = "@agents";
#[derive(Clone, PartialEq, Eq)]
pub struct Entry {
    pub name: String,
    pub content: Vec<u8>,
    pub version: String,
    pub mode: u32,
}
impl Entry {
    pub fn directory(&self) -> bool {
        self.name.ends_with('/')
    }
    pub(crate) fn wire(&self, body: bool) -> Value {
        json!({"name":self.name,"version":self.version,"mode":self.mode,"data":if body {encode(&self.content)}else{String::new()}})
    }
    pub(crate) fn parse(value: &Value) -> Result<Self> {
        exact(value, &["name", "version", "mode", "data"])?;
        let entry = Self {
            name: text(value, "name", 4096)?,
            version: text(value, "version", 256)?,
            mode: value["mode"]
                .as_u64()
                .filter(|v| *v <= 0o777)
                .ok_or(Error::Invalid)? as u32,
            content: decode(value["data"].as_str().ok_or(Error::Invalid)?)?,
        };
        if !allowed(&entry.name) || (entry.directory() && !entry.content.is_empty()) {
            return Err(Error::Invalid);
        }
        Ok(entry)
    }
}
pub fn hash(bytes: &[u8]) -> String {
    digest::sha256(bytes)
        .iter()
        .map(|v| format!("{v:02x}"))
        .collect()
}
pub fn excluded(name: &str) -> bool {
    name == "node_modules" || name == ".venv-asc" || name.ends_with(".backup")
}
pub fn allowed(name: &str) -> bool {
    let name = name.strip_suffix('/').unwrap_or(name);
    if name.is_empty()
        || name.len() > 4096
        || name.contains(['\\', ':'])
        || name.chars().any(char::is_control)
    {
        return false;
    }
    let parts = name.split('/').collect::<Vec<_>>();
    if parts.len() > 64
        || parts.iter().any(|p| {
            p.is_empty() || *p == "." || *p == ".." || excluded(p) || p.ends_with([' ', '.'])
        })
    {
        return false;
    }
    // Also refuse Windows device-name aliases, including extension-bearing aliases.
    if parts.iter().any(|p| {
        let p = p.split('.').next().unwrap_or("").to_ascii_uppercase();
        matches!(p.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || ["COM", "LPT"].iter().any(|s| {
                p.strip_prefix(s).is_some_and(|n| {
                    matches!(n, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
                })
            })
    }) {
        return false;
    }
    if parts[0] == AGENTS {
        return true;
    }
    (parts.len() == 1 && (CONFIG.contains(&name) || SINGLE.contains(&name)))
        || DIRECTORIES
            .iter()
            .any(|(dir, legacy)| parts[0] == *dir || legacy == &Some(parts[0]))
}
pub fn validate(entries: &[Entry]) -> Result<()> {
    let mut names = HashSet::new();
    let mut files = HashSet::new();
    let mut total = 0usize;
    if entries.len() > MAX_FILES {
        return Err(Error::Invalid);
    }
    for entry in entries {
        total = total
            .checked_add(entry.content.len())
            .ok_or(Error::Invalid)?;
        if !allowed(&entry.name)
            || !names.insert(entry.name.trim_end_matches('/').to_lowercase())
            || entry.version.is_empty()
            || entry.version.len() > 256
            || entry.mode > 0o777
            || total > MAX_BYTES
            || (entry.directory() && !entry.content.is_empty())
        {
            return Err(Error::Invalid);
        }
        if !entry.name.trim_end_matches('/').contains('/') {
            let root = entry.name.trim_end_matches('/');
            let directory = root == AGENTS
                || DIRECTORIES
                    .iter()
                    .any(|(name, old)| root == *name || *old == Some(root));
            if directory != entry.directory() {
                return Err(Error::Invalid);
            }
        }
        if !entry.directory() {
            files.insert(entry.name.to_lowercase());
        }
    }
    for entry in entries {
        let parts = entry
            .name
            .trim_end_matches('/')
            .split('/')
            .collect::<Vec<_>>();
        for n in 1..parts.len() {
            if files.contains(&parts[..n].join("/").to_lowercase()) {
                return Err(Error::Invalid);
            }
        }
    }
    Ok(())
}
pub(crate) fn signature(entries: &[Entry]) -> String {
    let ordered = entries
        .iter()
        .map(|v| (&v.name, (v.version.clone(), v.mode, hash(&v.content))))
        .collect::<BTreeMap<_, _>>();
    hash(&serde_json::to_vec(&ordered).unwrap_or_default())
}
pub(crate) fn same(a: &[Entry], b: &[Entry]) -> bool {
    a.len() == b.len() && a.iter().all(|e| b.iter().any(|v| e == v))
}
pub trait Endpoint: Send + Sync {
    fn read(&self, cancel: &Cancellation) -> Result<Vec<Entry>>;
    fn replace(
        &self,
        run: &str,
        before: &[Entry],
        after: &[Entry],
        cancel: &Cancellation,
    ) -> Result<()>;
    fn receipt(&self, run: &str) -> Result<Option<bool>>;
    fn history(&self) -> Result<Vec<Value>>;
}
/// Both endpoints are real I/O implementations. The actor supplies the home grant and exact SSH target.
pub struct NativeFiles {
    local: Arc<dyn Endpoint>,
    remote: Arc<dyn Endpoint>,
    cancel: Cancellation,
}
impl NativeFiles {
    pub fn new(local: Local, remote: Remote, cancel: Cancellation) -> Self {
        Self {
            local: Arc::new(local),
            remote: Arc::new(remote),
            cancel,
        }
    }
    fn endpoint(&self, remote: bool) -> &dyn Endpoint {
        if remote {
            self.remote.as_ref()
        } else {
            self.local.as_ref()
        }
    }
}
impl sync::Files for NativeFiles {
    fn read(&self, remote: bool) -> Result<Vec<Entry>> {
        self.endpoint(remote).read(&self.cancel)
    }
    fn replace(
        &self,
        remote: bool,
        run: &str,
        before: &[Entry],
        after: &[Entry],
        cancel: &Cancellation,
    ) -> Result<()> {
        let linked = self.cancel.linked(cancel);
        linked.check()?;
        self.endpoint(remote).replace(run, before, after, &linked)
    }
    fn receipt(&self, remote: bool, run: &str) -> Result<Option<bool>> {
        self.endpoint(remote).receipt(run)
    }
    fn history(&self, remote: bool) -> Result<Vec<Value>> {
        self.endpoint(remote).history()
    }
}
pub(crate) fn home_path(home: &std::path::Path, name: &str) -> Result<PathBuf> {
    if !allowed(name) {
        return Err(Error::Invalid);
    }
    Ok(if name.trim_end_matches('/') == AGENTS {
        home.join(".agents")
    } else if let Some(rel) = name.strip_prefix("@agents/") {
        home.join(".agents").join(rel)
    } else {
        home.join(".config/opencode").join(name)
    })
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
pub(crate) fn encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = ((c[0] as u32) << 16)
            | ((c.get(1).copied().unwrap_or(0) as u32) << 8)
            | (c.get(2).copied().unwrap_or(0) as u32);
        out.push(B64[(n >> 18) as usize] as char);
        out.push(B64[((n >> 12) & 63) as usize] as char);
        out.push(if c.len() > 1 {
            B64[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if c.len() > 2 {
            B64[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}
pub(crate) fn decode(text: &str) -> Result<Vec<u8>> {
    if text.len() > MAX_BYTES.div_ceil(3) * 4 || !text.len().is_multiple_of(4) {
        return Err(Error::Invalid);
    }
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    for (index, c) in text.as_bytes().chunks(4).enumerate() {
        let last = index + 1 == text.len() / 4;
        let mut n = 0u32;
        let mut padding = 0;
        for (i, b) in c.iter().enumerate() {
            let v = if *b == b'=' {
                if !last || i < 2 {
                    return Err(Error::Invalid);
                }
                padding += 1;
                0
            } else {
                if padding > 0 {
                    return Err(Error::Invalid);
                }
                B64.iter().position(|v| v == b).ok_or(Error::Invalid)? as u32
            };
            n = (n << 6) | v;
        }
        out.push((n >> 16) as u8);
        if padding < 2 {
            out.push((n >> 8) as u8);
        }
        if padding == 0 {
            out.push(n as u8);
        }
    }
    if encode(&out) != text {
        return Err(Error::Invalid);
    }
    Ok(out)
}

#[cfg(test)]
#[path = "ssh_io_tests.rs"]
mod tests;

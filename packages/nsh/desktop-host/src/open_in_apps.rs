//! Device-only catalog. Discovery never grants authority to a Host directory.
//! No launcher exists until the native Host can produce a sealed local mapping.
use crate::policy::{self, Result};
use nsh_engine::HostReply;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex, OnceLock};

#[cfg(target_os = "macos")]
#[path = "open_in_apps_macos.rs"]
mod platform;
#[cfg(target_os = "windows")]
#[path = "open_in_apps_windows.rs"]
mod platform;

pub const METHODS: &[&str] = &[
    "desktop.openInApps.capabilities",
    "desktop.openInApps.read",
    "desktop.openInApps.scan",
    "desktop.openInApps.select",
    "desktop.openInApps.open",
];
// Same ordered candidates as Web openInApps.ts. These are lookup names, never executable commands.
pub const CANDIDATES: &[(&str, &str, &str)] = &[
    ("finder", "Finder", "Finder"),
    ("terminal", "Terminal", "Terminal"),
    ("iterm2", "iTerm2", "iTerm"),
    ("ghostty", "Ghostty", "Ghostty"),
    ("vscode", "VS Code", "Visual Studio Code"),
    (
        "vscode-insiders",
        "VS Code Insiders",
        "Visual Studio Code - Insiders",
    ),
    ("intellij", "IntelliJ", "IntelliJ IDEA"),
    ("visual-studio", "Visual Studio", "Visual Studio"),
    ("cursor", "Cursor", "Cursor"),
    ("android-studio", "Android Studio", "Android Studio"),
    ("pycharm", "PyCharm", "PyCharm"),
    ("xcode", "Xcode", "Xcode"),
    ("sublime-text", "Sublime", "Sublime Text"),
    ("webstorm", "WebStorm", "WebStorm"),
    ("rider", "Rider", "Rider"),
    ("zed", "Zed", "Zed"),
    ("wu", "Wu", "Wu"),
    ("phpstorm", "PhpStorm", "PhpStorm"),
    ("eclipse", "Eclipse", "Eclipse"),
    ("windsurf", "Windsurf", "Windsurf"),
    ("vscodium", "VSCodium", "VSCodium"),
    ("rustrover", "RustRover", "RustRover"),
    ("kiro", "Kiro", "Kiro"),
    ("antigravity", "Antigravity", "Antigravity"),
    ("trae", "Trae", "Trae"),
];

#[derive(Clone)]
pub struct App {
    pub id: String,
    pub label: String,
    pub version: Option<String>,
}
pub fn app(id: &str, label: &str, version: Option<String>) -> App {
    App {
        id: id.into(),
        label: label.into(),
        version,
    }
}
type Discover = Arc<dyn Fn() -> Result<Vec<App>> + Send + Sync>;
struct Book {
    revision: u64,
    apps: Vec<App>,
    selected: String,
    scanning: bool,
    stale: bool,
    error: bool,
}
pub struct Catalog {
    book: Mutex<Book>,
    discover: Discover,
}
impl Catalog {
    fn new(discover: Discover) -> Self {
        Self {
            book: Mutex::new(Book {
                revision: 0,
                apps: vec![],
                selected: "finder".into(),
                scanning: false,
                stale: true,
                error: false,
            }),
            discover,
        }
    }
    pub fn native() -> Arc<Self> {
        static CATALOG: OnceLock<Arc<Catalog>> = OnceLock::new();
        CATALOG
            .get_or_init(|| Arc::new(Self::new(Arc::new(platform::discover))))
            .clone()
    }
    pub fn capabilities(value: &Value) -> Result<Value> {
        policy::keys(value, &[], &[])?;
        Ok(json!({"version":1,"platform":platform::NAME,
            "discovery":{"supported":true,"source":platform::SOURCE},
            "selection":{"supported":true,"persistence":"process"},
            "open":{"supported":false,"reason":"local_directory_mapping_unavailable"}}))
    }
    fn snapshot(book: &Book) -> Value {
        json!({"version":1,"revision":book.revision,"apps":book.apps.iter().map(|app| {
            let mut row = json!({"id":app.id,"label":app.label});
            if let Some(version) = &app.version { row["version"] = json!(version); }
            row
        }).collect::<Vec<_>>(),"selectedID":book.selected,"scanning":book.scanning,
            "stale":book.stale,"error":book.error.then_some("discovery_failed")})
    }
    pub fn read(&self, value: &Value) -> Result<Value> {
        policy::keys(value, &[], &[])?;
        let book = self.book.lock().map_err(|_| "open_in_apps_unavailable")?;
        Ok(Self::snapshot(&book))
    }
    pub fn select(&self, value: &Value) -> Result<Value> {
        policy::keys(value, &["appID"], &["appID"])?;
        let id = policy::string(value, "appID")?;
        let mut book = self.book.lock().map_err(|_| "open_in_apps_unavailable")?;
        if !book.apps.iter().any(|app| app.id == id) {
            return Err("open_in_apps_unknown_app".into());
        }
        book.revision = next_revision(&book)?;
        book.selected = id.into();
        Ok(Self::snapshot(&book))
    }
    /// One process-wide flight; OS discovery is off both the Engine and connection actor.
    pub fn scan(self: &Arc<Self>, value: &Value, reply: HostReply) {
        if let Err(error) = policy::keys(value, &[], &[]) {
            reply.reject(error);
            return;
        }
        {
            let Ok(mut book) = self.book.lock() else {
                reply.reject("open_in_apps_unavailable");
                return;
            };
            if book.scanning {
                reply.reject("open_in_apps_busy");
                return;
            }
            let Ok(next) = next_revision(&book) else {
                reply.reject("open_in_apps_unavailable");
                return;
            };
            book.revision = next;
            book.scanning = true;
        }
        let catalog = self.clone();
        // The reply is shared solely to settle a failed thread spawn without stranding scanning.
        let reply = Arc::new(Mutex::new(Some(reply)));
        let worker_reply = reply.clone();
        if std::thread::Builder::new()
            .name("yuri-open-in-apps".into())
            .spawn(move || {
                let result =
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (catalog.discover)()))
                        .unwrap_or_else(|_| Err("open_in_apps_discovery_failed".into()));
                let result = catalog.finish(result);
                if let Ok(mut slot) = worker_reply.lock()
                    && let Some(reply) = slot.take()
                {
                    reply.reply(result);
                }
            })
            .is_err()
        {
            let result = self.finish(Err("open_in_apps_worker_failed".into()));
            if let Ok(mut slot) = reply.lock()
                && let Some(reply) = slot.take()
            {
                reply.reply(result);
            }
        }
    }
    fn finish(&self, result: Result<Vec<App>>) -> Result<Value> {
        let mut book = self.book.lock().map_err(|_| "open_in_apps_unavailable")?;
        book.scanning = false;
        book.revision = next_revision(&book)?;
        match result.and_then(validate_apps) {
            Ok(apps) => {
                book.apps = apps;
                book.stale = false;
                book.error = false;
            }
            Err(_) => {
                book.stale = true;
                book.error = true;
                return Err("open_in_apps_discovery_failed".into());
            }
        }
        Ok(Self::snapshot(&book))
    }
    /// Syntax is checked, but a path (even localhost) is NOT a mapping grant.
    pub fn denied_open(&self, value: &Value, current_scope: Option<&Value>) -> Result<Value> {
        policy::keys(
            value,
            &["appID", "directory", "expectedHost", "intent"],
            &["appID", "directory", "expectedHost", "intent"],
        )?;
        let expected = policy::scope(&value["expectedHost"])?;
        if current_scope != Some(&expected) {
            return Err("open_in_apps_stale_host".into());
        }
        if value["intent"] != "open-current-directory" {
            return Err("invalid_arguments".into());
        }
        let directory = policy::string(value, "directory")?;
        validate_directory(directory)?;
        let id = policy::string(value, "appID")?;
        if !self
            .book
            .lock()
            .map_err(|_| "open_in_apps_unavailable")?
            .apps
            .iter()
            .any(|app| app.id == id)
        {
            return Err("open_in_apps_unknown_app".into());
        }
        Ok(json!({"status":"unsupported","reason":"local_directory_mapping_unavailable"}))
    }
}
fn validate_directory(path: &str) -> Result<()> {
    let windows = path.as_bytes().get(1) == Some(&b':')
        && path.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
        && path
            .as_bytes()
            .get(2)
            .is_some_and(|b| *b == b'\\' || *b == b'/');
    if path.len() > 32768
        || path.chars().any(char::is_control)
        || path.starts_with("//")
        || path.starts_with("\\\\")
        || !(path.starts_with('/') || windows)
        || path
            .split(['/', '\\'])
            .any(|part| part == "." || part == "..")
    {
        return Err("open_in_apps_invalid_directory".into());
    }
    Ok(())
}
fn next_revision(book: &Book) -> Result<u64> {
    book.revision
        .checked_add(1)
        .filter(|next| *next <= 9_007_199_254_740_991)
        .ok_or_else(|| "open_in_apps_unavailable".into())
}
fn validate_apps(apps: Vec<App>) -> Result<Vec<App>> {
    let mut seen = std::collections::HashSet::new();
    if apps.len() > CANDIDATES.len()
        || apps.iter().any(|app| {
            !CANDIDATES.iter().any(|row| row.0 == app.id)
                || !seen.insert(&app.id)
                || app.label.is_empty()
                || app.label.len() > 512
                || app.label.chars().any(char::is_control)
                || app.version.as_ref().is_some_and(|v| {
                    v.is_empty() || v.len() > 128 || v.chars().any(char::is_control)
                })
        })
    {
        return Err("open_in_apps_invalid_catalog".into());
    }
    Ok(apps)
}

#[cfg(test)]
#[path = "open_in_apps_tests.rs"]
mod tests;

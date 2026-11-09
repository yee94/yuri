//! Data-only copy of NativeAppearanceContract (appearance-core.ts + iOS AppearanceBridge).
//! A successful reply is produced by the UI owner, never by broadcasting a JS event.
use crate::policy::{self, Result};
use nsh_engine::HostReply;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
    mpsc::{self, Receiver, SyncSender},
};

pub const TOKENS: &[&str] = &[
    "background",
    "foreground",
    "card",
    "card-foreground",
    "primary",
    "primary-foreground",
    "secondary",
    "secondary-foreground",
    "muted",
    "muted-foreground",
    "accent",
    "accent-foreground",
    "border",
    "input",
    "ring",
    "destructive",
    "success",
    "chat-user",
    "chat-user-foreground",
    "chat-assistant",
    "chat-assistant-foreground",
];
pub const FONTS: &[&str] = &["ui", "mono", "assistantLight", "assistantDark"];
#[derive(Clone)]
pub struct Contract {
    pub mode: String,
    pub colors: Value,
    pub fonts: Value,
}
pub fn reset(value: &Value, host: Option<&str>) -> Result<()> {
    policy::keys(value, &["hostID"], &["hostID"])?;
    bounded(value)?;
    if !value["hostID"].is_null() {
        check_host(value, host)?;
    }
    Ok(())
}
fn check_host(value: &Value, host: Option<&str>) -> Result<()> {
    let id = policy::string(value, "hostID")?;
    if id.len() > 512 || Some(id) != host {
        return Err("appearance_scope_invalid".into());
    }
    Ok(())
}
fn bounded(value: &Value) -> Result<()> {
    if serde_json::to_vec(value).map_or(true, |v| v.len() > 16_384) {
        return Err("appearance_payload_invalid".into());
    }
    Ok(())
}
pub fn decode(value: &Value, host: Option<&str>, revision: u64) -> Result<Contract> {
    policy::keys(
        value,
        &["hostID", "revision", "mode", "cssVars", "fonts"],
        &["hostID", "revision", "mode", "cssVars", "fonts"],
    )?;
    bounded(value)?;
    check_host(value, host)?;
    if value["revision"].as_f64() != Some(revision as f64) {
        return Err("appearance_revision_stale".into());
    }
    let mode = policy::string(value, "mode")?;
    if !["system", "light", "dark"].contains(&mode) {
        return Err("appearance_payload_invalid".into());
    }
    policy::keys(&value["cssVars"], &["light", "dark"], &["light", "dark"])?;
    for scheme in ["light", "dark"] {
        let palette = &value["cssVars"][scheme];
        policy::keys(palette, TOKENS, TOKENS)?;
        if policy::object(palette)?.values().any(|v| {
            v.as_str().is_none_or(|s| {
                !s.starts_with('#')
                    || ![4, 5, 7, 9].contains(&s.len())
                    || !s[1..].bytes().all(|b| b.is_ascii_hexdigit())
            })
        }) {
            return Err("appearance_color_invalid".into());
        }
    }
    policy::keys(&value["fonts"], FONTS, FONTS)?;
    if policy::object(&value["fonts"])?.values().any(|v| {
        v.as_str().is_none_or(|s| {
            s.is_empty()
                || s.len() > 64
                || !s
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b' ' || b == b'-')
        })
    }) {
        return Err("appearance_font_invalid".into());
    }
    Ok(Contract {
        mode: mode.into(),
        colors: value["cssVars"].clone(),
        fonts: value["fonts"].clone(),
    })
}
pub enum Command {
    Reset { revision: u64 },
    Apply(Contract),
}
pub struct Job {
    pub generation: u64,
    pub command: Command,
    pub reply: HostReply,
}
#[derive(Clone)]
pub struct Port {
    sender: Option<SyncSender<Job>>,
    pub generation: Arc<AtomicU64>,
}
pub struct Inbox {
    receiver: Receiver<Job>,
    pub generation: Arc<AtomicU64>,
}
impl Port {
    pub fn unavailable() -> Self {
        Self {
            sender: None,
            generation: Arc::new(AtomicU64::new(0)),
        }
    }
    pub fn channel() -> (Self, Inbox) {
        let (sender, receiver) = mpsc::sync_channel(16);
        let generation = Arc::new(AtomicU64::new(0));
        (
            Self {
                sender: Some(sender),
                generation: generation.clone(),
            },
            Inbox {
                receiver,
                generation,
            },
        )
    }
    pub fn invalidate(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
    }
    pub fn submit(&self, command: Command, reply: HostReply) {
        let Some(sender) = &self.sender else {
            reply.reject("appearance_native_owner_unavailable");
            return;
        };
        let job = Job {
            generation: self.generation.load(Ordering::Acquire),
            command,
            reply,
        };
        if let Err(mpsc::TrySendError::Full(job) | mpsc::TrySendError::Disconnected(job)) =
            sender.try_send(job)
        {
            job.reply.reject("appearance_native_owner_busy");
        }
    }
}
impl Inbox {
    pub fn drain(&self, mut apply: impl FnMut(Command) -> Result<Value>) {
        for _ in 0..16 {
            let Ok(job) = self.receiver.try_recv() else {
                break;
            };
            if job.generation != self.generation.load(Ordering::Acquire) {
                job.reply.reject("appearance_revision_stale");
                continue;
            }
            let result = apply(job.command);
            if job.generation != self.generation.load(Ordering::Acquire) {
                job.reply.reject("appearance_revision_stale");
            } else {
                job.reply.reply(result);
            }
        }
    }
}
pub fn disabled_diagnostics() -> Value {
    json!({"schemaVersion":2,"enabled":false,"mode":"event-recorder","recordingLease":null,"eventCount":0,"maxEntries":500,"maxBytes":262144,"supported":false})
}
pub fn metadata(app: &Value) -> Value {
    let version = app["version"].as_str().filter(|s| {
        s.len() <= 96
            && s.split(['-', '+']).next().is_some_and(|v| {
                v.split('.').count() == 3
                    && v.split('.')
                        .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
            })
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".-+".contains(&b))
    });
    let build = app["build"]
        .as_u64()
        .filter(|n| *n <= 999_999_999_999_999_999)
        .map(|n| n.to_string());
    json!({"schemaVersion":1,"version":version,"build":build,"updates":{"status":"unsupported","blockers":["signed-artifact","trusted-update-origin","signed-manifest-verifier","native-install-lifecycle"]}})
}

#[cfg(test)]
pub fn fixture(host: &str, revision: u64) -> Value {
    let palette: serde_json::Map<String, Value> = TOKENS
        .iter()
        .map(|key| ((*key).into(), json!("#123456")))
        .collect();
    json!({"hostID":host,"revision":revision,"mode":"system","cssVars":{"light":palette,"dark":palette},"fonts":{"ui":"system-ui","mono":"monospace","assistantLight":"system-ui","assistantDark":"monospace"}})
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn production_ts_theme_projection_is_accepted_without_schema_reinterpretation() {
        let payload: Value =
            serde_json::from_str(include_str!("../fixtures/appearance.json")).unwrap();
        assert!(decode(&payload, Some("synthetic-host"), 7).is_ok());
    }
    #[test]
    fn contract_matches_ios_exact_schema_and_rejects_stale_executable_payloads() {
        let value = fixture("synthetic-host", 3);
        assert!(decode(&value, Some("synthetic-host"), 3).is_ok());
        let mut numeric = value.clone();
        numeric["revision"] = json!(3.0);
        assert!(decode(&numeric, Some("synthetic-host"), 3).is_ok());
        assert!(decode(&value, Some("other"), 3).is_err());
        assert!(decode(&value, Some("synthetic-host"), 4).is_err());
        for bad in [json!(true), json!("3"), json!(3.5)] {
            let mut v = value.clone();
            v["revision"] = bad;
            assert!(decode(&v, Some("synthetic-host"), 3).is_err());
        }
        for bad in [
            "red",
            "#123456\n",
            "#xyz",
            "var(--surface)",
            "url(https://invalid.example)",
        ] {
            let mut v = value.clone();
            v["cssVars"]["light"]["background"] = json!(bad);
            assert!(decode(&v, Some("synthetic-host"), 3).is_err());
        }
        for bad in [
            "system-ui\n",
            "url(https://invalid.example)",
            &"x".repeat(17000),
        ] {
            let mut v = value.clone();
            v["fonts"]["ui"] = json!(bad);
            assert!(decode(&v, Some("synthetic-host"), 3).is_err());
        }
        let mut extra = value.clone();
        extra["cssVars"]["light"]["script"] = json!("#123");
        assert!(decode(&extra, Some("synthetic-host"), 3).is_err());
        assert!(reset(&json!({"hostID":null}), None).is_ok());
        assert!(reset(&json!({"hostID":"old"}), Some("synthetic-host")).is_err());
    }
}

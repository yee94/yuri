//! Closed schema-2 ingress. No raw runtime object is serialized or recursively redacted.
use super::{Result, Value, json};

pub const MAX_ENTRIES: usize = 500;
pub const MAX_BYTES: usize = 256 * 1024;
pub const MAX_EXPORT_BYTES: usize = 512 * 1024;
pub const MAX_BATCH_BYTES: usize = 16 * 1024;
pub const TYPES: &[&str] = &[
    "reconnected", "server.connected", "global.disposed", "session.status", "session.idle", "session.error", "session.created", "session.updated", "session.deleted",
    "session.execution.started", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted",
    "session.step.started", "session.step.finished", "session.tool.started", "session.tool.finished",
    "session.step.failed", "session.text.started", "session.text.ended", "session.reasoning.started", "session.reasoning.ended",
    "session.tool.input.started", "session.tool.input.ended", "session.tool.called", "session.tool.success", "session.tool.failed",
    "session.retry.scheduled", "session.inbox.delivered", "session.inbox.cancelled", "session.instructions.updated", "session.metadata.updated", "session.usage.updated",
    "session.revert.staged", "session.revert.committed", "session.revert.cleared",
    "message.updated", "message.removed", "message.part.updated", "message.part.removed",
    "permission.asked", "permission.replied", "question.asked", "question.replied", "question.rejected", "form.asked", "form.replied", "form.cancelled",
    "yuri:session-status", "yuri:session-index-changed", "yuri:assistants-changed", "yuri:scheduled-tasks-changed",
    "yuri:contact-turn-start", "yuri:contact-turn-end", "yuri:project-order-changed", "yuri:worktree-topology-changed",
];
pub(super) fn exact(value: &Value, fields: &[&str]) -> Result<()> {
    crate::policy::keys(value, fields, fields).map_err(|_| "diagnostics_invalid_schema".into())
}
pub(super) fn text<'a>(value: &'a Value, key: &str, limit: usize) -> Result<&'a str> {
    crate::policy::string(value, key)
        .ok().filter(|s| s.len() <= limit && !s.chars().any(char::is_control))
        .ok_or_else(|| "diagnostics_invalid_schema".into())
}
pub(super) fn events(value: &Value) -> Result<(Vec<String>, u64)> {
    exact(value, &["hostID", "lease", "events", "dropped"])?;
    text(value, "hostID", 256)?;
    text(value, "lease", 128)?;
    let dropped = value["dropped"].as_u64().filter(|n| *n <= 1_000_000)
        .ok_or("diagnostics_invalid_schema")?;
    let rows = value["events"].as_array().filter(|a| !a.is_empty() && a.len() <= 32)
        .ok_or("diagnostics_invalid_schema")?;
    let mut bytes = 0;
    let mut result = Vec::with_capacity(rows.len());
    for row in rows {
        exact(row, &["at", "feat", "kind", "sessionID", "source", "sseType", "surfaceKind"])?;
        let at = row["at"].as_f64().filter(|n| n.is_finite() && *n >= 0.0 && *n <= 9_007_199_254_740_991.0);
        let session = text(row, "sessionID", 11)?;
        let ordinal = session.strip_prefix("session-").ok_or("diagnostics_invalid_schema")?;
        if at.is_none() || row["feat"] != "transcript" || row["kind"] != "sse-event" || row["source"] != "sse"
            || ordinal.is_empty() || ordinal.len() > 3 || !ordinal.bytes().all(|b| b.is_ascii_digit())
            || (ordinal.len() > 1 && ordinal.starts_with('0'))
            || !TYPES.contains(&text(row, "sseType", 64)?)
            || !["global", "chat"].contains(&text(row, "surfaceKind", 6)?) {
            return Err("diagnostics_invalid_schema".into());
        }
        // Only after every property has its fixed type/length/enum bounds.
        let encoded = serde_json::to_string(row).map_err(|_| "diagnostics_invalid_schema")?;
        bytes += encoded.len();
        if bytes > MAX_BATCH_BYTES { return Err("diagnostics_batch_limit".into()); }
        result.push(encoded);
    }
    Ok((result, dropped))
}
fn choice(value: &Value, choices: &[&str]) -> Value {
    value.as_str().filter(|s| choices.contains(s)).map_or(Value::Null, |s| json!(s))
}
fn boolean(value: &Value) -> Value { value.as_bool().map_or(Value::Null, |b| json!(b)) }
pub(super) fn version(value: &Value) -> Value {
    let Some(s) = value.as_str().map(str::trim).filter(|s| s.len() <= 96) else { return Value::Null };
    let s0 = s.strip_prefix('v').unwrap_or(s);
    let (main, build) = s0.split_once('+').map_or((s0, None), |(a,b)| (a, Some(b)));
    let (core, pre) = main.split_once('-').map_or((main, None), |(a,b)| (a, Some(b)));
    let valid_suffix = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-');
    let parts: Vec<_> = core.split('.').collect();
    if parts.len() != 3 || parts.iter().any(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()))
        || pre.is_some_and(|p| !valid_suffix(p)) || build.is_some_and(|p| !valid_suffix(p)) { Value::Null } else { json!(s) }
}
pub(super) fn client(version_value: &Value, build: &Value) -> Value {
    let build = build.as_str().filter(|s| {
        let p: Vec<_> = s.split('.').collect();
        !p.is_empty() && p.len() <= 3 && p.iter().enumerate().all(|(i,p)|
            !p.is_empty() && p.len() <= if i == 0 {18} else {6} && p.bytes().all(|b| b.is_ascii_digit()))
    }).map_or(Value::Null, |s| json!(s));
    json!({"schemaVersion":1,"version":version(version_value),"build":build,
        "updates":{"status":"unsupported","blockers":["signed-artifact","trusted-update-origin","signed-manifest-verifier","native-install-lifecycle"]}})
}
pub(super) fn context(input: &Value, client: &Value) -> Result<Value> {
    exact(input, &["schemaVersion", "host", "opencode", "hostUpdate"])?;
    if input["schemaVersion"] != 1 { return Err("diagnostics_invalid_schema".into()); }
    let host = &input["host"]; let oc = &input["opencode"]; let update = &input["hostUpdate"];
    exact(host, &["version", "status"])?;
    exact(oc, &["version", "status", "management", "canManage"])?;
    exact(update, &["status", "supported", "operation", "checkFailed"])?;
    // Do not walk/stringify arbitrary strings in a context; project only bounded values.
    for object in [host, oc, update] {
        for value in object.as_object().expect("exact object").values() {
            if !matches!(value, Value::Null | Value::Bool(_)) && !value.as_str().is_some_and(|s| s.len() <= 96) {
                return Err("diagnostics_invalid_schema".into());
            }
        }
    }
    let states = &["unknown", "ready", "failed"];
    Ok(json!({"schemaVersion":1,"kind":"nsh-about-snapshot","mode":"snapshot-only","client":client,
        "host":{"version":version(&host["version"]),"status":choice(&host["status"],states)},
        "opencode":{"version":version(&oc["version"]),"status":choice(&oc["status"],states),
            "management":choice(&oc["management"], &["manual-global","manual-external","bundled","in-app","none"]),"canManage":boolean(&oc["canManage"])},
        "hostUpdate":{"status":choice(&update["status"],states),"supported":boolean(&update["supported"]),
            "operation":choice(&update["operation"], &["checking","downloading","installing","restarting","succeeded","failed"]),"checkFailed":boolean(&update["checkFailed"])}}))
}

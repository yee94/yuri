//! Direct connection metadata/version CAS, matching connection-editor-core.ts and Swift records.
//! Only the actor commits these staged values. Credentials never enter an editor descriptor.
use super::{Connection, State};
use crate::{
    policy::{self, Result},
    vault,
};
use serde_json::{Value, json};

pub const INVALID: &str = "connection_editor_invalid";
pub const MISSING: &str = "connection_editor_missing";
pub const STALE: &str = "connection_editor_stale";
pub const PAIRING: &str = "connection_editor_pairing_required";
pub const DUPLICATE: &str = "connection_editor_duplicate";
#[derive(Clone)]
pub struct Target {
    pub id: String,
    pub version: String,
}
pub fn label(raw: &str) -> Result<String> {
    let label = raw.trim();
    if label.is_empty() || label.encode_utf16().count() > 120 || label.chars().any(char::is_control)
    {
        return Err(INVALID.into());
    }
    Ok(label.into())
}
fn text<'a>(value: &'a Value, name: &str) -> Result<&'a str> {
    policy::string(value, name).map_err(|_| INVALID.into())
}
pub fn record<'a>(state: &'a State, id: &str, version: Option<&str>) -> Result<&'a Connection> {
    let connection = state
        .connections
        .iter()
        .find(|connection| connection.id == id)
        .ok_or(MISSING)?;
    if version
        .is_some_and(|version| version != connection.editor_version.as_deref().unwrap_or("legacy"))
    {
        return Err(STALE.into());
    }
    Ok(connection)
}
pub fn descriptor(state: &State, value: &Value) -> Result<Value> {
    policy::keys(value, &["id"], &["id"]).map_err(|_| INVALID)?;
    let connection = record(state, text(value, "id")?, None)?;
    Ok(
        json!({"id":connection.id,"version":connection.editor_version.as_deref().unwrap_or("legacy"),"label":connection.label,"url":connection.url,"transport":"direct","lastUsedAt":connection.used}),
    )
}
/// None is an actual no-op: do not write storage or manufacture a new version/lease.
pub fn editing(state: &State, method: &str, value: &Value) -> Result<Option<State>> {
    let allowed: &[&str] = if method == "connection.rename" {
        &["id", "version", "label"]
    } else {
        &["id", "version", "label", "url"]
    };
    policy::keys(value, allowed, &["id", "version", "label"]).map_err(|_| INVALID)?;
    let id = text(value, "id")?;
    let version = text(value, "version")?;
    let name = label(value["label"].as_str().ok_or(INVALID)?)?;
    let previous = record(state, id, Some(version))?;
    if let Some(url) = value.get("url") {
        let url = policy::editor_origin(url.as_str().ok_or(INVALID)?).map_err(|_| INVALID)?;
        if url != previous.url {
            return Err(PAIRING.into());
        }
    }
    if previous.label == name {
        return Ok(None);
    }
    let mut next = state.clone();
    let index = next
        .connections
        .iter()
        .position(|connection| connection.id == id)
        .expect("validated record");
    next.connections[index].label = name;
    next.connections[index].editor_version = Some(vault::id()?);
    Ok(Some(next))
}
/// A replacement must be explicit, version-bound and freshly authorized. Never reuse a saved token.
pub fn replacement(state: &State, value: &Value) -> Result<Option<Target>> {
    if value.get("id").is_none() && value.get("version").is_none() {
        return Ok(None);
    }
    let target = Target {
        id: text(value, "id")?.into(),
        version: text(value, "version")?.into(),
    };
    record(state, &target.id, Some(&target.version))?;
    if let Some(raw) = value.get("label") {
        label(raw.as_str().ok_or(INVALID)?)?;
    }
    let password = policy::optional_string(value, "password").map_err(|_| INVALID)?;
    if password.is_empty() {
        let token = text(value, "token").map_err(|_| PAIRING)?;
        if state
            .connections
            .iter()
            .any(|connection| connection.token == token)
        {
            return Err(PAIRING.into());
        }
    }
    Ok(Some(target))
}
pub fn check(state: &State, target: &Target) -> Result<()> {
    record(state, &target.id, Some(&target.version)).map(|_| ())
}
/// Called only after the candidate's native authentication/probe succeeded. CAS is checked again.
pub fn replacing(
    state: &State,
    target: &Target,
    mut candidate: Connection,
) -> Result<(State, bool)> {
    let previous = record(state, &target.id, Some(&target.version))?;
    if candidate.token.is_empty() {
        return Err(PAIRING.into());
    }
    if state
        .connections
        .iter()
        .any(|connection| connection.id != target.id && connection.url == candidate.url)
    {
        return Err(DUPLICATE.into());
    }
    candidate.id = previous.id.clone();
    candidate.used = previous.used;
    candidate.editor_version = Some(vault::id()?);
    candidate.authorization = vault::id()?;
    let mut next = state.clone();
    let index = next
        .connections
        .iter()
        .position(|connection| connection.id == target.id)
        .expect("validated record");
    next.connections[index] = candidate;
    Ok((next, state.selected.as_deref() == Some(target.id.as_str())))
}
pub fn storage(error: String) -> String {
    if vault::invalidates_authority(&error) {
        error
    } else {
        "connection_editor_storage".into()
    }
}

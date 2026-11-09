//! One original secure-store object and one serialized record. Views never create NativeVault.
use crate::{
    policy::Result,
    vault::{self, Vault},
};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub(super) struct Lane(Arc<Mutex<Inner>>);
struct Inner {
    vault: Box<dyn Vault>,
    loaded: bool,
    bytes: Option<Vec<u8>>,
    generation: u64,
    failure: Option<String>,
    cold_selection: Option<Option<String>>,
}
struct View {
    lane: Lane,
    primary: bool,
}
impl Lane {
    pub fn new(vault: Box<dyn Vault>) -> Self {
        Self(Arc::new(Mutex::new(Inner {
            vault,
            loaded: false,
            bytes: None,
            generation: 0,
            failure: None,
            cold_selection: None,
        })))
    }
    pub fn view(&self, primary: bool) -> Box<dyn Vault> {
        Box::new(View {
            lane: self.clone(),
            primary,
        })
    }
    pub fn generation(&self) -> u64 {
        self.0.lock().map_or(u64::MAX, |s| s.generation)
    }
    pub fn failure(&self) -> Option<String> {
        self.0
            .lock()
            .map_or(Some(vault::COMMIT_UNKNOWN.into()), |s| s.failure.clone())
    }
    /// Already-loaded authoritative cold default only. Never triggers Vault I/O.
    /// The outer None means unknown, not an authoritative empty selection.
    pub fn cached_selection(&self) -> Option<Option<String>> {
        self.0.lock().ok().filter(|s| s.failure.is_none())?.cold_selection.clone()
    }
    pub fn poison(&self, error: &str) {
        if let Ok(mut s) = self.0.lock()
            && s.failure.is_none()
        {
            s.failure = Some(error.into());
        }
    }
}
impl Inner {
    fn load(&mut self) -> Result<()> {
        if let Some(error) = &self.failure {
            return Err(error.clone());
        }
        if !self.loaded {
            self.bytes = self.vault.read()?;
            self.cold_selection = match self.bytes.as_deref() {
                None => Some(None),
                Some(bytes) => serde_json::from_slice::<serde_json::Value>(bytes).ok()
                    .and_then(|value| selection(&value)),
            };
            self.loaded = true;
            self.generation = 1;
        }
        Ok(())
    }
}
impl Vault for View {
    fn read(&self) -> Result<Option<Vec<u8>>> {
        let mut inner = self.lane.0.lock().map_err(|_| vault::COMMIT_UNKNOWN)?;
        inner.load()?;
        Ok(inner.bytes.clone())
    }
    fn write(&self, bytes: &[u8]) -> Result<()> {
        let mut inner = self.lane.0.lock().map_err(|_| vault::COMMIT_UNKNOWN)?;
        inner.load()?;
        let mut next: serde_json::Value =
            serde_json::from_slice(bytes).map_err(|_| "secure_store_invalid")?;
        if !self.primary {
            let prior: Option<serde_json::Value> = inner
                .bytes
                .as_deref()
                .map(serde_json::from_slice)
                .transpose()
                .map_err(|_| "secure_store_invalid")?;
            next["selected"] = prior
                .as_ref()
                .and_then(|v| v.get("selected"))
                .cloned()
                .unwrap_or(serde_json::Value::Null);
        }
        let bytes = serde_json::to_vec(&next).map_err(|_| "secure_store_invalid")?;
        if inner.bytes.as_deref() == Some(&bytes) {
            return Ok(());
        }
        let generation = inner
            .generation
            .checked_add(1)
            .ok_or(vault::COMMIT_UNKNOWN)?;
        // Same original transaction lane; stale external records never become merge input.
        // macOS Keychain has no cross-process compare-and-swap primitive: this check does
        // not claim linearizability against an unrelated process racing the OS setter.
        if inner.vault.read()? != inner.bytes {
            inner.failure = Some(vault::CONFLICT.into());
            return Err(vault::CONFLICT.into());
        }
        if let Err(error) = inner.vault.write(&bytes) {
            if vault::invalidates_authority(&error) {
                inner.failure = Some(error.clone());
            }
            return Err(error);
        }
        if !matches!(inner.vault.read(), Ok(Some(actual)) if actual == bytes) {
            inner.failure = Some(vault::COMMIT_UNKNOWN.into());
            return Err(vault::COMMIT_UNKNOWN.into());
        }
        inner.bytes = Some(bytes);
        inner.cold_selection = selection(&next);
        inner.generation = generation;
        Ok(())
    }
}
fn selection(value: &serde_json::Value) -> Option<Option<String>> {
    match value.get("selected")? {
        serde_json::Value::Null => Some(None),
        serde_json::Value::String(id) if !id.is_empty() => Some(Some(id.clone())),
        _ => None,
    }
}

//! Consent-only metadata using the existing transactional FileStore in a separate
//! native private directory. Never writes diagnostics rows, Vault data or UI payloads.
use crate::{diagnostics, notification_store_grant, notifications, policy::Result};
use serde_json::json;
pub struct Consent {
    store: Result<notifications::Store>,
}
impl Consent {
    pub fn native() -> Self {
        Self {
            store: notification_store_grant::store_for("native-preferences"),
        }
    }
    #[cfg(test)]
    pub fn with_store(store: notifications::Store) -> Self {
        Self { store: Ok(store) }
    }
}
impl diagnostics::Preference for Consent {
    fn load(&mut self) -> Result<bool> {
        let Some(value) = self
            .store
            .as_mut()
            .map_err(|_| "diagnostics_preference_unavailable")?
            .load()?
        else {
            return Ok(false);
        };
        if value.as_object().is_none_or(|o| o.len() != 2) || value["v"] != 1 {
            return Err("diagnostics_preference_invalid".into());
        }
        value["diagnosticsEnabled"]
            .as_bool()
            .ok_or_else(|| "diagnostics_preference_invalid".into())
    }
    fn save(&mut self, enabled: bool) -> Result<()> {
        self.store
            .as_mut()
            .map_err(|_| "diagnostics_preference_unavailable")?
            .commit(&json!({"v":1,"diagnosticsEnabled":enabled}))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use diagnostics::Preference;
    use std::sync::{Arc, Mutex};
    struct Memory(Arc<Mutex<Option<serde_json::Value>>>);
    impl notifications::store::Store for Memory {
        fn load(&mut self) -> Result<Option<serde_json::Value>> {
            Ok(self.0.lock().unwrap().clone())
        }
        fn commit(&mut self, next: &serde_json::Value) -> Result<()> {
            *self.0.lock().unwrap() = Some(next.clone());
            Ok(())
        }
    }
    #[test]
    fn consent_cold_restore_is_exact_metadata_and_missing_is_false() {
        let data = Arc::new(Mutex::new(None));
        let mut first = Consent::with_store(Box::new(Memory(data.clone())));
        assert!(!first.load().unwrap());
        first.save(true).unwrap();
        let mut next = Consent::with_store(Box::new(Memory(data.clone())));
        assert!(next.load().unwrap());
        assert_eq!(
            *data.lock().unwrap(),
            Some(json!({"v":1,"diagnosticsEnabled":true}))
        );
        *data.lock().unwrap() = Some(json!({"v":1,"diagnosticsEnabled":true,"events":[]}));
        assert!(next.load().is_err());
        next.save(false).unwrap();
        assert!(!next.load().unwrap());
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn consent_uses_real_private_transactional_disk_and_rejects_corruption_without_empty_success() {
        use std::{fs, os::unix::fs::DirBuilderExt};
        let directory = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("nsh-consent-disk-{}", crate::vault::id().unwrap()));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .unwrap();
        let open = || {
            Consent::with_store(Box::new(
                notifications::store::FileStore::in_private_directory(&directory).unwrap(),
            ))
        };
        let mut first = open();
        assert!(!first.load().unwrap());
        first.save(true).unwrap();
        drop(first);
        let mut cold = open();
        assert!(cold.load().unwrap());
        cold.save(false).unwrap();
        drop(cold);
        let file = directory.join("desktop-notification-receipts.json");
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&fs::read(&file).unwrap()).unwrap(),
            json!({"v":1,"diagnosticsEnabled":false})
        );
        fs::write(&file, b"{partial").unwrap();
        let mut broken = open();
        assert!(broken.load().is_err());
        drop(broken);
        fs::remove_file(file).unwrap();
        fs::remove_file(directory.join("desktop-notification-receipts.lock")).unwrap();
        fs::remove_dir(directory).unwrap();
    }
}

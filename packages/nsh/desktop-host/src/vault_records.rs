//! Credential Manager transaction: immutable bounded chunks, one small commit manifest.
//! OS calls and cross-process serialization are injected; this core never uses a plaintext file.
use crate::policy::{self, Result};
use serde_json::{Value, json};

pub const LIMIT: usize = 64 * 1024;
pub const RECORD_LIMIT: usize = 2560;
pub const MANIFEST: &str = "connections-v2";
pub const LEGACY: &str = "connections-v1";
pub const UNKNOWN: &str = "secure_store_commit_unknown";
pub const CONFLICT: &str = "secure_store_conflict";
pub trait Records {
    fn read(&self, key: &str) -> Result<Option<Vec<u8>>>;
    fn write(&self, key: &str, bytes: &[u8]) -> Result<()>;
    fn delete(&self, key: &str) -> Result<()>;
    fn digest(&self, bytes: &[u8]) -> Result<[u8; 32]>;
    fn generation(&self) -> Result<String>;
    fn prune(&self, keep: Option<&str>) -> Result<()>;
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Baseline {
    pub manifest: Option<Vec<u8>>,
    pub legacy: Option<Vec<u8>>,
}
struct Manifest {
    generation: String,
    length: usize,
    parts: usize,
    digest: String,
}
pub fn generation_valid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}
fn hex(digest: [u8; 32]) -> String {
    digest.iter().map(|b| format!("{b:02x}")).collect()
}
impl Manifest {
    fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > RECORD_LIMIT {
            return Err("secure_store_invalid".into());
        }
        let value: Value = serde_json::from_slice(bytes).map_err(|_| "secure_store_invalid")?;
        policy::keys(
            &value,
            &["version", "generation", "length", "parts", "sha256"],
            &["version", "generation", "length", "parts", "sha256"],
        )?;
        let generation = policy::string(&value, "generation")?;
        let length = value["length"]
            .as_u64()
            .filter(|n| *n <= LIMIT as u64)
            .ok_or("secure_store_invalid")? as usize;
        let parts = value["parts"]
            .as_u64()
            .filter(|n| *n <= LIMIT.div_ceil(RECORD_LIMIT) as u64)
            .ok_or("secure_store_invalid")? as usize;
        let digest = policy::string(&value, "sha256")?;
        if value["version"] != 2
            || !generation_valid(generation)
            || parts != length.div_ceil(RECORD_LIMIT)
            || digest.len() != 64
            || !digest.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("secure_store_invalid".into());
        }
        Ok(Self {
            generation: generation.into(),
            length,
            parts,
            digest: digest.into(),
        })
    }
    fn encode(&self) -> Vec<u8> {
        json!({"version":2,"generation":self.generation,"length":self.length,"parts":self.parts,"sha256":self.digest}).to_string().into_bytes()
    }
    fn key(&self, part: usize) -> String {
        format!("{MANIFEST}/chunk/{}/{part}", self.generation)
    }
}
fn baseline(records: &impl Records) -> Result<Baseline> {
    let manifest = records.read(MANIFEST)?;
    let legacy = if manifest.is_none() {
        records.read(LEGACY)?
    } else {
        None
    };
    Ok(Baseline { manifest, legacy })
}
fn assemble(records: &impl Records, manifest: &Manifest) -> Result<Vec<u8>> {
    let mut bytes = Vec::with_capacity(manifest.length);
    for index in 0..manifest.parts {
        let chunk = records
            .read(&manifest.key(index))?
            .ok_or("secure_store_missing_chunk")?;
        let expected = (manifest.length - bytes.len()).min(RECORD_LIMIT);
        if chunk.len() != expected {
            return Err("secure_store_invalid_chunk".into());
        }
        bytes.extend(chunk);
    }
    if bytes.len() != manifest.length || hex(records.digest(&bytes)?) != manifest.digest {
        return Err("secure_store_integrity_failed".into());
    }
    Ok(bytes)
}
pub fn load(records: &impl Records) -> Result<(Option<Vec<u8>>, Baseline)> {
    let base = baseline(records)?;
    let bytes = if let Some(manifest) = &base.manifest {
        Some(assemble(records, &Manifest::decode(manifest)?)?)
    } else {
        base.legacy.clone()
    };
    if bytes.as_ref().is_some_and(|v| v.len() > LIMIT) {
        return Err("secure_store_capacity".into());
    }
    Ok((bytes, base))
}
fn discard(records: &impl Records, manifest: &Manifest) {
    // Only our collision-checked, uncommitted generation. A cleanup failure cannot delete prior.
    // The next write's bounded namespace prune must succeed before adding another generation.
    for index in 0..manifest.parts {
        let _ = records.delete(&manifest.key(index));
    }
}
pub fn commit(records: &impl Records, expected: &Baseline, bytes: &[u8]) -> Result<Baseline> {
    if bytes.len() > LIMIT {
        return Err("secure_store_capacity".into());
    }
    if baseline(records)? != *expected {
        return Err(CONFLICT.into());
    }
    let old = expected
        .manifest
        .as_deref()
        .map(Manifest::decode)
        .transpose()?;
    records.prune(old.as_ref().map(|m| m.generation.as_str()))?;
    let generation = records.generation()?;
    if !generation_valid(&generation) || old.as_ref().is_some_and(|m| m.generation == generation) {
        return Err("secure_store_generation_invalid".into());
    }
    let candidate = Manifest {
        generation,
        length: bytes.len(),
        parts: bytes.len().div_ceil(RECORD_LIMIT),
        digest: hex(records.digest(bytes)?),
    };
    // Never overwrite a different owner's staged generation, even on a random-id collision.
    for index in 0..candidate.parts {
        if records.read(&candidate.key(index))?.is_some() {
            return Err("secure_store_generation_collision".into());
        }
    }
    for (index, chunk) in bytes.chunks(RECORD_LIMIT).enumerate() {
        let staged = records.write(&candidate.key(index), chunk).and_then(|_| {
            if records.read(&candidate.key(index))?.as_deref() != Some(chunk) {
                return Err("secure_store_verify_failed".into());
            }
            Ok(())
        });
        if let Err(error) = staged {
            if baseline(records).ok().as_ref() != Some(expected) {
                return Err(UNKNOWN.into());
            }
            discard(records, &candidate);
            return Err(error);
        }
    }
    let encoded = candidate.encode();
    let result = records.write(MANIFEST, &encoded);
    // CredWrite's return alone is insufficient for an uncertain system failure. Read back the
    // sole commit point under the same native mutex; never delete candidate bytes if unknown.
    let current = baseline(records).map_err(|_| UNKNOWN)?;
    if current.manifest.as_deref() == Some(&encoded) {
        if assemble(records, &candidate).map_or(true, |v| v != bytes) {
            return Err(UNKNOWN.into());
        }
        if let Some(old) = old {
            discard(records, &old);
        }
        // Legacy is removed only after v2 is verified committed. Failed cleanup is not failed commit.
        let _ = records.delete(LEGACY);
        return Ok(current);
    }
    if current == *expected {
        discard(records, &candidate);
        return Err(result
            .err()
            .unwrap_or_else(|| "secure_store_verify_failed".into()));
    }
    Err(UNKNOWN.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        cell::{Cell, RefCell},
        collections::{BTreeMap, hash_map::DefaultHasher},
        hash::{Hash, Hasher},
    };
    #[derive(Default)]
    struct Memory {
        data: RefCell<BTreeMap<String, Vec<u8>>>,
        serial: Cell<usize>,
        mode: Cell<u8>,
        writes: Cell<usize>,
    }
    impl Records for Memory {
        fn read(&self, key: &str) -> Result<Option<Vec<u8>>> {
            if key == MANIFEST && self.mode.get() == 4 {
                return Err("synthetic_read_failure".into());
            }
            Ok(self.data.borrow().get(key).cloned())
        }
        fn write(&self, key: &str, bytes: &[u8]) -> Result<()> {
            assert!(bytes.len() <= RECORD_LIMIT);
            self.writes.set(self.writes.get() + 1);
            if self.mode.get() == 1 && key.ends_with("/1") {
                return Err("synthetic_chunk_failure".into());
            }
            if key == MANIFEST && self.mode.get() == 2 {
                return Err("synthetic_manifest_failure".into());
            }
            self.data.borrow_mut().insert(key.into(), bytes.into());
            if key == MANIFEST && self.mode.get() == 3 {
                return Err("synthetic_error_after_commit".into());
            }
            if key == MANIFEST && self.mode.get() == 5 {
                self.mode.set(4);
                return Err("synthetic_unknown_commit".into());
            }
            Ok(())
        }
        fn delete(&self, key: &str) -> Result<()> {
            self.data.borrow_mut().remove(key);
            Ok(())
        }
        fn digest(&self, bytes: &[u8]) -> Result<[u8; 32]> {
            // Transaction-test stand-in only. Windows production uses system CNG SHA-256.
            let mut hash = DefaultHasher::new();
            bytes.hash(&mut hash);
            let mut output = [0; 32];
            for chunk in output.chunks_mut(8) {
                chunk.copy_from_slice(&hash.finish().to_le_bytes());
            }
            Ok(output)
        }
        fn generation(&self) -> Result<String> {
            let serial = self.serial.get() + 1;
            self.serial.set(serial);
            Ok(format!("00000000-0000-4000-8000-{serial:012x}"))
        }
        fn prune(&self, keep: Option<&str>) -> Result<()> {
            self.data.borrow_mut().retain(|key, _| {
                !key.starts_with("connections-v2/chunk/")
                    || keep.is_some_and(|g| key.starts_with(&format!("connections-v2/chunk/{g}/")))
            });
            Ok(())
        }
    }
    #[test]
    fn secure_record_capacity_roundtrip_includes_full_64k_and_rejects_overflow_without_change() {
        let store = Memory::default();
        let (_, mut base) = load(&store).unwrap();
        for size in [0, 2560, 2561, 65536] {
            let bytes = vec![b'x'; size];
            base = commit(&store, &base, &bytes).unwrap();
            assert_eq!(load(&store).unwrap().0, Some(bytes));
            assert!(
                store
                    .data
                    .borrow()
                    .values()
                    .all(|v| v.len() <= RECORD_LIMIT)
            );
        }
        let before = store.data.borrow().clone();
        assert!(commit(&store, &base, &vec![0; 65537]).is_err());
        assert_eq!(*store.data.borrow(), before);
    }
    #[test]
    fn chunk_or_manifest_failure_preserves_prior_and_error_after_proven_commit_is_success() {
        let store = Memory::default();
        let (_, base) = load(&store).unwrap();
        let base = commit(&store, &base, b"prior").unwrap();
        for mode in [1, 2] {
            store.mode.set(mode);
            assert!(commit(&store, &base, &vec![b'n'; 6000]).is_err());
            assert_eq!(load(&store).unwrap().0, Some(b"prior".to_vec()));
        }
        store.mode.set(3);
        let base = commit(&store, &base, &vec![b'n'; 6000]).unwrap();
        assert_eq!(load(&store).unwrap().1, base);
    }
    #[test]
    fn unknown_commit_is_not_ordinary_rollback_and_restart_reads_only_committed_generation() {
        let store = Memory::default();
        let (_, base) = load(&store).unwrap();
        let base = commit(&store, &base, b"prior").unwrap();
        store.mode.set(5);
        assert_eq!(commit(&store, &base, b"candidate").unwrap_err(), UNKNOWN);
        store.mode.set(0);
        assert_eq!(load(&store).unwrap().0, Some(b"candidate".to_vec()));
        assert_eq!(commit(&store, &base, b"stale actor").unwrap_err(), CONFLICT);
    }
    #[test]
    fn missing_or_corrupt_chunks_never_fall_back_to_legacy_or_an_orphan_generation() {
        let store = Memory::default();
        store
            .data
            .borrow_mut()
            .insert(LEGACY.into(), b"legacy".to_vec());
        let (_, base) = load(&store).unwrap();
        let next = commit(&store, &base, b"current").unwrap();
        let manifest = Manifest::decode(next.manifest.as_ref().unwrap()).unwrap();
        store
            .data
            .borrow_mut()
            .insert(LEGACY.into(), b"legacy".to_vec());
        store
            .data
            .borrow_mut()
            .insert(manifest.key(0), b"corrupt".to_vec());
        assert!(load(&store).is_err());
        store.data.borrow_mut().remove(&manifest.key(0));
        assert!(load(&store).is_err());
    }
    #[test]
    fn legacy_migration_is_commit_last_and_stale_writers_never_overwrite_new_authority() {
        let store = Memory::default();
        store
            .data
            .borrow_mut()
            .insert(LEGACY.into(), b"legacy".to_vec());
        let (_, base) = load(&store).unwrap();
        store.mode.set(2);
        assert!(commit(&store, &base, &vec![b'n'; 65536]).is_err());
        assert_eq!(load(&store).unwrap().0, Some(b"legacy".to_vec()));
        store.mode.set(0);
        commit(&store, &base, &vec![b'n'; 65536]).unwrap();
        assert!(!store.data.borrow().contains_key(LEGACY));
        let writes = store.writes.get();
        assert_eq!(commit(&store, &base, b"stale").unwrap_err(), CONFLICT);
        assert_eq!(store.writes.get(), writes);
    }
}

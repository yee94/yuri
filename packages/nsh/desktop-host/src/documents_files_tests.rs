use super::*;
use std::{fs, path::PathBuf};
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "document-stage-test-{}",
            crate::vault::id().unwrap()
        ));
        fs::create_dir(&path).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        Self(path)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn bounded_stream_and_slice_share_same_grant_stage_commit_and_private_cleanup() {
    let temp = Temp::new();
    let dest = temp.0.join("selected.bin");
    fs::write(&dest, b"prior").unwrap();
    let grant = Grant::selected(&dest).unwrap();
    let mut stage = grant.begin().unwrap();
    let content = "中文\r\n"
        .as_bytes()
        .iter()
        .copied()
        .chain([0, 255, 128])
        .collect::<Vec<_>>();
    for chunk in content.chunks(2) {
        stage.append(chunk).unwrap();
    }
    assert_eq!(stage.written, content.len() as u64);
    assert_eq!(fs::read(&dest).unwrap(), b"prior");
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            stage.file.metadata().unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    stage.seal().unwrap();
    grant.commit(&mut stage).unwrap();
    assert!(stage.append(b"late").is_err());
    assert!(stage.rewind(0).is_err());
    assert!(grant.commit(&mut stage).is_err());
    assert_eq!(fs::read(&dest).unwrap(), content);
    drop(stage);
    assert_eq!(fs::read_dir(&temp.0).unwrap().count(), 1);
}
#[test]
fn interrupted_stream_retains_prefix_can_only_truncate_not_expand_and_never_touches_prior() {
    let temp = Temp::new();
    let dest = temp.0.join("selected.bin");
    fs::write(&dest, b"prior").unwrap();
    let grant = Grant::selected(&dest).unwrap();
    let mut stage = grant.begin().unwrap();
    assert!(stage.append(&vec![0; 65537]).is_err());
    assert_eq!(stage.written, 0);
    stage.append(&[0, 255, 1]).unwrap();
    assert!(stage.rewind(4).is_err());
    stage.rewind(2).unwrap();
    stage.append(&[13, 10]).unwrap();
    stage.seal().unwrap();
    assert!(grant.verify(&[0, 255, 13, 10]).is_ok_and(|same| !same));
    assert_eq!(fs::read_dir(&temp.0).unwrap().count(), 2);
    drop(stage);
    assert_eq!(fs::read(&dest).unwrap(), b"prior");
    assert_eq!(fs::read_dir(&temp.0).unwrap().count(), 1);
}
#[test]
fn unknown_rename_cannot_be_replayed_and_equal_bytes_on_another_file_are_not_a_receipt() {
    let temp = Temp::new();
    let dest = temp.0.join("selected.bin");
    fs::write(&dest, b"bytes").unwrap();
    let grant = Grant::selected(&dest).unwrap();
    let mut stage = grant.stage(b"bytes", || true).unwrap();
    // Inject uncertainty before publication. Content equality at the prior inode
    // is NOT acknowledgement of this Stage, and commit cannot be called again.
    stage.attempted = true;
    assert!(!grant.observes_stage(&stage).unwrap());
    assert!(!grant.confirm_stage(&mut stage, || true).unwrap());
    assert_eq!(
        grant.commit(&mut stage).unwrap_err(),
        "documents_stage_state"
    );
    drop(stage);
    assert_eq!(fs::read(&dest).unwrap(), b"bytes");
}
#[test]
fn original_published_stage_requires_new_real_barriers_and_current_authority_for_confirmation() {
    let temp = Temp::new();
    let dest = temp.0.join("selected.bin");
    let grant = Grant::selected(&dest).unwrap();
    let mut stage = grant.stage(b"bytes", || true).unwrap();
    grant.commit(&mut stage).unwrap();
    assert!(grant.observes_stage(&stage).unwrap());
    assert!(!grant.confirm_stage(&mut stage, || false).unwrap());
    #[cfg(target_os = "macos")]
    assert!(grant.confirm_stage(&mut stage, || true).unwrap());
    // Windows may refuse FlushFileBuffers on a directory handle. In that case
    // its caller must keep Unknown; no platform-specific success is invented.
    #[cfg(target_os = "windows")]
    {
        let _ = grant.confirm_stage(&mut stage, || true);
    }
    let replacement = temp.0.join("foreign.bin");
    fs::write(&replacement, b"bytes").unwrap();
    fs::rename(&replacement, &dest).unwrap();
    assert!(!grant.observes_stage(&stage).unwrap());
    assert!(!grant.confirm_stage(&mut stage, || true).unwrap());
    assert_eq!(fs::read(&dest).unwrap(), b"bytes");
}
#[cfg(target_os = "macos")]
#[test]
fn switched_stage_name_cannot_commit_or_be_deleted_as_our_partial() {
    let temp = Temp::new();
    let dest = temp.0.join("selected.bin");
    fs::write(&dest, b"prior").unwrap();
    let grant = Grant::selected(&dest).unwrap();
    let mut stage = grant.stage(b"ours", || true).unwrap();
    let name = temp.0.join(&stage.name);
    let retained = temp.0.join("retained-original");
    fs::rename(&name, &retained).unwrap();
    fs::write(&name, b"foreign").unwrap();
    assert_eq!(
        grant.commit(&mut stage).unwrap_err(),
        "documents_stage_changed"
    );
    drop(stage);
    assert_eq!(fs::read(&name).unwrap(), b"foreign");
    assert_eq!(fs::read(&dest).unwrap(), b"prior");
}

//! Host-chosen local receipt directory; no JS path, Vault or receipt-body logging.
//! On macOS every ancestor is opened without following links. Keep the directory
//! handles for the Store lifetime; never chmod an unfamiliar existing directory.
use crate::{notifications, policy::Result};
use serde_json::Value;

pub(crate) fn allowed_leaf(name: &str) -> bool {
    [
        "notification-receipts",
        "native-preferences",
        "window-state",
        "terminal-catalog-primary",
    ]
    .contains(&name)
        || name.strip_prefix("window-terminal-").is_some_and(|key| {
            key.len() == 64
                && key
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
}
pub(crate) fn terminal_catalog(namespace: &str) -> Result<notifications::Store> {
    store_for(&if namespace == "primary" {
        "terminal-catalog-primary".into()
    } else {
        format!("window-terminal-{namespace}")
    })
}

#[cfg(target_os = "windows")]
#[path = "private_directory_windows.rs"]
pub(crate) mod windows;
#[cfg(target_os = "windows")]
pub fn native() -> Result<notifications::Store> {
    store_for("notification-receipts")
}
#[cfg(target_os = "windows")]
pub(crate) fn store_for(name: &str) -> Result<notifications::Store> {
    native_granted(name).map(|(_, store)| store)
}
#[cfg(target_os = "windows")]
pub(crate) fn native_granted(name: &str) -> Result<(std::path::PathBuf, notifications::Store)> {
    let grant = windows::native(name)?;
    let path = grant.path.clone();
    let store = if name == "terminal-catalog-primary" || name.starts_with("window-terminal-") {
        notifications::store::FileStore::named(&grant.path, "terminal-catalog")?
    } else {
        notifications::store::FileStore::in_private_directory(&grant.path)?
    };
    struct Granted {
        store: notifications::store::FileStore,
        _grant: windows::Grant,
    }
    impl notifications::store::Store for Granted {
        fn load(&mut self) -> Result<Option<Value>> {
            self.store.load()
        }
        fn commit(&mut self, next: &Value) -> Result<()> {
            self.store.commit(next)
        }
    }
    Ok((
        path,
        Box::new(Granted {
            store,
            _grant: grant,
        }),
    ))
}

#[cfg(target_os = "macos")]
pub fn native() -> Result<notifications::Store> {
    store_for("notification-receipts")
}
#[cfg(target_os = "macos")]
pub(crate) fn store_for(name: &str) -> Result<notifications::Store> {
    native_granted(name).map(|(_, store)| store)
}
#[cfg(target_os = "macos")]
pub(crate) fn native_granted(name: &str) -> Result<(std::path::PathBuf, notifications::Store)> {
    use nsh_platform_macos::objc2_foundation::NSString;
    unsafe extern "C" {
        #[link_name = "NSHomeDirectory"]
        fn home_directory() -> *mut NSString;
    }
    // Foundation's native home authority, not HOME or a bundle-supplied path.
    let home = unsafe { nsh_platform_macos::objc2::rc::Retained::retain(home_directory()) }
        .ok_or("notification_private_directory_unsafe")?;
    secure_macos_granted(&std::path::PathBuf::from(home.to_string()), name)
}

#[cfg(all(test, target_os = "macos"))]
fn secure_macos(home: &std::path::Path, name: &str) -> Result<notifications::Store> {
    secure_macos_granted(home, name).map(|(_, store)| store)
}
#[cfg(all(test, target_os = "macos"))]
pub(crate) fn granted_in_synthetic_home(
    home: &std::path::Path,
    name: &str,
) -> Result<(std::path::PathBuf, notifications::Store)> {
    secure_macos_granted(home, name)
}
#[cfg(target_os = "macos")]
fn secure_macos_granted(
    home: &std::path::Path,
    name: &str,
) -> Result<(std::path::PathBuf, notifications::Store)> {
    use std::{
        ffi::CString,
        fs::File,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::{ffi::OsStrExt, fs::MetadataExt},
        },
        path::Component,
    };
    unsafe extern "C" {
        fn openat(fd: i32, path: *const std::ffi::c_char, flags: i32, ...) -> i32;
        fn mkdirat(fd: i32, path: *const std::ffi::c_char, mode: u32) -> i32;
        fn geteuid() -> u32;
        fn fgetattrlist(
            fd: i32,
            attributes: *const Attributes,
            buffer: *mut std::ffi::c_void,
            size: usize,
            options: std::ffi::c_ulong,
        ) -> i32;
        fn acl_get_fd_np(fd: i32, kind: i32) -> *mut std::ffi::c_void;
        fn acl_get_entry(
            acl: *mut std::ffi::c_void,
            entry_id: i32,
            entry: *mut *mut std::ffi::c_void,
        ) -> i32;
        fn acl_get_tag_type(entry: *mut std::ffi::c_void, tag: *mut i32) -> i32;
        fn acl_free(value: *mut std::ffi::c_void) -> i32;
    }
    #[repr(C)]
    struct Attributes {
        count: u16,
        reserved: u16,
        common: u32,
        volume: u32,
        directory: u32,
        file: u32,
        fork: u32,
    }
    let denied = || "notification_private_directory_unsafe".to_owned();
    if !allowed_leaf(name) {
        return Err(denied());
    }
    if !home.is_absolute() || home == std::path::Path::new("/") {
        return Err(denied());
    }
    let uid = unsafe { geteuid() };
    let mut parents = vec![File::open("/").map_err(|_| denied())?];
    let mut path = std::path::PathBuf::from("/");
    let names: Vec<_> = home
        .components()
        .skip(1)
        .map(|part| match part {
            Component::Normal(name) => Ok(name.to_owned()),
            _ => Err(denied()),
        })
        .collect::<Result<_>>()?;
    let mut leaves = vec![
        ("Library".into(), false, false),
        ("Application Support".into(), true, false),
        (
            "com.yee94.yuri.nsh".into(),
            true,
            name == "terminal-catalog-primary",
        ),
    ];
    if name != "terminal-catalog-primary" {
        leaves.push((name.into(), true, true));
    }
    for (name, create, private) in names.into_iter().map(|n| (n, false, false)).chain(leaves) {
        let c = CString::new(name.as_bytes()).map_err(|_| denied())?;
        let parent = parents.last().ok_or_else(denied)?;
        if create {
            let result = unsafe { mkdirat(parent.as_raw_fd(), c.as_ptr(), 0o700) };
            if result != 0
                && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists
            {
                return Err(denied());
            }
            parent.sync_all().map_err(|_| denied())?;
        }
        // Darwin O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC. fstat checks the opened object.
        let fd = unsafe { openat(parent.as_raw_fd(), c.as_ptr(), 0x100000 | 0x100 | 0x1000000) };
        if fd < 0 {
            return Err(denied());
        }
        let file = unsafe { File::from_raw_fd(fd) };
        let metadata = file.metadata().map_err(|_| denied())?;
        if !metadata.is_dir()
            || ![0, uid].contains(&metadata.uid())
            || metadata.mode() & 0o022 != 0
            || (private && (metadata.uid() != uid || metadata.mode() & 0o077 != 0))
        {
            return Err(denied());
        }
        {
            // ATTR_CMN_EXTENDED_SECURITY returns an attrreference of length zero
            // for authoritative no-ACL. Reject every ACL on the private leaf; never
            // interpret an ACL read error as empty/owner-only success.
            let attributes = Attributes {
                count: 5,
                reserved: 0,
                common: 0x00400000,
                volume: 0,
                directory: 0,
                file: 0,
                fork: 0,
            };
            let mut security = [0u32; 4096];
            if unsafe {
                fgetattrlist(
                    file.as_raw_fd(),
                    &attributes,
                    security.as_mut_ptr().cast(),
                    std::mem::size_of_val(&security),
                    4,
                )
            } != 0
                || security[0] < 12
                || security[0] as usize > std::mem::size_of_val(&security)
            {
                return Err(denied());
            }
            if security[2] != 0 {
                if private {
                    return Err(denied());
                }
                // Standard home directories may carry deny-delete ACLs. Permit only
                // deny entries on ancestors; an extra allow must never bypass the
                // POSIX no-other-writer check or allow replacing a granted parent.
                let acl = unsafe { acl_get_fd_np(file.as_raw_fd(), 0x100) };
                if acl.is_null() {
                    return Err(denied());
                }
                let checked = (|| -> Result<()> {
                    for index in 0..=169 {
                        let mut entry = std::ptr::null_mut();
                        if unsafe {
                            acl_get_entry(acl, if index == 0 { 0 } else { -1 }, &mut entry)
                        } != 0
                        {
                            return if std::io::Error::last_os_error().raw_os_error() == Some(22) {
                                Ok(())
                            } else {
                                Err(denied())
                            };
                        }
                        let mut tag = 0;
                        if index == 169
                            || unsafe { acl_get_tag_type(entry, &mut tag) } != 0
                            || tag != 2
                        {
                            return Err(denied());
                        }
                    }
                    Err(denied())
                })();
                unsafe {
                    acl_free(acl);
                }
                checked?;
            }
        }
        path.push(name);
        parents.push(file);
    }
    let store = if name == "terminal-catalog-primary" || name.starts_with("window-terminal-") {
        notifications::store::FileStore::named(&path, "terminal-catalog")?
    } else {
        notifications::store::FileStore::in_private_directory(&path)?
    };
    Ok((
        path,
        Box::new(Granted {
            store,
            _parents: parents,
        }),
    ))
}

#[cfg(target_os = "macos")]
struct Granted {
    store: notifications::store::FileStore,
    _parents: Vec<std::fs::File>,
}
#[cfg(target_os = "macos")]
impl notifications::store::Store for Granted {
    fn load(&mut self) -> Result<Option<Value>> {
        self.store.load()
    }
    fn commit(&mut self, next: &Value) -> Result<()> {
        self.store.commit(next)
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::{
        fs,
        os::unix::fs::{DirBuilderExt, symlink},
    };
    #[test]
    fn synthetic_native_grant_rejects_link_ancestors_and_never_repairs_untrusted_permissions() {
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "nsh-notification-grant-{}",
            crate::vault::id().unwrap()
        ));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        fs::DirBuilder::new()
            .mode(0o700)
            .create(root.join("Library"))
            .unwrap();
        // The test uses only its own temporary tree; never calls native home discovery.
        let mut store = secure_macos(&root, "notification-receipts").unwrap();
        store
            .commit(&serde_json::json!({"v":1,"rows":[],"retirements":[]}))
            .unwrap();
        assert!(store.load().unwrap().is_some());
        assert!(
            secure_macos(&root, "notification-receipts").is_err(),
            "exclusive Store lock"
        );
        drop(store);
        let app = root.join("Library/Application Support/com.yee94.yuri.nsh");
        fs::remove_file(app.join("notification-receipts/desktop-notification-receipts.json"))
            .unwrap();
        fs::remove_file(app.join("notification-receipts/desktop-notification-receipts.lock"))
            .unwrap();
        fs::remove_dir(app.join("notification-receipts")).unwrap();
        fs::remove_dir(&app).unwrap();
        symlink(&root, &app).unwrap();
        assert!(secure_macos(&root, "notification-receipts").is_err());
        fs::remove_file(&app).unwrap();
        fs::DirBuilder::new().mode(0o755).create(&app).unwrap();
        fs::DirBuilder::new()
            .mode(0o755)
            .create(app.join("notification-receipts"))
            .unwrap();
        assert!(secure_macos(&root, "notification-receipts").is_err());
        fs::remove_dir(app.join("notification-receipts")).unwrap();
        fs::remove_dir(app).unwrap();
        fs::remove_dir(root.join("Library/Application Support")).unwrap();
        fs::remove_dir(root.join("Library")).unwrap();
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn window_state_grant_exports_exact_pinned_leaf_and_has_independent_lock_and_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("nsh-window-grant-{}", crate::vault::id().unwrap()));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        fs::DirBuilder::new()
            .mode(0o700)
            .create(root.join("Library"))
            .unwrap();
        let (path, store) = secure_macos_granted(&root, "window-state").unwrap();
        let app = root.join("Library/Application Support/com.yee94.yuri.nsh");
        assert_eq!(path, app.join("window-state"));
        assert!(secure_macos_granted(&root, "window-state").is_err());
        let mut receipts = secure_macos(&root, "notification-receipts").unwrap();
        receipts
            .commit(&serde_json::json!({"fixture":"notification-only"}))
            .unwrap();
        let mut owner = crate::window_state::Owner::from_granted_store(&path, store).unwrap();
        owner.finish_restore().unwrap();
        owner
            .stage(
                0,
                vec![crate::window_persistence::tests::record("primary")],
                std::time::Instant::now(),
            )
            .unwrap();
        owner.flush().unwrap();
        assert_eq!(
            receipts.load().unwrap().unwrap()["fixture"],
            "notification-only"
        );
        assert_eq!(
            fs::metadata(path.join("desktop-notification-receipts.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        drop(owner);
        drop(receipts);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(secure_macos_granted(&root, "window-state").is_err());
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o755,
            "no permissions repair"
        );
        for leaf in ["window-state", "notification-receipts"] {
            for name in [
                "desktop-notification-receipts.json",
                "desktop-notification-receipts.lock",
            ] {
                fs::remove_file(app.join(leaf).join(name)).unwrap();
            }
            fs::remove_dir(app.join(leaf)).unwrap();
        }
        symlink(&root, &path).unwrap();
        assert!(secure_macos_granted(&root, "window-state").is_err());
        fs::remove_file(path).unwrap();
        fs::remove_dir(app).unwrap();
        fs::remove_dir(root.join("Library/Application Support")).unwrap();
        fs::remove_dir(root.join("Library")).unwrap();
        fs::remove_dir(root).unwrap();
    }
}

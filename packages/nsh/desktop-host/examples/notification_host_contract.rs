//! Host-owned preparation tests only; not installed in the production runner yet.
//! Never calls native home discovery, Native driver, application initialization or Vault.
#![allow(dead_code)]
#[path = "../src/notification_identity_windows.rs"]
mod notification_identity_windows;
#[cfg(target_os = "macos")]
#[path = "../src/notification_store_grant.rs"]
mod notification_store_grant;
#[path = "../src/notifications.rs"]
mod notifications;
#[path = "../src/policy.rs"]
mod policy;
#[path = "../src/private_directory_windows.rs"]
mod private_directory_windows;
#[path = "../src/vault.rs"]
mod vault;
#[path = "../src/notifications_windows.rs"]
mod windows_source;
fn main() {}

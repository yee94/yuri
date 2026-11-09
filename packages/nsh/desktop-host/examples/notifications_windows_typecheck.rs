//! Frontend/pure-layout harness for the REAL Windows source. Main is inert; never construct
//! windows_source::Native on Darwin. Windows DLL link attributes only apply on Windows.
#![allow(dead_code)]
#[path = "../src/notifications.rs"]
mod notifications;
#[path = "../src/policy.rs"]
mod policy;
#[path = "../src/vault.rs"]
mod vault;
#[path = "../src/notifications_windows.rs"]
mod windows_source;
fn main() {}

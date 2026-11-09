//! Synthetic-only contract harness. Never constructs a native OS driver or opens a user window.
#![allow(dead_code)]
#[path = "../src/notifications.rs"]
mod notifications;
#[path = "../src/policy.rs"]
mod policy;
#[path = "../src/vault.rs"]
mod vault;
fn main() {}

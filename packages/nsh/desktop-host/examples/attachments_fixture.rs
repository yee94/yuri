//! Compile/run tests without opening a window, restoring connections, or accessing a Vault.
#![allow(dead_code)]
#[path = "../src/attachments.rs"]
mod attachments;
#[path = "../src/file_download_attachment_validation.rs"]
mod file_download_attachment_validation;
#[path = "../src/policy.rs"]
mod policy;
#[path = "../src/vault.rs"]
mod vault;
fn main() {}

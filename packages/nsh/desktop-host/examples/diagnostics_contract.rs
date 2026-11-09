//! Metadata-only synthetic diagnostics contract; never opens a chooser or restores Vault.
//! Integration instructions: ../desktop-diagnostics-DOCUMENTATION.md.
#![allow(dead_code)]
#[path = "../src/diagnostics.rs"]
mod diagnostics;
#[path = "../src/policy.rs"]
mod policy;
#[path = "../src/vault.rs"]
mod vault;
fn main() {}

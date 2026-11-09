//! Synthetic source + synthetic OS grant; never runs native UI or user Host.
#![allow(dead_code)]
#[path = "../src/file_journal_download.rs"]
mod download;
#[path = "../src/policy.rs"]
mod policy;
#[path = "../src/vault.rs"]
mod vault;
fn main() {}

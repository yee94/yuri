//! V2 bounded download bridge; synthetic Network/grants, never system UI.
//! Uses the production documents streaming adapter; actor capture is injected.
#![allow(dead_code)]
#[path = "../src/file_download.rs"]
mod download;
#[path = "../src/file_download_attachment_validation.rs"]
mod file_download_attachment_validation;
#[path = "../src/policy.rs"]
mod policy;
#[path = "../src/vault.rs"]
mod vault;
fn main() {}

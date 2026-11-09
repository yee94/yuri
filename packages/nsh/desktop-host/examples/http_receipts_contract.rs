//! Standalone pure receipt tests: no actor/Host registration, Vault, Network, task or system UI.
//! cargo test --manifest-path packages/nsh/desktop-host/Cargo.toml --example http_receipts_contract
#![allow(dead_code)]
#[path = "../src/http_receipts.rs"]
mod http_receipts;
#[path = "../src/policy.rs"]
mod policy;
fn main() {}

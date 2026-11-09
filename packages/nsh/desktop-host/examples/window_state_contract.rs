//! Inert executable / synthetic disk tests. No Vault reads, native window, or home discovery.
#![allow(dead_code)]
#[path = "../src/policy.rs"]
mod policy;
#[path = "../src/vault.rs"]
mod vault;
// Reuse the REAL receipt Store without constructing notification delivery/OS drivers.
#[path = "../src/notifications.rs"]
mod notifications;
#[path = "../src/window_geometry.rs"]
mod window_geometry;
#[path = "../src/window_state.rs"]
mod window_state;
fn main() {}

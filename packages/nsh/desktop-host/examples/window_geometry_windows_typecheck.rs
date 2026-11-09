//! Real Win32 source + ABI layouts; inert main, NO Windows runtime claims on Darwin.
#![allow(dead_code)]
#[path = "../src/policy.rs"]
mod policy;
#[path = "../src/window_geometry.rs"]
mod window_geometry;
#[path = "../src/window_geometry_windows.rs"]
mod windows_source;
fn main() {}

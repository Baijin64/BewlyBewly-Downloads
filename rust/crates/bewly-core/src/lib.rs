//! Pure domain logic shared by every platform shell.
//!
//! This crate must stay free of IO, async runtimes, databases and platform APIs:
//! it is the layer reused by the desktop service, the mobile FFI and the tests.

pub mod formats;
pub mod ids;
pub mod naming;

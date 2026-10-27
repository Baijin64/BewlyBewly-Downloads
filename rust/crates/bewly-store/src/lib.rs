//! Durable state, kept byte-compatible with `native/core.mjs` so an upgrade can
//! fall back to the Node build without losing or misreading a single row.

pub mod local_storage;
pub mod store;

pub use store::{Store, StoreError};

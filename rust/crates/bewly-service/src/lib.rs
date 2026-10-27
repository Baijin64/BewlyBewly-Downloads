//! Service layer: settings, tasks, snapshot and the loopback RPC server.

pub mod health;
pub mod server;
pub mod settings;
pub mod tasks;

pub use server::run;

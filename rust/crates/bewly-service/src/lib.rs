//! Service layer: settings, tasks, snapshot and the loopback RPC server.

pub mod health;
pub mod lifetime;
pub mod server;
pub mod settings;
pub mod tasks;
pub mod tools;

pub use server::run;

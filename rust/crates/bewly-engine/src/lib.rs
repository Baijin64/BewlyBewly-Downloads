//! Download engine.
//!
//! The only piece implemented so far is the legacy `*.aria2` control-file reader:
//! it decides whether an interrupted task can resume or must restart from zero.

pub mod aria2_control;

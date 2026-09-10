//! Additive Rust local executor host. Speaks HTTP Worker protocol v1.
//! Orchestrator/Gateway/Frontend stay TypeScript.

pub mod binding;
pub mod config;
pub mod host;
pub mod output;
pub mod protocol;
pub mod state;
pub mod supervisor;

pub use config::{parse_host_config, HostConfig};
pub use host::start_host;

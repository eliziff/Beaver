//! Legal structure and PDF operations for Authorities and Beaver.
//! `engine` holds every operation and `dispatch` names them (the local A2AJ store is legal_structure_features'
//! a2aj_store); `node` binds that one call for Node-API and `wasi` for the browser's WebAssembly runtime.

mod dispatch;
pub mod engine;
pub mod formats;
#[cfg(not(target_arch = "wasm32"))]
mod node;
pub mod source;
#[cfg(target_arch = "wasm32")]
mod wasi;

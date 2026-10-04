//! Legal structure and PDF operations for Authorities and Beaver.
//! `engine` holds every operation and `dispatch` names them; `node` binds that one
//! call for Node-API and `wasi` for the browser's WebAssembly runtime.

mod dispatch;
pub mod engine;
#[cfg(not(target_arch = "wasm32"))]
mod node;
#[cfg(target_arch = "wasm32")]
mod wasi;

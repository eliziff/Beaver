//! Legal structure and PDF operations for Authorities and Beaver.
//! `engine` holds every operation; `node` binds it for Node-API and `wasi`
//! binds the same operations for the browser's WebAssembly runtime.

pub mod engine;
#[cfg(not(target_arch = "wasm32"))]
mod node;
#[cfg(target_arch = "wasm32")]
mod wasi;

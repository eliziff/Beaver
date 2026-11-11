//! Package-time declarations from the engine's Rust wire types (`bindings`), written to shared/engine-types; never
//! part of a runtime build.

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../shared/engine-types");
    legal_structure_node::bindings::export_types(&directory)?;
    Ok(())
}

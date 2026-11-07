//! The aligner's code hash (ALIGNER_CODE): what a record is stamped with, so that only a change to this crate makes a
//! record stale.
use sha2::{Digest, Sha256};
use std::{env, fs, path::Path};

fn main() {
    let root = env::var("CARGO_MANIFEST_DIR").unwrap();
    let root = Path::new(&root);
    let mut files: Vec<_> = fs::read_dir(root.join("src")).unwrap().map(|entry| entry.unwrap().path()).collect();
    files.sort();
    files.extend([root.join("build.rs"), root.join("Cargo.toml")]);
    let mut hash = Sha256::new();
    for file in &files {
        hash.update(fs::read(file).unwrap());
    }
    let hex: String = hash.finalize().iter().take(8).map(|byte| format!("{byte:02x}")).collect();
    println!("cargo:rustc-env=ALIGNER_CODE={hex}");
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=Cargo.toml");
}

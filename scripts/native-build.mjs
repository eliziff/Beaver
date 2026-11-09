import { cargo } from "./cargo.mjs";

const flags = process.argv.slice(2), release = flags.includes("--release");
if (flags.some(flag => flag !== "--release") || new Set(flags).size !== flags.length)
    throw new Error("Use native:build [--release]; Cargo overrides are not accepted");
cargo(["rustc", "--lib", "--crate-type", "cdylib", "--locked", "--offline", ...release ? ["--release"] : [],
    "--manifest-path", "native/legal-structure-node/Cargo.toml"]);

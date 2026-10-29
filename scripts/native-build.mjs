import { cargo } from "./cargo.mjs";

const flags = process.argv.slice(2), release = flags.includes("--release"), diagnostics = flags.includes("--diagnostics");
if (flags.some(flag => flag !== "--release" && flag !== "--diagnostics") || new Set(flags).size !== flags.length)
    throw new Error("Use native:build [--release] [--diagnostics]; Cargo overrides are not accepted");
cargo(["build", "--locked", "--offline", ...release ? ["--release"] : [],
    ...diagnostics ? ["--features", "diagnostics"] : [],
    "--manifest-path", "native/legal-structure-node/Cargo.toml"]);

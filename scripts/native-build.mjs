import "./background-work.mjs";
import { spawn } from "node:child_process";
import { constants, setPriority } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const release = process.argv[2] === "--release";
if (process.argv.length !== (release ? 3 : 2)) throw new Error("Use native:build [--release]; Cargo overrides are not accepted");
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith("CARGO_PROFILE_") && !(key.startsWith("CARGO_TARGET_") && /_(RUSTFLAGS|LINKER)$/.test(key)) &&
    !["RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS",
        "CARGO_INCREMENTAL", "CARGO_BUILD_RUSTFLAGS", "CARGO_BUILD_TARGET",
        "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER"].includes(key)));
env.CARGO_TARGET_DIR = path.join(root, "native/legal-structure-node/target");
const child = spawn("cargo", ["build", "--locked", "--offline", ...release ? ["--release"] : [],
    "--manifest-path", "native/legal-structure-node/Cargo.toml"], { cwd: root, env, stdio: "inherit" });
// The build yields to interactive work.
child.once("spawn", () => setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL));
child.once("error", error => { console.error(error.message); process.exitCode = 1; });
child.once("exit", code => { process.exitCode = code ?? 1; });

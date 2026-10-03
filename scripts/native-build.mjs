import "./background-work.mjs";
import { spawn } from "node:child_process";
import { constants, setPriority } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
if (process.argv.length !== 2) throw new Error("native:build takes no Cargo overrides");
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith("CARGO_PROFILE_") && !["RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS",
        "CARGO_INCREMENTAL", "CARGO_BUILD_RUSTFLAGS", "CARGO_BUILD_TARGET",
        "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER"].includes(key)));
env.CARGO_TARGET_DIR = path.join(root, "native/legal-structure-node/target");
const child = spawn("cargo", ["build", "--locked", "--offline", "--release", "--jobs", "1",
    "--manifest-path", "native/legal-structure-node/Cargo.toml"], { cwd: root, env, stdio: "inherit" });
child.once("spawn", () => setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL));
child.once("error", error => { console.error(error.message); process.exitCode = 1; });
child.once("exit", code => { process.exitCode = code ?? 1; });

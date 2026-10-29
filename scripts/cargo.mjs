// Cargo for this workspace, as every build of it runs: node scripts/cargo.mjs <cargo arguments>. The builds share one
// target folder, and Cargo names a crate's build without its compiler flags, so a build with other flags (a plain
// `cargo build` beside the addon's) replaces every shared crate's build and the next one rebuilds them all.
import "./background-work.mjs";
import { spawn } from "node:child_process";
import { constants, homedir, setPriority } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(import.meta.dirname, "..");

/** The environment every build of the workspace runs in: one job, no flags of the caller's, paths remapped. */
export function cargoEnv() {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !key.startsWith("CARGO_PROFILE_") && !(key.startsWith("CARGO_TARGET_") && /_(RUSTFLAGS|LINKER)$/.test(key)) &&
        !["RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS",
            "CARGO_INCREMENTAL", "CARGO_BUILD_RUSTFLAGS", "CARGO_BUILD_TARGET",
            "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER"].includes(key)));
    env.CARGO_TARGET_DIR = path.join(root, "native/legal-structure-node/target");
    env.CARGO_BUILD_JOBS = "1";
    env.CARGO_ENCODED_RUSTFLAGS = [[homedir(), "/home"],
        [process.env.RUSTUP_HOME ?? path.join(homedir(), ".rustup"), "/rustup"],
        [process.env.CARGO_HOME ?? path.join(homedir(), ".cargo"), "/cargo"], [root, "/workspace"]]
        .map(([from, to]) => `--remap-path-prefix=${from}=${to}`).join("\x1f");
    return env;
}

/** Cargo with these arguments, from the workspace root, yielding to interactive work; its exit code becomes ours. */
export function cargo(args) {
    const child = spawn("cargo", args, { cwd: root, env: cargoEnv(), stdio: "inherit" });
    child.once("spawn", () => setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL));
    child.once("error", error => { console.error(error.message); process.exitCode = 1; });
    child.once("exit", code => { process.exitCode = code ?? 1; });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cargo(process.argv.slice(2));

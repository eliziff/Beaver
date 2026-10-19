import "./background-work.mjs";
import { spawn } from "node:child_process";
import { constants, homedir, setPriority } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const flags = process.argv.slice(2), release = flags.includes("--release"), diagnostics = flags.includes("--diagnostics");
if (flags.some(flag => flag !== "--release" && flag !== "--diagnostics") || new Set(flags).size !== flags.length)
    throw new Error("Use native:build [--release] [--diagnostics]; Cargo overrides are not accepted");
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
const child = spawn("cargo", ["build", "--locked", "--offline", ...release ? ["--release"] : [],
    ...diagnostics ? ["--features", "diagnostics"] : [],
    "--manifest-path", "native/legal-structure-node/Cargo.toml"], { cwd: root, env, stdio: "inherit" });
// The build yields to interactive work.
child.once("spawn", () => setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL));
child.once("error", error => { console.error(error.message); process.exitCode = 1; });
child.once("exit", code => { process.exitCode = code ?? 1; });

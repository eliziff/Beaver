import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const baseEnv = { ...process.env };
delete baseEnv.BEAVER_TYPES_VERIFIED_BY;

function run(module, args, env = baseEnv) {
    return new Promise((resolve, reject) => {
        const child = spawn(
            process.execPath,
            [require.resolve(module), ...args],
            { env, stdio: "inherit" },
        );
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            if (signal) process.kill(process.pid, signal);
            else if (code === 0) resolve();
            else process.exit(code ?? 1);
        });
    });
}

await run("next/dist/bin/next", ["typegen"]);
await run("typescript/bin/tsc", ["--noEmit"]);
await run("next/dist/bin/next", ["build", ...process.argv.slice(2)], {
    ...baseEnv,
    BEAVER_TYPES_VERIFIED_BY: String(process.pid),
});

import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, version } from "esbuild";

const backend = fileURLToPath(new URL("../", import.meta.url));
const source = path.join(backend, "src");
assert(process.argv.slice(2).every(arg => arg === "--stage"), "Usage: build.mjs [--stage]");
const output = path.join(backend, process.argv.includes("--stage") ? ".tmp-build" : "dist");
const files = readdirSync(source, { recursive: true }).filter(file =>
  !/(?:^|[\\/])__tests__(?:[\\/]|$)|\.(?:test|spec|d)\.ts$/.test(file));
if (process.argv.includes("--stage")) rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const signature = createHash("sha256").update(version)
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .update(readFileSync(path.join(backend, "tsconfig.json"))).digest("hex");
const stamp = path.join(output, ".build-version");
const invalidated = !existsSync(stamp) || readFileSync(stamp, "utf8") !== signature;
const destination = file => path.join(output, file.replace(/\.ts$/, ".js"));
const changed = files.filter(file => /\.(ts|json)$/.test(file) &&
  (invalidated || !existsSync(destination(file)) || statSync(path.join(source, file)).mtimeMs > statSync(destination(file)).mtimeMs));

// Emit modules without loading dependency declarations or changing their runtime layout.
if (changed.some(file => file.endsWith(".ts"))) await build({
  absWorkingDir: backend,
  entryPoints: changed.filter(file => file.endsWith(".ts")).map(file => path.join(source, file)),
  outbase: source, outdir: output, bundle: false, platform: "node", format: "cjs",
  target: "es2022", tsconfig: path.join(backend, "tsconfig.json"),
  // Node CommonJS uses extensionless relative imports; native import() cannot resolve them.
  supported: { "dynamic-import": false },
});
for (const file of changed.filter(file => file.endsWith(".json"))) {
  mkdirSync(path.dirname(destination(file)), { recursive: true });
  copyFileSync(path.join(source, file), destination(file));
}
const expected = new Set(files.filter(file => /\.(ts|json)$/.test(file)).map(destination));
for (const file of readdirSync(output, { recursive: true })) {
  const candidate = path.join(output, file);
  if (/\.(js|json)$/.test(file) && !expected.has(candidate)) rmSync(candidate);
}
if (invalidated) writeFileSync(stamp, signature);

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import compiler from "typescript/package.json" with { type: "json" };

assert(process.argv.slice(2).every(arg => arg === "--stage"), "Usage: build-shared.mjs [--stage]");
const source = new URL("../shared/contracts/", import.meta.url);
const output = new URL(process.argv.includes("--stage")
  ? "../.tmp/shared-build/" : "../shared/runtime/", import.meta.url);
mkdirSync(output, { recursive: true });
if (process.argv.includes("--stage")) {
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
}
const signature = createHash("sha256").update(compiler.version).update(readFileSync(fileURLToPath(import.meta.url))).digest("hex");
const stamp = new URL(".build-version", output);
const invalidated = !existsSync(stamp) || readFileSync(stamp, "utf8") !== signature;
const files = readdirSync(source).filter(file => file.endsWith(".mts") && !file.endsWith(".d.mts"));
const changed = files.filter(file => {
  const destination = new URL(file.replace(/\.mts$/, ".mjs"), output);
  return invalidated || !existsSync(destination) || statSync(new URL(file, source)).mtimeMs > statSync(destination).mtimeMs;
});
const ts = changed.length ? (await import("typescript")).default : undefined;
// Consumers check contract sources directly; runtime emission needs no dependency graph or declarations.
for (const file of changed) {
  const destination = new URL(file.replace(/\.mts$/, ".mjs"), output);
  const result = ts.transpileModule(readFileSync(new URL(file, source), "utf8"), {
    fileName: fileURLToPath(new URL(file, source)), reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  const errors = result.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error) ?? [];
  assert.equal(errors.length, 0, ts.formatDiagnostics(errors, {
    getCanonicalFileName: name => name, getCurrentDirectory: () => process.cwd(), getNewLine: () => "\n",
  }));
  writeFileSync(destination, result.outputText);
}
const expected = new Set(files.map(file => file.replace(/\.mts$/, ".mjs")));
for (const file of readdirSync(output)) {
  if ((file.endsWith(".mjs") && !expected.has(file)) || file.endsWith(".d.mts")) rmSync(new URL(file, output));
}
if (invalidated) writeFileSync(stamp, signature);

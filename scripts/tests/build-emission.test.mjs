import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { test } from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("emitters reuse unchanged output, invalidate configuration and retire deleted modules", () => {
  mkdirSync(path.join(root, ".tmp"), { recursive: true });
  const scratch = mkdtempSync(path.join(root, ".tmp/emission-check-"));
  const probes = [];
  try {
    for (const [name, scriptPath, sourceDeclaration, outputDeclaration, extension] of [
      ["backend", "backend/scripts/build.mjs", 'const source = path.join(backend, "src");',
        'const output = path.join(backend, process.argv.includes("--stage") ? ".tmp-build" : "dist");', "ts"],
      ["shared", "scripts/build-shared.mjs", 'const source = new URL("../shared/contracts/", import.meta.url);',
        'const output = new URL(process.argv.includes("--stage")\n  ? "../.tmp/shared-build/" : "../shared/runtime/", import.meta.url);', "mts"],
    ]) {
      const source = path.join(scratch, name, "src"), output = path.join(scratch, name, "out");
      mkdirSync(source, { recursive: true });
      const original = readFileSync(path.join(root, scriptPath), "utf8");
      assert.ok(original.includes(sourceDeclaration) && original.includes(outputDeclaration));
      const literal = value => name === "shared"
        ? `new URL(${JSON.stringify(pathToFileURL(value + path.sep).href)})` : JSON.stringify(value);
      const script = original.replace(sourceDeclaration, `const source = ${literal(source)};`)
        .replace(outputDeclaration, `const output = ${literal(output)};`);
      const probe = path.join(root, path.dirname(scriptPath), `.emission-probe-${process.pid}.mjs`);
      probes.push(probe);
      writeFileSync(probe, script);
      const a = path.join(source, `a.${extension}`), b = path.join(source, `b.${extension}`);
      const emitted = file => path.join(output, `${file}.${name === "shared" ? "mjs" : "js"}`);
      writeFileSync(a, "export const value = 1;");
      writeFileSync(b, "export const value = 2;");
      const run = (...args) => {
        const start = performance.now();
        execFileSync(process.execPath, [probe, ...args], { cwd: root, timeout: 20_000, stdio: "pipe" });
        return Math.round(performance.now() - start);
      };
      const first = run(), before = statSync(emitted("a")).mtimeMs, untouched = statSync(emitted("b")).mtimeMs;
      const noop = run();
      assert.equal(statSync(emitted("a")).mtimeMs, before);
      writeFileSync(a, "export const value = 3;");
      const narrow = run();
      assert.equal(statSync(emitted("b")).mtimeMs, untouched);
      assert.match(readFileSync(emitted("a"), "utf8"), /3/);
      rmSync(b);
      run();
      assert.equal(existsSync(emitted("b")), false);
      // A changed emitter and an obsolete compiler signature must each force emission.
      const priorSignature = readFileSync(path.join(output, ".build-version"), "utf8");
      writeFileSync(emitted("a"), "obsolete output");
      writeFileSync(probe, script + "\n// changed emitter\n");
      run();
      assert.notEqual(readFileSync(path.join(output, ".build-version"), "utf8"), priorSignature);
      assert.match(readFileSync(emitted("a"), "utf8"), /3/);
      writeFileSync(emitted("a"), "obsolete output");
      writeFileSync(path.join(output, ".build-version"), "obsolete compiler/configuration");
      run();
      assert.match(readFileSync(emitted("a"), "utf8"), /3/);
      writeFileSync(path.join(output, "stale.txt"), "old staging artifact");
      run("--stage");
      assert.equal(existsSync(path.join(output, "stale.txt")), false);
      console.log(`${name}: first ${first}ms, no-op ${noop}ms, narrow ${narrow}ms (two-module fixture)`);
    }
  } finally {
    for (const probe of probes) rmSync(probe, { force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

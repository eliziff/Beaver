import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const addon = path.join(root, "native/legal-structure-node/target/release/legal_structure_node.dll");
test("a loaded addon does not lock Cargo's output", {
  skip: process.platform !== "win32" || !existsSync(addon),
}, () => {
  const scratchRoot = path.join(root, ".tmp");
  mkdirSync(scratchRoot, { recursive: true });
  const scratch = mkdtempSync(path.join(scratchRoot, "native-addon-proof-"));
  assert.ok(scratch.startsWith(scratchRoot + path.sep));
  try {
    const source = path.join(scratch, "target/release/legal_structure_node.dll");
    mkdirSync(path.dirname(source), { recursive: true });
    copyFileSync(addon, source);
    const script = `import assert from 'node:assert/strict';
      import {renameSync} from 'node:fs';
      import {nativeAddonFile} from ${JSON.stringify(pathToFileURL(path.join(root, "shared/nativeAddonFile.mjs")).href)};
      import {structureEngineAddon} from ${JSON.stringify(pathToFileURL(path.join(root, "shared/structure-engine.mjs")).href)};
      const source=${JSON.stringify(source)}, root=${JSON.stringify(scratch)};
      const loaded=nativeAddonFile(source,root), module={exports:{}};
      process.dlopen(module,loaded);
      const engine=structureEngineAddon(module.exports), features=engine.nativeBuildFeatures();
      renameSync(source,source+'.replacement');
      assert.equal(engine.nativeBuildFeatures(),features);
      renameSync(source+'.replacement',source);
      assert.equal(nativeAddonFile(source,root),loaded);`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || String(result.error ?? ""));
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

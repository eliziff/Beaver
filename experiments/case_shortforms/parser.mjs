// A persistent host for the existing citation engine; no citation grammar lives here.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { defaultNativeAddon, nativeAddonFile } from "../../shared/nativeAddonFile.mjs";
import { structureEngineAddon } from "../../shared/structure-engine.mjs";

const root = fileURLToPath(new URL("../../native/legal-structure-node/", import.meta.url));
const filename = process.env.LEGAL_STRUCTURE_NATIVE
  ? path.resolve(process.env.LEGAL_STRUCTURE_NATIVE) : defaultNativeAddon(root);
const module = { exports: {} };
process.dlopen(module, nativeAddonFile(filename, root));
const addon = "call" in module.exports
  ? structureEngineAddon(module.exports, { toBuffer: bytes => Buffer.from(bytes) }) : module.exports;
// The engine's typed citation ops, by the method names the screen sends.
const methods = {
  extract: request => addon.citationExtract(request.text, request.options ?? {}, request.offsetUnit),
  supraHint: request => addon.supraHint(request.text, request.aggressive, request.fallback),
};
const call = (method, request) => {
  if (!methods[method]) throw new Error(`No engine op for ${method}.`);
  return methods[method](request);
};
console.log(JSON.stringify({ version: { keyVersion: addon.citationKeyVersion() },
  nativeSha256: createHash("sha256").update(readFileSync(filename)).digest("hex") }));
const run = (method, request) => {
  const result = call(method, request);
  return method === "extract" ? { citations: result.citations.map(c => ({
    index: c.index, parallelGroup: c.parallelGroup, history: c.history, court: c.court,
    form: c.form, authority: c.authority, key: c.key, core: c.span,
    style: c.style, parties: c.parties, explicit: c.explicitShortName,
    explicitSpan: c.fields?.explicitShortSpan, name: c.form === "full" ? undefined : c.style?.text,
  })) } : result;
};
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  try {
    const { method, request } = JSON.parse(line);
    const result = method === "batch" ? request.map(({ method, request }) => {
      try { return run(method, request); }
      catch (error) { return { error: String(error) }; }
    }) : run(method, request);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.log(JSON.stringify({ error: String(error) }));
  }
}

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
const call = (method, request) => addon.citationEngineCall(method, JSON.stringify(request));
const grammarBytes = readFileSync(new URL("../../common-law-cite/crates/legal-grammar/data/grammar-corpus.json", import.meta.url));
const version = call("version", {});
const grammarSha256 = createHash("sha256").update(grammarBytes).digest("hex");
if (grammarSha256 !== version.grammar.sha256) throw new Error("Screen and native citation grammars differ.");
console.log(JSON.stringify({ version, grammarSha256,
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

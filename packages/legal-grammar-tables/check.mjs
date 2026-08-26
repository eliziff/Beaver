import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(root, "../..");
const corpusPath = path.join(workspace, "legal-structure/data/grammar-corpus.json");
const eyeciteReceiptPath = path.join(root, "eyecite-us-receipt.json");
const manifestPath = path.join(workspace, "legal-structure/data/manifest.json");
const bundles = [
  path.join(workspace, "AuthoritiesHelper/data/legal-grammar-tables"),
];
const allowedTableKeys = new Set(["description", "defs", "entries"]);
const allowedEntryKeys = new Set([
  "id",
  "pattern",
  "flags",
  "canonical",
  "provenance",
  "vectors",
]);
const allowedCanonicalKeys = new Set(["lowercase", "strip", "map"]);

const fail = (message) => {
  throw new Error(message);
};
const object = (value, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label}: expected object`);
  return value;
};
const exactKeys = (value, allowed, label) => {
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${label}: unknown field ${key}`);
};
const stringRecord = (value, label) => {
  object(value, label);
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") fail(`${label}.${key}: expected string`);
  }
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sameManifest = (actual, expected) =>
  actual.toString("utf8").replaceAll("\r\n", "\n") ===
  expected.toString("utf8").replaceAll("\r\n", "\n");
const expand = (source, defs, id) => {
  let result = source;
  for (let pass = 0; pass <= 10; pass += 1) {
    const next = result.replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (_, name) => {
      if (!(name in defs)) fail(`${id}: undefined fragment ${name}`);
      return defs[name];
    });
    if (next === result) return result;
    result = next;
  }
  fail(`${id}: fragment reference cycle`);
};
const validatePortablePattern = (source, id) => {
  if (source.includes("(?P")) fail(`${id}: Python named groups are not portable`);
  if (/\\[pP]\{/.test(source)) fail(`${id}: Unicode property classes are not portable`);
  if (/\(\?[A-Za-z-]+[:)]/.test(source)) fail(`${id}: inline flags are not portable`);
  if (/(?:^|[^\\])\(\?\(/.test(source)) fail(`${id}: conditional groups are not portable`);
  if (/\\u\{/.test(source)) fail(`${id}: braced Unicode escapes are not portable`);
};

const corpusBytes = readFileSync(corpusPath);
if (corpusBytes.length > 512 * 1024) fail("grammar-corpus.json exceeds 512 KiB");
if (corpusBytes.includes(0x0d)) fail("grammar-corpus.json must use LF line endings");
const eyeciteReceipt = object(
  JSON.parse(readFileSync(eyeciteReceiptPath)),
  "eyecite-us-receipt",
);
if (eyeciteReceipt.format !== "beaver.eyecite-us-grammar-candidate.v1") fail("unexpected eyecite receipt format");
if (eyeciteReceipt.eyecite?.version !== "2.7.8" || eyeciteReceipt.eyecite?.commit !== "09165c2d90b4295b4967b1b01b83963c37ab2a98") fail("eyecite source pin drifted");
if (eyeciteReceipt.reporters_db?.version !== "3.2.66" || eyeciteReceipt.reporters_db?.commit !== "fad63b383b92f9446c223ddc12bf0b6fd1a6b44c") fail("reporters-db source pin drifted");
if (eyeciteReceipt.license !== "BSD-2-Clause") fail("unexpected eyecite grammar source license");
if (eyeciteReceipt.candidate_bytes !== corpusBytes.length) fail("eyecite receipt byte count does not describe grammar-corpus.json");
if (eyeciteReceipt.candidate_sha256 !== sha256(corpusBytes)) fail("eyecite receipt does not describe grammar-corpus.json");
const corpus = object(JSON.parse(corpusBytes), "corpus");
if (corpus.format !== "legal-grammar-corpus:v1") fail(`unexpected corpus format ${corpus.format}`);
exactKeys(corpus, new Set(["format", "tables"]), "corpus");
const tables = object(corpus.tables, "corpus.tables");
const tableNames = Object.keys(tables).sort();
if (tableNames.join(",") !== "citations,footnote-labels,pinpoints,provisions,references") {
  fail(`incomplete table set: ${tableNames.join(",")}`);
}

const ids = new Set();
let vectors = 0;
for (const tableName of tableNames) {
  const table = object(tables[tableName], tableName);
  exactKeys(table, allowedTableKeys, tableName);
  if (typeof table.description !== "string" || !table.description) fail(`${tableName}: missing description`);
  const defs = object(table.defs ?? {}, `${tableName}.defs`);
  for (const [name, fragment] of Object.entries(defs)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof fragment !== "string") {
      fail(`${tableName}.defs.${name}: invalid fragment`);
    }
  }
  if (!Array.isArray(table.entries) || table.entries.length === 0) fail(`${tableName}: no entries`);
  for (const entry of table.entries) {
    object(entry, `${tableName}.entry`);
    exactKeys(entry, allowedEntryKeys, `${tableName}.${entry.id ?? "?"}`);
    if (typeof entry.id !== "string" || !/^[a-z0-9.-]+$/.test(entry.id)) fail(`${tableName}: invalid id`);
    if (ids.has(entry.id)) fail(`duplicate grammar id ${entry.id}`);
    ids.add(entry.id);
    if (typeof entry.pattern !== "string" || entry.pattern.length === 0) fail(`${entry.id}: empty pattern`);
    if (typeof entry.flags !== "string" || !/^(?!.*(.).*\1)[ims]*$/.test(entry.flags)) fail(`${entry.id}: invalid flags`);
    const canonical = object(entry.canonical, `${entry.id}.canonical`);
    exactKeys(canonical, allowedCanonicalKeys, `${entry.id}.canonical`);
    if (canonical.lowercase !== undefined && (!Array.isArray(canonical.lowercase) || canonical.lowercase.some((name) => typeof name !== "string"))) fail(`${entry.id}.canonical.lowercase: expected strings`);
    if (canonical.strip !== undefined) stringRecord(canonical.strip, `${entry.id}.canonical.strip`);
    if (canonical.map !== undefined) {
      object(canonical.map, `${entry.id}.canonical.map`);
      for (const [name, mapping] of Object.entries(canonical.map)) stringRecord(mapping, `${entry.id}.canonical.map.${name}`);
    }
    if (typeof entry.provenance !== "string" || entry.provenance.length === 0) fail(`${entry.id}: missing provenance`);
    if (!Array.isArray(entry.vectors) || entry.vectors.length === 0) fail(`${entry.id}: missing vectors`);
    const vectorInputs = new Set();
    for (const vector of entry.vectors) {
      object(vector, `${entry.id}.vector`);
      exactKeys(vector, new Set(["input", "groups", "canonical"]), `${entry.id}.vector`);
      if (typeof vector.input !== "string") fail(`${entry.id}: vector input must be text`);
      if (vectorInputs.has(vector.input)) fail(`${entry.id}: duplicate vector input`);
      vectorInputs.add(vector.input);
      if (vector.groups !== null) stringRecord(vector.groups, `${entry.id}.vector.groups`);
      if (vector.canonical !== undefined) stringRecord(vector.canonical, `${entry.id}.vector.canonical`);
      vectors += 1;
    }
    validatePortablePattern(expand(entry.pattern, defs, entry.id), entry.id);
    if (!entry.id.startsWith("cite.us.")) continue;
    let compiled;
    try {
      compiled = new RegExp(expand(entry.pattern, defs, entry.id), entry.flags);
    } catch (error) {
      fail(`${entry.id}: does not compile in JavaScript: ${error}`);
    }
    // The historical corpus predates a JavaScript runtime adapter and carries
    // Unicode-boundary vectors for the Python/Rust portable expansion. The US
    // snapshot is the first TS consumer: execute its vectors here in addition
    // to compiling every entry, without pretending native JS \b is that older
    // adapter's frozen Unicode word class.
    for (const vector of entry.vectors) {
      const match = compiled.exec(vector.input);
      if (vector.groups === null) {
        if (match) fail(`${entry.id}: ${JSON.stringify(vector.input)} expected no match, got ${JSON.stringify(match[0])}`);
        continue;
      }
      if (!match) fail(`${entry.id}: ${JSON.stringify(vector.input)} expected a match`);
      for (const [name, expected] of Object.entries(vector.groups)) {
        if (match.groups?.[name] !== expected) fail(`${entry.id}: ${JSON.stringify(vector.input)} group ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(match.groups?.[name])}`);
      }
    }
  }
}

const manifest = {
  format: "legal-grammar-manifest:v1",
  corpus: "grammar-corpus.json",
  sha256: sha256(corpusBytes),
  tables: tableNames,
  entries: ids.size,
  vectors,
};
const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);

if (process.argv.includes("--sync")) {
  writeFileSync(manifestPath, manifestBytes);
  for (const bundle of bundles) {
    mkdirSync(bundle, { recursive: true });
    writeFileSync(path.join(bundle, "grammar-corpus.json"), corpusBytes);
    writeFileSync(path.join(bundle, "manifest.json"), manifestBytes);
  }
}

if (!sameManifest(readFileSync(manifestPath), manifestBytes)) fail("manifest.json is stale; run npm run sync");
for (const bundle of bundles) {
  for (const name of ["grammar-corpus.json", "manifest.json"]) {
    const expected = name === "grammar-corpus.json" ? corpusBytes : manifestBytes;
    let actual;
    try {
      actual = readFileSync(path.join(bundle, name));
    } catch {
      fail(`${path.relative(workspace, bundle)}/${name} is missing; run npm run sync`);
    }
    if (!(name === "manifest.json" ? sameManifest(actual, expected) : actual.equals(expected))) {
      fail(`${path.relative(workspace, bundle)}/${name} is stale; run npm run sync`);
    }
  }
}
console.log(`legal grammar corpus ok: ${ids.size} entries, ${vectors} vectors, ${manifest.sha256}`);

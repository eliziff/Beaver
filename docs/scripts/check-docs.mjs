import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const docs = path.join(root, "docs");
const errors = [];

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const item = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(item) : [item];
  });
}

function relative(file) {
  return path.relative(root, file).replaceAll("\\", "/");
}

const topLevel = readdirSync(docs, { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name !== "README.md");
for (const entry of topLevel) errors.push(`uncatalogued top-level document: docs/${entry.name}`);

const allowed = new Set(["current", "roadmap", "experiments", "decisions", "harvey-labs", "scripts"]);
for (const file of walk(docs).filter(file => /\.(?:md|json)$/i.test(file))) {
  const rel = relative(file);
  const section = rel.split("/")[1];
  if (rel !== "docs/README.md" && !allowed.has(section)) {
    errors.push(`document outside a status directory: ${rel}`);
  }
  if (file.endsWith(".json")) {
    try {
      const document = JSON.parse(readFileSync(file, "utf8"));
      const values = [document];
      while (values.length) {
        const value = values.pop();
        if (typeof value === "string" && /^docs\/.+\.(?:md|json)$/i.test(value)) {
          if (!existsSync(path.join(root, value))) errors.push(`broken JSON document reference: ${rel} -> ${value}`);
        } else if (value && typeof value === "object") {
          values.push(...Object.values(value));
        }
      }
    } catch (error) {
      errors.push(`invalid JSON: ${rel}: ${error.message}`);
    }
  }
}

const markdown = [
  ...walk(docs).filter(file => file.endsWith(".md")),
  path.join(root, "benchmarks/harvey-labs/README.md"),
  path.join(root, "benchmarks/harvey-labs/CONTRIBUTING.md"),
  path.join(root, "benchmarks/harvey-labs/PROVENANCE.md"),
  path.join(root, "benchmarks/harvey-labs/sandbox/README.md"),
].filter(existsSync);

const linkPattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^)]*)?\)/g;
for (const file of markdown) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(linkPattern)) {
    let target = match[1].replace(/^<|>$/g, "");
    if (/^(?:[a-z]+:|#)/i.test(target)) continue;
    target = decodeURIComponent(target.split(/[?#]/, 1)[0]);
    if (!target) continue;
    const resolved = path.resolve(path.dirname(file), target);
    if (!resolved.startsWith(root + path.sep) || !existsSync(resolved)) {
      errors.push(`broken link: ${relative(file)} -> ${match[1]}`);
    }
  }
}

const harveyRoot = path.join(docs, "harvey-labs");
const harveyIndex = path.join(harveyRoot, "README.md");
const indexText = readFileSync(harveyIndex, "utf8");
const indexed = new Set();
for (const match of indexText.matchAll(linkPattern)) {
  const target = match[1].split(/[?#]/, 1)[0];
  if (/^(?:[a-z]+:|#)/i.test(target)) continue;
  indexed.add(path.resolve(path.dirname(harveyIndex), decodeURIComponent(target)));
}
for (const file of walk(harveyRoot).filter(file => /\.(?:md|json)$/i.test(file) && file !== harveyIndex)) {
  if (!indexed.has(path.resolve(file))) errors.push(`Harvey Labs file missing from index: ${relative(file)}`);
}
for (const protocol of walk(path.join(harveyRoot, "protocols")).filter(file => file.endsWith(".json"))) {
  if (!indexed.has(path.resolve(protocol))) errors.push(`orphan Harvey Labs protocol: ${relative(protocol)}`);
}
for (const heading of ["Runner version", "Result", "Decision", "Reproduction"]) {
  if (!indexText.includes(heading)) errors.push(`Harvey Labs manifest missing column: ${heading}`);
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`documentation OK: ${markdown.length} Markdown files; ${indexed.size} Harvey Labs index links`);

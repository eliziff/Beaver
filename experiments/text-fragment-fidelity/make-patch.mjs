// Generates the promotion patch: candidate builder body spliced onto
// production's import header, diffed against production legalSourceLinks.ts.
// Outputs land under results/promotion (gitignored) so the source-boundary
// checker never sees generated files with unresolved imports.
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const here = import.meta.dirname;
const root = path.resolve(here, "..", "..");
const candidatePath = path.join(here, "builder-candidate.ts");
const prodPath = path.join(root, "backend", "src", "lib", "legalSourceLinks.ts");
const outDir = path.join(here, "results", "promotion");
fs.mkdirSync(outDir, { recursive: true });

const prodLines = fs.readFileSync(prodPath, "utf8").split(/\r?\n/);
const candidateLines = fs.readFileSync(candidatePath, "utf8").split(/\r?\n/);

// Production header = everything up to and including the last import line.
const lastProdImport = prodLines.findIndex((line) => line.startsWith('import { buildCanliiCaseUrl }'));
const header = prodLines.slice(0, lastProdImport + 1).join("\n");

// Candidate body = everything after its own last import line.
const lastCandImport = candidateLines.findIndex((line) => line.startsWith("import { buildCanliiCaseUrl }"));
const body = candidateLines.slice(lastCandImport + 1).join("\n");

const normalized = `${header}\n${body}\n`;
const normalizedPath = path.join(outDir, "legalSourceLinks.candidate.ts");
fs.writeFileSync(normalizedPath, normalized);

let diff = "";
try {
  diff = execSync(
    `git diff --no-index --no-color -- ${JSON.stringify(prodPath)} ${JSON.stringify(normalizedPath)}`,
    { cwd: root, encoding: "utf8" },
  );
} catch (error) {
  diff = error.stdout ?? "";
}
fs.writeFileSync(path.join(outDir, "candidate.patch"), diff);

const functionNames = [...diff.matchAll(/^[-+]\s*function\s+(\w+)/gmu)].map((m) => m[1]);
console.log(JSON.stringify({
  patchBytes: diff.length,
  patchPath: path.join(outDir, "candidate.patch"),
  touchedFunctions: [...new Set(functionNames)],
}));

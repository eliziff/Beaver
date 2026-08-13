import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const code = /\.(?:[cm]?[jt]sx?)$/u;
const imports = /(?:\bfrom\s+|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/gu;
const files = execFileSync(
  "git",
  [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    "backend/src",
    "frontend/src",
    "shared",
    "backend/experiments",
    "experiments",
  ],
  { cwd: root, encoding: "utf8" },
)
  .split(/\r?\n/u)
  .filter((file) => code.test(file) && existsSync(path.join(root, file)));

const failures = [];
for (const file of files) {
  const production = /^(?:backend|frontend)\/src\/|^shared\//u.test(file);
  const maintained = production || !file.split("/").includes("scratch");
  const source = readFileSync(path.join(root, file), "utf8");
  for (const match of source.matchAll(imports)) {
    const specifier = match[1];
    if (production && specifier.split(/[\\/]/u).includes("experiments")) {
      failures.push(`${file}: production imports ${specifier}`);
    }
    if (!maintained || !specifier.startsWith(".")) continue;
    const target = path.resolve(root, path.dirname(file), specifier);
    if (
      [
        target,
        ...[".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"].flatMap((ext) => [
          target + ext,
          path.join(target, `index${ext}`),
        ]),
      ]
        .some(existsSync)
    ) continue;
    failures.push(`${file}: missing relative import ${specifier}`);
  }
}

if (failures.length) {
  console.error(`Experiment boundary check failed:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("Experiment boundary: production is one-way; relative imports resolve.");

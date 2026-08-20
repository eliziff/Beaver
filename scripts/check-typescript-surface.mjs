#!/usr/bin/env node
/** Candidate-only scan: exported declarations whose name occurs in one file. */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireFromBackend = createRequire(path.join(repo, "backend", "package.json"));
const ts = requireFromBackend("typescript");
const verbose = process.argv.includes("--verbose");
const showOneCallers = process.argv.includes("--one-callers");
const passThroughsOnly = process.argv.includes("--pass-throughs");
const showDuplicates = process.argv.includes("--duplicates");
const showTestOnly = process.argv.includes("--test-only");
const roots = [
  "backend/src",
  "backend/scripts",
  "backend/experiments",
  "frontend/src",
  "frontend/scripts",
  "experiments",
];

function sources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return sources(filename);
    return /\.(?:ts|tsx)$/u.test(entry.name) && statSync(filename).isFile()
      ? [filename]
      : [];
  });
}

const files = roots.flatMap((root) => sources(path.join(repo, root)));
const contents = new Map(files.map((file) => [file, readFileSync(file, "utf8")]));
const syntaxTrees = new Map([...contents].map(([file, source]) => [
  file,
  ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  ),
]));
const counts = new Map();
const productionCounts = new Map();
const filesByName = new Map();
for (const [file, tree] of syntaxTrees) {
  const relative = path.relative(repo, file);
  const production = /^(?:backend|frontend)\\src\\/u.test(relative) &&
    !/\\(?:__tests__|tests|fixtures|support)\\|\.test\.[cm]?[jt]sx?$/u.test(relative);
  const seen = new Set();
  const visit = (node) => {
    const name = ts.isIdentifier(node)
      ? node.text
      : (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
          /^[A-Za-z_][A-Za-z0-9_]*$/u.test(node.text)
        ? node.text
        : null;
    if (name) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
      if (production) productionCounts.set(name, (productionCounts.get(name) ?? 0) + 1);
      seen.add(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  for (const name of seen) {
    const owners = filesByName.get(name) ?? [];
    owners.push(file);
    filesByName.set(name, owners);
  }
}
const candidates = [];
const exports = [];
for (const [file, tree] of syntaxTrees) {
  for (const statement of tree.statements) {
    if (
      !statement.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword) ||
      statement.modifiers.some(({ kind }) => kind === ts.SyntaxKind.DefaultKeyword)
    ) {
      continue;
    }
    const names = ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)
      ? statement.name ? [statement.name.text] : []
      : ts.isVariableStatement(statement)
        ? statement.declarationList.declarations
          .filter(({ name }) => ts.isIdentifier(name))
          .map(({ name }) => name.text)
        : [];
    for (const name of names) {
      const exported = { name, file: path.relative(repo, file),
        occurrences: counts.get(name) ?? 0 };
      exports.push(exported);
      if (filesByName.get(name)?.length === 1) {
        candidates.push(exported);
      }
    }
  }
}
const dead = candidates.filter(({ occurrences }) => occurrences === 1);
const isProduction = ({ file }) =>
  /^(?:backend|frontend)\\src\\/u.test(file) &&
  !/\\(?:__tests__|tests|fixtures|support)\\|\.test\.[cm]?[jt]sx?$/u.test(file);
const productionDead = dead.filter(isProduction);
const nonproductionDead = dead.filter((candidate) => !productionDead.includes(candidate));
const privateOnly = candidates.filter(({ occurrences }) => occurrences > 1);
const productionPrivateOnly = privateOnly.filter(isProduction);
const report = {
  files: files.length,
  productionDead,
  productionPrivateOnly,
  nonproductionDeadCount: nonproductionDead.length,
  privateOnlyCount: privateOnly.length,
};
if (showTestOnly) report.testOnlyProduction = exports.filter((candidate) =>
  isProduction(candidate) && candidate.occurrences > 1 &&
  productionCounts.get(candidate.name) === 1);
if (verbose) {
  report.nonproductionDead = nonproductionDead;
  report.privateOnly = privateOnly;
}
if (showOneCallers || passThroughsOnly) {
  report.oneCallers = [];
  for (const [file, tree] of syntaxTrees) {
    if (!isProduction({ file: path.relative(repo, file) })) continue;
    for (const statement of tree.statements) {
      const declarations = ts.isFunctionDeclaration(statement) && statement.name
        ? [{ name: statement.name.text, node: statement }]
        : ts.isVariableStatement(statement)
          ? statement.declarationList.declarations.flatMap((declaration) =>
            ts.isIdentifier(declaration.name) && declaration.initializer &&
            (ts.isArrowFunction(declaration.initializer) ||
              ts.isFunctionExpression(declaration.initializer))
              ? [{ name: declaration.name.text, node: declaration }] : [])
          : [];
      for (const { name, node } of declarations) {
        const start = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line;
        const end = tree.getLineAndCharacterOfPosition(node.getEnd()).line;
        const initializer = ts.isVariableDeclaration(node) ? node.initializer : node;
        const body = initializer?.body;
        const returned = body && ts.isBlock(body)
          ? body.statements.length === 1 && ts.isReturnStatement(body.statements[0])
            ? body.statements[0].expression : null
          : body;
        const expression = returned && ts.isAwaitExpression(returned)
          ? returned.expression : returned;
        const passThrough = Boolean(expression && ts.isCallExpression(expression));
        if ((counts.get(name) ?? 0) === 2 && end - start < 10 &&
            (!passThroughsOnly || passThrough)) {
          report.oneCallers.push({
            name,
            file: path.relative(repo, file),
            lines: end - start + 1,
            passThrough,
          });
        }
      }
    }
  }
}
if (showDuplicates) {
  const bodies = new Map();
  for (const [file, tree] of syntaxTrees) {
    if (!isProduction({ file: path.relative(repo, file) })) continue;
    for (const statement of tree.statements) {
      const declarations = ts.isFunctionDeclaration(statement) && statement.name
        ? [{ name: statement.name.text, body: statement.body }]
        : ts.isVariableStatement(statement)
          ? statement.declarationList.declarations.flatMap((declaration) =>
            ts.isIdentifier(declaration.name) && declaration.initializer &&
            (ts.isArrowFunction(declaration.initializer) ||
              ts.isFunctionExpression(declaration.initializer))
              ? [{ name: declaration.name.text, body: declaration.initializer.body }]
              : [])
          : [];
      for (const { name, body } of declarations) {
        if (!body) continue;
        const normalized = body.getText(tree).replace(/\s+/gu, " ");
        if (normalized.length < 24) continue;
        const matches = bodies.get(normalized) ?? [];
        matches.push({ name, file: path.relative(repo, file) });
        bodies.set(normalized, matches);
      }
    }
  }
  report.duplicateBodies = [...bodies.values()]
    .filter((matches) => matches.length > 1 &&
      new Set(matches.map(({ file }) => file)).size > 1);
}
console.log(JSON.stringify(report, null, 2));
process.exitCode = productionDead.length || productionPrivateOnly.length ? 1 : 0;

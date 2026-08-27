#!/usr/bin/env node
/** Find small TypeScript surface-area and duplication cleanup candidates. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
const showTestOnlyModules = process.argv.includes("--test-only-modules");
const showObjectSurfaces = process.argv.includes("--object-surfaces");
const roots = [
  "backend/src",
  "backend/scripts",
  "backend/experiments",
  "frontend/src",
  "frontend/scripts",
  "experiments",
];

const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "--", ...roots],
  { cwd: repo, encoding: "utf8", maxBuffer: 32 << 20 },
).split(/\r?\n/u)
  .filter((file) => /\.(?:ts|tsx)$/u.test(file))
  .map((file) => path.join(repo, file))
  .filter(existsSync);
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
    const declarations = ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)
      ? statement.name ? [statement.name] : []
      : ts.isVariableStatement(statement)
        ? statement.declarationList.declarations
          .filter(({ name }) => ts.isIdentifier(name))
          .map(({ name }) => name)
        : [];
    for (const declaration of declarations) {
      const name = declaration.text;
      const exported = { name, file: path.relative(repo, file),
        line: tree.getLineAndCharacterOfPosition(declaration.getStart(tree)).line + 1,
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
const isTest = (file) =>
  /\\(?:__tests__|tests|fixtures|support)\\|\.test\.[cm]?[jt]sx?$/u.test(file);
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
if (showTestOnly) {
  report.nonproductionOnlyExports = exports.flatMap((candidate) => {
    if (!isProduction(candidate) || productionCounts.get(candidate.name) !== 1) return [];
    const referenceFiles = (filesByName.get(candidate.name) ?? [])
      .map((file) => path.relative(repo, file))
      .filter((file) => file !== candidate.file)
      .sort();
    return referenceFiles.length ? [{ ...candidate, referenceFiles }] : [];
  });
  report.testOnlyProduction = report.nonproductionOnlyExports.filter(({ referenceFiles }) =>
    referenceFiles.every(isTest));
}
if (showTestOnlyModules) {
  const existing = new Set(files.map((file) => path.resolve(file)));
  const resolveImport = (file, specifier) => {
    if (!specifier.startsWith(".") && !specifier.startsWith("@/")) return null;
    let base = specifier.startsWith("@/")
      ? path.join(repo, "frontend/src", specifier.slice(2))
      : path.resolve(path.dirname(file), specifier);
    base = base.replace(/\.[cm]?jsx?$/u, "");
    return [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"),
      path.join(base, "index.tsx")].map((candidate) => path.resolve(candidate)).find((candidate) =>
      existing.has(candidate)) ?? null;
  };
  const dependencies = new Map([...contents].map(([file, source]) => [
    path.resolve(file),
    ts.preProcessFile(source, true, true).importedFiles
      .map(({ fileName }) => resolveImport(file, fileName)).filter(Boolean),
  ]));
  const walk = (entries) => {
    const visited = new Set(entries.map((file) => path.resolve(file))
      .filter((file) => existing.has(file)));
    for (const file of visited) {
      for (const dependency of dependencies.get(file) ?? []) visited.add(dependency);
    }
    return visited;
  };
  const productionFiles = files.filter((file) =>
    isProduction({ file: path.relative(repo, file) }));
  const product = walk([
    path.join(repo, "backend/src/index.ts"),
    path.join(repo, "frontend/src/main.tsx"),
  ]);
  const tests = walk(files.filter((file) => isTest(path.relative(repo, file))));
  const other = walk(files.filter((file) => {
    const relative = path.relative(repo, file);
    return !isProduction({ file: relative }) && !isTest(relative);
  }));
  report.testOnlyModules = productionFiles
    .filter((file) => !product.has(file) && tests.has(file) && !other.has(file))
    .map((file) => ({
      file: path.relative(repo, file),
      lines: contents.get(file).split(/\r?\n/u).filter((line) => line.trim()).length,
    }));
}
if (showObjectSurfaces) {
  report.objectSurfaceOnly = [];
  for (const [file, tree] of syntaxTrees) {
    if (!isProduction({ file: path.relative(repo, file) })) continue;
    const declarations = new Map();
    for (const statement of tree.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name)
        declarations.set(statement.name.text, statement.name);
      if (ts.isVariableStatement(statement)) for (const declaration of
        statement.declarationList.declarations) if (ts.isIdentifier(declaration.name))
          declarations.set(declaration.name.text, declaration.name);
    }
    const visit = (node) => {
      if (ts.isIdentifier(node) && declarations.has(node.text) &&
          node !== declarations.get(node.text) && counts.get(node.text) === 2 &&
          ts.isShorthandPropertyAssignment(node.parent)) {
        let ancestor = node.parent;
        while (ancestor.parent && !ts.isVariableStatement(ancestor)) ancestor = ancestor.parent;
        if (ts.isVariableStatement(ancestor) && ancestor.modifiers?.some(({ kind }) =>
          kind === ts.SyntaxKind.ExportKeyword)) report.objectSurfaceOnly.push({
          name: node.text,
          file: path.relative(repo, file),
          line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
}
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
console.log(JSON.stringify(showTestOnly || showTestOnlyModules || showObjectSurfaces ? {
  files: report.files,
  ...(showTestOnly ? {
    testOnlyProduction: report.testOnlyProduction,
    nonproductionOnlyExports: report.nonproductionOnlyExports,
  } : {}),
  ...(showTestOnlyModules ? { testOnlyModules: report.testOnlyModules } : {}),
  ...(showObjectSurfaces ? { objectSurfaceOnly: report.objectSurfaceOnly } : {}),
} : report, null, 2));
process.exitCode = productionDead.length || productionPrivateOnly.length ? 1 : 0;

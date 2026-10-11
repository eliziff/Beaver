// Bundles what compose.ts runs (the ALR runtime's operations, and the model arms' codexArm.ts) into modules of
// <out dir>, so each compose process starts without compiling TypeScript: node bundle.mjs <ALR repository> <out dir>.
// Packages stay in node_modules. The bundles' require and __dirname are backend/src/lib's, which the bundled modules
// resolve their files from.
import { buildSync } from "esbuild";
import path from "node:path";

const [alr, outdir] = process.argv.slice(2);
buildSync({
  entryPoints: { operations: path.join(alr, "beaver_app/runtime/operations.ts"),
    codexArm: path.join(import.meta.dirname, "codexArm.ts") },
  bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "warning", outExtension: { ".js": ".mjs" },
  tsconfig: path.join(import.meta.dirname, "tsconfig.json"), outdir,
  banner: { js: [
    "import { createRequire as __alrRequire } from 'node:module';",
    "import { fileURLToPath as __alrPath } from 'node:url';",
    "import { dirname as __alrDir, join as __alrJoin } from 'node:path';",
    "const require = __alrRequire(import.meta.url);",
    `const __dirname = __alrJoin(__alrDir(__alrPath(import.meta.url)), ${JSON.stringify(path.relative(outdir,
      path.join(import.meta.dirname, "../../backend/src/lib")).replaceAll("\\", "/"))});`,
    "const __filename = __alrJoin(__dirname, 'bundle.mjs');",
  ].join(" ") },
});

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { localOnly, writeThirdPartyNotices } from "../authorities-package/bundle.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const require = createRequire(path.join(root, "backend/package.json"));
const stage = path.resolve(process.argv[2]);
mkdirSync(stage, { recursive: true });
const result = await require("esbuild").build({ absWorkingDir: root,
  nodePaths: [path.join(root, "backend/node_modules")],
  entryPoints: ["scripts/court-records-package/server.mjs"], outfile: path.join(stage, "server.cjs"),
  bundle: true, platform: "node", format: "cjs", target: "node22", metafile: true,
  minifySyntax: true, minifyWhitespace: true, legalComments: "none", plugins: [localOnly] });
for (const input of Object.keys(result.metafile.inputs)) assert.doesNotMatch(input.replaceAll("\\", "/"),
  /(?:\/src\/(?:middleware\/auth|index|runtime|supervisor)\.ts|\/src\/lib\/(?:jobQueue|relationalDatabase|supabase)\.ts|\/node_modules\/(?:@supabase|openai|@anthropic-ai)\/)/u,
  `Court Records includes a Beaver deployment dependency: ${input}`);
writeThirdPartyNotices(stage, Object.keys(result.metafile.inputs), root, "npm");

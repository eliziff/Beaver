import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const code = /\.(?:[cm]?[jt]sx?)$/u;
const imports = /(?:\bfrom\s+|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/gu;
const modeUse = /\b(?:AUTH_MODE|isLocalMode|isLocalRuntime|runtime\.mode)\b/u;
const storageFactoryUse = /\b(?:createFilesystemObjectStorage|createS3ObjectStorage)\b/u;

const allow = (...groups) => new Set(groups.flatMap(([base, names, extension = "ts"]) =>
  names.split(" ").map((name) => `${base}/${name}.${extension}`)));
const modeFiles = allow(
  ["backend/src", "api index jobLanes runtime runtimeConfig server"],
  ["backend/src/lib", "localMode relationalDatabase"],
  ["backend/src", "middleware/auth"],
  ["frontend/src/app", "(pages)/account/layout (pages)/layout (pages)/projects/[id]/assistant/chat/[chatId]/page components/documents/DocumentAutomation components/projects/ProjectDocumentsView components/projects/ProjectWorkspace components/settings/ApiKeySettings components/settings/AppSettingsModal components/shared/AppSidebar components/workflows/WorkflowDetailPage contexts/AuthContext contexts/UserProfileContext", "tsx"],
  ["frontend/src/app/lib", "authMode"], ["frontend/src", "main", "tsx"],
);
const adapterFiles = allow(
  ["backend/src", "runtime middleware/auth routes/auth"],
  ["backend/src/lib", "access audit authSession filesystemObjectStorage jobQueue pdfJobs providerSessionStore relationalChatRepository relationalDatabase relationalDocumentRepository relationalLibraryRepository relationalProjectRepository relationalRepositorySupport relationalTabularRepository relationalUserPreferencesRepository relationalWorkflowRepository relationalWorkProductRepository storage supabase supabaseUserAccount userApiKeys userDataCleanup userDataExport userLookup"],
  ["backend/src/lib/mcp", "oauth servers types"],
  ["frontend/src/app", "(pages)/account/security/page components/account/AuthPage components/popups/MfaVerificationPopup contexts/AuthContext", "tsx"],
  ["frontend/src/app/lib", "supabase"],
);

function deploymentAdapter(specifier) {
  const normalized = specifier.replaceAll("\\", "/");
  const leaf = normalized.split("/").at(-1)?.replace(/\.[cm]?[jt]sx?$/u, "");
  return ["authMode", "authSession", "filesystemObjectStorage", "localMode", "relationalDatabase",
    "runtimeConfig", "supabase"].includes(leaf ?? "") ||
    /^relational[A-Z].*Repository(?:Support)?$/u.test(leaf ?? "") || normalized === "postgres" ||
    normalized === "@supabase/supabase-js" || normalized.startsWith("@aws-sdk/");
}

assert.equal(deploymentAdapter("@aws-sdk/client-s3"), true);
assert.equal(deploymentAdapter("@/app/lib/api/documents"), false);

const files = execFileSync("git", [
  "ls-files", "--cached", "--others", "--exclude-standard", "--",
  "backend/src", "frontend/src", "shared", "backend/experiments", "experiments",
], { cwd: root, encoding: "utf8" })
  .split(/\r?\n/u)
  .map((file) => file.replaceAll("\\", "/"))
  .filter((file) => code.test(file) && existsSync(path.join(root, file)));

const failures = [];
for (const file of files) {
  const production = /^(?:backend|frontend)\/src\/|^shared\//u.test(file);
  const test = /(?:^|\/)(?:__tests__|test|tests)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file);
  const maintained = production || !file.split("/").includes("scratch");
  const source = readFileSync(path.join(root, file), "utf8");
  if (production && !test && modeUse.test(source) && !modeFiles.has(file)) {
    failures.push(`${file}: adds a local/cloud branch outside the runtime boundary`);
  }
  if (production && !test && storageFactoryUse.test(source) &&
      !["backend/src/lib/filesystemObjectStorage.ts", "backend/src/lib/storage.ts",
        "backend/src/runtime.ts"].includes(file)) {
    failures.push(`${file}: constructs deployment storage outside composition`);
  }
  for (const match of source.matchAll(imports)) {
    const specifier = match[1];
    if (production && specifier.split(/[\\/]/u).includes("experiments")) {
      failures.push(`${file}: production imports ${specifier}`);
    }
    if (production && !test && deploymentAdapter(specifier) &&
        !adapterFiles.has(file) && !modeFiles.has(file)) {
      failures.push(`${file}: imports deployment adapter ${specifier}`);
    }
    if (!maintained || !specifier.startsWith(".")) continue;
    const target = path.resolve(root, path.dirname(file), specifier);
    if ([target, ...[".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"].flatMap((ext) => [
      target + ext, path.join(target, `index${ext}`),
    ])].some(existsSync)) continue;
    failures.push(`${file}: missing relative import ${specifier}`);
  }
}

if (failures.length) {
  console.error(`Source boundary check failed:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("Source boundaries: deployment choices stay at adapters; imports resolve.");

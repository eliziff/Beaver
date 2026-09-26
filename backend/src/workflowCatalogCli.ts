import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { runtime } from "./runtime";

async function main() {
  const [command, filename, revision, assetDirectory] = process.argv.slice(2);
  if (command !== "status" && (command !== "install" || !filename || !/^[a-f0-9]{40}$/u.test(revision ?? "")))
    throw new Error("Usage: workflow-catalog status | install <catalogue.json> <source-commit> [asset-directory]");
  const { catalog } = await runtime.workflows();
  if (command === "status") {
    const snapshot = await catalog.current();
    console.log(JSON.stringify(snapshot ? { sourceCommit: snapshot.sourceCommit,
      workflows: snapshot.workflows.length, assets: snapshot.assets.length } : { source: "bundled" }));
    return;
  }
  if ((await stat(filename)).size > 16 * 1024 * 1024) throw new Error("Catalogue exceeds 16 MiB");
  const snapshot: unknown = JSON.parse(await readFile(filename, "utf8"));
  if (!snapshot || typeof snapshot !== "object" || !("sourceCommit" in snapshot) || snapshot.sourceCommit !== revision)
    throw new Error("Catalogue does not match the explicitly selected source commit");
  const directory = path.resolve(assetDirectory ?? path.join(path.dirname(filename), "assets"));
  const result = await catalog.install(snapshot, async (hash) => {
    // Only schema-validated digests reach this callback; never use package paths.
    const asset = path.join(directory, hash);
    if ((await stat(asset)).size > 100 * 1024 * 1024) throw new Error("Workflow asset exceeds 100 MiB");
    return readFile(asset);
  });
  console.log(JSON.stringify(result));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Catalogue installation failed");
  process.exitCode = 1;
}).finally(() => runtime.shutdown());

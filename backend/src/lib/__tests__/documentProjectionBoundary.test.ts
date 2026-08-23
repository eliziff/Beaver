import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = fileURLToPath(new URL("../../", import.meta.url));
const restrictedImport = /["'](?:[^"']*\/)?(documentProjectionPdf|documentProjection|structureNative)(?:\.[cm]?[jt]s)?["']/gu;

// Contraction ratchet: non-service owners are existing bypasses, not architecture.
// Delete their exact entries as each caller moves through documentProjectionService.
const allowedOwners: Record<string, string[]> = {
  documentProjectionPdf: ["lib/documentProjectionService.ts"],
  documentProjection: [
    "lib/documentProjectionService.ts",
    "lib/documentProjectionPdf.ts",
    "lib/providerPdfLibraryBridge.ts",
  ],
  structureNative: [
    "lib/chat/assistantTools.ts",
    "lib/documentProjectionService.ts",
    "lib/legalAmendOps.ts",
    "lib/legalSources/a2aj.ts",
    "lib/legalSources/courtlistener.ts",
    "lib/legalSources/govInfo.ts",
    "lib/legalSources/govUkEmploymentTribunal.ts",
    "lib/legalSources/journal.ts",
    "lib/legalSources/tna.ts",
  ],
};

async function productionFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" ? [] : productionFiles(target);
    }
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
      ? [target]
      : [];
  }));
  return files.flat();
}

describe("document projection boundary", () => {
  it("allows no new production projection or legacy structure bypasses", async () => {
    const imports = new Set<string>();
    for (const file of await productionFiles(src)) {
      const owner = path.relative(src, file).split(path.sep).join("/");
      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(restrictedImport)) {
        imports.add(`${match[1]}:${owner}`);
      }
    }
    const allowed = Object.entries(allowedOwners).flatMap(([module, owners]) =>
      owners.map((owner) => `${module}:${owner}`));
    expect([...imports].sort()).toEqual(allowed.sort());
  });
});

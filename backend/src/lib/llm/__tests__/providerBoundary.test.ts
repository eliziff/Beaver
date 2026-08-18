import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = fileURLToPath(new URL("../../../", import.meta.url));
const providerImport = /["'][^"']*\/llm\/(?:claudeP?|deepseek|gemini|meta|ollamaApi|openai|openrouter)["']/u;

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

describe("LLM provider boundary", () => {
  it("routes production provider calls through lib/llm/index", async () => {
    for (const file of await productionFiles(src)) {
      if (file.startsWith(path.join(src, "lib", "llm"))) continue;
      expect(await readFile(file, "utf8"), file).not.toMatch(providerImport);
    }
  });
});

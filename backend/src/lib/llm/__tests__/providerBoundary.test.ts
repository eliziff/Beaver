import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = fileURLToPath(new URL("../../../", import.meta.url));
const providerImport = /["'][^"']*\/llm\/(?:anthropicWire|claudeP?|deepseek|gemini(?:Wire)?|meta|ollama(?:Api|Models)|openai(?:CompatibleWire|ResponsesWire)?|openrouter|providerLoop)["']/u;
const sdkImport = /from\s+["'](?:@anthropic-ai\/sdk|@google\/genai|openai)["']/u;
const wireAdapter = /(?:anthropic|gemini|openaiCompatible|openaiResponses)Wire\.ts$/u;

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
  it("keeps provider calls behind index and SDKs inside wire adapters", async () => {
    for (const file of await productionFiles(src)) {
      const source = await readFile(file, "utf8");
      if (!file.startsWith(path.join(src, "lib", "llm"))) expect(source, file).not.toMatch(providerImport);
      if (sdkImport.test(source)) expect(file, file).toMatch(wireAdapter);
    }
  });
});

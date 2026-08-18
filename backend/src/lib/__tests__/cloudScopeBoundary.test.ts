import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sources = [
  "../cloudDocumentStore.ts", "../cloudProjectStore.ts", "../cloudChatStore.ts",
  "../cloudTabularStore.ts", "../cloudLibraryStore.ts", "../../routes/audit.ts",
  "../../routes/downloads.ts",
];

describe("cloud data-access boundary", () => {
  it("keeps service-role construction and retired loose access helpers out of consumers", async () => {
    for (const source of sources) {
      const text = await readFile(fileURLToPath(new URL(source, import.meta.url)), "utf8");
      expect(text, source).not.toContain("createServerSupabase");
      expect(text, source).not.toMatch(
        /checkProjectAccess|ensureDocAccess|ensureReviewAccess|filterAccessibleDocumentIds|listAccessibleProjectIds/u,
      );
      expect(text, source).toContain("cloudScope");
    }
  });
});

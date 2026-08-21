import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_DRAFTING_STYLE, normalizeDraftingStyleSettings, resolveDraftingOptions,
} from "../draftingStyle";
import { getDraftingStyleSettings, saveDraftingStyleSettings } from "../draftingStyleStore";
import { LocalDatabase } from "../relationalDatabase";

describe("drafting style settings", () => {
  it("normalizes one versioned object and enforces document-specific options", () => {
    const settings = normalizeDraftingStyleSettings({
      version: 99,
      documents: {
        memo: { citationPlacement: "inline", citationHyperlinks: false, numberHeadings: true },
        letter: { citationPlacement: "after-paragraph" },
      },
      memoHeader: { to: "  General file  ", from: "Counsel" },
    });
    expect(settings).toMatchObject({
      version: 1,
      documents: { memo: { citationPlacement: "inline", citationHyperlinks: false,
        numberHeadings: true }, factum: DEFAULT_DRAFTING_STYLE.documents.factum,
        letter: DEFAULT_DRAFTING_STYLE.documents.letter },
      memoHeader: { to: "General file", from: "Counsel" },
    });
    expect(resolveDraftingOptions({ document_type: "memo" }, settings)).toMatchObject({
      citationPlacement: "inline", citationHyperlinks: false,
      memoHeader: { to: "General file", from: "Counsel" },
    });
    expect(() => resolveDraftingOptions({ document_type: "letter",
      citation_style: "after-paragraph" }, settings)).toThrow("factums");
  });

  it("persists one shared relational contract scoped by user", async () => {
    const db = new LocalDatabase(new DatabaseSync(":memory:"));
    await db.query({ text: `CREATE TABLE user_preferences(user_id text primary key,
      drafting_style text not null,updated_at text not null)`, params: [] });
    const saved = await saveDraftingStyleSettings("user-1", {
      documents: { memo: { citationPlacement: "none" } },
      memoHeader: { to: "Matter file", from: "Beaver" },
    }, db);
    expect(await getDraftingStyleSettings("user-1", db)).toEqual(saved);
    expect(await getDraftingStyleSettings("user-2", db)).toEqual(DEFAULT_DRAFTING_STYLE);
    await db.close();
  });
});

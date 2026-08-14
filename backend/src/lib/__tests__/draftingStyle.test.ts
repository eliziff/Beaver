import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

const mode = vi.hoisted(() => ({ local: vi.fn(() => false) }));
vi.mock("../localMode", () => ({ isAnonymousLocalMode: mode.local }));

import {
  DEFAULT_DRAFTING_STYLE,
  normalizeDraftingStyleSettings,
  resolveDraftingOptions,
} from "../draftingStyle";
import {
  getDraftingStyleSettings,
  saveDraftingStyleSettings,
} from "../draftingStyleStore";

let temporary: string | null = null;
const originalDataDir = process.env.MIKE_LOCAL_DATA_DIR;

afterEach(async () => {
  mode.local.mockReturnValue(false);
  if (temporary) await rm(temporary, { recursive: true, force: true });
  temporary = null;
  if (originalDataDir === undefined) delete process.env.MIKE_LOCAL_DATA_DIR;
  else process.env.MIKE_LOCAL_DATA_DIR = originalDataDir;
});

describe("drafting style settings", () => {
  it("normalizes one versioned object and enforces document-specific options", () => {
    const settings = normalizeDraftingStyleSettings({
      version: 99,
      documents: {
        memo: { citationPlacement: "inline", numberHeadings: true },
        letter: { citationPlacement: "after-paragraph" },
      },
      memoHeader: { to: "  General file  ", from: "Counsel" },
    });

    expect(settings).toMatchObject({
      version: 1,
      documents: {
        memo: { citationPlacement: "inline", numberHeadings: true },
        factum: DEFAULT_DRAFTING_STYLE.documents.factum,
        letter: DEFAULT_DRAFTING_STYLE.documents.letter,
      },
      memoHeader: { to: "General file", from: "Counsel" },
    });
    expect(resolveDraftingOptions({ document_type: "memo" }, settings)).toMatchObject({
      citationPlacement: "inline",
      citationHyperlinks: true,
      memoHeader: { to: "General file", from: "Counsel" },
    });
    expect(() => resolveDraftingOptions({
      document_type: "letter",
      citation_style: "after-paragraph",
    }, settings)).toThrow("factums");
  });

  it("persists the same normalized contract in account-free local mode", async () => {
    mode.local.mockReturnValue(true);
    temporary = await mkdtemp(path.join(os.tmpdir(), "beaver-drafting-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporary;

    const saved = await saveDraftingStyleSettings("local-user", {
      documents: { memo: { citationPlacement: "none" } },
      memoHeader: { to: "Matter file", from: "Beaver" },
    });
    const loaded = await getDraftingStyleSettings("local-user");

    expect(loaded).toEqual(saved);
    expect(JSON.parse(await readFile(
      path.join(temporary, "drafting-style.json"),
      "utf8",
    ))).toEqual(saved);
  });

  it("persists the same normalized contract through the cloud profile port", async () => {
    let stored: unknown = null;
    const db = {
      from: () => ({
        update: (row: { drafting_style: unknown }) => ({
          eq: async () => {
            stored = row.drafting_style;
            return { error: null };
          },
        }),
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { drafting_style: stored },
              error: null,
            }),
          }),
        }),
      }),
    };

    const saved = await saveDraftingStyleSettings(
      "cloud-user",
      { memoHeader: { to: "Cloud file", from: "Assistant" } },
      db as never,
    );
    expect(await getDraftingStyleSettings("cloud-user", db as never)).toEqual(saved);
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { afterEach, describe, expect, it, vi } from "vitest";

const userId = "00000000-0000-0000-0000-000000000001";

let home: string | null = null;

afterEach(async () => {
  try {
    (await import("../../localApplicationDatabase"))
      .closeLocalApplicationDatabase();
  } catch {}
  delete process.env.MIKE_LOCAL_DATA_DIR;
  delete process.env.OPEN_LEGAL_DATA_HOME;
  vi.resetModules();
  if (home) {
    await rm(home, { recursive: true, force: true });
    home = null;
  }
});

const docxFrom = (paragraphs: string[]) =>
  Packer.toBuffer(
    new Document({
      sections: [
        {
          children: paragraphs.map(
            (text) => new Paragraph({ children: [new TextRun(text)] }),
          ),
        },
      ],
    }),
  );

describe("executeCompareVersionsTool", () => {
  it("compares in memory unless a durable redline is requested", async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "beaver-compare-tool-"));
    process.env.MIKE_LOCAL_DATA_DIR = home;
    process.env.OPEN_LEGAL_DATA_HOME = home;
    vi.resetModules();
    const store = await import("../../__tests__/support/localDocumentFixtures");
    const { executeCompareVersionsTool } = await import(
      "../tools/compareVersionsTool"
    );
    const { localDocuments } = await import(
      "../../__tests__/support/localDocumentFixtures"
    );

    const document = await store.createLocalDocument({
      userId,
      kind: "file",
      filename: "engagement-letter.docx",
      bytes: await docxFrom([
        "The fee is $5,000 payable on execution.",
        "Notices go to 100 King Street West.",
      ]),
    });

    const early = await executeCompareVersionsTool(
      localDocuments,
      { userId },
      "compare_versions",
      { document_id: document.id },
    );
    expect(early).toMatchObject({ ok: false, error: "no_prior_version" });

    await store.addLocalVersion({
      userId,
      documentId: document.id,
      filename: "engagement-letter.docx",
      bytes: await docxFrom([
        "The fee is $7,500 payable on execution.",
        "Notices go to 100 King Street West.",
      ]),
    });

    const reply = await executeCompareVersionsTool(
      localDocuments,
      { userId },
      "compare_versions",
      { document_id: document.id },
    );
    expect(reply).toMatchObject({ ok: true });
    expect(reply?.changes_total).toBeGreaterThan(0);
    expect(reply).not.toHaveProperty("document_id");
    const saved = await executeCompareVersionsTool(
      localDocuments,
      { userId },
      "compare_versions",
      { document_id: document.id, save_redline: true },
    );
    expect(String(saved?.filename)).toContain("(redline)");
    const listed = await store.pageLocalDocuments(userId, ["file"], {
      q: "", limit: 50, after: null,
    });
    expect(
      listed.items.some((doc) => doc.id === saved?.document_id),
    ).toBe(true);
  });

  it("ignores foreign tool names", async () => {
    const { executeCompareVersionsTool } = await import(
      "../tools/compareVersionsTool"
    );
    const { localDocuments } = await import(
      "../../__tests__/support/localDocumentFixtures"
    );
    expect(
      await executeCompareVersionsTool(
        localDocuments, { userId }, "library_read", {},
      ),
    ).toBeNull();
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { afterEach, describe, expect, it, vi } from "vitest";

const userId = "00000000-0000-0000-0000-000000000001";

let home: string | null = null;

afterEach(async () => {
  try {
    (await import("../../sqliteDatabase")).closeSqliteDatabase();
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

describe("compareDocumentVersions", () => {
  it("compares in memory unless a durable redline is requested", async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "beaver-compare-tool-"));
    process.env.MIKE_LOCAL_DATA_DIR = home;
    process.env.OPEN_LEGAL_DATA_HOME = home;
    vi.resetModules();
    const store = await import("../../__tests__/support/localDocumentFixtures");
    const { compareDocumentVersions } = await import(
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

    const early = await compareDocumentVersions(
      localDocuments,
      { userId },
      {
        documentId: document.id,
        newVersionId: document.current_version_id,
      },
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

    const versions = await store.listLocalVersions(userId, document.id);
    const newVersionId = versions!.current_version_id;
    const reply = await compareDocumentVersions(
      localDocuments,
      { userId },
      { documentId: document.id, newVersionId },
    );
    expect(reply).toMatchObject({ ok: true });
    expect(reply?.changes_total).toBeGreaterThan(0);
    expect(reply).not.toHaveProperty("document_id");
    const saved = await compareDocumentVersions(
      localDocuments,
      { userId },
      { documentId: document.id, newVersionId, saveRedline: true },
    );
    expect(String(saved?.filename)).toContain("(redline)");
    expect(await localDocuments.read(
      { userId }, String(saved?.document_id), null, false,
    )).not.toBeNull();
  });

});

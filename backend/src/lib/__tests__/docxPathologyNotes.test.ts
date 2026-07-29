// Phase 3 integration (3i-1): the pathology sniffer's notes_of_caution ride
// along on document reads as additive metadata. The extracted text stays
// byte-identical — these tests hold both halves of that contract on the
// local (library_*) and Supabase (read_document) paths.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { pathologyFixtureBuilders } from "./fixtures/docx-pathologies/generate";

const userId = "00000000-0000-0000-0000-000000000001";

const MANUAL_REDLINE_NOTE =
  "2 runs are struck and 2 runs carry a red colour without tracked-change markup; the edit intent is formatting only.";

let temporaryDirectory: string | null = null;

async function isolatedHome() {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-notes-"));
  process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
  vi.resetModules();
}

afterEach(async () => {
  delete process.env.MIKE_LOCAL_DATA_DIR;
  vi.doUnmock("../storage");
  vi.resetModules();
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  }
});

describe("pathology notes on local library reads", () => {
  it("carries the manual-redline note and keeps the text byte-identical", async () => {
    await isolatedHome();
    const redlineBytes =
      await pathologyFixtureBuilders["manual-red-strike-redline"]();
    const cleanBytes = await pathologyFixtureBuilders.clean();
    const store = await import("../localDocumentStore");
    const { runLocalAssistantTools } = await import(
      "../chat/localAssistantTools"
    );
    const { extractDocxBodyText } = await import("../docxTrackedChanges");

    const redline = await store.createLocalDocument({
      userId,
      kind: "file",
      filename: "notice-redline.docx",
      bytes: redlineBytes,
    });
    const clean = await store.createLocalDocument({
      userId,
      kind: "file",
      filename: "costs-clean.docx",
      bytes: cleanBytes,
    });

    const [redlineRead, cleanRead] = await runLocalAssistantTools(userId, [
      { id: "r1", name: "library_read", input: { document_id: redline.id } },
      { id: "r2", name: "library_read", input: { document_id: clean.id } },
    ]);

    const redlineResult = JSON.parse(redlineRead.content);
    expect(redlineResult.ok).toBe(true);
    expect(redlineResult.notes_of_caution).toContain(MANUAL_REDLINE_NOTE);
    // Additive metadata only: the text is exactly what the reader always
    // produced (struck runs still read as operative here — the redline
    // view, not the default text, is where that changes).
    expect(redlineResult.text).toBe(await extractDocxBodyText(redlineBytes));

    const cleanResult = JSON.parse(cleanRead.content);
    expect(cleanResult.ok).toBe(true);
    expect(cleanResult).not.toHaveProperty("notes_of_caution");
    expect(cleanResult.text).toBe(await extractDocxBodyText(cleanBytes));
  });

  it("attaches the same block to library_find and library_outline results", async () => {
    await isolatedHome();
    const bytes = await pathologyFixtureBuilders["manual-red-strike-redline"]();
    const store = await import("../localDocumentStore");
    const { runLocalAssistantTools } = await import(
      "../chat/localAssistantTools"
    );
    const document = await store.createLocalDocument({
      userId,
      kind: "file",
      filename: "notice-redline.docx",
      bytes,
    });

    const [find, outline] = await runLocalAssistantTools(userId, [
      {
        id: "f1",
        name: "library_find",
        input: { document_id: document.id, query: "notice period" },
      },
      {
        id: "o1",
        name: "library_outline",
        input: { document_id: document.id },
      },
    ]);
    expect(JSON.parse(find.content).notes_of_caution).toContain(
      MANUAL_REDLINE_NOTE,
    );
    expect(JSON.parse(outline.content).notes_of_caution).toContain(
      MANUAL_REDLINE_NOTE,
    );
  });

  it("keeps reading, without notes, when the cached report is not JSON", async () => {
    await isolatedHome();
    const bytes = await pathologyFixtureBuilders["manual-red-strike-redline"]();
    const store = await import("../localDocumentStore");
    const { cachedParse } = await import("../parseCache");
    const { runLocalAssistantTools } = await import(
      "../chat/localAssistantTools"
    );
    const document = await store.createLocalDocument({
      userId,
      kind: "file",
      filename: "notice-redline.docx",
      bytes,
    });
    // Poison the exact cache identity the helper uses; the hit proves the
    // identity and the read proves the tolerance.
    await cachedParse({
      scope: `user:${userId}`,
      parser: "docx-pathology",
      version: 1,
      bytes,
      parse: async () => "not json",
    });

    const [read] = await runLocalAssistantTools(userId, [
      { id: "r1", name: "library_read", input: { document_id: document.id } },
    ]);
    const parsed = JSON.parse(read.content);
    expect(parsed.ok).toBe(true);
    expect(parsed).not.toHaveProperty("notes_of_caution");
    expect(parsed.text).toContain("The notice period is");
  });
});

describe("pathology notes on Supabase document reads", () => {
  const docStore = new Map([
    [
      "doc-0",
      {
        storage_path: "docs/notice-redline.docx",
        file_type: "docx",
        filename: "notice-redline.docx",
      },
    ],
    [
      "doc-1",
      {
        storage_path: "docs/costs-clean.docx",
        file_type: "docx",
        filename: "costs-clean.docx",
      },
    ],
  ]);
  const emit = () => {};

  async function mockStorage(fixtures: Record<string, Buffer>) {
    vi.doMock("../storage", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../storage")>()),
      downloadFile: async (key: string) => {
        const bytes = fixtures[key];
        if (!bytes) return null;
        return bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        );
      },
    }));
  }

  it("prefixes the labeled block and keeps the text tail byte-identical", async () => {
    await isolatedHome();
    const redlineBytes =
      await pathologyFixtureBuilders["manual-red-strike-redline"]();
    const cleanBytes = await pathologyFixtureBuilders.clean();
    await mockStorage({
      "docs/notice-redline.docx": redlineBytes,
      "docs/costs-clean.docx": cleanBytes,
    });
    const { readDocumentContent } = await import("../chat/tools/documentOps");
    const { extractDocxBodyText } = await import("../docxTrackedChanges");

    const redlineText = await readDocumentContent("doc-0", docStore, emit);
    expect(
      redlineText.startsWith('[Document notes for "notice-redline.docx"]:'),
    ).toBe(true);
    expect(redlineText).toContain(`- ${MANUAL_REDLINE_NOTE}`);
    expect(
      redlineText.endsWith(await extractDocxBodyText(redlineBytes)),
    ).toBe(true);

    // A clean document reads back byte-identical, no block at all.
    expect(await readDocumentContent("doc-1", docStore, emit)).toBe(
      await extractDocxBodyText(cleanBytes),
    );
  });

  it("keeps find_in_document offsets anchored into pure text", async () => {
    await isolatedHome();
    const redlineBytes =
      await pathologyFixtureBuilders["manual-red-strike-redline"]();
    await mockStorage({ "docs/notice-redline.docx": redlineBytes });
    const { findInDocumentContent } = await import(
      "../chat/tools/documentOps"
    );
    const { extractDocxBodyText } = await import("../docxTrackedChanges");
    const body = await extractDocxBodyText(redlineBytes);

    const found = JSON.parse(
      await findInDocumentContent({
        docLabel: "doc-0",
        query: "notice period",
        docStore,
        emit,
      }),
    );
    expect(found.ok).toBe(true);
    expect(found.total_matches).toBe(1);
    const hit = found.hits[0];
    expect(body.slice(hit.at, hit.at + hit.excerpt.length)).toBe(hit.excerpt);
  });
});

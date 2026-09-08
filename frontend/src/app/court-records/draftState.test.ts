// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { WorkProduct, WorkProductInput, WorkProductStore } from "@/app/lib/workProducts";
import { applySourceEntryFields, courtRecordDraft, courtRecordDraftFromDocuments,
  restoreCourtRecordDraft } from "./draftState";
import type { CourtRecordsHost } from "./host";
import type { CourtRecordDraft, RecordEntry } from "./types";

const input: WorkProductInput = {
  kind: "local-file",
  handleId: "handle-1",
  lastSeen: { name: "motion.pdf", size: 4, modified: 12 },
};
const store = {} as WorkProductStore;

function product(state: CourtRecordDraft): WorkProduct<CourtRecordDraft> {
  return {
    id: crypto.randomUUID(), kind: "court-record", title: "Motion record", projectId: null,
    revision: 1, state, outputs: {}, createdAt: "2026-08-30T00:00:00Z",
    updatedAt: "2026-08-30T00:00:00Z",
  };
}

function entry(): RecordEntry {
  return {
    id: "entry-1", kindId: "motion", title: "Notice of motion",
    file: new File(["test"], "motion.pdf", { type: "application/pdf", lastModified: 12 }),
    pageCount: 1, searchable: true, encrypted: false, binding: input,
  };
}

describe("court record draft state", () => {
  it("keeps contextual documents durable without assigning a filing slot", () => {
    const state = courtRecordDraftFromDocuments("fc-motion-record-moving", [
      { id: "notice", filename: "Notice.docx", size_bytes: 42,
        created_at: "2026-08-30T01:02:03.000Z", source_sha256: "a".repeat(64) },
      { id: "record", filename: "Record.pdf" },
    ]);

    expect(state).toEqual({ profileId: "fc-motion-record-moving", cover: {}, entries: [
      { id: "notice", kindId: "unassigned", title: "Notice", lastSeen: {
        name: "Notice.docx", size: 42, modified: Date.parse("2026-08-30T01:02:03.000Z"),
        sha256: "a".repeat(64),
      } },
      { id: "record", kindId: "unassigned", title: "Record",
        lastSeen: { name: "Record.pdf", size: 0, modified: 0 } },
    ], bindings: {
      notice: { kind: "document", documentId: "notice", version: "latest" },
      record: { kind: "document", documentId: "record", version: "latest" },
    } });
  });

  it("persists intent and bindings without serializing source bytes", () => {
    const state = courtRecordDraft("fc-motion-record-moving", { courtFileNumber: "T-1-26" },
      [{ ...entry(), nonTextPagesConfirmed: true }]);
    expect(state).toMatchObject({
      profileId: "fc-motion-record-moving",
      entries: [{ id: "entry-1", title: "Notice of motion",
        nonTextPagesConfirmed: true,
        lastSeen: { name: "motion.pdf", size: 4, modified: 12 } }],
      bindings: { "entry-1": input },
    });
    expect(JSON.stringify(state)).not.toContain("test");
  });

  it("persists a lawyer-supplied Rule 70 page count", () => {
    const state = courtRecordDraft("fc-application-record-applicant", {}, [{ ...entry(),
      kindId: "memorandum", rule70CountedPages: 30 }]);

    expect(state.entries[0].rule70CountedPages).toBe(30);
  });

  it("propagates filing descriptions and dates without replacing lawyer edits", () => {
    const previous = { cover: {}, exhibitLabels: [], entryTitle: "NOTICE OF MOTION",
      entryDate: "August 30, 2026" };
    const next = { cover: {}, exhibitLabels: [], entryTitle: "AMENDED NOTICE OF MOTION",
      entryDate: "September 4, 2026" };
    const filing = { ...entry(), kindId: "notice-motion", title: previous.entryTitle,
      date: previous.entryDate, sourceFields: next };
    expect(applySourceEntryFields(filing, undefined, previous)).toMatchObject({
      title: next.entryTitle, date: next.entryDate,
    });
    expect(applySourceEntryFields({ ...filing, title: "My description",
      date: "My date" }, undefined, previous)).toMatchObject({
        title: "My description", date: "My date",
      });
    expect(applySourceEntryFields({ ...filing, kindId: "authority-extract" },
      undefined, previous)).toMatchObject({ title: previous.entryTitle,
        date: previous.entryDate });
  });

  it("persists detected and manually extended exhibit slots as one fixed sequence", () => {
    const sourceSha256 = "a".repeat(64);
    const affidavit = { ...entry(), id: "affidavit", kindId: "affidavit",
      binding: { kind: "local-file" as const, handleId: "affidavit-file",
        lastSeen: { name: "affidavit.pdf", size: 4, modified: 12, sha256: sourceSha256 } },
      sourceFields: { cover: {}, exhibitLabels: ["A", "C"] },
      sourceExhibits: { sourceSha256, labels: ["A", "B", "C", "D"] } };
    const exhibit = { ...entry(), id: "exhibit-c", kindId: "exhibit", exhibitLabel: "c" };

    const state = courtRecordDraft("ab-kb-affidavit-exhibits", {}, [affidavit, exhibit]);

    expect(state.entries).toMatchObject([
      { id: "affidavit", sourceExhibits: { sourceSha256, labels: ["A", "B", "C", "D"] },
        lastSeen: { sha256: sourceSha256 } },
      { id: "exhibit-c", exhibitLabel: "C" },
    ]);
  });

  it("retains missing source slots but replaces them when the affidavit bytes change", async () => {
    const oldSha = "a".repeat(64), newSha = "b".repeat(64);
    const oldInput = { kind: "local-file" as const, handleId: "affidavit-file",
      lastSeen: { name: "affidavit.pdf", size: 4, modified: 12, sha256: oldSha } };
    const affidavit = { ...entry(), id: "affidavit", kindId: "affidavit", binding: oldInput,
      sourceFields: { cover: {}, exhibitLabels: ["A", "C"] } };
    const state = courtRecordDraft("ab-kb-affidavit-exhibits", {}, [affidavit]);
    const missingHost = { mode: "standalone", drafts: store, prepareDeviceFile: vi.fn(),
      resolveInput: vi.fn().mockResolvedValue({ status: "missing", reason: "permission" }),
    } satisfies CourtRecordsHost;
    expect((await restoreCourtRecordDraft(product(state), missingHost))[0].sourceExhibits)
      .toEqual({ sourceSha256: oldSha, labels: ["A", "B", "C"] });

    const file = new File(["new"], "affidavit.pdf", { lastModified: 13 });
    const nextInput = { ...oldInput, lastSeen: { name: file.name, size: file.size,
      modified: file.lastModified, sha256: newSha } };
    const changedHost = { mode: "standalone", drafts: store,
      resolveInput: vi.fn().mockResolvedValue({ status: "changed", file, input: nextInput }),
      prepareDeviceFile: vi.fn().mockResolvedValue({ file, pageCount: 1, searchable: true,
        encrypted: false, origin: { kind: "device" },
        sourceFields: { cover: {}, exhibitLabels: ["A"] } }),
    } satisfies CourtRecordsHost;
    expect((await restoreCourtRecordDraft(product(state), changedHost))[0].sourceExhibits)
      .toEqual({ sourceSha256: newSha, labels: ["A"] });
  });

  it("retains a missing slot and its description for relinking", async () => {
    const state = courtRecordDraft("fc-motion-record-moving", {}, [entry()]);
    const host = {
      mode: "standalone", drafts: store, prepareDeviceFile: vi.fn(),
      resolveInput: vi.fn().mockResolvedValue({ status: "missing", reason: "permission" }),
    } satisfies CourtRecordsHost;
    const [restored] = await restoreCourtRecordDraft(product(state), host);
    expect(restored).toMatchObject({
      id: "entry-1", title: "Notice of motion", inputStatus: "missing",
      missingReason: "permission", binding: input,
    });
    expect(restored.file.name).toBe("motion.pdf");
    expect(host.prepareDeviceFile).not.toHaveBeenCalled();
  });

  it("surfaces an operational restore failure instead of inventing a missing file", async () => {
    const state = courtRecordDraft("fc-motion-record-moving", {}, [entry()]);
    const failure = new Error("Library unavailable");
    const host = { mode: "beaver", drafts: store, prepareDeviceFile: vi.fn(),
      resolveInput: vi.fn().mockRejectedValue(failure) } satisfies CourtRecordsHost;

    await expect(restoreCourtRecordDraft(product(state), host)).rejects.toBe(failure);
  });

  it("flags a retained file whose metadata changed", async () => {
    const state = courtRecordDraft("fc-motion-record-moving", {},
      [{ ...entry(), nonTextPagesConfirmed: true }]);
    const current = new File(["changed"], "motion.pdf", { type: "application/pdf", lastModified: 99 });
    const host = {
      mode: "standalone", drafts: store,
      resolveInput: vi.fn().mockResolvedValue({ status: "changed", file: current, input }),
      prepareDeviceFile: vi.fn().mockResolvedValue({
        file: current, pageCount: 1, searchable: true, encrypted: false,
        origin: { kind: "device" },
      }),
    } satisfies CourtRecordsHost;
    const [restored] = await restoreCourtRecordDraft(product(state), host);
    expect(restored.inputStatus).toBe("changed");
    expect(restored.file.lastModified).toBe(99);
    expect(restored.nonTextPagesConfirmed).toBeUndefined();
  });

  it("reuses prepared sources when only assistant-editable fields changed", async () => {
    const existing = entry();
    const state = courtRecordDraft("fc-motion-record-moving", {}, [existing]);
    state.entries[0].title = "Assistant description";
    const host = { mode: "standalone", drafts: store, resolveInput: vi.fn(),
      prepareDeviceFile: vi.fn() } satisfies CourtRecordsHost;

    const [restored] = await restoreCourtRecordDraft(product(state), host, undefined, [existing]);

    expect(restored).toMatchObject({ title: "Assistant description", file: existing.file,
      pageCount: 1, searchable: true });
    expect(host.resolveInput).not.toHaveBeenCalled();
  });

  it("restores a large record without exhausting preparation capacity", async () => {
    const sources = Array.from({ length: 12 }, (_, index) => {
      const file = new File(["test"], `source-${index}.pdf`, { lastModified: index + 1 });
      return { ...entry(), id: `entry-${index}`, file,
        binding: { kind: "local-file" as const, handleId: `handle-${index}`,
          lastSeen: { name: file.name, size: file.size, modified: file.lastModified } } };
    });
    const state = courtRecordDraft("fc-motion-record-moving", {}, sources);
    let active = 0, peak = 0;
    const host = {
      mode: "standalone", drafts: store,
      resolveInput: vi.fn(async (binding: WorkProductInput) => ({ status: "ready" as const,
        file: sources.find((source) => source.binding === binding)!.file, input: binding })),
      prepareDeviceFile: vi.fn(async (file: File) => {
        active += 1; peak = Math.max(peak, active);
        if (active > 4) { active -= 1; throw new Error("service busy"); }
        await Promise.resolve();
        active -= 1;
        return { file, pageCount: 1, searchable: true, encrypted: false };
      }),
    } satisfies CourtRecordsHost;

    const restored = await restoreCourtRecordDraft(product(state), host);

    expect(restored).toHaveLength(sources.length);
    expect(restored.every(({ inputStatus }) => inputStatus === "ready")).toBe(true);
    expect(peak).toBe(4);
  });

  it("restores a textless source for eager workspace OCR", async () => {
    const state = courtRecordDraft("fc-motion-record-moving", {}, [entry()]);
    const file = entry().file;
    const host = {
      mode: "standalone", drafts: store,
      resolveInput: vi.fn().mockResolvedValue({ status: "ready", file, input }),
      prepareDeviceFile: vi.fn().mockResolvedValue({ file, pageCount: 1,
        searchable: false, encrypted: false, textlessPageCount: 1, textlessPages: [1] }),
      runOcr: vi.fn().mockResolvedValue({ searchable: true, textlessPageCount: 0,
        textlessPages: [], ocrTextByPage: ["Notice of motion"] }),
    } satisfies CourtRecordsHost;

    const [restored] = await restoreCourtRecordDraft(product(state), host);

    expect(host.runOcr).not.toHaveBeenCalled();
    expect(restored).toMatchObject({ inputStatus: "ready", searchable: false,
      textlessPageCount: 1, textlessPages: [1] });
  });

  it("keeps a retained textless source ready for eager workspace OCR", async () => {
    const existing = { ...entry(), searchable: false, textlessPageCount: 1,
      textlessPages: [1] };
    const state = courtRecordDraft("fc-motion-record-moving", {}, [existing]);
    const host = {
      mode: "standalone", drafts: store, resolveInput: vi.fn(), prepareDeviceFile: vi.fn(),
      runOcr: vi.fn().mockRejectedValue(new Error("OCR unavailable")),
    } satisfies CourtRecordsHost;

    const [restored] = await restoreCourtRecordDraft(product(state), host, undefined, [existing]);

    expect(restored).toMatchObject({ inputStatus: "ready", searchable: false,
      textlessPages: [1] });
    expect(host.resolveInput).not.toHaveBeenCalled();
  });
});

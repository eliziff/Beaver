// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { WorkProduct, WorkProductInput, WorkProductStore } from "@/app/lib/workProducts";
import { courtRecordDraft, restoreCourtRecordDraft } from "./draftState";
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
  it("persists intent and bindings without serializing source bytes", () => {
    const state = courtRecordDraft("fc-motion-record-moving", { courtFileNumber: "T-1-26" }, [entry()]);
    expect(state).toMatchObject({
      profileId: "fc-motion-record-moving",
      entries: [{ id: "entry-1", title: "Notice of motion",
        lastSeen: { name: "motion.pdf", size: 4, modified: 12 } }],
      bindings: { "entry-1": input },
    });
    expect(JSON.stringify(state)).not.toContain("test");
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

  it("flags a retained file whose metadata changed", async () => {
    const state = courtRecordDraft("fc-motion-record-moving", {}, [entry()]);
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
  });
});

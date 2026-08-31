// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { WorkProduct, WorkProductStore } from "@/app/lib/workProducts";
import type { CourtRecordsHost } from "./host";
import { CourtRecordsWorkspace } from "./CourtRecordsWorkspace";
import type { CourtRecordDraft } from "./types";

const mocks = vi.hoisted(() => ({ build: vi.fn(), download: vi.fn() }));
vi.mock("./assembly", () => ({ buildCourtRecord: mocks.build }));
vi.mock("./host", async (original) => ({
  ...await original<typeof import("./host")>(), downloadArtifact: mocks.download,
}));

const saved = (id: string): WorkProduct<CourtRecordDraft> => ({
  id, kind: "court-record", title: id, projectId: null, revision: 1,
  state: { profileId: "general-court-record", cover: {}, entries: [], bindings: {} },
  outputs: {}, createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
});

describe("CourtRecordsWorkspace", () => {
  it("opens the requested saved draft first", async () => {
    const drafts = [saved("first"), saved("requested")];
    const store = {
      list: vi.fn(async () => drafts), get: vi.fn(), create: vi.fn(), update: vi.fn(),
      duplicate: vi.fn(), remove: vi.fn(),
    } as unknown as WorkProductStore;
    const host = { mode: "standalone", drafts: store,
      prepareDeviceFile: vi.fn(), resolveInput: vi.fn() } as unknown as CourtRecordsHost;
    const onDraftChange = vi.fn();

    render(<CourtRecordsWorkspace host={host} initialDraftId="requested"
      onDraftChange={onDraftChange} />);

    await waitFor(() => expect(onDraftChange).toHaveBeenCalledWith(drafts[1]));
    expect(store.create).not.toHaveBeenCalled();
  });

  it("keeps the saved build revision and refuses a stale download", async () => {
    const file = new File(["%PDF"], "Authorities.pdf", {
      type: "application/pdf", lastModified: 1,
    });
    const input = { kind: "work-product-output" as const,
      workProductId: "authorities", role: "book" };
    const prepared = { file, pageCount: 1, searchable: true, encrypted: false,
      textlessPageCount: 0, textlessPages: [], binding: input,
      origin: { kind: "library" as const, documentId: "book", versionId: "version-1",
        sourceSha256: "a".repeat(64) } };
    const draft: WorkProduct<CourtRecordDraft> = {
      ...saved("record"), state: { profileId: "general-court-record", cover: {
        courtName: "Federal Court", courtFileNumber: "T-1-26", recordTitle: "Record",
        partyStyleId: "application", partyGroups: [
          { id: "party-a", role: "Applicant", parties: [{ id: "a", name: "Applicant" }] },
          { id: "party-b", role: "Respondent", parties: [{ id: "b", name: "Respondent" }] },
        ], filingPartyId: "a",
      }, entries: [{ id: "entry", kindId: "document", title: "Authorities",
        lastSeen: { name: file.name, size: file.size, modified: file.lastModified,
          sha256: "a".repeat(64) } }], bindings: { entry: input } },
    };
    const artifact = { role: "record", filename: "Court record.pdf",
      mimeType: "application/pdf" as const, bytes: new Uint8Array([1]), pageCount: 1,
      sha256: "f".repeat(64) };
    const savedBuild: WorkProduct<CourtRecordDraft> = { ...draft, revision: 2,
      updatedAt: "2026-08-30T00:01:00.000Z", outputs: { record: {
        documentId: "built-record", versionId: "version-2", filename: artifact.filename,
        mimeType: artifact.mimeType, sha256: artifact.sha256, pageCount: 1,
      } } };
    mocks.build.mockResolvedValue({ artifacts: [artifact], receipt: {
      sources: [{ order: 0, entryId: "entry", filename: file.name, title: "Authorities",
        kindId: "document", sha256: "a".repeat(64), mimeType: file.type,
        byteCount: file.size, pageCount: 1, origin: prepared.origin, ocrAppliedPages: [] }],
    } });
    const resolveInput = vi.fn().mockResolvedValue({ status: "ready", file, input, prepared });
    const saveArtifacts = vi.fn(async () => ({ documents: [], product: savedBuild,
      outputs: { record: { documentId: "built-record", versionId: "version-2" } } }));
    const store = { list: vi.fn(async () => [draft]), get: vi.fn(), create: vi.fn(),
      update: vi.fn(), duplicate: vi.fn(), remove: vi.fn() } as unknown as WorkProductStore;
    const host = { mode: "beaver", drafts: store, prepareDeviceFile: vi.fn(),
      resolveInput, saveArtifacts } as unknown as CourtRecordsHost;
    const onDraftChange = vi.fn();
    const user = userEvent.setup();
    render(<CourtRecordsWorkspace host={host} onDraftChange={onDraftChange} />);

    await user.click(await screen.findByRole("button", { name: "Build record" }));
    const download = await screen.findByRole("button", { name: /Court record\.pdf/iu });
    await user.click(screen.getByRole("button", { name: "Save to Library" }));
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith(savedBuild));
    expect(saveArtifacts).toHaveBeenCalledOnce();
    expect(store.update).not.toHaveBeenCalled();
    resolveInput.mockResolvedValue({ status: "missing", reason: "unavailable" });
    await user.click(download);

    expect(mocks.download).not.toHaveBeenCalled();
    expect(await screen.findByText("Rebuild the source draft")).toBeVisible();
  });

  it("automatically OCRs a textless upload", async () => {
    const draft = saved("ocr");
    const store = { list: vi.fn(async () => [draft]), get: vi.fn(), create: vi.fn(),
      update: vi.fn(), duplicate: vi.fn(), remove: vi.fn() } as unknown as WorkProductStore;
    const prepareDeviceFile = vi.fn(async (file: File) => ({ file, pageCount: 1,
      searchable: false, encrypted: false, textlessPageCount: 1, textlessPages: [1],
      origin: { kind: "device" as const } }));
    const runOcr = vi.fn(async () => ({ searchable: true, textlessPageCount: 0,
      textlessPages: [], ocrAppliedPages: [1] }));
    const host = { mode: "standalone", drafts: store, prepareDeviceFile, runOcr,
      resolveInput: vi.fn() } as unknown as CourtRecordsHost;
    render(<CourtRecordsWorkspace host={host} />);

    await waitFor(() => expect(document.getElementById("court-record-document-file"))
      .toBeInTheDocument());
    const input = document.getElementById("court-record-document-file")!;
    fireEvent.change(input, { target: { files: [new File(["scan"], "scan.pdf",
      { type: "application/pdf" })] } });

    await waitFor(() => expect(runOcr).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button", { name: "OCR text pages" })).not.toBeInTheDocument();
  });

  it("fills empty affidavit details and explicit exhibit slots without guessing from filenames", async () => {
    const draft: WorkProduct<CourtRecordDraft> = {
      ...saved("affidavit"),
      state: { profileId: "ab-kb-affidavit-exhibits", cover: { deponent: "Edited deponent" },
        entries: [], bindings: {} },
    };
    const store = { list: vi.fn(async () => [draft]), get: vi.fn(), create: vi.fn(),
      update: vi.fn(async (_id, update) => ({ ...draft, revision: 2, state: update.state })),
      duplicate: vi.fn(), remove: vi.fn() } as unknown as WorkProductStore;
    const prepared = (file: File, sourceFields?: object) => ({ file, pageCount: 1,
      searchable: true, encrypted: false, textlessPageCount: 0, textlessPages: [],
      sourceBookmarks: [], origin: { kind: "device" as const }, sourceFields });
    const prepareDeviceFile = vi.fn(async (file: File) => prepared(file,
      file.name === "affidavit.pdf" ? {
        cover: { courtFileNumber: "2401-12345", deponent: "Source deponent" },
        partyStyleId: "action", parties: { first: "Alpha Person", second: "Beta Person" },
        exhibitLabels: ["A", "B"],
        entryTitle: "Affidavit of Source deponent", entryDate: "January 2, 2026",
      } : file.name === "source-labelled.pdf"
        ? { cover: {}, explicitExhibitLabel: "A" } : undefined));
    const host = { mode: "standalone", drafts: store, prepareDeviceFile,
      resolveInput: vi.fn() } as unknown as CourtRecordsHost;
    render(<CourtRecordsWorkspace host={host} />);

    await waitFor(() => expect(screen.getByLabelText(/Deponent/iu)).toHaveValue("Edited deponent"));
    fireEvent.change(document.querySelector<HTMLInputElement>("[data-kind-id=affidavit] input[type=file]")!, {
      target: { files: [new File(["affidavit"], "affidavit.pdf", { type: "application/pdf" })] },
    });

    await waitFor(() => expect(screen.getByLabelText(/Court file number/iu)).toHaveValue("2401-12345"));
    expect(screen.getByLabelText(/Deponent/iu)).toHaveValue("Edited deponent");
    expect(screen.getByLabelText("Contents description")).toHaveValue("Affidavit of Source deponent");
    expect(document.querySelector<HTMLInputElement>("[data-party-group=Plaintiff] input"))
      .toHaveValue("Alpha Person");
    const exhibits = [new File(["a"], "source-labelled.pdf", { type: "application/pdf" }),
      new File(["b"], "Exhibit B.pdf", { type: "application/pdf" })];
    fireEvent.change(document.querySelector<HTMLInputElement>("[data-kind-id=exhibit] input[type=file]")!, {
      target: { files: exhibits },
    });
    await waitFor(() => expect(screen.getAllByLabelText("Exhibit label").map((input) =>
      (input as HTMLInputElement).value)).toEqual(["A", ""]));
    const bId = screen.getByText("Exhibit B.pdf").closest("article")!.dataset.entryId!;
    fireEvent.drop(screen.getByRole("region", { name: "Exhibit A slot" }), {
      dataTransfer: { getData: () => bId, files: [] },
    });
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Exhibit A slot" }))
      .getByText("Exhibit B.pdf")).toBeVisible());
    const pool = screen.getByText("Unassigned files").parentElement!;
    fireEvent.drop(pool, { dataTransfer: { getData: () => bId, files: [] } });
    await waitFor(() => expect(within(pool).getByText("Exhibit B.pdf")).toBeVisible());
  });
});

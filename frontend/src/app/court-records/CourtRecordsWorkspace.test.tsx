// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  it("creates nothing until an exact filing format is selected", async () => {
    const existing = saved("existing");
    const created = { ...saved("created"), title: "Untitled court record", state: {
      profileId: "fc-motion-record-moving", cover: {}, entries: [], bindings: {},
    } };
    const store = {
      list: vi.fn(async () => [existing]), get: vi.fn(),
      create: vi.fn(async () => created), update: vi.fn(), duplicate: vi.fn(), remove: vi.fn(),
    } as unknown as WorkProductStore;
    const host = { mode: "standalone", drafts: store,
      prepareDeviceFile: vi.fn(), resolveInput: vi.fn() } as unknown as CourtRecordsHost;
    const onDraftChange = vi.fn();

    render(<CourtRecordsWorkspace host={host} onDraftChange={onDraftChange} />);

    await waitFor(() => expect(onDraftChange).toHaveBeenCalledWith(undefined, true));
    expect(store.create).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Open saved record" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "New court record" }));
    await userEvent.click(screen.getByRole("button", { name: "Motion record" }));
    await userEvent.click(within(screen.getByRole("dialog", { name: "Motion record format" }))
      .getByRole("button", { name: /^FC\b.*Moving party$/u }));

    expect(store.create).toHaveBeenCalledWith({ kind: "court-record",
      title: "Untitled court record", state: {
        profileId: "fc-motion-record-moving", cover: {}, entries: [], bindings: {},
      } });
    await waitFor(() => expect(onDraftChange).toHaveBeenCalledWith(created, true));
  });

  it("keeps saved filing-contact defaults only where the selected cover accepts them", async () => {
    const created = { ...saved("created"), state: { profileId: "ab-kb-affidavit-exhibits",
      cover: {}, entries: [], bindings: {} } };
    const store = { list: vi.fn(async () => []), get: vi.fn(),
      create: vi.fn(async () => created), update: vi.fn(), duplicate: vi.fn(),
      remove: vi.fn() } as unknown as WorkProductStore;
    const host = { mode: "beaver", drafts: store, newDraftCover: vi.fn(async () => ({
      counselName: "Ada Lawyer", counselEmail: "ada@example.test",
    })), prepareDeviceFile: vi.fn(), resolveInput: vi.fn() } as unknown as CourtRecordsHost;

    render(<CourtRecordsWorkspace host={host} />);
    await userEvent.click(await screen.findByRole("button", { name: "New court record" }));
    await userEvent.click(screen.getByRole("button", { name: "Affidavit with exhibits" }));
    await userEvent.click(within(screen.getByRole("dialog", {
      name: "Affidavit with exhibits format",
    })).getByRole("button", { name: "ABKB" }));

    expect(store.create).toHaveBeenCalledWith(expect.objectContaining({
      state: { profileId: "ab-kb-affidavit-exhibits", cover: {}, entries: [], bindings: {} },
    }));
  });

  it("resumes an exact deep link beyond the first saved page", async () => {
    const drafts = [saved("first")], requested = saved("requested");
    const store = {
      list: vi.fn(async () => drafts), get: vi.fn(async () => requested), create: vi.fn(), update: vi.fn(),
      duplicate: vi.fn(), remove: vi.fn(),
    } as unknown as WorkProductStore;
    const host = { mode: "standalone", drafts: store,
      prepareDeviceFile: vi.fn(), resolveInput: vi.fn() } as unknown as CourtRecordsHost;
    const onDraftChange = vi.fn();

    const { rerender } = render(<CourtRecordsWorkspace host={host} initialDraftId="requested"
      onDraftChange={onDraftChange} />);

    await waitFor(() => expect(onDraftChange).toHaveBeenCalledWith(requested, true));
    expect(store.get).toHaveBeenCalledWith("requested");
    expect(store.create).not.toHaveBeenCalled();

    rerender(<CourtRecordsWorkspace host={host} onDraftChange={onDraftChange} />);
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith(undefined, true));
    expect(screen.getByRole("heading", { name: "Start a court record" })).toBeVisible();
  });

  it("keeps the newest assistant refresh when responses arrive out of order", async () => {
    const initial = saved("record");
    const revisions = [2, 3].map((revision) => ({ ...initial, revision,
      updatedAt: `2026-08-30T00:0${revision}:00.000Z` }));
    const pending: Array<(draft: WorkProduct<CourtRecordDraft>) => void> = [];
    const get = vi.fn(() => new Promise<WorkProduct<CourtRecordDraft>>((resolve) =>
      pending.push(resolve)));
    const store = { list: vi.fn(async () => [initial]), get, create: vi.fn(),
      update: vi.fn(), duplicate: vi.fn(), remove: vi.fn() } as unknown as WorkProductStore;
    const host = { mode: "beaver", drafts: store, prepareDeviceFile: vi.fn(),
      resolveInput: vi.fn() } as unknown as CourtRecordsHost;
    const onDraftChange = vi.fn();
    const { rerender } = render(<CourtRecordsWorkspace host={host} initialDraftId={initial.id}
      refreshToken={1} onDraftChange={onDraftChange} />);

    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith(initial, true));
    rerender(<CourtRecordsWorkspace host={host} initialDraftId={initial.id}
      refreshToken={2} onDraftChange={onDraftChange} />);
    await waitFor(() => expect(get).toHaveBeenCalledOnce());
    rerender(<CourtRecordsWorkspace host={host} initialDraftId={initial.id}
      refreshToken={3} onDraftChange={onDraftChange} />);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));

    await act(async () => pending[1](revisions[1]));
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith(revisions[1], true));
    await act(async () => pending[0](revisions[0]));
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith(revisions[1], true));
  });

  it("saves edits before returning from an active draft", async () => {
    const draft = saved("Working record");
    const update = vi.fn(async (_id, change) => ({ ...draft, revision: 2,
      state: change.state }));
    const store = { list: vi.fn(async () => [draft]), get: vi.fn(), create: vi.fn(),
      update, duplicate: vi.fn(), remove: vi.fn() } as unknown as WorkProductStore;
    const host = { mode: "standalone", drafts: store, prepareDeviceFile: vi.fn(),
      resolveInput: vi.fn() } as unknown as CourtRecordsHost;
    render(<CourtRecordsWorkspace host={host} initialDraftId={draft.id} />);

    fireEvent.change(await screen.findByLabelText(/Court file number/iu),
      { target: { value: "T-1-26" } });
    await userEvent.click(screen.getByRole("button", { name: "Back from court record" }));

    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(update.mock.calls[0][1].state.cover.courtFileNumber).toBe("T-1-26");
    expect(screen.getByRole("heading", { name: "Start a court record" })).toBeVisible();
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
    render(<CourtRecordsWorkspace host={host} initialDraftId={draft.id}
      onDraftChange={onDraftChange} />);

    await user.click(await screen.findByRole("button", { name: "Build record" }));
    const download = await screen.findByRole("button", { name: /Court record\.pdf/iu });
    await user.click(screen.getByRole("button", { name: "Save to Library" }));
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith(savedBuild, true));
    expect(saveArtifacts).toHaveBeenCalledOnce();
    expect(store.update).not.toHaveBeenCalled();
    resolveInput.mockResolvedValue({ status: "missing", reason: "unavailable" });
    await user.click(download);

    expect(mocks.download).not.toHaveBeenCalled();
    expect(await screen.findByText("Rebuild the source draft")).toBeVisible();
  });

  it("binds a saved output selected through the Library picker", async () => {
    const draft = saved("record");
    const libraryDocument = { id: "authorities-document", project_id: null,
      filename: "Authorities.pdf", file_type: "pdf", pdf_storage_path: null,
      size_bytes: 4, page_count: 1, created_at: "2026-08-30T00:00:00.000Z",
      current_version_id: "version-1", source_sha256: "a".repeat(64) };
    const binding = { kind: "work-product-output" as const,
      workProductId: "authorities-draft", role: "book" };
    const choice = { workProductId: binding.workProductId,
      workProductTitle: "Application authorities", role: binding.role,
      output: { documentId: libraryDocument.id, versionId: "version-1",
        filename: libraryDocument.filename, mimeType: "application/pdf",
        sha256: libraryDocument.source_sha256, pageCount: 1 },
      document: libraryDocument };
    const file = new File(["book"], libraryDocument.filename, { type: "application/pdf" });
    const update = vi.fn(async (_id, change) => ({ ...draft, revision: 2,
      state: change.state }));
    const store = { list: vi.fn(async () => [draft]), get: vi.fn(), create: vi.fn(),
      update, duplicate: vi.fn(), remove: vi.fn() } as unknown as WorkProductStore;
    const importLibraryDocument = vi.fn();
    const importDraftOutput = vi.fn(async () => ({ file, pageCount: 1, searchable: true,
      encrypted: false, textlessPageCount: 0, textlessPages: [], binding,
      origin: { kind: "library" as const, documentId: libraryDocument.id,
        versionId: libraryDocument.current_version_id,
        sourceSha256: libraryDocument.source_sha256 } }));
    const host = { mode: "beaver", drafts: store, prepareDeviceFile: vi.fn(),
      resolveInput: vi.fn(), searchLibrary: vi.fn(async () => [libraryDocument]),
      searchDraftOutputs: vi.fn(async () => [choice]), importLibraryDocument,
      importDraftOutput } as unknown as CourtRecordsHost;
    const user = userEvent.setup();
    render(<CourtRecordsWorkspace host={host} initialDraftId={draft.id} />);

    await waitFor(() => expect(document.querySelector("[data-kind-id=document]"))
      .toBeInTheDocument());
    await user.click(within(document.querySelector("[data-kind-id=document]")!)
      .getByRole("button", { name: "Library" }));
    const picker = await screen.findByRole("dialog");
    const result = within(picker).getAllByRole("button", { name: /Authorities\.pdf/iu });
    expect(result).toHaveLength(1);
    await user.click(result[0]);

    await waitFor(() => expect(importDraftOutput).toHaveBeenCalledWith(choice,
      expect.any(Function)));
    expect(importLibraryDocument).not.toHaveBeenCalled();
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(Object.values(update.mock.calls.at(-1)![1].state.bindings))
      .toContainEqual(binding);
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
    render(<CourtRecordsWorkspace host={host} initialDraftId={draft.id} />);

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
    render(<CourtRecordsWorkspace host={host} initialDraftId={draft.id} />);

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

  it("fills missing case details from every restored source without replacing typed values", async () => {
    const input = (documentId: string) => ({ kind: "document" as const, documentId,
      version: "latest" as const });
    const snapshot = (name: string) => ({ name, size: 1, modified: 1 });
    const draft: WorkProduct<CourtRecordDraft> = { ...saved("restored"), state: {
      profileId: "ab-kb-affidavit-exhibits", cover: { deponent: "Typed deponent" },
      entries: [
        { id: "affidavit", kindId: "affidavit", title: "Affidavit", lastSeen: snapshot("affidavit.pdf") },
        { id: "exhibit", kindId: "exhibit", title: "Exhibit", lastSeen: snapshot("exhibit.pdf") },
      ], bindings: { affidavit: input("affidavit"), exhibit: input("exhibit") },
    } };
    const resolveInput = vi.fn(async (binding: ReturnType<typeof input>) => {
      const file = new File([binding.documentId], `${binding.documentId}.pdf`,
        { type: "application/pdf" });
      return { status: "ready" as const, input: binding, file, prepared: {
        file, pageCount: 1, searchable: true, encrypted: false,
        origin: { kind: "library" as const }, sourceFields: binding.documentId === "affidavit"
          ? { cover: { courtFileNumber: "2401-12345", deponent: "Source deponent" },
            partyStyleId: "action", parties: { first: "Alpha Person" }, exhibitLabels: [] }
          : { cover: { registry: "Calgary" }, parties: { second: "Beta Person" },
            exhibitLabels: [] },
      } };
    });
    const store = { list: vi.fn(async () => [draft]), get: vi.fn(), create: vi.fn(),
      update: vi.fn(), duplicate: vi.fn(), remove: vi.fn() } as unknown as WorkProductStore;
    const host = { mode: "standalone", drafts: store, resolveInput,
      prepareDeviceFile: vi.fn() } as unknown as CourtRecordsHost;

    render(<CourtRecordsWorkspace host={host} initialDraftId={draft.id} />);

    expect(await screen.findByLabelText(/Court file number/iu)).toHaveValue("2401-12345");
    expect(screen.getByLabelText(/Registry/iu)).toHaveValue("Calgary");
    expect(screen.getByLabelText(/Deponent/iu)).toHaveValue("Typed deponent");
    expect(document.querySelector<HTMLInputElement>("[data-party-group=Plaintiff] input"))
      .toHaveValue("Alpha Person");
    expect(document.querySelector<HTMLInputElement>("[data-party-group=Defendant] input"))
      .toHaveValue("Beta Person");
  });

  it("keeps only cover and party values supported by the selected format", async () => {
    const parties = [
      { id: "party-a", role: "Applicant", parties: [{ id: "applicant", name: "Alpha Ltd." }] },
      { id: "party-b", role: "Respondent", parties: [{ id: "respondent", name: "Beta Ltd." }] },
    ];
    const draft: WorkProduct<CourtRecordDraft> = { ...saved("switch-format"), state: {
      profileId: "general-court-record", cover: {
        courtName: "Old Court", courtFileNumber: "T-1-26", registry: "Calgary",
        recordTitle: "Old record", partyStyleId: "application", partyGroups: parties,
        filingPartyId: "respondent",
      }, entries: [], bindings: {},
    } };
    const update = vi.fn(async (_id, change) => ({ ...draft,
      revision: update.mock.calls.length + 1, state: change.state }));
    const store = { list: vi.fn(async () => [draft]), get: vi.fn(), create: vi.fn(),
      update, duplicate: vi.fn(), remove: vi.fn() } as unknown as WorkProductStore;
    const host = { mode: "standalone", drafts: store, resolveInput: vi.fn(),
      prepareDeviceFile: vi.fn() } as unknown as CourtRecordsHost;
    const user = userEvent.setup();
    render(<CourtRecordsWorkspace host={host} initialDraftId={draft.id} />);

    await user.click(await screen.findByRole("button", { name: "Document: Court record" }));
    const documents = within(screen.getByRole("dialog", { name: "Choose document" }));
    expect(documents.getByText("Trial and applications")).toBeVisible();
    expect(documents.getByText("Appeal")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Application record" }));
    await user.click(within(screen.getByRole("dialog", { name: "Application record format" }))
      .getByRole("button", { name: /^FC\b.*Applicant$/u }));

    expect(screen.getByLabelText(/Court file number/iu)).toHaveValue("T-1-26");
    expect(screen.queryByLabelText("Court")).not.toBeInTheDocument();
    expect(document.querySelector<HTMLInputElement>("[data-party-group=Applicant] input"))
      .toHaveValue("Alpha Ltd.");
    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    const applicantCover = update.mock.calls[0][1].state.cover;
    expect(applicantCover).not.toHaveProperty("recordTitle");
    expect(applicantCover.partyStyleId).toBe("application");
    expect(applicantCover.filingPartyId).toBeUndefined();

    await user.click(screen.getByRole("button", { name: "Document: Application record" }));
    await user.click(screen.getByRole("button", { name: "Trial record" }));
    await user.click(within(screen.getByRole("dialog", { name: "Trial record format" }))
      .getByRole("button", { name: "FC" }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    const trialCover = update.mock.calls[1][1].state.cover;
    expect(trialCover.courtFileNumber).toBe("T-1-26");
    expect(trialCover.partyStyleId).toBeUndefined();
    expect(trialCover.partyGroups).toBeUndefined();
  });

  it("omits an empty Case details step", async () => {
    const draft = { ...saved("filing-set"), state: { profileId: "fca-leave-response-set",
      cover: {}, entries: [], bindings: {} } };
    const store = { list: vi.fn(async () => [draft]), get: vi.fn(), create: vi.fn(),
      update: vi.fn(), duplicate: vi.fn(), remove: vi.fn() } as unknown as WorkProductStore;
    const host = { mode: "standalone", drafts: store, resolveInput: vi.fn(),
      prepareDeviceFile: vi.fn() } as unknown as CourtRecordsHost;

    render(<CourtRecordsWorkspace host={host} initialDraftId={draft.id} />);

    expect(await screen.findByRole("heading", { name: "1. Add documents" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: /Case details/iu })).not.toBeInTheDocument();
  });
});

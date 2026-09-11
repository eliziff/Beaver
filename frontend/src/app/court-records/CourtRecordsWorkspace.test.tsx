// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import type { WorkProduct, WorkProductStore } from "@/app/lib/workProducts";
import { BeaverApiError } from "@/app/lib/api/client";
import type { CourtRecordsHost, PreparedFile } from "./host";
import { CourtRecordsWorkspace } from "./CourtRecordsWorkspace";
import { COURT_PROFILE_BY_ID } from "./profiles";
import type { CourtRecordDraft, RecordEntry } from "./types";

const mocks = vi.hoisted(() => ({ build: vi.fn(), download: vi.fn() }));
vi.mock("./assembly", () => ({ buildCourtRecord: mocks.build }));
vi.mock("./host", async (original) => ({
  ...await original<typeof import("./host")>(), downloadArtifact: mocks.download,
}));
vi.mock("@/app/components/shared/views/PdfView", () => ({
  PdfView: ({ ariaLabel }: { ariaLabel: string }) => <div role="region" aria-label={ariaLabel} />,
}));

async function uploadFiles(control: HTMLElement, files: File[]) {
  await userEvent.click(control);
  fireEvent.change(await screen.findByLabelText("Upload files"), { target: { files } });
}

const saved = (id: string): WorkProduct<CourtRecordDraft> => ({
  id, kind: "court-record", title: id, projectId: null, revision: 1,
  state: { profileId: "general-affidavit-exhibits", cover: {}, entries: [], bindings: {} },
  outputs: {}, createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
});

// These fixtures serve Court records; the production store is generic over all work products.
function workspace(mode: CourtRecordsHost["mode"], { draft, drafts, ...overrides }: {
  draft?: WorkProduct<CourtRecordDraft>; drafts?: Partial<Record<keyof WorkProductStore, unknown>>;
} & Partial<Omit<CourtRecordsHost, "drafts" | "mode">> = {}) {
  const store = { list: vi.fn(async () => draft ? [draft] : []), get: vi.fn(async () => draft),
    create: vi.fn(), update: vi.fn(), duplicate: vi.fn(), remove: vi.fn(),
    ...drafts } as WorkProductStore;
  const host: CourtRecordsHost = { mode, drafts: store, prepareDeviceFile: vi.fn(),
    resolveInput: vi.fn(), ...overrides };
  return { host, store };
}

function readyRecord(id = "record") {
  const file = new File(["%PDF"], "Authorities.pdf", {
    type: "application/pdf", lastModified: 1,
  });
  const input = { kind: "work-product-output" as const,
    workProductId: "authorities", role: "book" };
  const prepared = { file, pageCount: 1, searchable: true, encrypted: false,
    textlessPageCount: 0, textlessPages: [], binding: input,
    origin: { kind: "library" as const, documentId: "book", versionId: "version-1",
      sourceSha256: "a".repeat(64) } };
  const draft: WorkProduct<CourtRecordDraft> = { ...saved(id), state: {
    profileId: "ab-kb-commercial-compendium", cover: {
      courtFileNumber: "2401-1",
      partyStyleId: "application", partyGroups: [
        { id: "party-a", role: "Applicant", parties: [{ id: "a", name: "Applicant" }] },
        { id: "party-b", role: "Respondent", parties: [{ id: "b", name: "Respondent" }] },
      ], filingPartyIds: ["a"],
    }, entries: [{ id: "entry", kindId: "authority-extract", title: "Authorities",
      lastSeen: { name: file.name, size: file.size, modified: file.lastModified,
        sha256: "a".repeat(64) } }], bindings: { entry: input },
  } };
  return { file, input, prepared, draft };
}

describe("CourtRecordsWorkspace", () => {
  it("retries a stale save on the fresh revision while retaining both writers' entries and edits", async () => {
    const { draft, input, prepared } = readyRecord();
    let current = draft;
    let releaseSave!: () => void;
    const pendingSave = new Promise<void>((resolve) => { releaseSave = resolve; });
    const revisions: number[] = [];
    const { host } = workspace("beaver", { drafts: { list: async () => [current],
      get: async () => current,
      update: async (_id: string, patch: { revision: number; state: CourtRecordDraft }) => {
        revisions.push(patch.revision);
        if (revisions.length === 1) current = { ...draft, revision: 2, state: {
          ...draft.state, entries: [...draft.state.entries,
            { ...draft.state.entries[0], id: "remote-exhibit", title: "Remote exhibit" }],
          bindings: { ...draft.state.bindings, "remote-exhibit": input },
        } };
        if (revisions.length === 1) await pendingSave;
        if (patch.revision !== current.revision) throw new BeaverApiError({ status: 409,
          message: "This draft changed", details: { current_revision: String(current.revision) } });
        return current = { ...current, revision: current.revision + 1, state: patch.state };
      } },
      resolveInput: async () => ({ status: "ready", input, prepared, file: prepared.file }) });
    const { rerender } = render(<CourtRecordsWorkspace host={host} initialDraftId={draft.id} />);
    fireEvent.change(await screen.findByLabelText(/Court file number/), { target: { value: "T-42" } });
    await waitFor(() => expect(revisions).toHaveLength(1));
    rerender(<CourtRecordsWorkspace host={host} initialDraftId={draft.id}
      refreshToken={{ id: draft.id, revision: 2 }} />);
    expect(await screen.findByDisplayValue("Remote exhibit")).toBeVisible();
    expect(screen.getByLabelText(/Court file number/)).toHaveValue("T-42");
    await act(async () => releaseSave());
    await waitFor(() => expect(current.state.cover.courtFileNumber).toBe("T-42"));
    expect(revisions).toEqual([1, 2]);
    expect(current.state.entries.map(({ id }) => id)).toEqual(["entry", "remote-exhibit"]);
    expect(screen.getByDisplayValue("Remote exhibit")).toBeVisible();
  });

  it.each([
    ["ab-kb-affidavit-exhibits", "affidavit"],
    ["fc-motion-record-responding", "written-representations"],
    ["fc-motion-record-moving", "notice-motion"],
    ["fc-application-record-applicant", "notice-application"],
  ])("reveals setup after the source document is added for %s", async (profileId, kindId) => {
    const draft = saved("source-first");
    draft.state.profileId = profileId;
    const { host } = workspace("standalone", { drafts: { list: async () => [draft],
      get: async () => draft,
      update: async (_id: string, change: { state: CourtRecordDraft }) =>
        ({ ...draft, revision: 2, state: change.state }) },
      prepareDeviceFile: async (file: File) => ({ file, pageCount: 1,
        searchable: true, encrypted: false,
        sourceFields: { cover: { courtFileNumber: "T-42-26" }, exhibitLabels: [] },
      }) });
    render(<CourtRecordsWorkspace host={host} initialDraftId={draft.id} />);
    await screen.findByRole("heading", { name: /Add the .*Required/ });
    expect(screen.queryByRole("heading", { name: "Case details" })).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Build output" })).not.toBeInTheDocument();
    expect(document.querySelectorAll("input[type=file]")).toHaveLength(0);
    await uploadFiles(document.getElementById(`court-record-${kindId}-file`)!, [new File(["source"], "Source.pdf", { type: "application/pdf" })]);
    expect(await screen.findByLabelText(/Court file number/)).toHaveValue("T-42-26");
    expect(screen.getByRole("complementary", { name: "Build output" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Replace" })).toBeVisible();
  });

  it("paginates saved records and searches beyond the current page", async () => {
    const records = Array.from({ length: 17 }, (_, index) => saved(`Record ${index + 1}`));
    const { host, store } = workspace("standalone", { drafts: { list: vi.fn(async () => records),
      get: vi.fn(async (id) => records.find((item) => item.id === id)) } });
    const user = userEvent.setup();
    render(<CourtRecordsWorkspace host={host} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Open saved record" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Open saved record" }));
    const modal = within(screen.getByRole("dialog", { name: "Open saved record" }));
    expect(modal.getAllByRole("button", { name: /^Record / })).toHaveLength(8);
    expect(modal.queryByRole("button", { name: /^Record 9 / })).not.toBeInTheDocument();
    await user.click(modal.getByRole("button", { name: "Next" }));
    expect(modal.getByText("Page 2 of 3")).toBeVisible();
    await user.type(modal.getByRole("searchbox", { name: "Search saved records" }), "Record 17");
    expect(modal.getByText("Page 1 of 1")).toBeVisible();
    expect(modal.getAllByRole("button", { name: /^Record / })).toHaveLength(1);
    await user.click(modal.getByRole("button", { name: /^Record 17 / }));
    await waitFor(() => expect(store.get).toHaveBeenCalledWith("Record 17"));
    expect(screen.queryByRole("dialog", { name: "Open saved record" })).not.toBeInTheDocument();
  });

  it("opens standalone output settings without starting a record", async () => {
    const choose = vi.fn(async () => "Filed records");
    const { host, store } = workspace("standalone", { outputFolder: { get: vi.fn(async () => "Court outputs"),
        choose, clear: vi.fn() } });
    const user = userEvent.setup();
    render(<CourtRecordsWorkspace host={host} />);

    await user.click(await screen.findByRole("button", { name: "Settings" }));
    expect(screen.getByRole("dialog", { name: "Settings" })).toHaveTextContent("Court outputs");
    await user.click(screen.getByRole("button", { name: "Choose folder" }));
    await waitFor(() => expect(choose).toHaveBeenCalledOnce());
    expect(screen.getByRole("dialog", { name: "Settings" })).toHaveTextContent("Filed records");
    expect(store.create).not.toHaveBeenCalled();
  });

  it("restores contextual files and saves their explicit slot assignments", async () => {
    const binding = { kind: "document" as const, documentId: "notice", version: "latest" as const };
    const file = new File(["notice"], "Notice.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    let draft = saved("contextual");
    const update = vi.fn(async (_id, change) => ({ ...draft, revision: 2,
      state: change.state }));
    let finishListing!: (items: []) => void;
    const prepared = { file, pdfRendition: new File(["pdf"], "Notice.pdf",
      { type: "application/pdf" }), pageCount: 1, searchable: true, encrypted: false,
      textlessPageCount: 0, textlessPages: [], binding,
      origin: { kind: "library" as const, documentId: "notice" }, sourceFields: {
        cover: { courtFileNumber: "T-42-26" }, exhibitLabels: [],
      } };
    const { host } = workspace("beaver", { drafts: { listMetadata: () => new Promise<[]>((resolve) => { finishListing = resolve; }),
      create: vi.fn(async (input) => (draft = { ...draft, ...input })),
      update },
      resolveInput: vi.fn(async () => ({ status: "ready" as const, file, input: binding,
        prepared })) });
    const user = userEvent.setup();
    const consumed = vi.fn();
    render(<CourtRecordsWorkspace host={host}
      initialDocuments={[{ id: "notice", filename: file.name }]}
      onDocumentsConsumed={consumed} />);

    await user.click(await screen.findByRole("button", { name: "Federal courts" }));
    await user.click(within(screen.getByRole("dialog", { name: "Choose document" }))
      .getAllByRole("button", { name: /^Application record$/u })[0]);
    expect(draft.state).toMatchObject({ profileId: "fc-application-record-applicant",
      entries: [{ id: "notice", kindId: "unassigned" }], bindings: { notice: binding } });
    expect(consumed).toHaveBeenCalledOnce();
    expect(await screen.findByRole("region", { name: "Files" })).toBeVisible();
    await act(async () => finishListing([]));
    expect(screen.getByRole("region", { name: "Files" })).toBeVisible();
    expect(screen.queryByLabelText(/Court file number/iu)).not.toBeInTheDocument();
    const kind = COURT_PROFILE_BY_ID.get("fc-application-record-applicant")!
      .documentKinds.find(({ id }) => id === "notice-application")!;
    await userEvent.selectOptions(screen.getByLabelText("Document type for Notice.docx"), kind.id);
    expect(screen.getByLabelText(/Court file number/iu)).toHaveValue("T-42-26");

    await waitFor(() => expect(update.mock.calls.at(-1)![1].state).toMatchObject({
      profileId: "fc-application-record-applicant",
      entries: [{ id: "notice", kindId: kind.id, title: "Notice" }],
      bindings: { notice: binding },
    }));

    await user.click(screen.getByRole("button", { name: /^Change document:/u }));
    await user.click(within(screen.getByRole("dialog", { name: "Choose document" }))
      .getByRole("button", { name: "Trial record" }));
    await waitFor(() => expect(update.mock.calls.at(-1)![1].state).toMatchObject({
      profileId: "fc-trial-record",
      entries: [{ id: "notice", kindId: "unassigned" }],
      bindings: { notice: binding },
    }));
  });

  it("creates nothing until an exact filing format is selected in the active project", async () => {
    const existing = saved("existing");
    const created = { ...saved("created"), projectId: "matter-1",
      title: "Moving party’s motion record", state: {
      profileId: "fc-motion-record-moving", cover: {}, entries: [], bindings: {},
    } };
    const { host, store } = workspace("standalone", { drafts: { list: vi.fn(async () => [existing]),
      create: vi.fn(async () => created) } });
    const onDraftChange = vi.fn();

    const user = userEvent.setup();
    render(<CourtRecordsWorkspace host={host} projectId="matter-1"
      onDraftChange={onDraftChange} />);

    await waitFor(() => expect(onDraftChange).toHaveBeenCalledWith(undefined, true));
    expect(store.create).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Open saved record" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "New court record" }));
    await user.click(screen.getByRole("button", { name: "Federal courts" }));
    await user.click(within(screen.getByRole("dialog", { name: "Choose document" }))
      .getAllByRole("button", { name: /^Motion record$/u })[0]);

    expect(store.list).toHaveBeenCalledWith("court-record", "matter-1");
    expect(store.create).toHaveBeenCalledWith({ kind: "court-record",
      projectId: "matter-1",
      title: "Moving party’s motion record", state: {
        profileId: "fc-motion-record-moving", cover: {}, entries: [], bindings: {},
    } });
    await waitFor(() => expect(onDraftChange).toHaveBeenCalledWith(created, true));
    await user.click(screen.getByRole("button", { name: "Back from court record" }));
    await user.click(screen.getByRole("button", { name: "Open saved record" }));
    expect(screen.getByRole("dialog", { name: "Open saved record" }))
      .toHaveTextContent(created.title);
  });

  it("discards a cancelled file handoff before starting another record", async () => {
    const create = vi.fn(async (input) => ({ ...saved("new"), ...input }));
    const host = { mode: "beaver", drafts: { list: async () => [], create },
      resolveInput: vi.fn(), prepareDeviceFile: vi.fn() } as unknown as CourtRecordsHost;
    const consumed = vi.fn();
    render(<CourtRecordsWorkspace host={host}
      initialDocuments={[{ id: "notice", filename: "Notice.pdf" }]}
      onDocumentsConsumed={consumed} />);
    await screen.findByRole("dialog", { name: "Choose document" });
    await userEvent.keyboard("{Escape}");
    expect(create).not.toHaveBeenCalled();
    expect(consumed).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "New court record" }));
    await userEvent.click(screen.getByRole("button", { name: "Alberta" }));
    await userEvent.click(within(screen.getByRole("dialog", { name: "Choose document" }))
      .getByRole("button", { name: "Affidavit" }));
    expect(create.mock.calls[0][0].state).toMatchObject({
      profileId: "ab-kb-affidavit-exhibits", entries: [], bindings: {},
    });
  });

  it("finishes an old draft save without restoring its route over a new file handoff", async () => {
    const old = { ...saved("old"), state: { ...saved("old").state,
      profileId: "ab-kb-commercial-compendium" } };
    let finishSave!: () => void;
    const file = new File(["pdf"], "Notice.pdf");
    const { host } = workspace("beaver", { drafts: { listMetadata: async () => [],
      get: async () => old,
      create: vi.fn(async (input) => ({ ...saved("new"), ...input })),
      update: (id: string, change: { state: CourtRecordDraft }) => id === "new"
        ? Promise.resolve({ ...saved("new"), ...change, revision: 2 })
        : new Promise((resolve) => { finishSave = () => resolve({ ...old, ...change, revision: 2 }); }) },
      resolveInput: async (input) => ({ status: "ready", input, file,
        prepared: { file, pageCount: 1, searchable: true, encrypted: false } }) });
    function RoutedBuilder() {
      const [params, setParams] = useSearchParams();
      const location = useLocation(), navigate = useNavigate();
      return <>
        <output aria-label="Route">{location.search}</output>
        <button onClick={() => navigate("/court-records", { state: {
          documents: [{ id: "notice", filename: "Notice.pdf" }],
        } })}>Start selected filing</button>
        <CourtRecordsWorkspace host={host} initialDraftId={params.get("draft") ?? undefined}
          initialDocuments={location.state?.documents}
          onDocumentsConsumed={() => navigate(location.pathname + location.search,
            { replace: true, state: null })}
          onDraftChange={(draft, synced) => {
            if (!synced || (params.get("draft") ?? undefined) === draft?.id) return;
            setParams(draft ? { draft: draft.id } : {}, { replace: true });
          }} />
      </>;
    }
    render(<MemoryRouter initialEntries={["/court-records?draft=old"]}>
      <RoutedBuilder /></MemoryRouter>);
    const field = await screen.findByLabelText(/Court file number/iu);
    fireEvent.change(field, { target: { value: "T-42-26" } });
    await userEvent.click(screen.getByRole("button", { name: "Start selected filing" }));
    await waitFor(() => expect(finishSave).toBeTypeOf("function"));
    expect(screen.getByRole("status", { name: "Route" })).not.toHaveTextContent("old");
    await act(async () => finishSave());
    await userEvent.click(await screen.findByRole("button", { name: "Alberta" }));
    await userEvent.click(within(screen.getByRole("dialog", { name: "Choose document" }))
      .getByRole("button", { name: "Affidavit" }));
    await waitFor(() => expect(screen.getByRole("status", { name: "Route" }))
      .toHaveTextContent("?draft=new"));
    expect(await screen.findByRole("region", { name: "Files" })).toHaveTextContent("Notice.pdf");
  });

  it("does not open a routed draft from another project", async () => {
    const requested = { ...saved("other-project"), projectId: "matter-2" };
    const { host, store } = workspace("beaver", { drafts: { get: vi.fn(async () => requested) } });
    const onDraftChange = vi.fn();

    render(<CourtRecordsWorkspace host={host} projectId="matter-1"
      initialDraftId={requested.id} onDraftChange={onDraftChange} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("not in this project");
    expect(screen.queryByRole("heading", { name: requested.title })).not.toBeInTheDocument();
    expect(store.list).toHaveBeenCalledWith("court-record", "matter-1");
  });

  it("keeps saved filing-contact defaults only where the selected cover accepts them", async () => {
    const created = { ...saved("created"), state: { profileId: "ab-kb-affidavit-exhibits",
      cover: {}, entries: [], bindings: {} } };
    const { host, store } = workspace("beaver", { drafts: { create: vi.fn(async () => created) },
      newDraftCover: vi.fn(async () => ({
      counselName: "Ada Lawyer", counselEmail: "ada@example.test",
    })) });

    const user = userEvent.setup();
    render(<CourtRecordsWorkspace host={host} />);
    await user.click(await screen.findByRole("button", { name: "New court record" }));
    await user.click(screen.getByRole("button", { name: "Alberta" }));
    await user.click(within(screen.getByRole("dialog", { name: "Choose document" }))
      .getByRole("button", { name: "Affidavit" }));

    expect(store.create).toHaveBeenCalledWith(expect.objectContaining({
      state: { profileId: "ab-kb-affidavit-exhibits", cover: {}, entries: [], bindings: {} },
    }));
  });

  it("saves only the visible filing details when the user asks", async () => {
    const draft = { ...saved("contact"), state: { profileId: "fc-motion-record-moving",
      cover: { counselName: "Ada Lawyer", counselEmail: "ada@example.test" },
      entries: [], bindings: {} } };
    const saveFilingContact = vi.fn(async () => undefined);
    const { host } = workspace("standalone", { draft,
      saveFilingContact,
      prepareDeviceFile: async (file: File) => ({ file, pageCount: 1, searchable: true, encrypted: false }) });

    render(<CourtRecordsWorkspace host={host} initialDraftId={draft.id} />);
    await screen.findByRole("heading", { name: /Add the notice/ });
    await uploadFiles(document.getElementById("court-record-notice-motion-file")!, [new File(["source"], "Notice.pdf", { type: "application/pdf" })]);
    await userEvent.click(await screen.findByRole("button", {
      name: "Save filing details for new records",
    }));

    expect(saveFilingContact).toHaveBeenCalledWith({ counselName: "Ada Lawyer",
      counselEmail: "ada@example.test" });
    expect(await screen.findByText("Filing details saved for new records")).toBeVisible();
  });

  it("resumes an exact deep link beyond the first saved page", async () => {
    const drafts = [saved("first")], requested = saved("requested");
    let resolveRequested!: (draft: WorkProduct<CourtRecordDraft>) => void;
    const { host, store } = workspace("standalone", { drafts: { list: vi.fn(async () => drafts),
      get: vi.fn(() =>
        new Promise<WorkProduct<CourtRecordDraft>>((resolve) => { resolveRequested = resolve; })) } });
    const onDraftChange = vi.fn();

    const { rerender } = render(<CourtRecordsWorkspace host={host} initialDraftId="requested"
      onDraftChange={onDraftChange} />);

    await waitFor(() => expect(store.get).toHaveBeenCalledWith("requested"));
    expect(screen.queryByRole("button", { name: "New court record" })).not.toBeInTheDocument();
    await act(async () => resolveRequested(requested));
    await waitFor(() => expect(onDraftChange).toHaveBeenCalledWith(requested, true));
    expect(store.create).not.toHaveBeenCalled();

    rerender(<CourtRecordsWorkspace host={host} onDraftChange={onDraftChange} />);
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith(undefined, true));
    expect(screen.getByRole("button", { name: "New court record" })).toBeVisible();
  });

  it("keeps the newest assistant refresh when responses arrive out of order", async () => {
    const initial = saved("record");
    const revisions = [2, 3].map((revision) => ({ ...initial, revision,
      updatedAt: `2026-08-30T00:0${revision}:00.000Z` }));
    const pending: Array<(draft: WorkProduct<CourtRecordDraft>) => void> = [];
    const get = vi.fn(() => new Promise<WorkProduct<CourtRecordDraft>>((resolve) =>
      pending.push(resolve))).mockResolvedValueOnce(initial);
    const { host } = workspace("beaver", { drafts: { list: vi.fn(async () => [initial]),
      get } });
    const onDraftChange = vi.fn();
    const { rerender } = render(<CourtRecordsWorkspace host={host} initialDraftId={initial.id}
      refreshToken={{ id: initial.id, revision: 1 }} onDraftChange={onDraftChange} />);

    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith(initial, true));
    rerender(<CourtRecordsWorkspace host={host} initialDraftId={initial.id}
      refreshToken={{ id: initial.id, revision: 2 }} onDraftChange={onDraftChange} />);
    await waitFor(() => expect(pending).toHaveLength(1));
    rerender(<CourtRecordsWorkspace host={host} initialDraftId={initial.id}
      refreshToken={{ id: initial.id, revision: 3 }} onDraftChange={onDraftChange} />);
    await waitFor(() => expect(pending).toHaveLength(2));

    await act(async () => pending[1](revisions[1]));
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith(revisions[1], true));
    await act(async () => pending[0](revisions[0]));
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith(revisions[1], true));
  });

  it("saves edits before returning from an active draft", async () => {
    const draft = saved("Working record");
    draft.state.profileId = "ab-kb-commercial-compendium";
    const update = vi.fn(async (_id, change) => ({ ...draft, revision: 2,
      state: change.state }));
    const { host } = workspace("standalone", { draft,
      drafts: { update } });
    render(<CourtRecordsWorkspace host={host} initialDraftId={draft.id} />);

    fireEvent.change(await screen.findByLabelText(/Court file number/iu),
      { target: { value: "T-1-26" } });
    await userEvent.click(screen.getByRole("button", { name: "Back from court record" }));

    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(update.mock.calls[0][1].state.cover.courtFileNumber).toBe("T-1-26");
    expect(screen.getByRole("button", { name: "New court record" })).toBeVisible();
  });

  it("flushes the latest edit when navigation unmounts before autosave", async () => {
    const draft = saved("Navigation-safe record");
    draft.state.profileId = "ab-kb-commercial-compendium";
    const update = vi.fn(async (_id, change) => ({ ...draft, revision: 2,
      state: change.state }));
    const { host } = workspace("standalone", { draft,
      drafts: { update } });
    const view = render(<CourtRecordsWorkspace host={host} initialDraftId={draft.id} />);

    fireEvent.change(await screen.findByLabelText(/Court file number/iu),
      { target: { value: "T-99-26" } });
    view.unmount();

    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(update.mock.calls[0][1].state.cover.courtFileNumber).toBe("T-99-26");
  });

  it("flushes an edit made during an in-flight autosave before returning", async () => {
    const draft = saved("Working record");
    draft.state.profileId = "ab-kb-commercial-compendium";
    const pending: Array<{ state: CourtRecordDraft;
      resolve: (draft: WorkProduct<CourtRecordDraft>) => void }> = [];
    const update = vi.fn((_id, change: { state: CourtRecordDraft }) =>
      new Promise<WorkProduct<CourtRecordDraft>>((resolve) => pending.push({
        state: change.state, resolve,
      })));
    const { host } = workspace("standalone", { draft,
      drafts: { update } });
    render(<CourtRecordsWorkspace host={host} initialDraftId={draft.id} />);

    const field = await screen.findByLabelText(/Court file number/iu);
    fireEvent.change(field, { target: { value: "T-1-26" } });
    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    fireEvent.change(field, { target: { value: "T-2-26" } });
    await userEvent.click(screen.getByRole("button", { name: "Back from court record" }));
    await act(async () => pending[0].resolve({ ...draft, revision: 2,
      state: pending[0].state }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(pending[1].state.cover.courtFileNumber).toBe("T-2-26");
    await act(async () => pending[1].resolve({ ...draft, revision: 3,
      state: pending[1].state }));

    expect(await screen.findByRole("button", { name: "New court record" })).toBeVisible();
  });

  it("never publishes a build completed against an edited record", async () => {
    const { prepared, draft } = readyRecord("changing-record");
    let finishBuild!: (result: object) => void;
    mocks.build.mockImplementationOnce(() => new Promise((resolve) => {
      finishBuild = resolve;
    }));
    const { host } = workspace("beaver", { draft,
      drafts: { update: vi.fn(async (_id, change) => ({ ...draft, revision: 2,
        state: change.state })) },
      resolveInput: vi.fn(async () => ({
        status: "ready" as const, file: prepared.file, input: prepared.binding!, prepared,
      })) });
    const onDraftChange = vi.fn();
    render(<CourtRecordsWorkspace host={host} initialDraftId={draft.id}
      onDraftChange={onDraftChange} />);

    const build = await screen.findByRole("button", { name: "Build record" });
    await userEvent.click(build);
    await waitFor(() => expect(build).toBeDisabled());
    expect(onDraftChange).toHaveBeenLastCalledWith(draft, false);
    fireEvent.change(screen.getByLabelText(/Court file number/iu), {
      target: { value: "2401-2" },
    });
    await act(async () => finishBuild({ artifacts: [{ role: "record",
      filename: "stale.pdf", mimeType: "application/pdf", bytes: new Uint8Array([1]),
      sha256: "f".repeat(64) }], receipt: { sources: [] } }));

    await waitFor(() => expect(build).toBeEnabled());
    expect(screen.queryByRole("button", { name: /stale\.pdf/iu })).not.toBeInTheDocument();
  });

  it("refreshes source-owned affidavit fields without overwriting manual values", async () => {
    mocks.build.mockClear();
    const binding = { kind: "document" as const, documentId: "affidavit",
      version: "latest" as const };
    const file = new File(["%PDF"], "affidavit.pdf", { type: "application/pdf" });
    const base = { file, pageCount: 1, searchable: true, encrypted: false,
      textlessPageCount: 0, textlessPages: [], binding,
      origin: { kind: "library" as const, documentId: "affidavit",
        versionId: "version-1", sourceSha256: "a".repeat(64) } };
    const previousFields = { cover: { courtFileNumber: "2401-11111",
      deponent: "Old deponent", swornDate: "January 1, 2026" }, partyStyleId: "action",
      partyGroups: [{ role: "Plaintiff", parties: ["Old applicant"] },
        { role: "Defendant", parties: ["Old respondent"] }], exhibitLabels: ["A"],
      entryTitle: "Affidavit of Old deponent", entryDate: "January 1, 2026" };
    const draft: WorkProduct<CourtRecordDraft> = { ...saved("latest-affidavit"), state: {
      profileId: "ab-kb-affidavit-exhibits", cover: {
        courtFileNumber: "2401-11111", deponent: "Counsel override",
        swornDate: "January 1, 2026", partyStyleId: "action",
        partyGroups: [
          { id: "party-a", role: "Plaintiff", parties: [{ id: "a", name: "Old applicant" }] },
          { id: "party-b", role: "Defendant", parties: [{ id: "b", name: "Old respondent" }] },
        ], filingPartyIds: ["a"] },
      entries: [{ id: "affidavit", kindId: "affidavit",
        title: "Affidavit of Old deponent", date: "January 1, 2026",
        sourceFields: previousFields,
        lastSeen: { name: file.name, size: file.size, modified: file.lastModified } }],
      bindings: { affidavit: binding },
    } };
    const current = { ...base, sourceFields: previousFields };
    const finalized = { ...base, origin: { ...base.origin, versionId: "version-2",
      sourceSha256: "b".repeat(64) }, sourceFields: {
      cover: { courtFileNumber: "2401-99999", deponent: "Ada Applicant",
        swornDate: "September 4, 2026" }, partyStyleId: "action",
      partyGroups: [{ role: "Plaintiff", parties: ["Ada Applicant"] },
        { role: "Defendant", parties: ["Riley Respondent"] }], exhibitLabels: ["A"],
      entryTitle: "Affidavit of Ada Applicant", entryDate: "September 4, 2026" } };
    const resolveInput = vi.fn()
      .mockResolvedValueOnce({ status: "ready", file, input: binding, prepared: current })
      .mockResolvedValue({ status: "changed", file, input: binding, prepared: finalized });
    const { host } = workspace("beaver", { draft,
      drafts: { update: vi.fn(async (_id, change) => ({ ...draft, revision: 2, state: change.state })) },
      resolveInput });
    mocks.build.mockResolvedValueOnce({ artifacts: [], receipt: { sources: [] } });
    render(<CourtRecordsWorkspace host={host} initialDraftId={draft.id} />);

    await waitFor(() => expect(resolveInput).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole("button", { name: "Build record" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Build record" }));

    await waitFor(() => expect(mocks.build).toHaveBeenCalledOnce());
    expect(mocks.build.mock.calls[0][0].cover).toMatchObject({
      courtFileNumber: "2401-99999", deponent: "Counsel override",
      swornDate: "September 4, 2026",
      partyGroups: [expect.objectContaining({ parties: [{ id: "a", name: "Old applicant" }] }),
        expect.objectContaining({ parties: [{ id: "b", name: "Old respondent" }] })],
    });
    expect(mocks.build.mock.calls[0][0].entries[0]).toMatchObject({
      title: "Affidavit of Ada Applicant", date: "September 4, 2026",
    });
  });

  it("focuses the exact party field that blocks a build", async () => {
    const draft = { ...saved("missing-party"), state: {
      profileId: "ab-kb-commercial-compendium", cover: {
        courtFileNumber: "2401-1",
        partyStyleId: "application", partyGroups: [
          { id: "party-a", role: "Applicant", parties: [{ id: "a", name: "" }] },
          { id: "party-b", role: "Respondent", parties: [{ id: "b", name: "Respondent" }] },
        ], filingPartyIds: ["b"],
      }, entries: [], bindings: {},
    } };
    const { host } = workspace("standalone", { draft });
    render(<CourtRecordsWorkspace host={host} initialDraftId={draft.id} />);

    await userEvent.click(await screen.findByRole("button", { name: "Build record" }));
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById("party-party-a")));
  });

  it("focuses relinking rather than an unrelated field when an input is missing", async () => {
    const { draft } = readyRecord("missing-input");
    const { host } = workspace("standalone", { draft,
      resolveInput: vi.fn(async () => ({ status: "missing" as const, reason: "deleted" as const })), relinkInput: vi.fn() });
    render(<CourtRecordsWorkspace host={host} initialDraftId={draft.id} />);

    await userEvent.click(await screen.findByRole("button", { name: "Build record" }));
    const relink = screen.getByRole("button", { name: "Relink file" });
    await waitFor(() => expect(document.activeElement).toBe(relink));
  });

  it("keeps the saved build revision and refuses a stale download", async () => {
    const { file, input, prepared, draft } = readyRecord();
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
        kindId: "authority-extract", sha256: "a".repeat(64), mimeType: file.type,
        byteCount: file.size, pageCount: 1, origin: prepared.origin, ocrAppliedPages: [] }],
    } });
    const resolveInput = vi.fn().mockResolvedValue({ status: "ready", file, input, prepared });
    type SavedArtifacts = Awaited<ReturnType<NonNullable<CourtRecordsHost["saveArtifacts"]>>>;
    let finishSave!: (value: SavedArtifacts) => void;
    const saveArtifacts = vi.fn(() => new Promise<SavedArtifacts>((resolve) => { finishSave = resolve; }));
    const { host, store } = workspace("beaver", { draft,
      resolveInput,
      saveArtifacts });
    const onDraftChange = vi.fn();
    const user = userEvent.setup();
    render(<CourtRecordsWorkspace host={host} initialDraftId={draft.id}
      onDraftChange={onDraftChange} />);

    await waitFor(() => expect(resolveInput).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole("button", { name: "Build record" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Build record" }));
    const download = await screen.findByRole("button", { name: /Court record\.pdf/iu });
    const saveButton = screen.getByRole("button", { name: "Save to Library" });
    await user.click(saveButton);
    await waitFor(() => expect(saveButton).toBeDisabled());
    expect(onDraftChange).toHaveBeenLastCalledWith(draft, false);
    await act(async () => finishSave({ documents: [], product: savedBuild,
      outputs: { record: { documentId: "built-record", versionId: "version-2" } } }));
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith(savedBuild, true));
    expect(saveArtifacts).toHaveBeenCalledOnce();
    expect(store.update).not.toHaveBeenCalled();
    resolveInput.mockResolvedValue({ status: "missing", reason: "unavailable" });
    await user.click(download);

    expect(mocks.download).not.toHaveBeenCalled();
    expect(await screen.findByText("Rebuild the source draft")).toBeVisible();
  });

  it("binds a saved output and replaces an occupied fixed slot", async () => {
    const draft = saved("record");
    const oldFile = new File(["old"], "Old affidavit.pdf", { type: "application/pdf" });
    const oldBinding = { kind: "document" as const, documentId: "old-affidavit",
      version: "latest" as const };
    draft.state.entries = [{ id: "affidavit", kindId: "affidavit", title: "My affidavit",
      lastSeen: { name: oldFile.name, size: oldFile.size, modified: oldFile.lastModified } }];
    draft.state.bindings = { affidavit: oldBinding };
    const libraryDocument = { id: "authorities-document", project_id: null,
      filename: "Authorities.pdf", file_type: "pdf", pdf_storage_path: null,
      size_bytes: 4, page_count: 1, created_at: "2026-08-30T00:00:00.000Z",
      current_version_id: "version-1", source_sha256: "a".repeat(64) };
    const binding = { kind: "work-product-output" as const,
      workProductId: "authorities-draft", role: "book" };
    const choice = { kind: "authorities" as const, workProductId: binding.workProductId,
      workProductTitle: "Application authorities", role: binding.role,
      output: { documentId: libraryDocument.id, versionId: "version-1",
        filename: libraryDocument.filename, mimeType: "application/pdf",
        sha256: libraryDocument.source_sha256, pageCount: 1 },
      document: libraryDocument };
    const file = new File(["book"], libraryDocument.filename, { type: "application/pdf" });
    const update = vi.fn(async (_id, change) => ({ ...draft, revision: 2,
      state: change.state }));
    const importLibraryDocument = vi.fn();
    const importDraftOutput = vi.fn(async () => ({ file, pageCount: 1, searchable: true,
      encrypted: false, textlessPageCount: 0, textlessPages: [], binding,
      origin: { kind: "library" as const, documentId: libraryDocument.id,
        versionId: libraryDocument.current_version_id,
        sourceSha256: libraryDocument.source_sha256 } }));
    const { host } = workspace("beaver", { draft,
      drafts: { update },
      resolveInput: vi.fn(async () => ({ status: "ready" as const, file: oldFile,
        input: oldBinding, prepared: { file: oldFile, pageCount: 1, searchable: true,
          encrypted: false, binding: oldBinding, origin: { kind: "library" as const } } })),
      searchDraftOutputs: vi.fn(async () => [choice]),
      importLibraryDocument,
      importDraftOutput });
    const user = userEvent.setup();
    render(<CourtRecordsWorkspace host={host} initialDraftId={draft.id} />);

    await waitFor(() => expect(document.querySelector("[data-kind-id=affidavit]"))
      .toBeInTheDocument());
    await user.click(within(document.querySelector("[data-kind-id=affidavit]")!)
      .getByRole("button", { name: "Replace" }));
    const picker = await screen.findByRole("dialog");
    const result = await within(picker).findAllByRole("radio", { name: "Select Authorities.pdf" });
    expect(result).toHaveLength(1);
    await user.click(result[0]);
    await user.click(within(picker).getByRole("button", { name: "Confirm" }));

    expect(importLibraryDocument).not.toHaveBeenCalled();
    await waitFor(() => expect(update).toHaveBeenCalled());
    const state = update.mock.calls.at(-1)![1].state;
    expect(state.entries).toEqual([expect.objectContaining({ id: "affidavit",
      kindId: "affidavit", title: "My affidavit" })]);
    expect(state.bindings).toEqual({ affidavit: binding });
  });

  it("merges OCR into the current draft after three quick additions and a manual edit", async () => {
    const draft = saved("ocr");
    let persisted = draft;
    const prepareDeviceFile = vi.fn(async (file: File) => ({ file, pageCount: 1,
      searchable: file.name !== "scan.pdf", encrypted: false,
      textlessPageCount: file.name === "scan.pdf" ? 1 : 0,
      textlessPages: file.name === "scan.pdf" ? [1] : [],
      origin: { kind: "device" as const } }));
    let finishOcr!: (patch: Partial<RecordEntry>) => void;
    const runOcr = vi.fn(() => new Promise<Partial<RecordEntry>>((resolve) => { finishOcr = resolve; }));
    const { host } = workspace("standalone", { draft,
      drafts: { update: vi.fn(async (_id, patch) => persisted = { ...persisted,
        revision: persisted.revision + 1, state: patch.state }) },
      prepareDeviceFile,
      runOcr });
    const onDraftChange = vi.fn();
    render(<CourtRecordsWorkspace host={host} initialDraftId={draft.id}
      onDraftChange={onDraftChange} />);

    await waitFor(() => expect(document.getElementById("court-record-affidavit-file"))
      .toBeInTheDocument());
    await uploadFiles(document.getElementById("court-record-affidavit-file")!,
      [new File(["scan"], "scan.pdf", { type: "application/pdf" })]);

    await waitFor(() => expect(runOcr).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Build record" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Deponent/iu), { target: { value: "Human deponent" } });
    await uploadFiles(document.getElementById("court-record-exhibit-file")!,
      ["one.pdf", "two.pdf"].map((name) => new File([name], name, { type: "application/pdf" })));
    await act(async () => finishOcr({ searchable: true, textlessPageCount: 0,
      textlessPages: [] }));
    await waitFor(() => expect(persisted.state.entries).toHaveLength(3));
    expect(persisted.state.cover.deponent).toBe("Human deponent");
    expect(screen.getByDisplayValue("Human deponent")).toBeVisible();
  });

  it("propagates the affidavit, auto-slots certified exhibits, and replaces files", async () => {
    const sourceSha256 = "a".repeat(64);
    const draft: WorkProduct<CourtRecordDraft> = {
      ...saved("affidavit"),
      state: { profileId: "ab-kb-affidavit-exhibits", cover: { deponent: "Edited deponent" },
        entries: [], bindings: {} },
    };
    const prepared = (file: File, sourceFields?: PreparedFile["sourceFields"] & Record<string, unknown>) => ({ file, pageCount: 1,
      searchable: true, encrypted: false, textlessPageCount: 0, textlessPages: [],
      sourceBookmarks: [], origin: { kind: "device" as const }, sourceFields,
      binding: { kind: "local-file" as const, handleId: file.name,
        lastSeen: { name: file.name, size: file.size, modified: file.lastModified,
          sha256: sourceSha256 } } });
    const prepareDeviceFile = vi.fn(async (file: File) => prepared(file,
      file.name.endsWith("affidavit.pdf") ? {
        cover: { courtFileNumber: "2401-12345", deponent: "Source deponent" },
        partyStyleId: "action", partyGroups: [
          { role: "Plaintiff", parties: ["Alpha Person"] },
          { role: "Defendant", parties: ["Beta Person"] },
        ],
        exhibitLabels: ["A", "B"],
        entryTitle: "Affidavit of Source deponent", entryDate: "January 2, 2026",
      } : file.name === "source-labelled.pdf"
        ? { cover: {}, exhibitLabels: [], explicitExhibitLabel: "A" } : undefined));
    const { host } = workspace("standalone", { draft,
      drafts: { update: vi.fn(async (_id, update) => ({ ...draft, revision: 2, state: update.state })) },
      prepareDeviceFile });
    render(<CourtRecordsWorkspace host={host} initialDraftId={draft.id} />);

    await screen.findByRole("heading", { name: /Add the affidavit.*Required/ });
    expect(screen.queryByLabelText(/Deponent/iu)).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Build output" })).not.toBeInTheDocument();
    await uploadFiles(document.getElementById("court-record-affidavit-file")!, [new File(["affidavit"], "affidavit.pdf", { type: "application/pdf" })]);

    await waitFor(() => expect(screen.getByLabelText(/Court file number/iu)).toHaveValue("2401-12345"));
    expect(screen.getByLabelText(/Deponent/iu)).toHaveValue("Edited deponent");
    expect(screen.getByText("affidavit.pdf")).toBeVisible();
    expect(screen.getByLabelText(/Style of cause/u)).toHaveValue("");
    fireEvent.drop(document.querySelector("[data-kind-id=affidavit]")!, {
      dataTransfer: { types: ["Files"], files: [new File(["updated"],
        "updated-affidavit.pdf", { type: "application/pdf" })] },
    });
    await waitFor(() => expect(screen.getByText("updated-affidavit.pdf")).toBeVisible());
    expect(screen.queryByText("affidavit.pdf")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add exhibit" }));
    expect(screen.getByRole("region", { name: "Exhibit C slot" })).toBeVisible();
    const exhibits = [new File(["a"], "source-labelled.pdf", { type: "application/pdf" }),
      new File(["b"], "Exhibit B.pdf", { type: "application/pdf" })];
    await uploadFiles(document.getElementById("court-record-exhibit-file")!, exhibits);
    const pool = screen.getByRole("heading", { name: /^Files/ }).closest("div")!.parentElement!;
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Exhibit A slot" }))
      .getByText("source-labelled.pdf")).toBeVisible());
    expect(within(pool).queryByText("source-labelled.pdf")).toBeNull();
    expect(within(pool).getByText("Exhibit B.pdf")).toBeVisible();
    await uploadFiles(within(screen.getByRole("region", { name: "Exhibit A slot" })).getByRole("button", { name: "Replace" }), [new File(["replacement"], "replacement.pdf",
        { type: "application/pdf" })]);
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Exhibit A slot" }))
      .getByText("replacement.pdf")).toBeVisible());
    expect(screen.queryByText("source-labelled.pdf")).toBeNull();
  });

  it("fills case details from filing sources but ignores exhibit metadata", async () => {
    const input = (documentId: string) => ({ kind: "document" as const, documentId,
      version: "latest" as const });
    const snapshot = (name: string) => ({ name, size: 1, modified: 1 });
    const draft: WorkProduct<CourtRecordDraft> = { ...saved("restored"), state: {
      profileId: "ab-kb-affidavit-exhibits", cover: { deponent: "Typed deponent",
        partyStyleId: "action", partyGroups: [
          { id: "party-a", role: "Plaintiff", parties: [{ id: "typed", name: "Typed Plaintiff" }] },
          { id: "party-b", role: "Defendant", parties: [{ id: "blank", name: "" }] },
        ] },
      entries: [
        { id: "affidavit", kindId: "affidavit", title: "Affidavit", lastSeen: snapshot("affidavit.pdf") },
        { id: "filing", kindId: "unassigned", title: "Notice", lastSeen: snapshot("notice.pdf") },
        { id: "exhibit", kindId: "exhibit", title: "Exhibit", lastSeen: snapshot("exhibit.pdf") },
      ], bindings: { affidavit: input("affidavit"), filing: input("filing"),
        exhibit: input("exhibit") },
    } };
    const resolveInput = vi.fn(async (binding: ReturnType<typeof input>) => {
      const file = new File([binding.documentId], `${binding.documentId}.pdf`,
        { type: "application/pdf" });
      return { status: "ready" as const, input: binding, file, prepared: {
        file, pageCount: 1, searchable: true, encrypted: false,
        origin: { kind: "library" as const }, sourceFields: binding.documentId === "affidavit"
          ? { cover: { deponent: "Source deponent" },
            partyStyleId: "action",
            partyGroups: [{ role: "Plaintiff", parties: ["Alpha Person"] }],
            exhibitLabels: [] }
          : binding.documentId === "filing"
            ? { cover: { courtFileNumber: "2401-12345" }, exhibitLabels: [] }
          : { cover: { registry: "Calgary" },
            partyGroups: [{ role: "Defendant", parties: ["Beta Person"] }],
            exhibitLabels: [] },
      } };
    });
    const { host } = workspace("standalone", { draft,
      resolveInput });

    render(<CourtRecordsWorkspace host={host} initialDraftId={draft.id} />);

    expect(await screen.findByLabelText(/Court file number/iu)).toHaveValue("2401-12345");
    expect(screen.getByLabelText(/Registry/iu)).toHaveValue("");
    expect(screen.getByLabelText(/Deponent/iu)).toHaveValue("Typed deponent");
    expect(screen.getByLabelText("Plaintiff names, one per line")).toHaveValue("Typed Plaintiff");
    expect(screen.getByLabelText("Defendant names, one per line"))
      .toHaveValue("");
  });

  it("keeps only cover and party values supported by the selected format", async () => {
    const parties = [
      { id: "party-a", role: "Applicant", parties: [{ id: "applicant", name: "Alpha Ltd." }] },
      { id: "party-b", role: "Respondent", parties: [{ id: "respondent", name: "Beta Ltd." }] },
    ];
    const draft: WorkProduct<CourtRecordDraft> = { ...saved("switch-format"), state: {
      profileId: "ab-kb-commercial-compendium", cover: {
        courtFileNumber: "T-1-26", partyStyleId: "application", partyGroups: parties,
        filingPartyIds: ["respondent"],
      }, entries: [], bindings: {},
    } };
    const update = vi.fn(async (_id, change) => ({ ...draft,
      revision: update.mock.calls.length + 1, state: change.state }));
    const { host } = workspace("standalone", { draft,
      drafts: { update },
      prepareDeviceFile: async (file: File) => ({ file, pageCount: 1, searchable: true, encrypted: false }) });
    const user = userEvent.setup();
    render(<CourtRecordsWorkspace host={host} initialDraftId={draft.id} />);

    await user.click(await screen.findByRole("button", {
      name: /^Change document:/u,
    }));
    await user.click(screen.getByRole("button", { name: "Federal courts" }));
    const documents = within(screen.getByRole("dialog", { name: "Choose document" }));
    expect(documents.getByText("Trial")).toBeVisible();
    expect(documents.getByText("Appeal")).toBeVisible();
    await user.click(documents.getAllByRole("button",
      { name: /^Application record$/u })[0]);

    await uploadFiles(document.getElementById("court-record-notice-application-file")!, [new File(["source"], "Notice.pdf", { type: "application/pdf" })]);
    expect(await screen.findByLabelText(/Court file number/iu)).toHaveValue("T-1-26");
    expect(screen.getByLabelText("Applicant names, one per line"))
      .toHaveValue("Alpha Ltd.");
    await waitFor(() => expect(update.mock.calls.some(([, change]) =>
      change.state.profileId === "fc-application-record-applicant")).toBe(true));
    const applicantCover = update.mock.calls.find(([, change]) =>
      change.state.profileId === "fc-application-record-applicant")![1].state.cover;
    expect(applicantCover.partyStyleId).toBe("application");
    expect(applicantCover.filingPartyIds).toEqual(["applicant"]);

    await user.click(screen.getByRole("button", { name: /^Change document:/u }));
    await user.click(within(screen.getByRole("dialog", { name: "Choose document" }))
      .getByRole("button", { name: "Trial record" }));
    expect(screen.queryByRole("dialog", { name: "Trial record format" })).toBeNull();

    await waitFor(() => expect(update.mock.calls.some(([, change]) =>
      change.state.profileId === "fc-trial-record" &&
      change.state.cover.partyGroups?.[0]?.role === "Plaintiff")).toBe(true));
    const trialCover = [...update.mock.calls].reverse().find(([, change]) =>
      change.state.profileId === "fc-trial-record" &&
      change.state.cover.partyGroups?.[0]?.role === "Plaintiff")![1].state.cover;
    expect(trialCover.courtFileNumber).toBe("T-1-26");
    expect(trialCover.partyStyleId).toBe("action");
    expect(trialCover.partyGroups).toMatchObject([
      { role: "Plaintiff", parties: [{ name: "Alpha Ltd." }] },
      { role: "Defendant", parties: [{ name: "Beta Ltd." }] },
    ]);
  });
});

import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { randomUUID } from "node:crypto";
import * as XLSX from "xlsx";

// Live tool-loop E2E: drives the real /chat route in account-free mode with
// REAL model calls (no LLM mock) against an isolated data home. Skipped
// unless LIVE_E2E=1. It defaults to the flat-rate Codex CLI surface:
//
//   LIVE_E2E=1 npx vitest run src/__tests__/integration/liveToolLoop.test.ts
//
// Turn A: the model must use the library tools to read an uploaded lease
// and answer with the rent figure.
// Turn B: the model must route a structural-drafting-errors request to the
// deterministic lint_document tool and relay its findings.
// Turns C-D prove assistant edits survive reload in Authorities and Court Records.

const LIVE = process.env.LIVE_E2E === "1";
const MODEL = process.env.LIVE_MODEL?.trim() || "codex:gpt-6-luna";
const REASONING_EFFORT = process.env.LIVE_REASONING_EFFORT?.trim() || "low";
const TURN_TIMEOUT = 240_000;
const AUTHORITY_PDF = "Luna-vault-7Q9-Jordan-2016-SCC-27.pdf";
const SCOPE = { userId: "00000000-0000-0000-0000-000000000001" };
const ORGANIZE_FILES = [
  { filename: "Share purchase agreement.docx", text: "The buyer acquires all issued shares. The purchase price is CAD 400,000 at closing." },
  { filename: "Closing checklist.docx", text: "The share acquisition closes after the buyer receives signed transfer forms and the seller's closing certificate." },
  { filename: "Employment agreement.docx", text: "The employee receives an annual salary of CAD 90,000. Employment may be terminated on thirty days notice." },
  { filename: "Compensation letter.docx", text: "The employee's annual salary increases to CAD 95,000. The employment benefits and vacation entitlement remain unchanged." },
];

async function textDocx(text: string) {
  return Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph(text)] }] }));
}

async function seedResearch() {
  const { runtime } = await import("../../runtime"), documents = await runtime.documents(),
    sources = await runtime.sources(), { documentProjectionService } = await import("../../lib/documentProjectionService"),
    { createLibraryEvidence } = await import("../../lib/chat/legalEvidence");
  const records = [], evidence = [];
  for (const fixture of ORGANIZE_FILES) {
    const document = await documents.create(SCOPE, { filename: fixture.filename, fileType: "docx",
      bytes: await textDocx(fixture.text), libraryKind: "file" });
    const source = await documents.projectionSource(SCOPE, document.id, null);
    const text = await documentProjectionService.text(source!);
    expect(text).toContain(fixture.text);
    const start = text.indexOf(fixture.text);
    records.push(document);
    evidence.push(createLibraryEvidence({ documentId: document.id, versionId: document.current_version_id!,
      filename: fixture.filename, sourceText: text, spanText: fixture.text, start, end: start + fixture.text.length }));
  }
  let file = await sources.create(SCOPE, { title: "Acquisition and employment research",
    sources: records.map((document) => ({ provider: "library" as const, kind: "document" as const,
      id: document.id, versionId: document.current_version_id!, title: document.filename })), evidence });
  const labelId = randomUUID();
  const actions: Parameters<typeof sources.update>[2]["action"][] = [
    { type: "label", id: labelId, name: "Key terms", scope: "highlight", definition: "The agreement's operative terms." },
    ...evidence.map((receipt) => ({ type: "annotate" as const, kind: "evidence" as const,
      sourceId: Object.values(file.state.sources).find(({ reference }) => reference.id === receipt.stable_source_id)!.id,
      id: receipt.evidence_id, labelIds: [labelId] })),
  ];
  for (const action of actions) file = (await sources.update(SCOPE, file.document.id, {
    versionId: file.versionId, workingRevision: file.workingRevision, action })).file;
  return { file, sources, evidence, records };
}

vi.mock("../../lib/localMode", () => ({
  isLocalRuntime: () => true,
}));

let dataHome: string;
let closeRuntime: (() => Promise<void>) | null = null;

async function loadApi() {
  vi.resetModules();
  console.info("LIVE starting isolated runtime", { model: MODEL, reasoning: REASONING_EFFORT });
  const { api } = await import("../../api");
  console.info("LIVE API loaded");
  const { runtime } = await import("../../runtime"), workers = await runtime.startWorkers();
  console.info("LIVE workers started");
  closeRuntime = async () => { await workers.stop(); await runtime.shutdown(); };
  await (await runtime.user()).updateProfile(SCOPE, { lastSelectedChatModel: MODEL, titleModel: MODEL, tabularModel: MODEL });
  return api;
}

type SseEvent = { type?: string; [key: string]: unknown };

function sseEvents(body: string): SseEvent[] {
  return body
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)) as SseEvent);
}

function visibleText(events: SseEvent[]) {
  return events
    .filter((event) => event.type === "content_final")
    .map((event) => String(event.text ?? ""))
    .join("");
}

function toolCalls(events: SseEvent[]) {
  return events
    .filter((event) => event.type === "tool_activity" && event.status === "running")
    .map((event) => String(event.tool ?? ""));
}

async function buildLeaseDocx(): Promise<Buffer> {
  // Sections 1-3 exist; Section 9 is referenced but missing, and Schedule 2
  // is referenced while only Schedule 1 is attached — both are findings the
  // deterministic lint must surface in turn B.
  const paragraphs = [
    "COMMERCIAL LEASE AGREEMENT dated March 1, 2024 between Grandview Properties Ltd. (the \"Landlord\") and Maple Analytics Inc. (the \"Tenant\").",
    "1. Rent",
    "The initial annual rent is $84,000, payable in equal monthly instalments of $7,000 in advance.",
    "2. Term",
    "The term of this lease is five (5) years commencing April 1, 2024.",
    "3. Use",
    "The permitted use is general office use only, as further described in Schedule 1.",
    "The Tenant's early termination right is set out in Section 9.",
    "The service charge cap is listed in Schedule 2.",
    "SCHEDULE 1",
    "Permitted use: general office use.",
  ];
  const doc = new Document({
    sections: [
      {
        children: paragraphs.map(
          (text) => new Paragraph({ children: [new TextRun(text)] }),
        ),
      },
    ],
  });
  return Packer.toBuffer(doc);
}

async function buildNoticePdf() {
  const pdf = await PDFDocument.create(), page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText("NOTICE OF MOTION", { x: 72, y: 720, size: 16, font });
  page.drawText("COURT FILE NUMBER: T-982-26", { x: 72, y: 700, size: 11, font });
  page.drawText("COUNSEL NAME: Avery Counsel", { x: 72, y: 685, size: 11, font });
  page.drawText("The moving party will apply for the relief set out in this notice.",
    { x: 72, y: 655, size: 11, font });
  return Buffer.from(await pdf.save());
}

async function buildAuthorityPdf() {
  const pdf = await PDFDocument.create(), page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText("R v Jordan", { x: 72, y: 720, size: 16, font });
  page.drawText("2016 SCC 27 | [2016] 1 SCR 631", { x: 72, y: 690, size: 11, font });
  return Buffer.from(await pdf.save());
}

beforeEach(async () => {
  dataHome = await mkdtemp(path.join(os.tmpdir(), "beaver-live-e2e-"));
  vi.stubEnv("AUTH_MODE", "local");
  vi.stubEnv("OPEN_LEGAL_DATA_HOME", dataHome);
  vi.stubEnv(
    "MIKE_LOCAL_DATA_DIR",
    path.join(dataHome, "apps", "mike", "library"),
  );
  vi.stubEnv("SUPABASE_URL", "");
  vi.stubEnv("SUPABASE_SECRET_KEY", "");
});

afterEach(async () => {
  await closeRuntime?.();
  closeRuntime = null;
  vi.unstubAllEnvs();
  vi.resetModules();
  if (process.env.LIVE_KEEP_DATA === "1") console.info("LIVE data home", dataHome);
  else await rm(dataHome, { recursive: true, force: true });
});

describe.skipIf(!LIVE)("live tool loop (account-free, real model)", () => {
  it("organizes research with a reviewed revision, rejects stale acceptance, and undoes the filing", async () => {
    const api = await loadApi(), { file } = await seedResearch(), id = file.document.id,
      input = { model: MODEL, reasoningEffort: REASONING_EFFORT, repropose: true, rows: "sources",
        request: "Organize this research into Acquisition and Employment source categories. File all four sources. Keep the names short." };
    const first = await request(api).post(`/source-workspaces/${id}/labels/preview`).timeout(180_000).send(input);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.proposalId).toBeTruthy();
    const pending = (await request(api).get(`/source-workspaces/${id}`)).body;
    expect(pending.state.labels).toEqual(file.state.labels);
    expect(pending.state.sources).toEqual(file.state.sources);
    expect(pending.state.proposals).toEqual(expect.arrayContaining([expect.objectContaining({ model: MODEL })]));
    const edited = structuredClone(first.body.design);
    edited.sourceLabels[0].name = "Reviewed category";
    edited.sourceLabels[0].color = "#315efb";
    const revised = await request(api).post(`/source-workspaces/${id}/labels/preview`).timeout(180_000).send({
      ...input, proposalId: first.body.proposalId, currentDesign: edited,
      request: "Keep my category named Reviewed category, its colour and existing members. Improve the remaining source filing; include all four sources." });
    expect(revised.status, JSON.stringify(revised.body)).toBe(200);
    expect(revised.body.design.sourceLabels).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Reviewed category", color: "#315efb" })]));
    const stale = await request(api).post(`/source-workspaces/${id}/labels`).send({ ...input,
      request: undefined, proposalId: first.body.proposalId, design: first.body.design, fingerprint: first.body.fingerprint });
    expect(stale.status).toBe(409);
    const accepted = await request(api).post(`/source-workspaces/${id}/labels`).send({ ...input,
      request: undefined, proposalId: revised.body.proposalId, design: revised.body.design, fingerprint: revised.body.fingerprint });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const saved = (await request(api).get(`/source-workspaces/${id}`)).body;
    expect(saved.state.proposals).toHaveLength(0);
    expect(Object.values(saved.state.sources).every((source: any) => source.labelIds.length > 0)).toBe(true);
    const undo = await request(api).post(`/source-workspaces/${id}/actions`).send({
      version_id: saved.versionId, working_revision: saved.workingRevision,
      action: { type: "undo", changeId: revised.body.proposalId } });
    expect(undo.status, JSON.stringify(undo.body)).toBe(200);
    const restored = (await request(api).get(`/source-workspaces/${id}`)).body;
    expect(restored.state.labels).toEqual(file.state.labels);
    expect(restored.state.sources).toEqual(file.state.sources);
    console.info("LIVE Organize proof", { model: MODEL, proposals: [first.body.proposalId, revised.body.proposalId],
      sources: Object.keys(saved.state.sources).length, undo: undo.status });
  }, 480_000);

  it("creates a suggested research table with original passage references and reopens it", async () => {
    const api = await loadApi(), { file, evidence } = await seedResearch(), id = file.document.id;
    const preview = await request(api).post(`/source-workspaces/${id}/table/preview`).timeout(180_000).send({
      model: MODEL, reasoningEffort: REASONING_EFFORT, repropose: true,
      request: "Arrange the saved research into a table with one row per source and columns for Acquisition terms and Employment terms. Map each existing operative-terms passage to its appropriate column by reference." });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.proposed, preview.body.fallback).toBe(true);
    const created = await request(api).post(`/source-workspaces/${id}/table`).send({
      design: preview.body.design, fingerprint: preview.body.fingerprint });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const reopened = await request(api).get(`/tabular-review/${created.body.id}`);
    expect(reopened.status).toBe(200);
    expect(reopened.body.review.scope_config.frozen).toBe(true);
    expect(reopened.body.review.document_ids).toHaveLength(4);
    const answered = reopened.body.cells.filter((cell: any) => cell.status === "done" && cell.content?.evidence?.length);
    expect(answered.length).toBeGreaterThanOrEqual(4);
    expect(answered.every((cell: any) => cell.content.claims.every((claim: any) =>
      claim.evidence_ids.every((id: string) => cell.content.evidence.some((receipt: any) => receipt.evidence_id === id))))).toBe(true);
    const originals = new Map(evidence.map(receipt => [receipt.evidence_id, receipt]));
    const imported = answered.flatMap((cell: any) => cell.content.evidence);
    expect([...new Set(imported.map((receipt: any) => receipt.evidence_id))].sort()).toEqual([...originals.keys()].sort());
    for (const receipt of imported) expect(receipt).toEqual(originals.get(receipt.evidence_id));
    console.info("LIVE table layout proof", { model: MODEL, review: created.body.id, rows: 4, groundedCells: answered.length });
  }, TURN_TIMEOUT);

  it.each(["library", "project"])("organizes %s folders and refuses a stale filing proposal", async (kind) => {
    const api = await loadApi();
    const project = kind === "project" ? await request(api).post("/projects").send({ name: "Luna folder pilot" }) : null;
    if (project) expect(project.status).toBe(201);
    const base = project ? `/projects/${project.body.id}` : "/library/files", uploaded = [];
    for (const fixture of ORGANIZE_FILES) {
      const result = await request(api).post(`${base}/documents`).attach("file", await textDocx(fixture.text), fixture.filename);
      expect(result.status).toBe(201); uploaded.push(result.body);
    }
    const preview = await request(api).post(`${base}/organize/preview`).timeout(180_000).send({
      model: MODEL, reasoningEffort: REASONING_EFFORT,
      instruction: "Organize by workstream: Acquisition and Employment. File both share acquisition documents together and both employment documents together." });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.unfiled).toEqual([]);
    expect(preview.body.folders.flatMap((folder: any) => folder.documents.map((document: any) => document.id)).sort())
      .toEqual(uploaded.map(({ id }) => id).sort());
    const applied = await request(api).post(`${base}/organize/apply`).send({
      fingerprint: preview.body.fingerprint, design: preview.body.design });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body.moved).toBe(4);
    const { localLibraryStore, localProjects } = await import("../../lib/__tests__/support/localDocumentFixtures"),
      { libraryDocuments } = await import("../../lib/libraryStore"), { projectDocuments } = await import("../../lib/projectStore");
    const records = project ? await projectDocuments(localProjects, SCOPE, project.body.id)
      : await libraryDocuments(localLibraryStore, { ...SCOPE, kind: "file" });
    const folders = uploaded.map((document) => records!.find(({ id }) => id === document.id)!.folder_id);
    expect(folders.every(Boolean)).toBe(true);
    expect(folders[0]).not.toBe(folders[2]);
    for (const pair of [[0, 1], [2, 3]]) {
      const memberIds = pair.map((index) => uploaded[index].id);
      expect(new Set(records!.filter(({ id }) => memberIds.includes(id)).map(({ folder_id }) => folder_id)).size).toBe(1);
    }
    const stale = await request(api).post(`${base}/organize/apply`).send({
      fingerprint: preview.body.fingerprint, design: preview.body.design });
    expect(stale.status).toBe(409);
    console.info("LIVE folder proof", { model: MODEL, kind, ...applied.body, stale: stale.status });
  }, TURN_TIMEOUT);

  it("generates grounded tabular answers, regenerates one cell, and exports the saved review", async () => {
    const api = await loadApi(), documents = [];
    for (const [index, rent] of [84_000, 96_000].entries()) {
      const result = await request(api).post("/single-documents").attach("file",
        await textDocx(`COMMERCIAL LEASE ${index + 1}. The annual rent is CAD ${rent}. The governing law is Alberta. The lease starts on 1 April 2026.`),
        `lease-${index + 1}.docx`);
      expect(result.status).toBe(201); documents.push({ ...result.body, rent });
    }
    const created = await request(api).post("/tabular-review").send({ title: "Luna rent comparison",
      document_ids: documents.map(({ id }) => id), columns_config: [
        { index: 0, name: "Annual rent", prompt: "What is the annual rent in CAD? Return its numeric amount.", format: "number" },
        { index: 1, name: "Governing law", prompt: "What jurisdiction's law governs this lease?", format: "text" },
      ] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const base = `/tabular-review/${created.body.id}`, options = { model: MODEL, reasoning_effort: REASONING_EFFORT };
    expect((await request(api).post(`${base}/generate`).send(options)).status).toBe(202);
    const wait = async () => {
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        const detail = await request(api).get(base); expect(detail.status).toBe(200);
        if (!detail.body.review.is_running) return detail.body;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error("Live tabular workers did not finish");
    };
    const completed = await wait();
    expect(completed.cells).toHaveLength(4);
    for (const document of documents) {
      const rent = completed.cells.find((cell: any) => cell.document_id === document.id && cell.column_index === 0),
        law = completed.cells.find((cell: any) => cell.document_id === document.id && cell.column_index === 1);
      expect(rent.status, JSON.stringify(rent)).toBe("done"); expect(rent.content.value).toBe(document.rent);
      expect(law.status, JSON.stringify(law)).toBe("done"); expect(JSON.stringify(law.content)).toContain("Alberta");
      for (const cell of [rent, law]) {
        expect(cell.content.evidence.length).toBeGreaterThan(0);
        expect(cell.content.claims.length).toBeGreaterThan(0);
        expect(cell.content.claims.every((claim: any) => claim.evidence_ids.length > 0 && claim.evidence_ids.every((id: string) =>
          cell.content.evidence.some((receipt: any) => receipt.evidence_id === id && receipt.span_text.trim())))).toBe(true);
      }
    }
    const sibling = completed.cells.find((cell: any) => cell.document_id === documents[1].id && cell.column_index === 0);
    const regenerated = await request(api).post(`${base}/regenerate-cell`).send({ ...options, document_id: documents[0].id, column_index: 0 });
    expect(regenerated.status).toBe(202);
    const reopened = await wait();
    expect(reopened.cells.find((cell: any) => cell.document_id === documents[0].id && cell.column_index === 0).content.value).toBe(84_000);
    expect(reopened.cells.find((cell: any) => cell.id === sibling.id)).toEqual(sibling);
    const exported = await request(api).get(`${base}/export`).buffer(true).parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => done(null, Buffer.concat(chunks)));
    });
    expect(exported.status).toBe(200);
    expect(exported.headers["content-type"]).toContain("spreadsheetml");
    const workbook = XLSX.read(exported.body, { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets["Review"], { header: 1 });
    expect(rows).toEqual([
      ["Document", "Annual rent", "Governing law"],
      ...documents.map(document => [document.filename,
        ...[0, 1].map(index => reopened.cells.find((cell: any) =>
          cell.document_id === document.id && cell.column_index === index).content.summary)]),
    ]);
    console.info("LIVE tabular proof", { model: MODEL, rows: 2, cells: completed.cells.length,
      regenerated: regenerated.status, exportBytes: exported.body.length });
  }, 480_000);

  it(
    "builds one labelled, annotated, searchable research file with a cited memo",
    async () => {
      const api = await loadApi();
      const streamed = await request(api).post("/chat").timeout(450_000).send({
        model: MODEL, reasoning_effort: REASONING_EFFORT, expected_version: 0,
        current_turn: { kind: "message", content:
          "Do this work in the Library, not merely in your answer. Research Canadian appellate " +
          "cases on the duty of procedural fairness, using primary court decisions only. " +
          "Include Mission Institution v. Khela, Canadian Pacific Railway Company v. Canada " +
          "(Attorney General), and Nova-BioRubber Green Technologies Inc. v. Investment " +
          "Agriculture Foundation British Columbia. Create a research file titled exactly " +
          "'Luna fairness pilot'. Save at least three verified cases and relevant passage evidence. " +
          "Create source labels 'Procedural fairness' (#315EFB), with children 'Scope' (#8B5CF6) " +
          "and 'Remedy' (#E05D3D), and assign every saved case to a child with a short case note. " +
          "Create highlight labels 'Key passages' (#0F8A72), with children 'Legal test' (#D28B16) " +
          "and 'Application' (#C24170); label at least three saved passages and note at least one. " +
          "Search the saved sources for exactly 'fairness' and save that query receipt. " +
          "Finally write a memo inside this research file titled exactly 'Luna fairness pilot memo' that synthesizes the " +
          "saved cases. Supply the saved verified evidence IDs so the memo contains clickable " +
          "passage citations. Finish only after all durable writes succeed." },
      });
      expect(streamed.status).toBe(200);
      const events = sseEvents(streamed.text), calls = toolCalls(events);
      const store = await import("../../lib/__tests__/support/localDocumentFixtures");
      const scope = { userId: "00000000-0000-0000-0000-000000000001", kind: "file" as const };
      const page = await store.localLibraryStore.page(scope,
        { q: "Luna fairness pilot", parentFolderId: null, limit: 20, after: null });
      const documents = page.items.flatMap((item) => item.kind === "document" ? [item.document] : []);
      const researchDocument = documents.find(({ filename }) => filename === "Luna fairness pilot.research.md");
      console.info("LIVE research attempt", { calls, answer: visibleText(events),
        documents: documents.map(({ filename }) => filename) });
      expect(researchDocument).toBeTruthy(); expect(documents).toHaveLength(1);
      const { readResearchEvidenceParts, readResearchFile, readResearchQueries } =
        await import("../../lib/researchFile");
      const chats = await request(api).get("/chat"), chatId = chats.body[0].id,
        transcript = await request(api).get(`/chat/${chatId}`);
      const reviewed = await request(api).post("/chat").timeout(240_000).send({
        chat_id: chatId, expected_version: transcript.body.chat.transcript_version,
        model: MODEL, reasoning_effort: REASONING_EFFORT,
        current_turn: { kind: "message", content:
          "Review the saved Luna fairness pilot research file against the original request. " +
          "Preserve completed work and correct any missing work in that same file. " +
          "Ensure at least three verified Canadian appellate cases are collected, including " +
          "the three requested cases; read and save any missing case passages. Ensure EVERY saved case " +
          "has a Scope or Remedy child label and a short case note. Preserve the requested label " +
          "hierarchies and colours. Ensure at least three saved passages have Legal test or " +
          "Application child labels and at least one has a note. Finish the saved literal " +
          "fairness query and Luna fairness pilot memo with clickable citations to saved evidence " +
          "if either is missing. Use exact returned evidence IDs and continuation tokens. " +
          "Make the durable corrections and give a brief completion report." },
      });
      expect(reviewed.status, reviewed.text).toBe(200);
      console.info("LIVE research review", { calls: toolCalls(sseEvents(reviewed.text)),
        answer: visibleText(sseEvents(reviewed.text)) });
      const finalPage = await store.localLibraryStore.page(scope,
        { q: "Luna fairness pilot", parentFolderId: null, limit: 20, after: null });
      expect(finalPage.items.filter(({ kind }) => kind === "document")).toHaveLength(1);
      const research = await readResearchFile(store.localDocuments, scope, researchDocument!.id);
      expect(research).toBeTruthy();
      const labels = Object.values(research!.state.labels), sources = Object.values(research!.state.sources)
        .filter(({ collected }) => collected),
        parts = await readResearchEvidenceParts(store.localDocuments, scope, research!,
          sources.map(({ id }) => id)), evidence = [...parts.values()].flatMap(Object.values),
        queries = await readResearchQueries(store.localDocuments, scope, research!);
      const sourceLabels = labels.filter(({ scope: kind }) => kind === "source"),
        highlightLabels = labels.filter(({ scope: kind }) => kind === "highlight");
      expect(Object.fromEntries(labels.map(({ name, color }) => [name, color]))).toMatchObject({
        "Procedural fairness": "#315EFB", Scope: "#8B5CF6", Remedy: "#E05D3D",
        "Key passages": "#0F8A72", "Legal test": "#D28B16", Application: "#C24170",
      });
      expect(sources.length).toBeGreaterThanOrEqual(3);
      expect(sourceLabels.some(({ parentId }) => parentId !== null)).toBe(true);
      expect(sources.every(({ labelIds, note }) => labelIds.length > 0 && note.trim())).toBe(true);
      expect(highlightLabels.filter(({ parentId }) => parentId !== null).length).toBeGreaterThanOrEqual(2);
      expect(evidence.filter(({ labelIds }) => labelIds.length > 0).length).toBeGreaterThanOrEqual(3);
      expect(evidence.some(({ note }) => note.trim())).toBe(true);
      expect(research!.state.note.trim()).not.toBe("");
      expect(queries).toEqual(expect.arrayContaining([
        expect.objectContaining({ executor_version: "legal-source-pattern-v1",
          input: expect.objectContaining({ pattern: "fairness", target: "sources" }) }),
      ]));
      expect(research!.state.note).toContain("Luna fairness pilot memo");
      expect(research!.state.note).toContain("](</sources/view?");
      console.info("LIVE research proof", { model: MODEL, reasoning: REASONING_EFFORT, calls,
        counts: { labels: labels.length, sources: sources.length, passages: evidence.length },
        research: researchDocument!.filename });
    },
    720_000,
  );

  it(
    "reads an uploaded lease through library tools and answers with the rent",
    async () => {
      const api = await loadApi();
      const upload = await request(api)
        .post("/single-documents")
        .attach("file", await buildLeaseDocx(), "lease.docx");
      expect(upload.status).toBe(201);

      const streamed = await request(api)
        .post("/chat")
        .timeout(TURN_TIMEOUT - 10_000)
        .send({
          model: MODEL,
          reasoning_effort: REASONING_EFFORT,
          expected_version: 0,
          current_turn: {
            kind: "message",
            content:
              "What is the annual rent under the lease in my library? Quote the exact rent sentence.",
          },
        });
      expect(streamed.status).toBe(200);
      const events = sseEvents(streamed.text);
      const calls = toolCalls(events);
      const answer = visibleText(events);

      // The model must have gone through the library tools, not memory.
      expect(calls.some((name) => ["Glob", "Grep", "Read"].includes(name))).toBe(true);
      expect(answer).toContain("84,000");
      // Internal doc labels must not leak into prose.
      expect(answer).not.toMatch(/\bdoc-\d+\b/u);

      // Turn persisted: the transcript survives a reload with a version bump.
      const chats = await request(api).get("/chat");
      expect(chats.status).toBe(200);
      const chatId = (chats.body as { id: string }[])[0]?.id;
      expect(chatId).toBeTruthy();
      const transcript = await request(api).get(`/chat/${chatId}`);
      expect(transcript.status).toBe(200);
      const transcriptText = JSON.stringify(transcript.body);
      expect(transcriptText).toContain("84,000");
    },
    TURN_TIMEOUT,
  );

  it(
    "routes a drafting-errors request to the deterministic structural lint",
    async () => {
      const api = await loadApi();
      const upload = await request(api)
        .post("/single-documents")
        .attach("file", await buildLeaseDocx(), "lease.docx");
      expect(upload.status).toBe(201);

      const streamed = await request(api)
        .post("/chat")
        .timeout(TURN_TIMEOUT - 10_000)
        .send({
          model: MODEL,
          reasoning_effort: REASONING_EFFORT,
          expected_version: 0,
          current_turn: {
            kind: "message",
            content:
              "Check the lease DOCX in my library for structural drafting errors like broken cross-references or missing schedules.",
          },
        });
      expect(streamed.status).toBe(200);
      const events = sseEvents(streamed.text);
      const calls = toolCalls(events);
      const answer = visibleText(events);

      // The system prompt routes this request to the deterministic lint.
      expect(calls).toContain("lint_document");
      // The lint's verified findings surface in the answer: the missing
      // Section 9 target and the missing Schedule 2 attachment.
      expect(answer).toMatch(/Section 9/u);
      expect(answer).toMatch(/Schedule 2/u);
    },
    TURN_TIMEOUT,
  );

  it(
    "delegates parallel source review to reader subagents",
    async () => {
      const api = await loadApi();
      const streamed = await request(api).post("/chat").timeout(450_000).send({
        model: MODEL, reasoning_effort: REASONING_EFFORT, expected_version: 0,
        subagents: true, subagent_model: MODEL, subagent_effort: REASONING_EFFORT,
        current_turn: { kind: "message", content:
          "Use two parallel research readers: one on the content of the duty of procedural fairness, " +
          "and another on remedies for its breach. Use Canadian appellate cases only. Each reader " +
          "should identify one controlling case and read its relevant passages. Compare their " +
          "findings with exact passage citations." },
      });
      expect(streamed.status).toBe(200);
      const events = sseEvents(streamed.text), calls = toolCalls(events);
      const readers = events.filter(({ type }) => type === "subagent_run");
      console.info("LIVE subagent proof", { model: MODEL, reasoning: REASONING_EFFORT, calls,
        readers: readers.map(({ id, status, task, error }) => ({ id, status, task, error })),
        answer: visibleText(events) });
      expect(calls).toContain("delegate_read");
      const completed = new Map(readers.filter(({ status }) => status === "completed").map((event) => [event.id, event]));
      expect(completed.size).toBeGreaterThanOrEqual(2);
      expect(visibleText(events).trim()).not.toBe("");
      expect(visibleText(events)).toMatch(/\[\d+\]/u);
      const chats = await request(api).get("/chat");
      const transcript = await request(api).get(`/chat/${chats.body[0].id}`);
      expect(transcript.status).toBe(200);
      expect(JSON.stringify(transcript.body)).toContain("subagent_run");
      const { runtime } = await import("../../runtime");
      const stored = await (await runtime.chats()).transcript(SCOPE, chats.body[0].id);
      const storedReaders = stored!.flatMap(({ content }) => Array.isArray(content) ? content : [])
        .filter((event) => event.type === "subagent_run" && event.status === "completed");
      expect(storedReaders.length).toBeGreaterThanOrEqual(2);
      const { getReadSubagentCapability } = await import("../../lib/chat/readSubagents");
      const capability = await getReadSubagentCapability(undefined, { model: MODEL, effort: REASONING_EFFORT });
      expect(capability.available).toBe(true);
      expect(capability.runModel).toBe(MODEL);
      console.info("LIVE stored reader models", storedReaders.map((event) => event.type === "subagent_run"
        ? { model: event.model, runModel: capability.runModel, effort: event.effort } : null));
      expect(storedReaders.every((event) => event.type === "subagent_run" &&
        [MODEL, MODEL.replace("codex:", ""), capability.displayName].includes(event.model) &&
        event.effort === REASONING_EFFORT)).toBe(true);
    },
    480_000,
  );

  it(
    "uses the selected parallel citation and discovers its Library PDF",
    async () => {
      const api = await loadApi();
      const { createAuthoritiesDraft } = await import("../../lib/authoritiesDomain");
      const uploaded = await request(api).post("/single-documents")
        .attach("file", await buildAuthorityPdf(), AUTHORITY_PDF);
      expect(uploaded.status).toBe(201);
      const unitText = "See also R v Jordan, 2016 SCC 27, [2016] 1 SCR 631 at para 5.";
      const authorityText = "R v Jordan, 2016 SCC 27, [2016] 1 SCR 631", citation = "2016 SCC 27";
      const authorityStart = unitText.indexOf(authorityText);
      const authorityEnd = authorityStart + authorityText.length;
      const coreStart = unitText.indexOf(citation), pinpointStart = unitText.indexOf("para 5");
      const draft = createAuthoritiesDraft({ kind: "manual" });
      draft.units = [{ id: "footnote:1", kind: "footnote", ordinal: 0, footnoteId: 1,
        footnoteRefs: [], pageNumbers: [1], text: unitText, occurrenceIds: ["occurrence-1"] }];
      draft.authorities["2016scc27"] = { id: "2016scc27", key: "2016scc27", kind: "case",
        citation, name: "R v Jordan", displayName: null, evidenceIds: [], locators: [],
        sourceIdentity: null, excluded: false, source: { kind: "unresolved" } };
      draft.authorityOrder = ["2016scc27"];
      draft.occurrences["occurrence-1"] = { id: "occurrence-1", unitId: "footnote:1",
        start: 0, end: pinpointStart + 6, text: unitText.slice(0, pinpointStart + 6),
        authoritySpan: { start: 0, end: authorityEnd, text: unitText.slice(0, authorityEnd) },
        coreSpan: { start: coreStart, end: coreStart + citation.length, text: citation },
        pinpointSpan: { start: pinpointStart, end: pinpointStart + 6, text: "para 5" },
        kind: "case", citation, authorityId: "2016scc27", reference: null,
        pinpoints: [{ kind: "paragraph", text: "para 5" }], evidenceIds: [],
        sourceTextSha256: "a".repeat(64), localOrdinal: 0, reviewed: false };

      const created = await request(api).post("/work-products").send({
        kind: "authorities", title: "Boundary proof", project_id: null, state: draft,
      });
      expect(created.status).toBe(201);
      const product = created.body as { id: string; revision: number };
      const streamed = await request(api).post("/chat").timeout(TURN_TIMEOUT - 10_000).send({
        model: MODEL, reasoning_effort: REASONING_EFFORT, expected_version: 0,
        work_product: { kind: "authorities", id: product.id, revision: product.revision,
          focus: { item_id: "occurrence-1",
            selection: { start: authorityStart, end: authorityEnd } } },
        current_turn: { kind: "message", content:
          "The selected text is the exact authority span for the focused citation, including its " +
          `parallel citation. Apply that selected span without asking me for offsets. Then find ${AUTHORITY_PDF} ` +
          "in the Library and attach it to that authority as its English source." },
      });
      expect(streamed.status).toBe(200);
      const events = sseEvents(streamed.text), calls = toolCalls(events);
      const persisted = await request(api).get(`/work-products/${product.id}`);
      expect(persisted.status).toBe(200);
      expect(persisted.body.revision).toBeGreaterThan(product.revision);
      expect(persisted.body.state.occurrences["occurrence-1"].authoritySpan).toEqual({
        start: authorityStart, end: authorityEnd, text: authorityText,
      });
      const source = persisted.body.state.authorities["2016scc27"].source;
      expect(source).toMatchObject({ kind: "attached", sources: [expect.objectContaining({
        filename: AUTHORITY_PDF, language: "en",
      })] });
      expect(persisted.body.state.bindings[source.sources[0].bindingRole]).toEqual({
        kind: "document", documentId: uploaded.body.id, version: "latest",
      });
      console.info("LIVE Authorities proof", { model: MODEL, reasoning: REASONING_EFFORT,
        calls, revision: persisted.body.revision,
        authoritySpan: persisted.body.state.occurrences["occurrence-1"].authoritySpan,
        source: source.sources[0] });
    },
    TURN_TIMEOUT,
  );

  it(
    "fills only empty Court fields and attaches a Library PDF with a latest binding",
    async () => {
      const api = await loadApi();
      const uploaded = await request(api).post("/single-documents")
        .attach("file", await buildNoticePdf(), "Notice of Motion.pdf");
      expect(uploaded.status).toBe(201);
      const created = await request(api).post("/work-products").send({
        kind: "court-record", title: "Motion record", project_id: null,
        state: { profileId: "fc-motion-record-moving",
          cover: { courtFileNumber: "T-111-26" }, entries: [], bindings: {} },
      });
      expect(created.status).toBe(201);
      const product = created.body as { id: string; revision: number };
      const streamed = await request(api).post("/chat").timeout(TURN_TIMEOUT - 10_000).send({
        model: MODEL, reasoning_effort: REASONING_EFFORT, expected_version: 0,
        work_product: { kind: "court-record", id: product.id, revision: product.revision },
        current_turn: { kind: "message", files: [{ document_id: uploaded.body.id }], content:
          "Read the uploaded Notice of Motion.pdf. Fill the active Court Record's empty counsel " +
          "name from it and attach that same PDF to the required notice-motion slot. Preserve " +
          "the lawyer-entered court file number T-111-26. Do not create another document." },
      });
      expect(streamed.status).toBe(200);
      const events = sseEvents(streamed.text), calls = toolCalls(events);
      const persisted = await request(api).get(`/work-products/${product.id}`);
      expect(persisted.status).toBe(200);
      expect(persisted.body.revision).toBeGreaterThan(product.revision);
      const entry = persisted.body.state.entries.find(
        (item: { kindId?: string }) => item.kindId === "notice-motion",
      );
      expect(entry).toBeTruthy();
      expect(persisted.body.state.cover).toMatchObject({
        courtFileNumber: "T-111-26", counselName: "Avery Counsel",
      });
      expect(persisted.body.state.bindings[entry.id]).toEqual({
        kind: "document", documentId: uploaded.body.id, version: "latest",
      });
      console.info("LIVE Court Record proof", { model: MODEL, reasoning: REASONING_EFFORT,
        calls, revision: persisted.body.revision,
        cover: persisted.body.state.cover, entryId: entry.id,
        binding: persisted.body.state.bindings[entry.id] });
    },
    TURN_TIMEOUT,
  );
});

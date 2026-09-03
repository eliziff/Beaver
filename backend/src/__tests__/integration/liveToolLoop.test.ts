import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { PDFDocument, StandardFonts } from "pdf-lib";

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
const MODEL = process.env.LIVE_MODEL?.trim() || "codex:gpt-5.6-luna";
const REASONING_EFFORT = process.env.LIVE_REASONING_EFFORT?.trim() || "low";
const TURN_TIMEOUT = 240_000;

vi.mock("../../lib/localMode", () => ({
  isLocalRuntime: () => true,
}));

let dataHome: string;
let closeRuntime: (() => Promise<void>) | null = null;

async function loadApi() {
  vi.resetModules();
  const { api } = await import("../../api");
  const { runtime } = await import("../../runtime"), workers = await runtime.startWorkers();
  closeRuntime = async () => { await workers.stop(); await runtime.shutdown(); };
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
  page.drawText("The moving party will apply for the relief set out in this notice.",
    { x: 72, y: 680, size: 11, font });
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
  await rm(dataHome, { recursive: true, force: true });
});

describe.skipIf(!LIVE)("live tool loop (account-free, real model)", () => {
  it(
    "builds a labelled multi-case research file with passage highlights and a linked memo",
    async () => {
      const api = await loadApi();
      const streamed = await request(api).post("/chat").send({
        model: MODEL, reasoning_effort: REASONING_EFFORT, expected_version: 0,
        current_turn: { kind: "message", content:
          "Do this work in the Library, not merely in your answer. Research Canadian appellate " +
          "cases on the duty of procedural fairness. Create a research file titled exactly " +
          "'Luna fairness pilot'. Save at least three verified cases and relevant passage evidence. " +
          "Create coloured source labels with a root 'Procedural fairness' and at least two child " +
          "labels, and assign every saved case to a child label with a short case note. Create " +
          "coloured highlight labels with a root 'Key passages' and children 'Legal test' and " +
          "'Application'; assign at least three saved passages to those children. Finally create " +
          "a linked Markdown memo titled exactly 'Luna fairness pilot memo' that synthesizes the " +
          "saved cases with citations. Finish only after all durable writes succeed." },
      });
      expect(streamed.status).toBe(200);
      const events = sseEvents(streamed.text), calls = toolCalls(events);
      const store = await import("../../lib/__tests__/support/localDocumentFixtures");
      const scope = { userId: "00000000-0000-0000-0000-000000000001", kind: "file" as const };
      const page = await store.localLibraryStore.page(scope,
        { q: "Luna fairness pilot", parentFolderId: null, limit: 20, after: null });
      const documents = page.items.flatMap((item) => item.kind === "document" ? [item.document] : []);
      const researchDocument = documents.find(({ filename }) => filename === "Luna fairness pilot.research.md");
      const memo = documents.find(({ filename }) => filename === "Luna fairness pilot memo.md");
      console.info("LIVE research attempt", { calls, answer: visibleText(events),
        documents: documents.map(({ filename }) => filename) });
      expect(researchDocument).toBeTruthy(); expect(memo).toBeTruthy();
      const { readResearchFile } = await import("../../lib/researchFile");
      const research = await readResearchFile(store.localDocuments, scope, researchDocument!.id);
      expect(research).toBeTruthy();
      const labels = Object.values(research!.state.labels), sources = Object.values(research!.state.sources),
        evidence = Object.values(research!.state.evidence);
      const sourceLabels = labels.filter(({ scope: kind }) => kind === "source"),
        highlightLabels = labels.filter(({ scope: kind }) => kind === "highlight");
      expect(sources.length).toBeGreaterThanOrEqual(3);
      expect(sourceLabels.some(({ parentId }) => parentId !== null)).toBe(true);
      expect(sources.every(({ labelIds, note }) => labelIds.length > 0 && note.trim())).toBe(true);
      expect(highlightLabels.filter(({ parentId }) => parentId !== null).length).toBeGreaterThanOrEqual(2);
      expect(evidence.filter(({ labelIds }) => labelIds.length > 0).length).toBeGreaterThanOrEqual(3);
      const memoContent = await store.localDocuments.read(scope, memo!.id, null, false);
      expect(memoContent?.bytes.toString("utf8")).toMatch(/\[Research file\]\(document:\/\//u);
      console.info("LIVE research proof", { model: MODEL, reasoning: REASONING_EFFORT, calls,
        counts: { labels: labels.length, sources: sources.length, passages: evidence.length },
        research: researchDocument!.filename, memo: memo!.filename });
    },
    480_000,
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
    "edits an Authorities citation boundary and persists the model's exact range",
    async () => {
      const api = await loadApi();
      const { createAuthoritiesDraft } = await import("../../lib/authoritiesDomain");
      const unitText = "See also R v Jordan, 2016 SCC 27 at para 5.";
      const authorityText = "R v Jordan, 2016 SCC 27", citation = "2016 SCC 27";
      const authorityStart = unitText.indexOf(authorityText);
      const authorityEnd = authorityStart + authorityText.length;
      const coreStart = unitText.indexOf(citation), pinpointStart = unitText.indexOf("para 5");
      const draft = createAuthoritiesDraft({ kind: "manual" });
      draft.units = [{ id: "footnote:1", kind: "footnote", ordinal: 0, footnoteId: 1,
        footnoteRefs: [], pageNumbers: [1], text: unitText, occurrenceIds: ["occurrence-1"] }];
      draft.authorities["2016scc27"] = { id: "2016scc27", key: "2016scc27", kind: "case",
        citation, name: "R v Jordan", displayName: null, evidenceIds: [], locators: [],
        sourceIdentity: null, excluded: false, tabLabel: null, source: { kind: "unresolved" } };
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
      const streamed = await request(api).post("/chat").send({
        model: MODEL, reasoning_effort: REASONING_EFFORT, expected_version: 0,
        work_product: { kind: "authorities", id: product.id, revision: product.revision },
        current_turn: { kind: "message", content:
          "Edit the active Authorities draft. Read occurrence-1, then make its authority span " +
          "exactly 'R v Jordan, 2016 SCC 27'. The leading words " +
          "'See also' and the pinpoint 'para 5' must stay outside that span. Do not merely explain." },
      });
      expect(streamed.status).toBe(200);
      const events = sseEvents(streamed.text), calls = toolCalls(events);
      const persisted = await request(api).get(`/work-products/${product.id}`);
      expect(persisted.status).toBe(200);
      expect(persisted.body.revision).toBeGreaterThan(product.revision);
      expect(persisted.body.state.occurrences["occurrence-1"].authoritySpan).toEqual({
        start: authorityStart, end: authorityEnd, text: authorityText,
      });
      console.info("LIVE Authorities proof", { model: MODEL, reasoning: REASONING_EFFORT,
        calls, revision: persisted.body.revision,
        authoritySpan: persisted.body.state.occurrences["occurrence-1"].authoritySpan });
    },
    TURN_TIMEOUT,
  );

  it(
    "attaches an uploaded Library PDF to a Court Record slot and persists the binding",
    async () => {
      const api = await loadApi();
      const uploaded = await request(api).post("/single-documents")
        .attach("file", await buildNoticePdf(), "Notice of Motion.pdf");
      expect(uploaded.status).toBe(201);
      const created = await request(api).post("/work-products").send({
        kind: "court-record", title: "Motion record", project_id: null,
        state: { profileId: "fc-motion-record-moving", cover: {}, entries: [], bindings: {} },
      });
      expect(created.status).toBe(201);
      const product = created.body as { id: string; revision: number };
      const streamed = await request(api).post("/chat").send({
        model: MODEL, reasoning_effort: REASONING_EFFORT, expected_version: 0,
        work_product: { kind: "court-record", id: product.id, revision: product.revision },
        current_turn: { kind: "message", files: [{ document_id: uploaded.body.id }], content:
          "Attach the uploaded Notice of Motion.pdf to the active Court Record's required " +
          "notice-motion slot. Do not change the cover or create another document." },
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
      expect(persisted.body.state.bindings[entry.id]).toEqual({
        kind: "document", documentId: uploaded.body.id, version: "latest",
      });
      console.info("LIVE Court Record proof", { model: MODEL, reasoning: REASONING_EFFORT,
        calls, revision: persisted.body.revision, entryId: entry.id,
        binding: persisted.body.state.bindings[entry.id] });
    },
    TURN_TIMEOUT,
  );
});

import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Document, Packer, Paragraph, TextRun } from "docx";

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

const LIVE = process.env.LIVE_E2E === "1";
const MODEL = process.env.LIVE_MODEL?.trim() || "codex:gpt-5.6-luna";
const TURN_TIMEOUT = 240_000;

vi.mock("../../lib/localMode", () => ({
  isLocalRuntime: () => true,
}));

let dataHome: string;
let closeLocalStore: (() => Promise<void>) | null = null;

async function loadApi() {
  vi.resetModules();
  const { api } = await import("../../api");
  closeLocalStore = async () => (await import("../../lib/relationalDatabase"))
    .closeRelationalDatabase();
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
    .filter((event) => event.type === "content_delta")
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
  await closeLocalStore?.();
  closeLocalStore = null;
  vi.unstubAllEnvs();
  vi.resetModules();
  await rm(dataHome, { recursive: true, force: true });
});

describe.skipIf(!LIVE)("live tool loop (account-free, real model)", () => {
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
});

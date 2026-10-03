import { buildCourtRecord } from "../../frontend/src/app/court-records/assembly";
import { COURT_PROFILE_BY_ID } from "../../frontend/src/app/court-records/profiles";
import type { RecordEntry } from "../../frontend/src/app/court-records/types";

// Invented inventory records; no user documents, prompts, app storage or provider calls.
const NativeDate = Date;
const fixedTime = NativeDate.parse("2026-01-02T12:00:00Z");
globalThis.Date = class extends NativeDate {
  constructor(value?: string | number) { super(value ?? fixedTime); }
  static now() { return fixedTime; }
} as DateConstructor;

const cover = {
  courtFileNumber: "T-90000-26", partyStyleId: "application",
  partyGroups: [
    { id: "party-a", role: "Applicant", parties: [{ id: "first", name: "Northstar Inventory Ltd." }] },
    { id: "party-b", role: "Respondent", parties: [{ id: "second", name: "Bayleaf Storage Ltd." }] },
  ],
  filingPartyIds: ["first"], counselName: "Sample Filing Office",
  counselAddress: "10 Sample Avenue", counselPhone: "555-0100",
  counselEmail: "benchmark@example.test", recordSubtitle: "Inventory inspection materials",
  applicationUnder: "Sample procedural application",
};
let entries: RecordEntry[];
const digest = async (bytes: Uint8Array) => Array.from(new Uint8Array(
  await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)),
  value => value.toString(16).padStart(2, "0")).join("");

Object.assign(window, { courtPdfBenchmark: {
  async prepare(workload: string) {
    const manifest = await (await fetch(`/fixtures/${workload}.json`)).json() as Array<{
      id: string; title: string; kindId: string; path: string; pages: number; sha256: string;
    }>;
    entries = await Promise.all(manifest.map(async input => {
      const bytes = new Uint8Array(await (await fetch(`/fixtures/${input.path}`)).arrayBuffer());
      if (await digest(bytes) !== input.sha256) throw new Error("Source digest mismatch");
      return { id: input.id, title: input.title, kindId: input.kindId,
        file: new File([bytes], `${input.id}.pdf`, { type: "application/pdf" }),
        pageCount: input.pages, searchable: true, encrypted: false };
    }));
    return { documents: entries.length, pages: entries.reduce((sum, entry) => sum + entry.pageCount!, 0) };
  },
  async run() {
    const progress: Array<[string, number, number]> = [];
    const started = performance.now();
    const result = await buildCourtRecord({ profile: COURT_PROFILE_BY_ID.get("fc-motion-record-moving")!,
      entries, cover, preparationDate: "2026-01-02",
      onProgress: (message, completed, total) => progress.push([message, completed, total]) });
    const wallMs = performance.now() - started;
    const artifacts = await Promise.all(result.artifacts.map(async artifact => {
      const sha256 = await digest(artifact.bytes);
      if (sha256 !== artifact.sha256) throw new Error("Output digest mismatch");
      return { filename: artifact.filename, role: artifact.role, mimeType: artifact.mimeType,
        pageCount: artifact.pageCount, byteCount: artifact.bytes.byteLength, sha256 };
    }));
    return { wallMs, oracle: { artifacts, receipt: result.receipt, progress } };
  },
} });

// SLA drafting workflow — Spec→Ledger→Draft→Audit→Grounding — wired over
// the deterministic organs that already exist (skeleton outlines, anchor
// coverage). The LLM keeps judgment; it loses bookkeeping:
//   Spec     the drafting contract rides in the system prompt
//   Ledger   per-document skeleton outlines + the source anchor inventory
//   Draft    the normal provider tool loop, steered to section-scoped reads
//   Audit    deterministic anchor coverage of the draft vs the sources,
//            typed findings returned for exactly one revision pass
//   Grounding the final coverage report, persisted as a machine receipt
// Enabled per-process with MIKE_SLA_WORKFLOW=1 (same pattern as the other
// sealed-run gates); receipts append to MIKE_SLA_RECEIPT_PATH when set.
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import {
  anchorCoverage,
  type AnchorCoverageReport,
  type AnchorDocument,
  type AnchorRow,
} from "../legalTextAnchors";
import {
  compileAgreementSkeleton,
  renderAgreementOutline,
} from "../legalTextSkeleton";
import { listLocalLibrary } from "../localDocumentStore";
import { extractLocalDocument } from "./localAssistantTools";

const MAX_LEDGER_DOCUMENTS = 8;
const MAX_OUTLINE_CHARS = 4_000;
const MAX_FINDING_ROWS_PER_CLASS = 12;

export function slaWorkflowEnabled(): boolean {
  return process.env.MIKE_SLA_WORKFLOW === "1";
}

export interface SlaLedger {
  documents: AnchorDocument[];
  /** Appended to the system prompt: the Spec contract + document outlines. */
  promptSection: string;
  /**
   * Library snapshot at ledger build (documentId -> currentVersionId), over
   * the WHOLE library, not just the in-scope sources: a deliverable created
   * or revised during the turn is recognized by diffing against this.
   */
  baseline: ReadonlyMap<string, string>;
}

/**
 * Ledger phase: outline every in-scope document and carry the raw texts for
 * the audit. Returns null when there is nothing to draft against.
 */
export async function buildSlaLedger(
  userId: string,
  allowedDocumentIds: ReadonlySet<string> | null,
): Promise<SlaLedger | null> {
  const collection = await listLocalLibrary(userId, "file");
  const baseline = new Map<string, string>(
    collection.documents.map((document) => [
      document.id,
      document.current_version_id,
    ]),
  );
  const inScope = collection.documents.filter(
    (document) => !allowedDocumentIds || allowedDocumentIds.has(document.id),
  );
  const documents: AnchorDocument[] = [];
  const outlines: string[] = [];
  for (const meta of inScope.slice(0, MAX_LEDGER_DOCUMENTS)) {
    const document = await extractLocalDocument(userId, meta.id);
    if (!document?.text?.trim()) continue;
    documents.push({ name: document.filename, text: document.text });
    const skeleton = compileAgreementSkeleton(document.text);
    outlines.push(
      skeleton.nodes.length
        ? `## ${document.filename}\n${renderAgreementOutline(skeleton, { maxChars: MAX_OUTLINE_CHARS })}`
        : `## ${document.filename}\n(no structural handles compiled — read this one in full)`,
    );
  }
  if (!documents.length) return null;
  const dropped = inScope.length - documents.length;
  const promptSection =
    `\n\nSLA DRAFTING WORKFLOW is active (Spec→Ledger→Draft→Audit→Grounding).\n` +
    `Structural outlines of the matter documents follow — they are the map, not the content:\n` +
    `- Pull only the spans you need with library_read section="<handle>" using handles from these outlines; avoid whole-document reads when a handle covers the need.\n` +
    `- Work deliverable-first: enumerate the deliverable's required topics from the instructions, then read precisely against them.\n` +
    `- After you produce the deliverable, a deterministic audit compares it to the source documents' anchors (amounts, dates, section references, citations) and you will get exactly one revision pass with typed findings. Expect it; keep judgment for it.\n` +
    (dropped > 0 ? `- (${dropped} additional document(s) exceeded the ledger cap; list and read them yourself.)\n` : "") +
    `\n${outlines.join("\n\n")}`;
  return { documents, promptSection, baseline };
}

export interface SlaDeliverable {
  /** Chat text plus the text of every document created/revised this turn. */
  text: string;
  /** Filenames of the included artifact documents (receipt evidence). */
  artifacts: string[];
}

const MAX_DELIVERABLE_ARTIFACTS = 8;

/**
 * The deliverable for a file-producing task is the artifact, not the chat
 * message ("I've created the document…" carries no anchors — the smoke run
 * that audited it read 0 matched / 0 draft_only against 59 source anchors).
 * Diff the library against the ledger baseline and fold new or revised
 * documents' text into the audited draft.
 */
export async function collectSlaDeliverable(
  userId: string,
  ledger: SlaLedger,
  chatText: string,
): Promise<SlaDeliverable> {
  const artifacts: { name: string; text: string }[] = [];
  try {
    const collection = await listLocalLibrary(userId, "file");
    for (const meta of collection.documents) {
      if (ledger.baseline.get(meta.id) === meta.current_version_id) continue;
      if (artifacts.length >= MAX_DELIVERABLE_ARTIFACTS) break;
      const document = await extractLocalDocument(userId, meta.id);
      if (document?.text?.trim()) {
        artifacts.push({ name: document.filename, text: document.text });
      }
    }
  } catch {
    // Store trouble degrades to auditing the chat text alone.
  }
  return {
    text: [
      chatText,
      ...artifacts.map(
        (artifact) =>
          `\n\n[deliverable document: ${artifact.name}]\n${artifact.text}`,
      ),
    ].join(""),
    artifacts: artifacts.map((artifact) => artifact.name),
  };
}

export interface SlaAudit {
  /** Null when the audit found nothing worth a revision pass. */
  repairPrompt: string | null;
  receipt: {
    source_only_total: number;
    draft_only_total: number;
    matched_total: number;
    classes: Record<
      string,
      { matched: number; source_only: number; draft_only: number }
    >;
  };
  report: AnchorCoverageReport;
}

function findingRows(rows: AnchorRow[]): string {
  return rows
    .slice(0, MAX_FINDING_ROWS_PER_CLASS)
    .map((row) => `${row.display} [${row.documents[0] ?? "?"}]`)
    .join("; ");
}

/**
 * Audit phase: deterministic two-way anchor coverage of the draft against
 * the ledger sources. Zero model calls.
 */
export function auditSlaDraft(
  ledger: SlaLedger,
  draft: string,
  options?: {
    /** The deliverable includes library artifacts (repair goes via tools). */
    artifactDeliverable?: boolean;
  },
): SlaAudit {
  const report = anchorCoverage(ledger.documents, [
    { name: "draft", text: draft },
  ]);
  const classes: SlaAudit["receipt"]["classes"] = {};
  let sourceOnly = 0;
  let draftOnly = 0;
  let matched = 0;
  const missingLines: string[] = [];
  const unsourcedLines: string[] = [];
  for (const [cls, coverage] of Object.entries(report.classes)) {
    classes[cls] = {
      matched: coverage.matched,
      source_only: coverage.source_only.length,
      draft_only: coverage.draft_only.length,
    };
    sourceOnly += coverage.source_only.length;
    draftOnly += coverage.draft_only.length;
    matched += coverage.matched;
    if (coverage.source_only.length) {
      missingLines.push(
        `- ${cls}${coverage.source_only_truncated ? " (truncated list)" : ""}: ${findingRows(coverage.source_only)}`,
      );
    }
    if (coverage.draft_only.length) {
      unsourcedLines.push(`- ${cls}: ${findingRows(coverage.draft_only)}`);
    }
  }
  const repairPrompt =
    missingLines.length || unsourcedLines.length
      ? `DETERMINISTIC AUDIT (no model involved; computed from the source documents and your deliverable):\n` +
        (missingLines.length
          ? `\nAnchors present in the source documents but absent from your deliverable:\n${missingLines.join("\n")}\n`
          : "") +
        (unsourcedLines.length
          ? `\nAnchors in your deliverable with no match in any source document — verify each against the source and correct or remove what you cannot ground:\n${unsourcedLines.join("\n")}\n`
          : "") +
        `\nNot every missing anchor is material — exercise judgment. Re-read the exact sections involved via their outline handles, then ` +
        (options?.artifactDeliverable
          ? `apply the corrections to the deliverable document itself with the library tools (revise the document; do not paste its content into chat).`
          : `output the COMPLETE revised deliverable (full text, same format), not a description of changes.`)
      : null;
  return {
    repairPrompt,
    receipt: {
      source_only_total: sourceOnly,
      draft_only_total: draftOnly,
      matched_total: matched,
      classes,
    },
    report,
  };
}

/** Grounding phase: append a machine receipt line (JSONL) when configured. */
export function appendSlaReceipt(entry: Record<string, unknown>): void {
  const configured = process.env.MIKE_SLA_RECEIPT_PATH?.trim();
  if (!configured) return;
  try {
    mkdirSync(path.dirname(configured), { recursive: true });
    appendFileSync(
      configured,
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
      "utf8",
    );
  } catch {
    // Receipts are best-effort telemetry; never fail the turn over them.
  }
}

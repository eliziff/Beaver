// SLA drafting workflow — Spec→Ledger→Draft→Audit→Grounding — wired over
// the deterministic organs that already exist (skeleton outlines, anchor
// coverage). The LLM keeps judgment; it loses bookkeeping:
//   Spec     the drafting contract rides in the system prompt (always-on
//            rules only; inventory and structure stay on demand so
//            per-document state never becomes standing prompt weight)
//   Ledger   the source documents' texts + the library snapshot, carried
//            for the deterministic audit only — never into model context
//   Draft    the normal provider tool loop, steered to section-scoped reads
//   Audit    four deterministic organs over the draft and the sources —
//            anchor coverage, arithmetic conflicts, defined-term drift,
//            drafting lint — typed findings returned for exactly one
//            revision pass
//   Grounding the final coverage report, persisted as a machine receipt
// Enabled per-process with MIKE_SLA_WORKFLOW=1 (same pattern as the other
// sealed-run gates); receipts append to MIKE_SLA_RECEIPT_PATH when set.
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { conflictScan, type ConflictFinding } from "../legalConflictScan";
import { draftingLint, type DraftingFinding } from "../legalDraftingLint";
import {
  anchorCoverage,
  type AnchorCoverageReport,
  type AnchorDocument,
  type AnchorRow,
} from "../legalTextAnchors";
import { temporalScan, type TemporalFinding } from "../legalTemporalScan";
import { termDriftReport } from "../legalTermDrift";
import { listLocalLibrary } from "../localDocumentStore";
import { extractLocalDocument } from "./localAssistantTools";

const MAX_LEDGER_DOCUMENTS = 32;
const MAX_FINDING_ROWS_PER_CLASS = 12;
/** Repair-prompt caps, per organ: findings are evidence, not a report. */
const MAX_CONFLICT_FINDINGS = 8;
const MAX_DRIFT_TERMS = 6;
const MAX_LINT_FINDINGS = 10;
/** The draft's document name inside every organ that takes a stack. */
const DRAFT_NAME = "draft";

export function slaWorkflowEnabled(): boolean {
  return process.env.MIKE_SLA_WORKFLOW === "1";
}

export interface SlaLedger {
  documents: AnchorDocument[];
  /** Appended to the system prompt: the compact Spec/compiler contract. */
  promptSection: string;
  /**
   * Library snapshot at ledger build (documentId -> currentVersionId), over
   * the WHOLE library, not just the in-scope sources: a deliverable created
   * or revised during the turn is recognized by diffing against this.
   */
  baseline: ReadonlyMap<string, string>;
}

/**
 * Ledger phase: carry in-scope source text for the host-side audit. Returns
 * null when there is nothing to draft against. Nothing here enters model
 * context unless the later audit reports a bounded finding.
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
  for (const meta of inScope.slice(0, MAX_LEDGER_DOCUMENTS)) {
    const document = await extractLocalDocument(userId, meta.id);
    if (!document?.text?.trim()) continue;
    documents.push({ name: document.filename, text: document.text });
  }
  if (!documents.length) return null;
  const dropped = inScope.length - documents.length;
  // The ordinary library prompt owns inventory. Repeating filenames, token
  // estimates, and outlines here inflated every request and taught coding
  // arms to call tools that were not on their surface.
  const strategy = process.env.MIKE_SLA_STRATEGY;
  const fullWorkflow = strategy === "full" || strategy === "working_set_first";
  const workingSetFirst = strategy === "working_set_first";
  const workflowPrompt = fullWorkflow
    ? `\n\nFULL SLA WORKFLOW (Spec → Ledger → Draft → Audit → Grounding):\n` +
      `- Spec: turn the instructions into a checklist of every required issue, comparison, calculation, and deliverable field.\n` +
      `- Ledger: gather each material checklist fact into a compact source-addressed working ledger. ` +
      (workingSetFirst
        ? `Your first source-content retrieval must be Grep with output_mode="working_set" and a targeted union regex derived from the Spec (never "." or ".*"); if the inventory is abbreviated, Glob may enumerate filenames first. Read the returned path, then inspect exact source sections only for gaps or verification. Create another non-overlapping working set only if the manifest is truncated or the checklist still has gaps. `
        : `Search long documents with Grep and Read the smallest responsive section, page, table row, or reference scope; use a working_set for a bounded cross-document union when cheaper. `) +
      `Record an explicit source gap instead of guessing.\n` +
      `- Draft: create the exact requested artifact only after every material checklist item has evidence or an explicit gap.\n` +
      `- Audit and Grounding: deterministic checks run after synthesis. When findings arrive, evaluate every finding against exact source spans and revise the actual artifact for every material, source-grounded issue. Reject a finding only after verifying it is immaterial or a false positive.\n`
    : `\n\nA deterministic compiler pass will check the completed deliverable against source anchors, arithmetic, dates, and defined-term drift. When findings arrive, evaluate every finding against exact source spans and revise the actual artifact for every material, source-grounded issue. Reject only verified immaterial or false-positive findings. `;
  const promptSection =
    workflowPrompt +
    `The quality checks are automatic and are not model-callable tools.` +
    (dropped > 0
      ? ` (${dropped} source document(s) exceed the compiler's ${MAX_LEDGER_DOCUMENTS}-document audit cap.)`
      : "");
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
 * Diff the library against the ledger baseline and audit new or revised
 * documents; use chat text only when no artifact exists.
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
    text: artifacts.length
      ? artifacts
          .map(
            (artifact) =>
              `[deliverable document: ${artifact.name}]\n${artifact.text}`,
          )
          .join("\n\n")
      : chatText,
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
      {
        matched: number;
        source_only: number;
        draft_only: number;
        /** The anchors themselves, so a receipt can be checked, not trusted. */
        source_only_rows: string[];
        draft_only_rows: string[];
      }
    >;
    /** Arithmetic that does not close, over sources + draft. */
    conflict: {
      findings: number;
      consistent: number;
      /** Each detail prefixed by origin (draft | sources), capped. */
      finding_details: string[];
    };
    /** Date-plus-duration identities that do not close, over sources + draft. */
    temporal: {
      findings: number;
      consistent: number;
      finding_details: string[];
    };
    /** Defined terms whose bodies differ across sources + draft. */
    term_drift: { divergent: number; terms: string[] };
    /** Drafting lint over the draft alone, by severity. */
    drafting_lint: { errors: number; warnings: number; info: number };
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
 * A conflict finding touching the draft is the drafter's own arithmetic; one
 * confined to the sources is a source-vs-source disagreement to surface.
 */
function touchesDraft(finding: ConflictFinding): boolean {
  return [
    finding.part,
    finding.whole,
    finding.total,
    ...(finding.parts ?? []),
  ].some((figure) => figure?.document === DRAFT_NAME);
}

function lintLine(finding: DraftingFinding): string {
  return `- [${finding.severity}] ${finding.rule}: ${finding.excerpt} — ${finding.message}`;
}

/**
 * Audit phase: four deterministic organs over the draft and the ledger
 * sources — anchor coverage, arithmetic conflicts, defined-term drift (all
 * three over sources + draft as one stack) and drafting lint (draft only).
 * Zero model calls.
 */
export function auditSlaDraft(
  ledger: SlaLedger,
  draft: string,
  options?: {
    /** The deliverable includes library artifacts (repair goes via tools). */
    artifactDeliverable?: boolean;
  },
): SlaAudit {
  const draftDocument = { name: DRAFT_NAME, text: draft };
  const stack = [...ledger.documents, draftDocument];
  const report = anchorCoverage(ledger.documents, [draftDocument]);
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
      source_only_rows: coverage.source_only
        .slice(0, MAX_FINDING_ROWS_PER_CLASS)
        .map((row) => row.display),
      draft_only_rows: coverage.draft_only
        .slice(0, MAX_FINDING_ROWS_PER_CLASS)
        .map((row) => row.display),
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

  const conflict = conflictScan(stack);
  const draftConflicts = conflict.findings.filter(touchesDraft);
  const sourceConflicts = conflict.findings.filter(
    (finding) => !touchesDraft(finding),
  );
  // Budget the cap draft-first: the drafter's own arithmetic outranks a
  // disagreement it merely inherited.
  const draftConflictLines = draftConflicts
    .slice(0, MAX_CONFLICT_FINDINGS)
    .map((finding) => `- ${finding.detail}`);
  const sourceConflictLines = sourceConflicts
    .slice(0, MAX_CONFLICT_FINDINGS - draftConflictLines.length)
    .map((finding) => `- ${finding.detail}`);

  const temporal = temporalScan(stack);
  const touchesDraftTemporal = (finding: TemporalFinding) =>
    [finding.base, finding.duration, finding.stated].some(
      (ref) => ref.document === "draft",
    );
  const draftTemporal = temporal.findings.filter(touchesDraftTemporal);
  const sourceTemporal = temporal.findings.filter(
    (finding) => !touchesDraftTemporal(finding),
  );
  const draftTemporalLines = draftTemporal
    .slice(0, MAX_CONFLICT_FINDINGS)
    .map((finding) => `- ${finding.detail}`);
  const sourceTemporalLines = sourceTemporal
    .slice(0, MAX_CONFLICT_FINDINGS - draftTemporalLines.length)
    .map((finding) => `- ${finding.detail}`);

  const drift = termDriftReport(stack);
  const divergent = drift.shared.filter((row) => row.status === "divergent");
  const driftLines = divergent
    .slice(0, MAX_DRIFT_TERMS)
    .map((row) =>
      row.divergence
        ? `- "${row.term}" (${row.divergence.documents[0]} vs ${row.divergence.documents[1]}): "${row.divergence.excerpts[0]}" / "${row.divergence.excerpts[1]}"`
        : `- "${row.term}" (defined in ${row.definitions.map((def) => def.document).join(", ")})`,
    );

  const lint = draftingLint(draft);
  const lintErrors = lint.findings.filter(
    (finding) => finding.severity === "error",
  );
  const lintWarnings = lint.findings.filter(
    (finding) => finding.severity === "warning",
  );
  const lintInfo = lint.findings.filter(
    (finding) => finding.severity === "info",
  );
  const lintLines = [...lintErrors, ...lintWarnings]
    .slice(0, MAX_LINT_FINDINGS)
    .map(lintLine);

  // Lint warnings alone do not buy a revision pass: they are style-grade and
  // the pass costs a whole model turn.
  const worthARevision =
    missingLines.length > 0 ||
    unsourcedLines.length > 0 ||
    conflict.findings.length > 0 ||
    temporal.findings.length > 0 ||
    divergent.length > 0 ||
    lintErrors.length > 0;
  const repairPrompt = worthARevision
    ? `DETERMINISTIC AUDIT (no model involved; computed from the source documents and your deliverable):\n` +
      (missingLines.length
        ? `\nAnchors present in the source documents but absent from your deliverable:\n${missingLines.join("\n")}\n`
        : "") +
      (unsourcedLines.length
        ? `\nAnchors in your deliverable with no match in any source document — verify each against the source and correct or remove what you cannot ground:\n${unsourcedLines.join("\n")}\n`
        : "") +
      (draftConflictLines.length
        ? `\nArithmetic in your deliverable that does not close — your own error unless a source states it that way:\n${draftConflictLines.join("\n")}\n`
        : "") +
      (sourceConflictLines.length
        ? `\nArithmetic the source documents disagree on — not yours to invent a number for; state the discrepancy where it bears on the deliverable:\n${sourceConflictLines.join("\n")}\n`
        : "") +
      (draftTemporalLines.length
        ? `\nDeadline arithmetic in your deliverable that does not close — a period and its resolved date disagree:\n${draftTemporalLines.join("\n")}\n`
        : "") +
      (sourceTemporalLines.length
        ? `\nDeadline arithmetic the source documents state inconsistently — flag it where it bears on the deliverable:\n${sourceTemporalLines.join("\n")}\n`
        : "") +
      (driftLines.length
        ? `\nDefined terms whose definitions differ across the stack — check which one your deliverable relies on:\n${driftLines.join("\n")}\n`
        : "") +
      (lintLines.length
        ? `\nDrafting lint over your deliverable (exact spans; errors first):\n${lintLines.join("\n")}\n`
        : "") +
      `\nReview every finding; do not blindly copy source-only anchors into the deliverable. Re-read the exact source spans for each potentially material finding. Revise every grounded, material issue, and disregard a finding only after verifying that it is immaterial or a false positive. Then ` +
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
      conflict: {
        findings: conflict.findings.length,
        consistent: conflict.consistent,
        finding_details: [
          ...draftConflicts.map((finding) => `draft: ${finding.detail}`),
          ...sourceConflicts.map((finding) => `sources: ${finding.detail}`),
        ].slice(0, MAX_CONFLICT_FINDINGS),
      },
      temporal: {
        findings: temporal.findings.length,
        consistent: temporal.consistent,
        finding_details: [
          ...draftTemporal.map((finding) => `draft: ${finding.detail}`),
          ...sourceTemporal.map((finding) => `sources: ${finding.detail}`),
        ].slice(0, MAX_CONFLICT_FINDINGS),
      },
      term_drift: {
        divergent: divergent.length,
        terms: divergent.slice(0, MAX_DRIFT_TERMS).map((row) => row.term),
      },
      drafting_lint: {
        errors: lintErrors.length,
        warnings: lintWarnings.length,
        info: lintInfo.length,
      },
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

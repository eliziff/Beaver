import { sha256 } from "../hash";
import { SYSTEM_ASSISTANT_WORKFLOWS } from "../systemWorkflows";
import {
  DOCUMENT_RESOURCE_PATTERN,
  parseResourceReference,
  resourceReference,
} from "../resourceReferences";
import {
  a2ajLegalSourceProvider,
  type A2AJDocument,
  type A2AJLocatorLookup,
} from "../legalSources/a2aj";
import {
  readLegalSourcePassage,
  type LegalSourcePassage,
  type LegalSourceReference,
} from "../legalSourceRegistry";
import type { RemoteLegalSourceDocument } from "../legalSources/remoteProvider";
import { fixDocumentSupras } from "../docxDeterministicCleanup";
import { lintDocxStructure } from "../docxStructuralLint";
import {
  deleteProvisionAndRenumberSiblings,
  type DeleteAndRenumberReceipt,
} from "../structureNative";
import {
  graphScope,
  lookupStructureBlock,
  pageMapFromMarkers,
  pageMapFromSourceDoc,
  parseAddress,
  resolvePage,
  referenceLabelsOutside,
  type FollowDirection,
  type PageMap,
} from "../legalDocumentNavigator";
import { extractDocxDraftingSource } from "../docxDraftingSource";
import { resolveDocxEvidenceCitations } from "../docxEvidenceCitations";
import { resolveDraftingOptions } from "../draftingStyle";
import { getDraftingStyleSettings } from "../draftingStyleStore";
import {
  applyTrackedEdits,
  extractDocxBodyStructure,
  extractDocxBodyText,
  finalizeTrackedEdits,
  insertTrackedBlocks,
  type EditMode,
  type EditInput,
} from "../docxTrackedChanges";
import type { LibraryStore } from "../libraryStore";
import type { ProjectStore } from "../projectStore";
import type {
  AssistantEdit,
  StoredAssistantEdit,
  DocumentContent,
  DocumentProvenance,
  DocumentScope,
  DocumentStore,
} from "../documentStore";
import {
  documentProjectionService,
  type PdfLocatorKind,
} from "../documentProjectionService";
import {
  sourceDocBlockText,
  sourceDocSubtreeLabels,
  type SourceDoc,
  type SourceDocBlock,
} from "../sourceDoc";
import { analyzeDocumentNative } from "../structureNative";
import { preparePdf, preparePdfPages } from "../pdfJobs";
import {
  lookupProviderPdfReference,
  rehydrateProviderPdfReference,
} from "../providerPdfLibraryBridge";
import type {
  NormalizedToolCall,
  Tool,
} from "../llm";
import {
  getTableOfAuthoritiesJob,
  submitTableOfAuthoritiesDocument,
} from "../tableOfAuthorities";
import {
  a2ajLookupEvidenceBlocks,
  assistantReadEvidenceActivityLabel,
  assistantToolActivityLabel,
  readA2AJReferenceNeighborhood,
  type A2AJReferenceDirection,
} from "./tools/a2ajTools";
import {
  createA2AJLookupEvidence,
  createA2AJPassageEvidence,
  createCourtlistenerEvidence,
  createGovInfoEvidence,
  createGovUkEmploymentTribunalEvidence,
  createHansardEvidence,
  createTnaEvidence,
  createLibraryEvidence,
  createPublicJournalPassageEvidence,
  legalEvidenceProseIntegrityErrors,
  modelEvidencePassage,
  registerLegalEvidence,
  type LegalEvidenceReceipt,
  type LegalEvidenceTurnState,
  type RegisteredEvidence,
} from "./legalEvidence";
import { CITATOR_TOOLS, executeCitatorTool } from "./tools/citatorTools";
import {
  COMPARE_VERSIONS_TOOLS,
  compareDocumentVersions,
} from "./tools/compareVersionsTool";
import {
  SEARCH_SOURCES_TOOL,
  searchSources,
} from "./tools/sourceSearchTools";
import { queueProviderPdfRenditions } from "../providerPdfLibraryBridge";
import {
  applyTextOpsToDocx,
  type TextOpRequest,
} from "../docxTextOps";
import {
  buildPptxPresentation,
  findTextMatches,
  presentationFromMarkdown,
  renderMarkdownDocx,
  renderXlsxWorkbook,
  safeGeneratedFilename,
  workbookFromMarkdown,
} from "./tools/documentOps";
import { quoteRepairSuggestion } from "./quoteRepair";
import { projectDocxRedline } from "../docx/redline";
import {
  ADVANCED_DOCX_EDIT_TOOL,
  TABULAR_TOOLS,
  WRITE_TOOL,
} from "./tools/toolSchemas";
import {
  courtlistenerPdfRendition,
} from "./courtlistenerToolRunner";
import { jsonRecord as objectRecord, trimmedText as trimmed } from "../value";
import { RESOURCE_TOOLS, globPattern as globRegExp } from "./resourceTools";
import {
  supraFixEvent,
  tableOfAuthoritiesEvent,
} from "./localAutomationEvent";
import {
  MAX_MODEL_TOOL_RESULT_CHARS,
  toolText,
  type BeaverOutcome,
  type BeaverTool,
} from "./toolRegistry";
import { readTabularCells } from "./tabularCells";
import type { TabularCellStore, WorkflowStore } from "./types";
import type { ReadSubagentAssignment, ReadSubagentRegion } from "./readSubagents";
import type { AssistantEvent } from "./turnEngine";
import { safeErrorMessage } from "../safeError";

const DOCUMENT_ID_PROPERTY = {
  type: "string",
  pattern: DOCUMENT_RESOURCE_PATTERN,
  description: "Version-pinned document resource returned by Glob.",
};
const objectSchema = (
  properties: Record<string, object>,
  required: string[] = [],
): Tool["inputSchema"] => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});
const DOCUMENT_OPERATION_TOOL: Tool = {
  name: "document_operation",
  description:
    "Specialist operation on one version-pinned Library document. Actions: metadata saves user-requested classification or notes; fix_supras creates native Word supra cross-references; lint_structure reports structural defects without editing; delete_and_renumber atomically deletes one provision and closes its sibling numbering gap as tracked changes; table_of_authorities starts deterministic authorities detection for DOCX or PDF. Do not pre-compute filesystem paths.",
  annotations: { readOnlyHint: false },
  inputSchema: objectSchema({
    action: {
      type: "string",
      enum: [
        "metadata",
        "fix_supras",
        "delete_and_renumber",
        "table_of_authorities",
      ],
    },
    document_id: DOCUMENT_ID_PROPERTY,
    kind: { type: "string", enum: ["file", "template"] },
    metadata: objectSchema({
      jurisdiction: { type: "string" },
      areas_of_law: { type: "array", items: { type: "string" } },
      document_types: { type: "array", items: { type: "string" } },
      description: { type: "string" },
    }),
    notes: { type: "string" },
    target: {
      type: "string",
      description: "Exact provision handle from Grep for delete_and_renumber.",
    },
    split_fallback: { type: "string", enum: ["off", "auto"] },
  }, ["action", "document_id"]),
};
const LINT_DOCUMENT_TOOL: Tool = {
  name: "lint_document",
  description:
    "Read-only structural lint for one version-pinned Library DOCX: broken internal references, missing schedules or exhibits, numbering defects, and duplicate or unused defined terms.",
  annotations: { readOnlyHint: true },
  inputSchema: objectSchema({ document_id: DOCUMENT_ID_PROPERTY }, ["document_id"]),
};

const referenceGraph = (structure: unknown) =>
  (structure as {
    cross_references?: Parameters<typeof graphScope>[1] | null;
  } | null)?.cross_references ?? null;

function oneHopLegalScope(
  doc: SourceDoc,
  graph: Parameters<typeof graphScope>[1],
  block: { label: string; start: number; end: number },
  direction: "inbound" | "outbound" | "both",
) {
  const seed = doc.blocks.find(
    (candidate) => candidate.label === block.label &&
      candidate.start === block.start && candidate.end === block.end,
  );
  if (!seed) return null;
  const subtree = sourceDocSubtreeLabels(doc.blocks, seed.label);
  const follow = direction === "inbound"
    ? "in"
    : direction === "outbound" ? "out" : "both";
  const byLabel = new Map(doc.blocks.map((node) => [node.label, node]));
  const reached = referenceLabelsOutside(graph, subtree, follow)
    .flatMap((label) => byLabel.get(label) ?? []);
  return {
    seed,
    nodes: [
      seed,
      ...reached.sort((left, right) => left.start - right.start),
    ],
  };
}






type AssistantDocument = Record<string, unknown> & {
  id: string; filename: string; current_version_id: string; file_type: string;
  page_count?: number | null;
};

const documentsFromPage = (items: Record<string, unknown>[]) =>
  items.flatMap((item) => item.kind === "document"
    ? [item.document as AssistantDocument] : []);

async function scopedDocuments(
  scope: DocumentScope,
  library: LibraryStore,
  projects: ProjectStore,
  limit = 200,
  matterId?: string | null,
) : Promise<AssistantDocument[]> {
  if (matterId) {
    return documentsFromPage((await projects.directory(
      scope,
      matterId,
      { q: "", parentFolderId: null, limit, after: null },
    )).items);
  }
  return documentsFromPage((await library.page(
    { ...scope, kind: "file" },
    {
      q: "",
      parentFolderId: null,
      limit,
      after: null,
      documentsOnly: true,
    },
  )).items as Record<string, unknown>[]);
}

function resolveDocumentArgument(
  input: Record<string, unknown>,
): { input: Record<string, unknown>; error?: string } {
  const reference = trimmed(input.document_id);
  if (!reference) return { input };
  const resource = parseResourceReference(reference);
  if (resource?.kind === "document") {
    return {
      input: {
        ...input,
        document_id: resource.documentId,
        version_id: resource.versionId,
      },
    };
  }
  return { input, error: "document_id must be a document resource returned by Glob" };
}

type AssistantEditTurnState = Map<string, {
  versionId: string; parentVersionId: string;
}>;

async function commitAssistantTurnVersion(params: {
  documents: DocumentStore;
  scope: DocumentScope;
  documentId: string;
  sourceVersionId: string;
  filename: string;
  bytes: Buffer;
  trackedEdits: AssistantEdit[];
  turnEditState?: AssistantEditTurnState;
  editMode?: EditMode;
}) {
  const existing = params.turnEditState?.get(params.documentId);
  if (existing && existing.versionId !== params.sourceVersionId) return null;
  const parentVersionId = existing?.parentVersionId ?? params.sourceVersionId;
  const finalized = params.trackedEdits.length
    ? await finalizeTrackedEdits(
        params.bytes,
        params.trackedEdits.flatMap((edit) =>
          [edit.delWId, edit.insWId].filter((id): id is string => !!id),
        ),
        params.editMode ?? "manual",
      )
    : { bytes: params.bytes, status: "pending" as const };
  const committed = await params.documents.commitAssistantVersion(
    params.scope,
    params.documentId,
    {
      sourceVersionId: params.sourceVersionId,
      ...(existing ? { turnVersionId: existing.versionId } : {}),
      parentVersionId,
      filename: params.filename,
      bytes: finalized.bytes,
      edits: params.trackedEdits,
      status: finalized.status,
    },
  );
  if (committed.status === "committed") {
    params.turnEditState?.set(params.documentId, {
      versionId: committed.version.id,
      parentVersionId,
    });
  }
  return committed.status === "committed"
    ? {
        version: committed.version,
        parentVersionId,
        trackedEdits: committed.edits,
      }
      : null;
}

const editAnnotations = (
  documentId: string,
  versionId: string,
  versionNumber: number | null,
  edits: StoredAssistantEdit[],
) => edits.map((edit) => ({
  edit_id: edit.id,
  document_id: documentId,
  version_id: versionId,
  version_number: versionNumber,
  del_w_id: edit.delWId,
  ins_w_id: edit.insWId,
  deleted_text: edit.deletedText.slice(0, 500),
  inserted_text: edit.insertedText,
  reason: edit.reason,
  diff: edit.diff,
  status: edit.status,
}));

const assistantEdits = (changes: ReadonlyArray<{
  id: string; delId?: string; insId?: string; deletedText: string;
  insertedText: string; contextBefore?: string; contextAfter?: string;
  reason?: string; diff: AssistantEdit["diff"];
}>): AssistantEdit[] => changes.map((change) => ({
  changeId: change.id,
  delWId: change.delId,
  insWId: change.insId,
  deletedText: change.deletedText,
  insertedText: change.insertedText,
  contextBefore: change.contextBefore ?? "",
  contextAfter: change.contextAfter ?? "",
  reason: change.reason,
  diff: change.diff,
}));

async function saveDocxEdits(params: {
  documents: DocumentStore;
  scope: DocumentScope;
  documentId: string;
  source: DocumentContent;
  bytes: Buffer;
  edits: AssistantEdit[];
  turnEditState?: AssistantEditTurnState;
  editMode: EditMode;
  extra?: Record<string, unknown>;
}) {
  const committed = await commitAssistantTurnVersion({
    documents: params.documents,
    scope: params.scope,
    documentId: params.documentId,
    sourceVersionId: params.source.version.id,
    filename: params.source.version.filename ?? params.source.filename,
    bytes: params.bytes,
    trackedEdits: params.edits,
    turnEditState: params.turnEditState,
    editMode: params.editMode,
  });
  if (!committed) return fail("The active document version changed.");
  const { version, trackedEdits } = committed;
  const lintProjection = await documentProjectionService.read({
    documentId: params.documentId,
    versionId: version.id,
    filename: version.filename,
    fileType: "docx",
    sourceSha256: version.source_sha256,
    bytes: params.bytes,
  }).catch(() => null);
  const lint = lintProjection?.kind === "docx-session"
    ? lintDocxStructure(lintProjection.structure)
    : null;
  return documentResult({
    ok: true,
    action: "revised",
    edit_mode: params.editMode,
    document_id: params.documentId,
    version_id: version.id,
    version_number: version.version_number,
    filename: version.filename,
    change_count: trackedEdits.length,
    resource: resourceReference.document(params.documentId, version.id),
    download_url:
      `/api/single-documents/${encodeURIComponent(params.documentId)}/file` +
      `?version_id=${encodeURIComponent(version.id)}`,
    annotations: editAnnotations(
      params.documentId, version.id, version.version_number, trackedEdits,
    ),
    structural_lint: lint
      ? {
          finding_count: lint.findings.length,
          findings: lint.findings.slice(0, 8),
          notes: lint.notes,
        }
      : undefined,
    ...params.extra,
  });
}

const GREP_LINE_CAP = 2_000;

type CodingOutputLine = {
  rendered: string;
  span?: [number, number];
  handoffCandidate?: boolean;
  source?: {
    documentId: string;
    versionId: string;
    filename?: string;
    locator?: string;
    locatorKind?: "paragraph" | "page" | "section" | "footnote";
    sourceText?: string;
  };
};

const sourceLineStarts = (text: string) =>
  [0, ...Array.from(text.matchAll(/\n/gu), ({ index }) => index + 1)];
const sourceLineAt = (starts: readonly number[], offset: number) =>
  Math.max(0, starts.findIndex((_, index) => (starts[index + 1] ?? Infinity) > offset));

function takeCodingOutputLines(
  lines: CodingOutputLine[],
  maxChars = MAX_MODEL_TOOL_RESULT_CHARS,
) {
  const budget = Math.max(1_000,
    Math.min(MAX_MODEL_TOOL_RESULT_CHARS, maxChars) - 1_000);
  const kept: CodingOutputLine[] = [];
  let chars = 0;
  for (const line of lines) {
    const added = line.rendered.length + (kept.length ? 1 : 0);
    if (kept.length && chars + added > budget) break;
    kept.push(line);
    chars += added;
  }
  return { kept, truncated: kept.length < lines.length };
}

type TextRange = { start: number; end: number };

function addCoveredRange(covered: TextRange[], added: TextRange) {
  const ordered = [...covered, added]
    .sort((left, right) => left.start - right.start);
  const merged: TextRange[] = [];
  for (const range of ordered) {
    const last = merged.at(-1);
    if (!last || range.start > last.end) merged.push(range);
    else last.end = Math.max(last.end, range.end);
  }
  covered.splice(0, covered.length, ...merged);
}

function uncoveredRanges(range: TextRange, covered: readonly TextRange[]) {
  let cursor = range.start;
  const open: TextRange[] = [];
  for (const prior of covered) {
    if (prior.end <= cursor) continue;
    if (prior.start >= range.end) break;
    if (prior.start > cursor) {
      open.push({ start: cursor, end: Math.min(prior.start, range.end) });
    }
    cursor = Math.max(cursor, prior.end);
    if (cursor >= range.end) break;
  }
  if (cursor < range.end) open.push({ start: cursor, end: range.end });
  return open;
}

function codingRangeLines(
  text: string,
  starts: readonly number[],
  range: TextRange,
  header?: string,
  source?: CodingOutputLine["source"],
): CodingOutputLine[] {
  const rows: CodingOutputLine[] = header ? [{ rendered: header }] : [];
  const lineIndex = sourceLineAt(starts, range.start);
  for (let index = lineIndex; index < starts.length; index += 1) {
    const lineStart = starts[index];
    const nextStart = starts[index + 1] ?? text.length;
    if (lineStart >= range.end) break;
    const start = Math.max(lineStart, range.start);
    let end = Math.min(nextStart, range.end);
    while (end > start && (text[end - 1] === "\n" || text[end - 1] === "\r")) {
      end -= 1;
    }
    if (end <= start) continue;
    const full = text.slice(start, end);
    const shown = full.slice(0, Math.max(GREP_LINE_CAP, MAX_MODEL_TOOL_RESULT_CHARS - 2_000));
    rows.push({
      rendered:
        `${String(index + 1).padStart(6, " ")}\t${start > lineStart ? "…" : ""}${shown}` +
        (shown.length < full.length || end < nextStart ? "…" : ""),
      span: [start, start + shown.length],
      ...(source ? { source } : {}),
    });
  }
  return rows;
}
function trackedEditsForRenumberPlan(
  sourceText: string,
  receipts: readonly DeleteAndRenumberReceipt[],
): EditInput[] | string {
  const edits: EditInput[] = [];
  const add = (
    start: number,
    end: number,
    replace: string,
    reason: string,
  ) => {
    const find = sourceText.slice(start, end);
    if (!find || find.includes("\n") || replace.includes("\n")) {
      return false;
    }
    edits.push({
      find,
      replace,
      context_before: "",
      context_after: "",
      reason,
      exact_start: start,
      exact_end: end,
    });
    return true;
  };

  for (const receipt of receipts) {
    if (sourceText.slice(receipt.start, receipt.end) !== receipt.removed) {
      return `Pinned text no longer matches ${receipt.kind} at ${receipt.start}-${receipt.end}`;
    }
    const reason =
      receipt.kind === "delete_provision"
        ? `Delete ${receipt.from} and close its numbering gap`
        : receipt.kind === "renumber_heading"
          ? `Renumber ${receipt.from} to ${receipt.to}`
          : `Update pointer from ${receipt.from} to ${receipt.to}`;
    if (receipt.kind !== "delete_provision") {
      if (!add(receipt.start, receipt.end, receipt.inserted, reason)) {
        return `${receipt.kind} crossed a paragraph boundary`;
      }
      continue;
    }

    let cursor = receipt.start;
    while (cursor < receipt.end) {
      const newline = sourceText.indexOf("\n", cursor);
      const end =
        newline < 0 || newline > receipt.end ? receipt.end : newline;
      if (end > cursor && !add(cursor, end, "", reason)) {
        return `Deletion of ${receipt.from} could not be split safely`;
      }
      cursor = end + 1;
    }
  }
  return edits.length ? edits : "Renumber plan contained no trackable text";
}

const comparableAcceptedText = (value: string) =>
  value
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .join("\n");

async function activeDocument(
  documents: DocumentStore,
  scope: DocumentScope,
  documentId: string,
  versionId?: string,
): Promise<DocumentContent | "stale" | null> {
  const file = await documents.read(
    scope, documentId, versionId ?? null, false,
  );
  if (!file) return null;
  return (await documents.versions(scope, documentId))
      ?.current_version_id === file.version.id
    ? file
    : "stale";
}

async function activeDocx(
  documents: DocumentStore,
  scope: DocumentScope,
  documentId: string,
  versionId?: string,
) {
  const file = await activeDocument(documents, scope, documentId, versionId);
  if (!file) throw new Error("Document not found");
  if (file === "stale") throw new Error("Version is not active");
  if (file.fileType.toLowerCase() !== "docx")
    throw new Error("Operation requires a DOCX document");
  return file;
}



async function readNonDocumentResource(
  call: NormalizedToolCall,
  args: Record<string, unknown>,
  workflows: WorkflowStore,
  userId: string,
) {
  if (call.name !== "Read") return null;
  const requested = trimmed(args.file_path);
  const resource = parseResourceReference(requested);
  if (resource?.kind === "workflow") {
    const workflow = workflows.get(resource.id);
    return workflow
      ? result({
          ok: true,
          resource: requested,
          title: workflow.title,
          instructions: workflow.skill_md,
        })
      : fail("Workflow not found");
  }
  if (resource?.kind === "job") {
    try {
      const payload = {
        ok: true,
        resource: requested,
        job: await getTableOfAuthoritiesJob(userId, resource.id),
      };
      const event = tableOfAuthoritiesEvent(payload, call.id);
      return {
        ...result(payload),
        ...(event ? { events: [event] } : {}),
      };
    } catch (error) {
      return fail(
        safeErrorMessage(error, "Table of Authorities status lookup failed"),
      );
    }
  }
  if (resource?.kind !== "source") return null;
  if (resource.provider !== "pdf") {
    return fail(`Read does not support source provider '${resource.provider}'.`);
  }
  const handle = trimmed(args.handle);
  if (handle && (trimmed(args.locator_kind) || trimmed(args.locator))) {
    return fail("Use either handle or locator fields, not both.");
  }
  try {
    const resolved = handle
      ? await rehydrateProviderPdfReference(resource.sourceId, userId, handle)
      : await lookupProviderPdfReference(
          resource.sourceId, userId, pdfLocatorParams(args));
    if (resolved.availability !== "ready") {
      return result({
        ok: false,
        resource: requested,
        status: resolved.availability,
        ...("state" in resolved ? resolved.state : {}),
        ...("error" in resolved && resolved.error ? { error: resolved.error } : {}),
        next_required_action:
          resolved.availability === "queued"
            ? `Retry Read on ${requested} later.`
            : "Use the authoritative provider text already returned.",
      });
    }
    const evidence = providerPdfLegalEvidence(resolved);
    return {
      ...result({
        ...compactProviderPdfLookup(resolved),
        ...(evidence.length
          ? {
              passages: evidence.map(modelEvidencePassage),
              evidence_ids: evidence.map(({ evidence_id }) => evidence_id),
            }
          : {}),
        resource: requested,
      }),
      ...(evidence.length ? { evidence } : {}),
    };
  } catch (error) {
    return fail(
      error instanceof Error &&
          /^(?:Provider PDF|Invalid PDF evidence|PDF evidence)/u.test(error.message)
        ? error.message
        : "Provider PDF lookup is unavailable",
    );
  }
}

type EvidenceSource = Omit<RegisteredEvidence, "receipt">;
type EvidenceSpan = {
  text: string;
  start: number;
  end: number;
  blockId?: string;
  locator?: LegalEvidenceReceipt["locator"];
};

function sourceDocArtifact(value: unknown): SourceDoc | undefined {
  const artifact = objectRecord(value);
  return artifact && typeof artifact.text === "string" &&
      Array.isArray(artifact.blocks) && artifact.index !== null &&
      typeof artifact.index === "object"
    ? artifact as unknown as SourceDoc
    : undefined;
}

function legalEvidenceSource(passage: LegalSourcePassage): EvidenceSource {
  const source = sourceDocArtifact(passage.documentArtifact);
  if (passage.source.provider !== "a2aj") return source ? { source } : {};
  const native = objectRecord(passage.native);
  const lookup = objectRecord(native?.lookup) as A2AJLocatorLookup | null;
  if (lookup?.status === "found") return { lookup, ...(source && { source }) };
  return typeof native?.citation === "string" && typeof native.text === "string"
    ? { document: native as unknown as A2AJDocument, ...(source && { source }) }
    : source ? { source } : {};
}

function smallestContainingBlock(
  source: SourceDoc,
  start: number,
  end: number,
): SourceDocBlock | undefined {
  return source.blocks
    .filter((block) => block.start <= start && block.end >= end)
    .sort((left, right) =>
      left.end - left.start - (right.end - right.start))[0];
}

function cleanSearchEvidenceSpan(
  passage: LegalSourcePassage,
  hit: { at: number; excerpt: string },
): EvidenceSpan {
  const matchEnd = hit.at + hit.excerpt.length;
  const source = sourceDocArtifact(passage.documentArtifact);
  if (passage.role === "document" && source?.text === passage.text) {
    const block = smallestContainingBlock(source, hit.at, matchEnd);
    if (block) return {
      text: sourceDocBlockText(source, block),
      start: block.start,
      end: block.end,
      blockId: `${block.kind}:${block.label}:${block.start}:${block.end}`,
      ...(["paragraph", "page", "section", "footnote"].includes(block.kind)
        ? { locator: { kind: block.kind as "paragraph" | "page" | "section" | "footnote", label: block.label } }
        : {}),
    };
  }

  const text = passage.text;
  let start = text.lastIndexOf("\n", Math.max(0, hit.at - 1)) + 1;
  const nextLine = text.indexOf("\n", matchEnd);
  let end = nextLine < 0 ? text.length : nextLine;
  while (start < end && /\s/u.test(text[start])) start += 1;
  while (end > start && /\s/u.test(text[end - 1])) end -= 1;
  return { text: text.slice(start, end), start, end };
}

function legalSourceEvidence(
  passage: LegalSourcePassage,
  span?: EvidenceSpan,
): LegalEvidenceReceipt | undefined {
  if (passage.source.provider === "a2aj") {
    const native = objectRecord(passage.native);
    if (typeof native?.citation === "string" &&
        typeof native.dataset === "string" &&
        typeof native.text === "string" &&
        (native.language === "en" || native.language === "fr")) {
      return span ? createA2AJPassageEvidence({
        citation: native.citation,
        name: typeof native.name === "string" ? native.name : null,
        dataset: native.dataset,
        language: native.language,
        sourceText: native.text,
        spanText: span.text,
        start: span.start,
        end: span.end,
        externalUrl: typeof native.url === "string" ? native.url : null,
        sourceClass: passage.source.kind === "legislation" ? "legislation" : "case",
        blockId: span.blockId,
        locator: span.locator,
      }) : undefined;
    }
    const lookup = objectRecord(native?.lookup) as A2AJLocatorLookup | null;
    const block = objectRecord(native?.block) as A2AJLocatorLookup["block"];
    if (lookup?.status === "found" && block) return createA2AJLookupEvidence({
      ...lookup,
      requested: {
        kind: block.kind as A2AJLocatorLookup["requested"]["kind"],
        locator: block.label,
        label: block.label,
      },
      matches: [block.label],
      block,
      before: [],
      after: [],
    }, passage.source.kind === "legislation" ? "legislation" : "case") ?? undefined;
  }
  if (!span && passage.role === "document" && passage.source.provider !== "hansard") {
    return undefined;
  }
  if (passage.source.provider === "journal") {
    return createPublicJournalPassageEvidence({
      citation: passage.source.citation ?? passage.source.id,
      name: passage.source.title ?? null,
      date: passage.source.date ?? null,
      url: passage.source.url ?? null,
      text: span?.text ?? passage.text,
      articleId: passage.source.id,
      language: passage.source.language,
      locatorKind: span?.locator?.kind ?? passage.locator.requested?.kind ?? "document",
      locatorLabel: span?.locator?.label ?? passage.locator.label,
    });
  }
  const sourceClass = passage.source.kind === "legislation"
    ? "legislation"
    : passage.source.kind === "case"
      ? "case"
      : "commentary";
  const jurisdiction = passage.source.provider === "courtlistener" ||
      passage.source.provider === "govinfo"
    ? "US"
    : passage.source.provider === "tna" ||
        passage.source.provider === "govuk-et"
      ? "UK"
      : "CA-ON";
  const artifact = objectRecord(passage.documentArtifact);
  const createEvidence = {
    courtlistener: createCourtlistenerEvidence,
    tna: createTnaEvidence,
    "govuk-et": createGovUkEmploymentTribunalEvidence,
    govinfo: createGovInfoEvidence,
    hansard: createHansardEvidence,
  }[passage.source.provider];
  if (!createEvidence) return undefined;
  return createEvidence({
    jurisdiction,
    sourceClass,
    stableSourceId: [
      passage.source.id,
      passage.source.part ?? "",
    ].join(":"),
    sourceText: typeof passage.documentArtifact === "string"
      ? passage.documentArtifact
      : typeof artifact?.text === "string" ? artifact.text : passage.text,
    spanText: span?.text ?? passage.text,
    citation: passage.source.citation ?? passage.source.id,
    name: passage.source.title,
    dataset: passage.source.collection ?? passage.source.provider,
    language: passage.source.language,
    version: passage.source.date,
    externalUrl: passage.source.url,
    locatorKind: span?.locator?.kind ??
      (span ? "document" : passage.locator.requested?.kind ?? "document"),
    locatorLabel: span?.locator?.label ??
      (span ? `characters ${span.start + 1}–${span.end}` : passage.locator.label),
  });
}

function sourceReference(
  provider: string,
  sourceId: string,
): LegalSourceReference | null {
  const tuple = (): unknown[] | null => {
    try {
      const value: unknown = JSON.parse(sourceId);
      return Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  };
  if (provider === "a2aj") {
    const identity = tuple();
    const dataset = identity?.[1];
    if (typeof identity?.[0] !== "string" ||
        (dataset !== "cases" && dataset !== "laws")) return null;
    return {
      provider,
      id: identity[0],
      citation: identity[0],
      kind: dataset === "laws" ? "legislation" : "case",
      collection: typeof identity[2] === "string" && identity[2]
        ? identity[2] : null,
    };
  }
  if (provider === "courtlistener-opinion") {
    const identity = tuple();
    if (!identity || !Number.isSafeInteger(Number(identity[0])) ||
        !Number.isSafeInteger(Number(identity[1]))) return null;
    return {
      provider: "courtlistener",
      id: String(identity[0]),
      part: String(identity[1]),
      kind: "case",
    };
  }
  if (provider === "courtlistener") {
    return Number.isSafeInteger(Number(sourceId)) && Number(sourceId) > 0
      ? { provider, id: sourceId, kind: "case" }
      : null;
  }
  if (["tna", "govuk-et", "govinfo"].includes(provider))
    return { provider, id: sourceId, kind: "case" };
  return provider === "journal" || provider === "hansard"
    ? { provider, id: sourceId, kind: provider } : null;
}

async function readLegalSourceResource(
  call: NormalizedToolCall,
  args: Record<string, unknown>,
  options: {
    userId: string;
    signal?: AbortSignal;
    reader?: ReadSubagentAssignment;
  },
): Promise<BeaverOutcome | null> {
  if (call.name !== "Read") return null;
  const resource = parseResourceReference(trimmed(args.file_path));
  if (resource?.kind !== "source" || resource.provider === "pdf") return null;
  const locator = trimmed(args.locator);
  const locatorKind = trimmed(args.locator_kind);
  const endLocator = trimmed(args.end_locator);
  if (Boolean(locator) !== Boolean(locatorKind))
    return fail("locator_kind and locator are required together.");
  if (locator && !["paragraph", "section", "page", "footnote"].includes(locatorKind))
    return fail("Unsupported legal-source locator kind.");
  const source = sourceReference(resource.provider, resource.sourceId);
  if (!source) return fail(`Invalid ${resource.provider} resource.`);
  const sourceRegion = source.provider === "courtlistener" || source.provider === "govinfo"
    ? "US" : source.provider === "tna" || source.provider === "govuk-et" ? "UK" : "CA";
  if (options.reader && sourceRegion !== options.reader.jurisdiction)
    return fail(`This source is outside the reader's ${options.reader.jurisdiction} boundary.`);
  if (options.reader?.collections?.length && source.collection &&
      !options.reader.collections.some((value) => value.toLowerCase() ===
        source.collection!.toLowerCase()))
    return fail("This source is outside the reader's collection boundary.");
  const references = (args.references ?? "none") as
    "none" | "inbound" | "outbound" | "both";
  if (references !== "none") {
    if (source.provider !== "a2aj" || source.kind !== "legislation" ||
        locatorKind !== "section")
      return fail("references is available only for A2AJ statutory sections.");
  }
  try {
    const read = await readLegalSourcePassage({
      source,
      ...(locator
        ? {
            locator: {
              kind: locatorKind as "paragraph" | "section" | "page" | "footnote",
              value: locator,
              ...(endLocator ? { endValue: endLocator } : {}),
            },
            contextBlocks: Math.min(
              2,
              Math.max(0, Math.trunc(Number(args.context_blocks) || 0)),
            ),
          }
        : {}),
      signal: options.signal,
    });
    if (read.status !== "found") {
      return fail(
        read.status === "unsupported"
          ? "Legal source provider is unavailable."
          : "The requested legal source passage was not found.",
      );
    }

    const registered = read.values.map((passage) => ({
      passage,
      receipt: legalSourceEvidence(passage),
      source: legalEvidenceSource(passage),
    }));
    const evidenceSources = new Map<string, EvidenceSource>();
    for (const { receipt, source } of registered) {
      if (receipt) evidenceSources.set(receipt.evidence_id, source);
    }
    const remoteSources = new Map<string, RemoteLegalSourceDocument>();
    const courtCases = new Map<string, Record<string, unknown>>();
    for (const { passage } of registered) {
      const native = objectRecord(passage.native);
      const nativeDocument = objectRecord(native?.document);
      if (nativeDocument && ["tna", "govuk-et", "govinfo"].includes(
        passage.source.provider,
      )) {
        const document = nativeDocument as RemoteLegalSourceDocument;
        remoteSources.set(`${document.provider}:${document.identity}`, document);
      }
      const courtCase = objectRecord(native?.case);
      if (courtCase && passage.source.provider === "courtlistener")
        courtCases.set(passage.source.id, courtCase);
    }
    const pdfRenditions = (await Promise.all([
      ...[...remoteSources.values()].map((document) =>
        queueProviderPdfRenditions(document, options.userId)),
      ...[...courtCases.values()].map((courtCase) =>
        courtlistenerPdfRendition(courtCase, options.userId)),
    ])).flatMap((value) => Array.isArray(value) ? value : value ? [value] : []);

    const pattern = trimmed(args.pattern);
    if (pattern) {
      const maxResults = Math.min(50, Math.max(1, Math.trunc(Number(args.max_results) || 20)));
      const contextChars = Math.min(2_000, Math.max(40,
        Math.trunc(Number(args.context_chars) || 160)));
      let total = 0;
      const hits = registered.flatMap(({ passage }) => {
        const found = findTextMatches({
          text: passage.text,
          query: pattern,
          maxResults: Math.max(0, maxResults - total),
          contextChars,
          startIndex: total,
        });
        total += found.totalMatches;
        return found.hits.map((hit) => {
          const receipt = passage.locator.requested
            ? legalSourceEvidence(passage)
            : legalSourceEvidence(
                passage,
                cleanSearchEvidenceSpan(passage, hit),
              );
          if (receipt) {
            evidenceSources.set(receipt.evidence_id, legalEvidenceSource(passage));
          }
          return {
            ...hit,
            locator: passage.locator.label,
            ...(receipt && { evidence_id: receipt.evidence_id, receipt }),
            ...(passage.source.part && {
              resource: resourceReference.source(
                passage.source.provider === "courtlistener" ? "courtlistener-opinion" : passage.source.provider,
                passage.source.provider === "courtlistener"
                  ? JSON.stringify([passage.source.id, Number(passage.source.part)])
                  : passage.source.id,
              ),
            }),
          };
        });
      });
      const evidence = [...new Map(hits.flatMap(({ receipt }) =>
        receipt ? [[receipt.evidence_id, receipt] as const] : [],
      )).values()];
      const visibleHits = hits.map(({ receipt: _receipt, ...hit }) => hit);
      return {
        ...result({
          ok: true,
          source: "Legal source",
          provider: source.provider,
          identifier: source.id,
          resource: trimmed(args.file_path),
          query: pattern,
          total_matches: total,
          returned: hits.length,
          truncated: total > hits.length,
          hits: visibleHits,
          ...(evidence.length ? {
            passages: evidence.map(modelEvidencePassage),
            evidence_ids: evidence.map(({ evidence_id }) => evidence_id),
          } : {}),
          ...(pdfRenditions.length ? { pdf_renditions: pdfRenditions } : {}),
        }),
        ...(evidence.length ? { evidence } : {}),
        ...(evidenceSources.size ? { evidenceSources } : {}),
      };
    }

    let referenceNeighborhood: Record<string, unknown> | undefined;
    const relatedEvidence: LegalEvidenceReceipt[] = [];
    if (references !== "none") {
      const seed = registered.map(({ passage }) => {
        const native = objectRecord(passage.native);
        return objectRecord(native?.lookup) as A2AJLocatorLookup | null;
      }).find((value): value is A2AJLocatorLookup => Boolean(value));
      if (seed) {
        const related = await readA2AJReferenceNeighborhood(
          seed,
          references as A2AJReferenceDirection,
          options.signal,
        );
        const sections = related.lookups.map((lookup) => {
          const evidence = a2ajLookupEvidenceBlocks(lookup, "legislation");
          const source = a2ajLegalSourceProvider.source(lookup);
          relatedEvidence.push(...evidence.map(({ receipt }) => receipt));
          evidence.forEach(({ receipt }) =>
            evidenceSources.set(receipt.evidence_id, {
              lookup,
              ...(source && { source }),
            }));
          return {
            label: lookup.block?.label,
            text: lookup.block?.text,
            evidence_ids: evidence.map(({ receipt }) => receipt.evidence_id),
          };
        });
        referenceNeighborhood = {
          direction: references,
          depth: 1,
          returned: related.lookups.length,
          truncated: related.truncated,
          limit_reason: related.limitReason,
          omitted: related.omitted,
          failures: related.failures,
          sections,
        };
      }
    }

    const evidences = [...new Map(
      [...registered.map(({ receipt }) => receipt), ...relatedEvidence].flatMap((receipt) =>
        receipt ? [[receipt.evidence_id, receipt] as const] : [],
      ),
    ).values()];
    const passages = registered.slice(0, read.values.length).map(
      ({ passage, receipt }) => ({
        role: passage.role,
        kind: passage.locator.requested?.kind ?? "document",
        locator: passage.locator.label,
        text: passage.text,
        text_sha256: passage.textSha256,
        ...(receipt ? { evidence_id: receipt.evidence_id } : {}),
        ...(passage.source.provider === "courtlistener" && passage.source.part
          ? {
              resource: resourceReference.source(
                "courtlistener-opinion",
                JSON.stringify([passage.source.id, Number(passage.source.part)]),
              ),
            }
          : {}),
      }),
    );
    const payload = {
      ok: true,
      source: "Legal source",
      provider: source.provider,
      identifier: source.id,
      title: read.values[0].source.title,
      citation: read.values[0].source.citation,
      resource: trimmed(args.file_path),
      requested: locator
        ? {
            kind: locatorKind,
            locator,
            ...(endLocator ? { end_locator: endLocator } : {}),
          }
        : null,
      passage_count: passages.length,
      passages,
      evidence_ids: passages.flatMap(({ evidence_id }) =>
        evidence_id ? [evidence_id] : [],
      ),
      ...(passages.some(({ role, evidence_id }) =>
          role === "document" && !evidence_id
        )
        ? {
            next_required_action:
              "This document read is navigation text, not citable evidence. Re-read the needed native locator before relying on it.",
          }
        : {}),
      ...(pdfRenditions.length ? { pdf_renditions: pdfRenditions } : {}),
      ...(referenceNeighborhood
        ? { reference_neighborhood: referenceNeighborhood }
        : {}),
    };
    return {
      ...result(payload),
      evidence: evidences,
      ...(evidenceSources.size ? { evidenceSources } : {}),
    };
  } catch (error) {
    return fail(
      error instanceof Error
        ? error.message
        : "Legal source read failed.",
    );
  }
}

async function runCodingShapeCall(
  call: NormalizedToolCall,
  args: Record<string, unknown>,
  documents: DocumentStore,
  library: LibraryStore,
  projects: ProjectStore,
  scope: DocumentScope,
  matterId?: string | null,
  turnEditState?: AssistantEditTurnState,
  servedDraftingCache?: Map<string, ServedDrafting>,
  workflows: WorkflowStore = new Map(),
  editMode: EditMode = "manual",
  documentNames: Map<string, string> = new Map(),
  progress?: (label: string) => void,
  signal?: AbortSignal,
): Promise<BeaverOutcome> {
  servedDraftingCache ??= new Map();
  const direct = await readNonDocumentResource(call, args, workflows, scope.userId);
  if (direct) return direct;
  const files = await scopedDocuments(
    scope, library, projects, 200, matterId,
  );
  files.forEach(({ id, filename }) => documentNames.set(id, filename));
  const codingPath = (document: AssistantDocument, versionId = document.current_version_id) =>
    resourceReference.document(document.id, versionId);
  const resolvePath = (raw: string) => {
    const reference = parseResourceReference(raw.trim());
    return reference?.kind === "document"
      ? files.find(({ id }) => id === reference.documentId) ?? null : null;
  };
  const referencedVersion = (raw: string) => {
    const reference = parseResourceReference(raw.trim());
    return reference?.kind === "document" ? reference.versionId : undefined;
  };
  const codingDocument = async (
    documentId: string,
    versionId?: string,
    mode?: "text" | "drafting" | "redline",
  ) => {
    let raw: { versionId: string; text: string } | null = null;
    if (mode === "redline") {
      const file = await documents.read(scope, documentId, versionId ?? null, false);
      if (!file || file.fileType.toLowerCase() !== "docx") return null;
      const redline = await projectDocxRedline(file.bytes);
      raw = {
        versionId: file.version.id,
        text: redline.text,
      };
    } else if (mode !== "text") {
      const drafting = await servedDraftingText(
        documents, scope, documentId, servedDraftingCache, versionId,
      );
      if (drafting) {
        raw = {
          versionId: drafting.versionId,
          text: drafting.served,
        };
      }
    }
    if (raw) {
      const analyzed = await analyzeDocumentNative({
        kind: "instrument",
        id: documentId,
        text: raw.text,
        table_cells: [],
        reconstruct_lineation: true,
        source_doc: true,
      });
      if (!analyzed.source_doc) throw new Error("Rust omitted SourceDoc");
      return {
        ...raw,
        pages: { pages: [], source: "unindexed" as const },
        tableCells: [],
        sourceDoc: analyzed.source_doc,
        structure: analyzed.structure,
      };
    }
    return extractDocument(documents, scope, documentId, versionId);
  };
  if (call.name === "Glob") {
    const re = globRegExp(trimmed(args.pattern) || "*");
    const fileRows = files
      .filter((document) => re.test(document.filename))
      .map((document) => `${codingPath(document)}\tfilename=${document.filename}`);
    const workflowRows = [...workflows].flatMap(([id, workflow]) => {
      const resource = resourceReference.workflow(id);
      return re.test(resource) ? [`${resource}\ttitle=${workflow.title}`] : [];
    });
    const rows = [...fileRows, ...workflowRows];
    if (!rows.length) return result("No files found");
    return result(rows.join("\n"));
  }

  if (call.name === "Read") {

    const requested = trimmed(args.file_path);
    const handle = trimmed(args.handle);
    const locatorKind = trimmed(args.locator_kind);
    const locator = trimmed(args.locator);
    if (handle || locatorKind || locator) {
      if (handle && (locatorKind || locator)) {
        return fail("Use either handle or locator fields, not both.");
      }
      if (!handle && (!locatorKind || !locator)) {
        return fail("locator_kind and locator are required together.");
      }
      const meta = resolvePath(requested);
      if (!meta) {
        return fail(`Document resource does not exist: ${requested}`);
      }
      const versionId = referencedVersion(requested);
      const file = await documents.read(
        scope, meta.id, versionId ?? null, false,
      );
      if (!file) return fail("PDF resource/version not found.");
      if (file.fileType.toLowerCase() !== "pdf") {
        return fail("Exact structural Read requires a PDF resource.");
      }
      let physicalPageCount = Number.isSafeInteger(meta.page_count)
        ? Number(meta.page_count)
        : null;
      if (locatorKind === "page" && !trimmed(args.end_locator) && /^[1-9]\d*$/u.test(locator)) {
        if (physicalPageCount === null) {
          try {
            const projection = await documentProjectionService.read({
              documentId: meta.id,
              versionId: file.version.id,
              filename: file.filename,
              fileType: file.fileType,
              sourceSha256: file.version.source_sha256,
              bytes: file.bytes,
            }, { signal });
            physicalPageCount = projection.kind === "pdf"
              ? projection.pdfSourceMap.pages.length
              : null;
          } catch {
            return fail(
              `${meta.filename} is not a valid readable PDF. Retrying will not help.`,
            );
          }
        }
        if (physicalPageCount === null) {
          return fail(`${meta.filename} is not a valid readable PDF.`);
        }
        if (Number(locator) > physicalPageCount) {
          return fail(
            `Page ${locator} does not exist in ${meta.filename}; ` +
            `the PDF has ${physicalPageCount} page${physicalPageCount === 1 ? "" : "s"}.`,
          );
        }
      }
      try {
        const sourcePath = await documentProjectionService.publishPdf(
          file.bytes, file.version.source_sha256,
        );
        let lookup: PdfLookupResult;
        if (handle) {
          const receipt = await documentProjectionService.readPdfEvidence(handle);
          if (
            receipt.source.document_id !== meta.id ||
            receipt.source.version_id !== file.version.id
          ) {
            return fail("PDF evidence does not belong to this resource.");
          }
          lookup = await documentProjectionService.rehydratePdfEvidence(
            sourcePath,
            handle,
          );
        } else {
          const locatorInput = pdfLocatorParams(args);
          const exactPage = locatorKind === "page" &&
            !trimmed(args.end_locator) && /^[1-9]\d*$/u.test(locator)
            ? Number(locator)
            : null;
          if (exactPage) {
            const contextBlocks = Math.max(0, Math.min(2,
              Math.trunc(Number(args.context_blocks) || 0)));
            const selectedPages = Array.from(
              {
                length: Math.min(physicalPageCount ?? exactPage + contextBlocks,
                  exactPage + contextBlocks) - Math.max(1, exactPage - contextBlocks) + 1,
              },
              (_, index) => Math.max(1, exactPage - contextBlocks) + index,
            );
            const cacheKey = await preparePdfPages({
              userId: scope.userId,
              documentId: meta.id,
              versionId: file.version.id,
              sourceSha256: file.version.source_sha256,
              pages: selectedPages,
              signal,
              onProgress: ({ phase }) => progress?.(
                phase === "ocr"
                  ? `Running OCR on page ${exactPage} of ${meta.filename}`
                  : phase === "inspecting"
                    ? `Inspecting page ${exactPage} of ${meta.filename}`
                    : `Reading page ${exactPage} of ${meta.filename}`,
              ),
            });
            lookup = await documentProjectionService.lookupPdf(
              sourcePath,
              locatorInput,
              {
                cacheKey,
                documentId: meta.id,
                versionId: file.version.id,
                pages: selectedPages,
              },
            );
          } else {
            const cacheKey = await preparePdf({
              userId: scope.userId,
              documentId: meta.id,
              versionId: file.version.id,
              sourceSha256: file.version.source_sha256,
              signal,
              onProgress: ({ phase }) => progress?.(
                phase === "ocr"
                  ? `Running OCR on ${meta.filename}`
                  : phase === "inspecting"
                    ? `Inspecting ${meta.filename}`
                    : `Reading ${meta.filename}`,
              ),
            });
            lookup = await documentProjectionService.lookupPdf(
              sourcePath,
              locatorInput,
              {
                cacheKey,
                documentId: meta.id,
                versionId: file.version.id,
              },
            );
          }
        }
        const evidence = pdfLegalEvidence(
          meta.id,
          file.version.id,
          file.filename,
          lookup,
        );
        return {
          ...result({
            ...compactPdfLookup(file.filename, lookup),
            passages: evidence.map(modelEvidencePassage),
            evidence_ids: evidence.map(({ evidence_id }) => evidence_id),
            resource: codingPath(meta, file.version.id),
          }),
          evidence,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        return fail(SAFE_PDF_EVIDENCE_ERRORS.has(message)
          ? message : "PDF evidence is unavailable");
      }
    }
    const meta = resolvePath(requested);
    if (!meta) {
      return fail(`Document resource does not exist: ${requested}`);
    }
    const mode = args.mode as "text" | "drafting" | "redline" | undefined;
    let document;
    try {
      document = await codingDocument(
        meta.id,
        referencedVersion(requested),
        mode,
      );
    } catch {
      return fail(
        `Could not read ${meta.filename}. The document reader failed; retrying will not help.`,
      );
    }
    if (!document) return fail(`File could not be read: ${requested}`);
    const lines = document.text.split(/\r?\n/u);
    const starts = sourceLineStarts(document.text);
    const limit = (args.limit as number | undefined) ?? 2_000;
    const startChar = (args.start_char as number | undefined) ?? 0;
    const sectionArg = trimmed(args.section);
    const references = (args.references ?? "none") as
      "none" | "inbound" | "outbound" | "both";
    const source = (
      locator?: string,
      locatorKind?: NonNullable<CodingOutputLine["source"]>["locatorKind"],
    ) => ({
      documentId: meta.id,
      versionId: document.versionId,
      filename: meta.filename,
      sourceText: document.text,
      ...(locator && locatorKind ? { locator, locatorKind } : {}),
    });
    const finish = (
      candidates: CodingOutputLine[],
      suffix?: (kept: CodingOutputLine[], truncated: boolean) => string,
    ) => {
      const { kept, truncated } = takeCodingOutputLines(candidates);
      return codingTextResult(
        call,
        kept.map(({ rendered }) => rendered).join("\n") +
          (suffix?.(kept, truncated) ?? ""),
        kept,
      );
    };
    if (references !== "none" && !sectionArg) {
      return fail("references requires an exact section handle.");
    }
    if (sectionArg) {
      const lookup = lookupStructureBlock(document.sourceDoc, sectionArg);
      if (lookup.status !== "found" || !lookup.block) {
        return fail(
          `Section '${sectionArg}' not found (${lookup.status}` +
            (lookup.matches.length
              ? `; candidates: ${lookup.matches.join(", ")}`
              : "") +
            "). Grep for the wording, or Read without section.",
        );
      }
      const block = lookup.block;
      if (references !== "none") {
        const graph = referenceGraph(document.structure);
        if (!graph) {
          return fail(`Section '${sectionArg}' has no reference graph.`);
        }
        const scope = oneHopLegalScope(
          document.sourceDoc,
          graph,
          block,
          references,
        );
        if (!scope) {
          return fail(`Section '${sectionArg}' could not seed a reference scope.`);
        }
        const covered: TextRange[] = [];
        const candidates: CodingOutputLine[] = [];
        for (const [index, node] of scope.nodes.entries()) {
          const open = uncoveredRanges(
            { start: node.start, end: node.end },
            covered,
          );
          for (const range of open) {
            candidates.push(
              ...codingRangeLines(
                document.text,
                starts,
                range,
                `=== ${meta.filename} :: Read section="${node.label}" :: ${
                  index === 0 ? "target" : "direct reference"
                } ===`,
                source(node.label, "section"),
              ),
            );
          }
          addCoveredRange(covered, { start: node.start, end: node.end });
        }
        return finish(
          candidates,
          (_kept, truncated) => graph.documentAbstained
            ? `\n(Reference graph abstained: ${graph.note ?? "unresolved document structure"}.)`
            : truncated
              ? "\n(Reference read stopped at the tool-result limit; narrow the direction or read a returned section recipe.)"
              : "",
        );
      }
      const startLine = sourceLineAt(starts, block.start) + 1;
      const endLine = sourceLineAt(starts, Math.max(block.start, block.end - 1)) + 1;
      const offset = (args.offset as number | undefined) ?? startLine;
      if (offset < startLine || offset > endLine) {
        return fail(
          `(offset ${offset} is outside section ${block.label}; the section spans lines ${startLine}-${endLine})`,
        );
      }
      const candidates = codingRangeLines(
        document.text,
        starts,
        { start: Math.max(block.start, starts[offset - 1]), end: block.end },
        undefined,
        source(block.label, "section"),
      ).slice(0, limit);
      return finish(
        candidates,
        (kept, truncated) => {
          const lastShown = offset + kept.length - 1;
          return lastShown < endLine
            ? `\n\n[TRUNCATED: returned section lines ${offset}-${lastShown} of ${startLine}-${endLine}; continue with Read(file_path="${requested}", section="${block.label}", offset=${lastShown + 1}).${truncated ? " Tool-result limit reached." : ""}]`
            : "";
        },
      );
    }
    const offset = (args.offset as number | undefined) ?? 1;
    const firstLine = lines[offset - 1];
    if (firstLine === undefined) return fail(
      offset > lines.length
        ? `(offset ${offset} is past the end of the file; total lines: ${lines.length})`
        : "(empty file)",
    );
    if (startChar > firstLine.length) return fail(
      `(start_char ${startChar} is past the end of line ${offset}; line chars: ${firstLine.length})`,
    );
    let candidates = codingRangeLines(
      document.text,
      starts,
      { start: starts[offset - 1] + startChar, end: document.text.length },
      undefined,
      source(),
    );
    const first = candidates[0]?.span;
    if (first && first[1] < starts[offset - 1] + firstLine.length)
      candidates = candidates.slice(0, 1);
    const selected = candidates.slice(0, limit);
    return finish(
      selected,
      (kept, truncated) => {
        let next = kept.at(-1)?.span?.[1] ?? document.text.length;
        let nextLine = sourceLineAt(starts, next);
        let nextChar = next - starts[nextLine];
        if (nextChar >= lines[nextLine].length && nextLine + 1 < lines.length) {
          nextLine += 1;
          nextChar = 0;
          next = starts[nextLine];
        }
        return next < document.text.length &&
            (truncated || selected.length < candidates.length)
          ? `\n\n[TRUNCATED: continue with Read(file_path=${JSON.stringify(requested)}, offset=${nextLine + 1}, limit=${limit}, start_char=${nextChar}).]`
          : "";
      },
    );
  }

  if (call.name === "Edit" || call.name === "edit_docx_advanced") {
    const requested = trimmed(args.file_path);
    const meta = resolvePath(requested);
    if (!meta) {
      return fail(`Document resource does not exist: ${requested}`);
    }
    const sourceVersionId = referencedVersion(requested);
    const turnVersion = turnEditState?.get(meta.id);
    if (
      sourceVersionId &&
      sourceVersionId !== meta.current_version_id &&
      sourceVersionId !== turnVersion?.parentVersionId &&
      sourceVersionId !== turnVersion?.versionId
    ) {
      return fail("Edit requires the document's current version resource.");
    }
    if (call.name === "edit_docx_advanced") {
      return runAdvancedDocxEdit({
        args,
        documents,
        scope,
        documentId: meta.id,
        turnEditState,
        editMode,
      });
    }
    const oldString =
      typeof args.old_string === "string" ? args.old_string : "";
    const newString =
      typeof args.new_string === "string" ? args.new_string : "";
    if (!oldString) return result("old_string is required");
    if (oldString === newString) {
      return result("old_string and new_string must be different");
    }
    const file = await activeDocument(documents, scope, meta.id);
    if (!file) return fail("DOCX Library version not found");
    if (file === "stale") return fail("The active document version changed.");
    if (file.fileType.toLowerCase() !== "docx") {
      return fail("Edit only supports .docx files.");
    }
    if (args.replace_all === true) {
      const applied = await applyTextOpsToDocx(file.bytes, [{
        op: "replace_text",
        find: oldString,
        replace: newString,
        match_case: true,
        scope: { kind: "whole_document" },
      }]);
      if (!applied.replacementCount) {
        return result({
          ok: true,
          action: "no_changes",
          document_id: meta.id,
          version_id: file.version.id,
          change_count: 0,
        });
      }
      return saveDocxEdits({
        documents,
        scope,
        documentId: meta.id,
        source: file,
        bytes: applied.bytes,
        edits: applied.edits,
        turnEditState,
        editMode,
        extra: {
          ops: applied.reports,
          ...(applied.editErrors.length ? { edit_errors: applied.editErrors } : {}),
        },
      });
    }
    const applied = await applyTrackedEdits(file.bytes, [{
      find: oldString,
      replace: newString,
      context_before: "",
      context_after: "",
    }], { author: "Beaver" });
    if (!applied.changes.length) {
      const sourceText = await extractDocxBodyText(file.bytes);
      const spans: string[] = [];
      for (let at = 0; at < sourceText.length && spans.length < 40; at += 12_000)
        spans.push(sourceText.slice(at, at + 15_000));
      return result({
        ok: false,
        error: "No revision was saved",
        edit_errors: applied.errors.map(({ index, reason }) =>
          `edit ${index + 1}: ${reason}`),
        nearest_match: quoteRepairSuggestion(
          oldString.replace(/^["'“‘]+|["'”’]+$/gu, ""), spans),
      });
    }
    return saveDocxEdits({
      documents,
      scope,
      documentId: meta.id,
      source: file,
      bytes: applied.bytes,
      edits: assistantEdits(applied.changes),
      turnEditState,
      editMode,
    });
  }

  const pattern = trimmed(args.pattern);
  if (/\\[1-9]|\(\?(?!:)|\((?:[^()\\]|\\.)*(?:[+*?]|\{\d)[^()]*(?:\)|\])\s*(?:[+*?]|\{\d)/u
    .test(pattern) ||
    pattern.includes("|") && /\)\s*(?:[+*?]|\{\d)/u.test(pattern))
    return fail("regex parse error: unsafe backtracking pattern");
  let re: RegExp;
  try {
    re = new RegExp(pattern, args["-i"] === true ? "iu" : "u");
  } catch (error) {
    return fail(`regex parse error: ${safeErrorMessage(error, "invalid pattern")}`);
  }
  const pathArg = trimmed(args.path);
  let targets = files;
  let targetVersionId: string | undefined;
  if (pathArg) {
    const match = resolvePath(pathArg);
    if (!match)
      return fail(`Document resource does not exist: ${pathArg}`);
    targets = [match];
    targetVersionId = referencedVersion(pathArg);
  } else if (trimmed(args.glob)) {
    const globRe = globRegExp(trimmed(args.glob));
    targets = files.filter(({ filename }) => globRe.test(filename));
  }
  const grepSection = trimmed(args.section);
  if (grepSection && !pathArg)
    return fail("Legal Grep scopes require one exact path.");
  const mode = (args.output_mode ?? "files_with_matches") as
    "content" | "files_with_matches" | "count";
  const headLimit = (args.head_limit as number | undefined) ?? 250;
  const context = (args["-C"] as number | undefined) ?? 0;
  const contextBefore = (args["-B"] as number | undefined) ?? context;
  const contextAfter = (args["-A"] as number | undefined) ?? context;
  const numberLines = args["-n"] !== false;

  const rows: CodingOutputLine[] = [];
  const fileBuckets: CodingOutputLine[][] = [];
  let truncated = false;
  for (const meta of targets) {
    const document = await codingDocument(meta.id, targetVersionId);
    if (!document) continue;
    const resource = codingPath(meta, document.versionId);
    const lines = document.text.split(/\r?\n/u);
    const starts = sourceLineStarts(document.text);
    let scopeSpan: TextRange | null = null;
    if (grepSection) {
      const lookup = lookupStructureBlock(document.sourceDoc, grepSection);
      if (lookup.status !== "found" || !lookup.block) {
        const candidates = lookup.matches.length
          ? `; candidates: ${lookup.matches.join(", ")}` : "";
        return fail(`Section '${grepSection}' not found (${lookup.status}${candidates}).`);
      }
      scopeSpan = lookup.block;
    }
    const matched = lines.flatMap((line, index) => {
      const end = starts[index + 1] ?? document.text.length;
      const inScope = !scopeSpan ||
        starts[index] < scopeSpan.end && scopeSpan.start < end;
      return inScope && re.test(line) ? [index] : [];
    });
    if (!matched.length) continue;
    if (mode === "files_with_matches") {
      rows.push({ rendered: resource });
      continue;
    }
    if (mode === "count") {
      rows.push({ rendered: `${resource}:${matched.length}` });
      continue;
    }
    const matchedLines = new Set(matched);
    const selected = [...new Set(matched.flatMap((at) => {
      const first = Math.max(0, at - contextBefore);
      const last = Math.min(lines.length - 1, at + contextAfter);
      return Array.from({ length: last - first + 1 }, (_, offset) => first + offset);
    }))].sort((left, right) => left - right);
    const sink: CodingOutputLine[] = [];
    let previous = -2;
    for (const index of selected.slice(0, headLimit)) {
      if (previous >= 0 && index > previous + 1) sink.push({ rendered: "--" });
      const isMatch = matchedLines.has(index);
      const separator = isMatch ? ":" : "-";
      const line = lines[index];
      const matchAt = isMatch ? Math.max(0, line.search(re)) : 0;
      const sliceStart = line.length > GREP_LINE_CAP && isMatch
        ? Math.min(
            Math.max(0, matchAt - Math.floor(GREP_LINE_CAP / 2)),
            line.length - GREP_LINE_CAP,
          )
        : 0;
      const shown = line.slice(sliceStart, sliceStart + GREP_LINE_CAP);
      const prefix = numberLines
        ? `${resource}${separator}${index + 1}${separator}`
        : `${resource}${separator}`;
      sink.push({
        rendered: `${prefix}${sliceStart ? "…" : ""}${shown}${
          sliceStart + shown.length < line.length ? "…" : ""}`,
        span: [starts[index] + sliceStart, starts[index] + sliceStart + shown.length],
        handoffCandidate: isMatch || matchedLines.has(index - 1) ||
          matchedLines.has(index + 1),
        source: {
          documentId: meta.id,
          versionId: document.versionId,
          filename: meta.filename,
          sourceText: document.text,
        },
      });
      previous = index;
    }
    truncated ||= selected.length > headLimit;
    if (sink.length) fileBuckets.push(sink);
  }
  if (fileBuckets.length) {
    const perFile = Math.max(1, Math.floor(headLimit / fileBuckets.length));
    for (const bucket of fileBuckets) {
      rows.push(...bucket.slice(0, perFile));
      truncated ||= bucket.length > perFile;
    }
  }
  if (!rows.length) return result("No matches found");
  const limited = rows.slice(0, headLimit);
  const { kept, truncated: sizeTruncated } = takeCodingOutputLines(limited);
  const body = kept.map((line) => line.rendered).join("\n");
  return codingTextResult(
    call,
    truncated || rows.length > headLimit || sizeTruncated
      ? mode === "content"
        ? `${body}\n(Results truncated: ${headLimit} lines split evenly across ${fileBuckets.length} matching file${fileBuckets.length === 1 ? "" : "s"}. Narrow the pattern, scope with path=, or raise head_limit.)`
        : `${body}\n(Results truncated, showing first ${headLimit} lines. Narrow the pattern or pass head_limit.)`
      : body,
    kept,
  );
}

function pdfLocatorParams(args: Record<string, unknown>) {
  return {
    locatorKind: args.locator_kind as PdfLocatorKind,
    locator: typeof args.locator === "string" ? args.locator : "",
    endLocator: args.end_locator as string | undefined,
    contextBlocks: args.context_blocks as number | undefined,
    page: args.page as number | undefined,
    occurrence: args.occurrence as number | undefined,
  };
}

export async function extractDocument(
  documents: DocumentStore,
  scope: DocumentScope,
  documentId: string,
  versionId?: string,
) {
  const file = await documents.read(
    scope, documentId, versionId ?? null, false,
  );
  if (!file) return null;
  const fileType = file.fileType.toLowerCase();
  const projection = await documentProjectionService.read({
    documentId,
    versionId: file.version.id,
    filename: file.filename,
    fileType,
    sourceSha256: file.version.source_sha256,
    bytes: file.bytes,
  });
  const { sourceDoc, structure } = projection;
  const text = sourceDoc.text;
  // Preserve the engine's distinct PDF and printed page labels; text markers
  // are only a fallback because they cannot recover that distinction.
  let pages: PageMap | null = pageMapFromSourceDoc(sourceDoc);
  if (!pages?.pages.length) pages = pageMapFromMarkers(text);
  if (!pages.pages.length && fileType === "pdf")
    pages = { pages: [], source: "unindexed" };
  return {
    versionId: file.version.id,
    text,
    pages,
    tableCells: projection.tableCells,
    sourceDoc,
    structure,
  };
}

const result = (content: unknown): BeaverOutcome => ({ result: toolText(content, objectRecord(content)?.ok === false) });

function documentResult(content: Record<string, unknown>): BeaverOutcome {
  const base = result(content);
  const action = content.action;
  if (
    content.ok !== true ||
    (action !== "created" && action !== "revised") ||
    typeof content.filename !== "string" ||
    typeof content.document_id !== "string" ||
    typeof content.version_id !== "string" ||
    typeof content.download_url !== "string"
  ) return base;
  const event: Extract<AssistantEvent, { type: "document_artifact" }> = {
    type: "document_artifact",
    action: action === "created" ? "created" : "edited",
    filename: content.filename,
    document_id: content.document_id,
    version_id: content.version_id,
    version_number: typeof content.version_number === "number"
      ? content.version_number
      : null,
    download_url: content.download_url,
    ...(action === "revised" && {
      edit_mode: content.edit_mode === "auto" ? "auto" : "manual",
      annotations: Array.isArray(content.annotations)
        ? content.annotations as Extract<AssistantEvent, { type: "document_artifact" }>["annotations"]
        : [],
    }),
  };
  return {
    ...base,
    mutated: true,
    events: [...(base.events ?? []), event],
  };
}

const mutationResult = (content: Record<string, unknown>) => ({
  ...result(content),
  mutated: content.ok === true,
});

const withEvent = (output: BeaverOutcome, event: AssistantEvent | null | undefined): BeaverOutcome => event
  ? { ...output, events: [...(output.events ?? []), event] }
  : output;

function codingTextResult(
  call: NormalizedToolCall,
  content: string,
  lines: CodingOutputLine[],
): BeaverOutcome {
  const sourceLines =
    call.name === "Grep"
      ? lines.filter((line) => line.handoffCandidate === true)
      : lines;
  const receipts = new Map<string, LegalEvidenceReceipt>();
  const segments = sourceLines.flatMap((line) => {
    if (!line.span || !line.source) return [];
    const { sourceText, ...source } = line.source;
    if (call.name === "Read" && sourceText) {
      const [start, end] = line.span;
      const receipt = createLibraryEvidence({
        documentId: source.documentId,
        versionId: source.versionId,
        filename: source.filename ?? source.documentId,
        sourceText,
        spanText: sourceText.slice(start, end),
        start,
        end,
        locator: source.locator && source.locatorKind
          ? { kind: source.locatorKind, label: source.locator }
          : undefined,
      });
      receipts.set(receipt.evidence_id, receipt);
    }
    return [{
      ...source,
      start: line.span[0],
      end: line.span[1],
      kind: call.name === "Grep" ? "candidate" as const : "evidence" as const,
    }];
  });
  const evidence = [...receipts.values()];
  const rendered = result(
    evidence.length
      ? `${content}\n\nCitation evidence_ids: ${evidence.map(({ evidence_id }) => evidence_id).join(", ")}`
      : content,
  );
  return {
    ...rendered,
    metadata: {
      ...rendered.metadata,
      evidenceSpans: sourceLines.flatMap((line) => line.span ? [line.span] : []),
      evidenceSegments: segments,
    },
    ...(evidence.length ? { evidence } : {}),
  };
}

const fail = (error: string) => result({ ok: false, error });

const SAFE_PDF_EVIDENCE_ERRORS = new Set([
  "Invalid PDF evidence handle",
  "Invalid PDF evidence receipt",
  "PDF evidence receipt handle does not match its content",
  "PDF evidence receipt does not belong to this source",
  "PDF evidence source bytes no longer match their version",
  "PDF evidence no longer matches the authoritative source artifacts",
]);

type PdfLookupResult =
  | Awaited<ReturnType<typeof documentProjectionService.lookupPdf>>
  | Awaited<ReturnType<typeof documentProjectionService.rehydratePdfEvidence>>;
const MAX_COMPACT_PDF_MATCHES = 20;

function compactPdfLookup(filename: string, lookup: PdfLookupResult) {
  if (lookup.status !== "found") {
    const matches = lookup.matches.slice(0, MAX_COMPACT_PDF_MATCHES);
    return {
      ok: false,
      filename,
      status: lookup.status,
      exact: false,
      ...(matches.length ? { matches } : {}),
      ...(lookup.matches.length > matches.length
        ? { matches_truncated: true }
        : {}),
      ...("error" in lookup ? { error: lookup.error } : {}),
    };
  }
  const confidence = lookup.units
    .map((unit) => unit.confidence)
    .filter((value): value is number => typeof value === "number");
  const compactUnit = (unit: (typeof lookup.units)[number]) => ({
    kind: unit.kind,
    locator: unit.locator,
    text: unit.text,
    ...(unit.page_numbers.length ? { pages: unit.page_numbers } : {}),
    ...(unit.confidence !== null && unit.confidence < 1
      ? { confidence: unit.confidence }
      : {}),
    ...(unit.proposition ? { proposition: unit.proposition } : {}),
    ...(unit.note
      ? {
          note: {
            label: unit.note.label,
            ...(unit.note.warnings.length
              ? { warnings: unit.note.warnings }
              : {}),
          },
        }
      : {}),
  });
  return {
    ok: true,
    filename,
    status: lookup.status,
    exact: true,
    handle: lookup.evidence.handle,
    version_id: lookup.source.version_id,
    units: lookup.units.map(compactUnit),
    ...(lookup.before.length || lookup.after.length
      ? {
          context: {
            before: lookup.before.map(compactUnit),
            after: lookup.after.map(compactUnit),
          },
        }
      : {}),
    confidence: confidence.length ? Math.min(...confidence) : null,
    link: {
      ...(lookup.evidence.page_text_sha256 &&
      lookup.evidence.page_numbers?.length
        ? { href: lookup.link.href }
        : {}),
      page_numbers: lookup.link.page_numbers,
    },
  };
}

type ReadyProviderPdfLookup = Extract<
  Awaited<ReturnType<typeof lookupProviderPdfReference>>,
  { availability: "ready" }
>;

function compactProviderPdfLookup(resolved: ReadyProviderPdfLookup) {
  const filename =
    resolved.params.title ||
    resolved.params.filename ||
    resolved.params.identity;
  const compact = compactPdfLookup(filename, resolved.lookup);
  if (resolved.lookup.status !== "found") {
    return {
      ...compact,
      reference_id: resolved.state.reference_id,
      request_reference: resolved.state.request_reference,
      source_reference: resolved.state.source_reference,
    };
  }
  const pageNumbers =
    resolved.linkEvidence?.pageNumbers ?? resolved.lookup.link.page_numbers;
  const sourceUrl = new URL(resolved.params.url);
  if (pageNumbers[0]) sourceUrl.hash = `page=${pageNumbers[0]}`;
  return {
    ...compact,
    reference_id: resolved.state.reference_id,
    request_reference: resolved.state.request_reference,
    source_reference: resolved.state.source_reference,
    link: { href: sourceUrl.toString(), page_numbers: pageNumbers },
  };
}

type InsertBlocksRequest = {
  blocks: string[]; position: "before" | "after";
  anchorText?: string; occurrence?: number;
};

function parseAdvancedOps(raw: unknown):
  | { insert?: InsertBlocksRequest; requests: TextOpRequest[] }
  | string {
  const ops = raw as Array<Record<string, unknown>>;
  const inserted = ops.find(({ op }) => op === "insert_blocks");
  if (inserted) {
    if (ops.length !== 1) return "insert_blocks must be the only op in its call";
    const blocks = inserted.blocks as string[];
    const scope = inserted.scope as Record<string, unknown>;
    if (blocks.some((block) => !block.trim() || /[\r\n]/u.test(block)))
      return "insert_blocks.blocks must contain non-empty single-paragraph strings";
    if (scope.kind !== "whole_document" && scope.kind !== "find_text")
      return "insert_blocks scope must be whole_document or find_text";
    if (scope.kind === "find_text" && !trimmed(scope.text))
      return "insert_blocks find_text scope requires exact anchor text";
    return {
      insert: {
        blocks,
        position: inserted.position === "before" ? "before" : "after",
        ...(scope.kind === "find_text" ? { anchorText: trimmed(scope.text) } : {}),
        ...(typeof scope.occurrence === "number" && { occurrence: scope.occurrence }),
      },
      requests: [],
    };
  }
  for (const [index, op] of ops.entries()) {
    const scope = op.scope as Record<string, unknown>;
    if (scope.kind === "find_text" && !trimmed(scope.text))
      return `ops[${index}].scope.text is required for find_text`;
    if (scope.kind === "range" &&
        (!trimmed(scope.from_text) || !trimmed(scope.to_text)))
      return `ops[${index}].scope.from_text and to_text are required for range`;
    if (scope.kind === "at" && !trimmed(scope.at))
      return `ops[${index}].scope.at is required for at`;
    if (op.op === "replace_text" && typeof op.find !== "string")
      return `ops[${index}].find is required for replace_text`;
  }
  return { requests: ops as unknown as TextOpRequest[] };
}

function providerPdfLegalEvidence(
  resolved: ReadyProviderPdfLookup,
): LegalEvidenceReceipt[] {
  if (
    resolved.lookup.status !== "found" ||
    !resolved.linkEvidence ||
    !resolved.state.source_reference
  ) return [];
  const provider = resolved.state.provider;
  const jurisdiction = provider === "govinfo" ? "US" : "UK";
  const sourceClass = provider === "govinfo" ? "legislation" : "case";
  const title = resolved.params.title || resolved.params.filename || resolved.params.identity;
  return resolved.linkEvidence.sources.map((source) => {
    const page = source.pageNumbers[0];
    const url = new URL(resolved.params.url);
    if (page) url.hash = `page=${page}`;
    const createEvidence = provider === "tna"
      ? createTnaEvidence
      : provider === "govuk-et"
        ? createGovUkEmploymentTribunalEvidence
        : createGovInfoEvidence;
    return createEvidence({
      jurisdiction,
      sourceClass,
      stableSourceId: `${resolved.state.source_reference}:${source.key}`,
      sourceText: source.documentText,
      spanText: source.blockText,
      citation: title,
      name: title,
      dataset: provider,
      version: resolved.params.version,
      externalUrl: url.toString(),
      locatorKind: page ? "page" : "section",
      locatorLabel: page ? `page=${page}` : source.label,
    });
  });
}

function pdfLegalEvidence(
  documentId: string,
  versionId: string,
  filename: string,
  lookup: PdfLookupResult,
): LegalEvidenceReceipt[] {
  if (lookup.status !== "found") return [];
  return [...lookup.before, ...lookup.units, ...lookup.after].flatMap((unit) => {
    if (!unit.text.trim()) return [];
    const locatorKind = unit.kind === "page"
      ? "page"
      : unit.kind === "footnote"
        ? "footnote"
        : unit.kind === "paragraph"
          ? "paragraph"
          : "section";
    return [createLibraryEvidence({
      documentId,
      versionId,
      filename,
      sourceText: unit.text,
      spanText: unit.text,
      start: 0,
      end: unit.text.length,
      blockId: `pdf:${unit.id}`,
      locator: { kind: locatorKind, label: unit.locator },
    })];
  });
}

async function runAdvancedDocxEdit(params: {
  args: Record<string, unknown>;
  documents: DocumentStore;
  scope: DocumentScope;
  documentId: string;
  turnEditState?: AssistantEditTurnState;
  editMode: EditMode;
}) {
  const parsed = parseAdvancedOps(params.args.ops);
  if (typeof parsed === "string") return fail(parsed);
  const { insert: blockInsert, requests } = parsed;
  try {
    const file = await activeDocx(
      params.documents,
      params.scope,
      params.documentId,
      params.turnEditState?.get(params.documentId)?.versionId,
    );
    let resolvedRequests = requests;
    if (requests.some(({ scope }) =>
      (scope as unknown as { kind: string }).kind === "at")) {
      const body = await extractDocxBodyStructure(file.bytes);
      if (!body.text) {
        return fail("DOCX body text could not be extracted, so an `at` scope cannot be resolved.");
      }
      const analyzed = await analyzeDocumentNative({
        kind: "instrument",
        id: params.documentId,
        text: body.text,
        table_cells: body.tableCells,
        reconstruct_lineation: true,
        source_doc: true,
      });
      if (!analyzed.source_doc) throw new Error("Rust omitted SourceDoc");
      const sourceDoc = analyzed.source_doc;
      const graph = referenceGraph(analyzed.structure);
      const map = pageMapFromMarkers(body.text);
      resolvedRequests = requests.map((request, index) => {
        const scope = request.scope as unknown as {
          kind: string;
          at: string;
          follow?: FollowDirection;
          depth?: number;
        };
        if (scope.kind !== "at") return request;
        const address = parseAddress(scope.at ?? "");
        if (!address || address.kind === "offset") throw new Error(
          `ops[${index}].scope.at is not a provision or page address`);
        let spans: { start: number; end: number }[];
        if (address.kind === "page") {
          const lookup = resolvePage(map, body.text, address.spec);
          if (lookup.status !== "found") throw new Error(
            `ops[${index}].scope.at did not resolve (${lookup.status})`);
          spans = [{ start: lookup.page.start, end: lookup.page.end }];
        } else {
          const seed = lookupStructureBlock(sourceDoc, address.locator);
          if (seed.status !== "found" || !seed.block) throw new Error(
            `ops[${index}].scope.at did not resolve (${seed.status})`);
          const follow = scope.follow ?? "none";
          spans = [{ start: seed.block.start, end: seed.block.end }];
          if (follow !== "none") {
            if (!graph) throw new Error(
              `ops[${index}].scope.at has no reference graph`);
            const walked = graphScope(
              sourceDoc,
              graph,
              seed.block.label,
              { follow, depth: scope.depth ?? 1 },
            );
            if (!walked) throw new Error(
              `ops[${index}].scope.at is not an addressable block`);
            spans = walked.nodes.map(({ start, end }) => ({ start, end }));
          }
        }
        return { ...request, scope: { kind: "spans" as const, spans } };
      });
    }
    const applied = blockInsert
      ? await insertTrackedBlocks(file.bytes, blockInsert, { author: "Beaver" }).then(
          (inserted) => ({
            bytes: inserted.bytes,
            edits: assistantEdits(inserted.changes),
            reports: [{
              op: "insert_blocks",
              replacements: inserted.changes.length,
              notes: [] as string[],
            }],
            replacementCount: inserted.changes.length,
            editErrors: inserted.errors.map(
              ({ index, reason }) => `change ${index + 1}: ${reason}`,
            ),
          }),
        )
      : await applyTextOpsToDocx(file.bytes, resolvedRequests);
    const reports = applied.reports.map(({ op, replacements, notes }) => ({
      op,
      replacements,
      unchanged_sites: notes,
    }));
    if (!applied.replacementCount) {
      return result({
        ok: true,
        action: "no_changes",
        document_id: params.documentId,
        version_id: file.version.id,
        change_count: 0,
        ops: reports,
      });
    }
    if (!applied.edits.length) {
      return result({
        ok: false,
        error: "No revision was saved",
        ops: reports,
        ...(applied.editErrors.length ? { edit_errors: applied.editErrors } : {}),
      });
    }
    return saveDocxEdits({
      documents: params.documents,
      scope: params.scope,
      documentId: params.documentId,
      source: file,
      bytes: applied.bytes,
      edits: applied.edits,
      turnEditState: params.turnEditState,
      editMode: params.editMode,
      extra: {
        ops: reports,
        ...(applied.editErrors.length ? { edit_errors: applied.editErrors } : {}),
      },
    });
  } catch (error) {
    return fail(safeErrorMessage(error, "Deterministic text operations failed"));
  }
}

async function saveWorkflowDocx(
  documents: DocumentStore,
  scope: DocumentScope,
  documentId: string,
  turnEditState: AssistantEditTurnState | undefined,
  input: { sourceVersionId: string; filename: string; bytes: Buffer },
) {
  const committed = await commitAssistantTurnVersion({
    documents,
    scope,
    documentId,
    ...input,
    trackedEdits: [],
    turnEditState,
  });
  if (!committed) throw new Error("The active version changed");
  return {
    id: committed.version.id,
    filename: committed.version.filename ?? input.filename,
    version_number: committed.version.version_number ?? undefined,
    file_type: committed.version.file_type ?? undefined,
    source_sha256: committed.version.source_sha256 ?? undefined,
    parentVersionId: committed.parentVersionId,
  };
}

async function runDocxWorkflow(
  action: "fix_supras" | "lint_structure",
  documents: DocumentStore,
  scope: DocumentScope,
  documentId: string,
  versionId?: string,
  turnEditState?: AssistantEditTurnState,
): Promise<Record<string, unknown>> {
  if (action === "fix_supras") return fixDocumentSupras(
    documents, scope.userId, documentId, {
      saveVersion: (input) => saveWorkflowDocx(
        documents, scope, documentId, turnEditState, input),
    },
  );
  const file = await activeDocx(documents, scope, documentId, versionId);
  const projection = await documentProjectionService.read({
    documentId,
    versionId: file.version.id,
    filename: file.filename,
    fileType: file.fileType,
    sourceSha256: file.version.source_sha256,
    bytes: file.bytes,
  });
  if (projection.kind !== "docx-session") {
    throw new Error("DOCX structure projection is unavailable");
  }
  return {
    ok: true,
    document_id: documentId,
    version_id: file.version.id,
    filename: file.filename,
    ...lintDocxStructure(projection.structure),
  };
}

type ServedDrafting = { served: string; versionId: string } | null;

async function servedDraftingText(
  documents: DocumentStore,
  scope: DocumentScope,
  documentId: string,
  cache?: Map<string, ServedDrafting>,
  versionId?: string,
): Promise<ServedDrafting> {

  const file = await documents.read(
    scope, documentId, versionId ?? null, false,
  );
  if (!file || file.fileType.toLowerCase() !== "docx") return null;
  const cacheKey = `${documentId}:${file.version.id}`;
  if (cache?.has(cacheKey)) return cache.get(cacheKey)!;
  const source = await extractDocxDraftingSource(file.bytes).catch(() => null);
  const result = source ? {
    served: source.markdown,
    versionId: file.version.id,
  } : null;
  cache?.set(cacheKey, result);
  return result;
}

type AssistantToolsDependencies = {
  userId: string;
  userEmail?: string;
  documents: DocumentStore;
  library: LibraryStore;
  projects: ProjectStore;
  workflows?: WorkflowStore;
  allowedDocumentIds?: Set<string>;
  matterId?: string | null;
  legalEvidence?: LegalEvidenceTurnState;
  edits?: AssistantEditTurnState;
  servedDraftingCache?: Map<string, ServedDrafting>;
  editMode?: EditMode;
  timeZone?: string;
  scope: "main" | "reader";
  readerAssignment?: ReadSubagentAssignment;
  tabular?: TabularCellStore;
  documentNames?: ReadonlyMap<string, string>;
  resolveArtifact(value: string): string | undefined;
  artifactFor(documentId: string, versionId: string): string;
  onMutationCommitted(): void;
};

type AssistantToolRun = (
  call: Readonly<NormalizedToolCall>,
  input: Record<string, unknown>,
  signal: AbortSignal,
  progress?: (label: string) => void,
) => Promise<BeaverOutcome>;

export function assistantTools<Context extends {
  updateActivity?: (id: string, label: string) => void;
}>(
  {
    userId,
    userEmail,
    allowedDocumentIds,
    matterId,
    legalEvidence: legalEvidenceState,
    edits: turnEditState,
    servedDraftingCache = new Map(),
    editMode = "manual",
    timeZone,
    documents,
    library,
    projects,
    workflows,
    scope: turnScope,
    readerAssignment,
    tabular,
    documentNames,
    resolveArtifact,
    artifactFor,
    onMutationCommitted,
  }: AssistantToolsDependencies,
): BeaverTool<Context>[] {
  const scope: DocumentScope = { userId, userEmail };
  const availableWorkflows = workflows ?? new Map(
    SYSTEM_ASSISTANT_WORKFLOWS.map(({ id, title, skill_md }) => [
      id,
      { title, skill_md },
    ]),
  );
  const knownDocumentNames = new Map(documentNames);
  const persistGenerated = async (
    filename: string,
    bytes: Buffer,
    provenance?: DocumentProvenance,
  ) => {
    const document = await documents.create(scope, {
      filename,
      fileType: filename.slice(filename.lastIndexOf(".") + 1).toLowerCase(),
      bytes,
      projectId: matterId,
      libraryKind: "file",
      provenance,
    });
    allowedDocumentIds?.add(document.id);
    return documentResult({
      ok: true,
      action: "created",
      document_id: document.id,
      version_id: document.current_version_id,
      version_number: document.active_version_number,
      filename: document.filename,
      file_type: document.file_type,
      resource: resourceReference.document(document.id, document.current_version_id),
      download_url: `/api/single-documents/${encodeURIComponent(document.id)}/file?version_id=${encodeURIComponent(document.current_version_id)}`,
    });
  };
  const coding: AssistantToolRun = async (call, args, signal, progress) => {
    const sourceRead = await readLegalSourceResource(call, args, {
      userId,
      signal,
      reader: readerAssignment,
    });
    if (sourceRead) return sourceRead;
    const output = await runCodingShapeCall(
      call,
      args,
      documents,
      library,
      projects,
      scope,
      matterId,
      turnEditState,
      servedDraftingCache,
      availableWorkflows,
      editMode,
      knownDocumentNames,
      progress,
      signal,
    );
    return output;
  };
  const documentTool = (
    run: (
      call: Readonly<NormalizedToolCall>,
      input: Record<string, unknown>,
      documentId: string,
      signal: AbortSignal,
    ) => Promise<BeaverOutcome>,
  ): AssistantToolRun => async (call, input, signal) => {
    const resolved = resolveDocumentArgument(input);
    if (resolved.error) return fail(resolved.error);
    const documentId = trimmed(resolved.input.document_id);
    if (documentId && (matterId
      ? allowedDocumentIds && !allowedDocumentIds.has(documentId)
      : !await library.document({ ...scope, kind: "file" }, documentId))) {
      return fail("Document is outside this chat's document scope");
    }
    return run(call, resolved.input, documentId, signal);
  };
  const write: AssistantToolRun = async (_call, args) => {
    const requestedFilename = trimmed(args.filename);
    const markdown = typeof args.content === "string" ? args.content.trim() : "";
    const extension = /\.([^.]+)$/u.exec(requestedFilename)?.[1].toLowerCase();
    if (!markdown || !["docx", "xlsx", "pptx"].includes(extension ?? "")) {
      return fail("Write requires content and a .docx, .xlsx, or .pptx filename.");
    }
    const title = requestedFilename.replace(/\.[^.]+$/u, "");
    const filename = safeGeneratedFilename(title, extension!);
    try {
      if (extension !== "docx") {
        const bytes = extension === "xlsx"
          ? await renderXlsxWorkbook(title, workbookFromMarkdown(markdown))
          : await buildPptxPresentation(presentationFromMarkdown(markdown));
        return persistGenerated(filename, bytes);
      }
      const generatedAt = new Date();
      const drafting = resolveDraftingOptions(
        args,
        await getDraftingStyleSettings(userId),
      );
      const evidence = resolveDocxEvidenceCitations(
        legalEvidenceState,
        args.citations,
      );
      if (legalEvidenceState) {
        const integrityErrors = legalEvidenceProseIntegrityErrors(
          markdown,
          evidence.bindings.flatMap(({ evidenceIds }) => evidenceIds),
          legalEvidenceState,
        );
        if (integrityErrors.length) {
          return fail(`Draft integrity check failed: ${integrityErrors.join("; ")}`);
        }
      }
      const rendered = await renderMarkdownDocx(
        title,
        markdown,
        args.fields,
        {
          landscape: args.landscape === true,
          citations: evidence.citations,
          citationPlacement: drafting.citationPlacement,
          citationHyperlinks: drafting.citationHyperlinks,
          numberHeadings: drafting.numberHeadings,
          memoHeader: drafting.memoHeader,
          generatedAt,
          timeZone,
        },
      );
      return persistGenerated(
        filename,
        rendered.bytes,
        {
          schemaVersion: 1,
          actor: "assistant",
          action: "created",
          generation: {
            rendererVersion: "beaver.docx-markdown.v2",
            markdownSha256: sha256(markdown),
            fieldValuesSha256: sha256(JSON.stringify(args.fields ?? [])),
            sourceRegistrySha256: sha256(
              JSON.stringify(args.citations ?? []),
            ),
            evidenceBindings: evidence.bindings,
          },
        },
      );
    } catch (error) {
      return fail(
        error instanceof Error ? error.message : "DOCX creation failed",
      );
    }
  };

  const deleteAndRenumber = documentTool(
    async (_call, args, documentId) => {
      let versionId = trimmed(args.version_id);
      const target = trimmed(args.target);
      const turnVersion = turnEditState?.get(documentId);
      if (turnVersion) {
        if (
          versionId &&
          versionId !== turnVersion.versionId &&
          versionId !== turnVersion.parentVersionId
        ) {
          return fail("version_id is not the active turn version");
        }
        versionId = turnVersion.versionId;
      }
      try {
        const file = await activeDocx(
          documents, scope, documentId, versionId || undefined,
        );
        const bytes = file.bytes;
        const body = await extractDocxBodyStructure(bytes);
        if (!body.text) {
          return fail("DOCX body text could not be extracted");
        }
        const plan = await deleteProvisionAndRenumberSiblings(body.text, target);
        if (plan.failures.length) {
          return result({
            ok: false,
            error: "Delete-and-renumber refused; the document is unchanged",
            document_id: documentId,
            version_id: file.version.id,
            source_sha256: file.version.source_sha256,
            target,
            mapping: plan.mapping,
            failures: plan.failures,
          });
        }
        const edits = trackedEditsForRenumberPlan(body.text, plan.applied);
        if (typeof edits === "string") return fail(edits);
        const edited = await applyTrackedEdits(bytes, edits, {
          author: "Beaver",
        });
        if (edited.errors.length || !edited.changes.length) {
          return result({
            ok: false,
            error: "Delete-and-renumber could not be represented as tracked changes; the document is unchanged",
            edit_errors: edited.errors,
          });
        }
        if (comparableAcceptedText(await extractDocxBodyText(edited.bytes)) !==
            comparableAcceptedText(plan.text)) {
          return fail("Tracked-change verification disagreed with the renumber plan; the document is unchanged");
        }
        return saveDocxEdits({
          documents,
          scope,
          documentId,
          source: file,
          bytes: edited.bytes,
          edits: assistantEdits(edited.changes),
          turnEditState,
          editMode,
          extra: { target, mapping: plan.mapping, verification: plan.verification },
        });
      } catch (error) {
        return fail(safeErrorMessage(error, "Delete-and-renumber failed"));
      }
    },
  );

  const updateMetadata = documentTool(
    async (_call, args, documentId) => {
      const kind = args.kind as "file" | "template";
      const libraryScope = { ...scope, kind } as const;
      const current = await library.document(libraryScope, documentId);
      const updated = current?.filename
        ? await library.updateDocument(libraryScope, documentId, {
            filename: current.filename,
            metadata: args.metadata,
            notes: args.notes as string | undefined,
          })
        : null;
      return updated
        ? mutationResult({
            ok: true,
            document_id: updated.id,
            filename: updated.filename,
            metadata: updated.metadata,
            notes: updated.notes,
          })
        : fail("Document not found");
    },
  );

  const runWorkflow = documentTool(
    async (call, args, documentId) => {
      const action = args.action as "fix_supras" | "lint_structure";
      const automationEvent = action === "fix_supras" ? supraFixEvent : null;
      const respond = (output: Record<string, unknown>) => withEvent(
        documentResult(output), automationEvent?.(output, call.id),
      );
      try {
        const output = await runDocxWorkflow(
          action,
          documents,
          scope,
          documentId,
          trimmed(args.version_id) || undefined,
          turnEditState,
        );
        return respond(output);
      } catch (error) {
        const fallback = action === "fix_supras"
          ? "DOCX supra cleanup failed"
          : "DOCX structural lint failed";
        const message = safeErrorMessage(error, fallback);
        return respond({ ok: false, error: message });
      }
    },
  );

  const createAuthorities = documentTool(
    async (call, args, documentId) => {
      const versionId = trimmed(args.version_id);
      const respond = (payload: Record<string, unknown>) => withEvent(
        payload.ok === true ? mutationResult(payload) : fail(String(payload.error)),
        tableOfAuthoritiesEvent(payload, call.id),
      );
      try {
        const file = await documents.read(scope, documentId, versionId || null, false);
        if (!file) return respond({ ok: false, error: "Library version not found" });
        if (!["docx", "pdf"].includes(file.fileType.toLowerCase())) return respond({
          ok: false,
          error: "Table of Authorities requires a Word or PDF Library version",
        });
        const job = await submitTableOfAuthoritiesDocument({
          userId: scope.userId,
          bytes: file.bytes,
          filename: file.version.filename ?? file.filename,
          splitFallback: args.split_fallback === "off" ? "off" : "auto",
          projectId: matterId,
        });
        const payload = {
          ok: true,
          document_id: documentId,
          version_id: file.version.id,
          filename: file.version.filename,
          resource: resourceReference.job(job.id),
          job,
          next_required_action:
            `Read ${resourceReference.job(job.id)} until detection is complete.`,
        };
        return respond(payload);
      } catch (error) {
        const message = safeErrorMessage(error, "Table of Authorities submission failed");
        return respond({ ok: false, error: message });
      }
    },
  );

  const runCitator: AssistantToolRun = async (call, args) => {
    const citator = executeCitatorTool(call.name, args)!;
    return {
      ...result(citator.payload),
      evidence: citator.evidences ?? [],
    };
  };

  const compare = documentTool(async (_call, args, documentId) => {
    const rawBaseline = trimmed(args.baseline);
    const baseline = rawBaseline ? parseResourceReference(rawBaseline) : null;
    if (rawBaseline && (
      baseline?.kind !== "document" || baseline.documentId !== documentId
    )) return fail("baseline must be a version of the compared document");
    return documentResult(await compareDocumentVersions(
      documents,
      scope,
      {
        documentId,
        newVersionId: trimmed(args.version_id),
        ...(baseline?.kind === "document"
          ? { oldVersionId: baseline.versionId }
          : {}),
        saveRedline: args.save_redline === true,
      },
      matterId,
    ));
  });

  const sourceSearch: AssistantToolRun = async (_call, input, signal) => {
    const sourceTypes = Array.isArray(input.source_types)
      ? input.source_types.filter((value): value is string => typeof value === "string")
      : [];
    if (readerAssignment?.source_types?.length && sourceTypes.some((value) =>
      !readerAssignment.source_types!.includes(value))) {
      return fail("This search requests a source type outside the reader assignment.");
    }
    const collection = typeof input.collection === "string" ? input.collection : "";
    if (readerAssignment?.collections?.length && collection &&
        !readerAssignment.collections.some((value) =>
          value.toLowerCase() === collection.toLowerCase())) {
      return fail("This search requests a collection outside the reader assignment.");
    }
    return result(await searchSources(readerAssignment
      ? { ...input, jurisdiction: readerAssignment.jurisdiction }
      : input, signal));
  };
  const documentOperation: AssistantToolRun = (call, input, signal) => {
    switch (input.action) {
      case "metadata":
        if (input.kind !== "file" && input.kind !== "template")
          return Promise.resolve(fail("metadata requires kind"));
        return updateMetadata(call, input, signal);
      case "fix_supras":
        return runWorkflow(call, input, signal);
      case "delete_and_renumber":
        if (!trimmed(input.target))
          return Promise.resolve(fail("delete_and_renumber requires target"));
        return deleteAndRenumber(call, input, signal);
      case "table_of_authorities":
        return createAuthorities(call, input, signal);
      default:
        return Promise.resolve(fail("Unknown document operation"));
    }
  };
  const codingWithArtifacts: AssistantToolRun = (call, input, signal, progress) => {
    const filePath = trimmed(input.file_path);
    const resolved = filePath ? resolveArtifact(filePath) : undefined;
    const args = resolved ? { ...input, file_path: resolved } : input;
    return coding({ ...call, input: args }, args, signal, progress);
  };
  const isDocumentToolEvent = (
    event: AssistantEvent,
  ): event is Extract<AssistantEvent, { type: "document_artifact" }> =>
    event.type === "document_artifact";
  const documentName = (value: unknown) => {
    const raw = trimmed(value);
    const resolved = resolveArtifact(raw) ?? raw;
    const reference = parseResourceReference(resolved);
    return knownDocumentNames.get(reference?.kind === "document"
      ? reference.documentId : resolved);
  };
  const documentActivity = (verb: string, toolName: string, key: string) =>
    (input: Record<string, unknown>) => {
      const name = documentName(input[key]);
      if (toolName === "Edit" && name) return `${verb} ${name}`;
      return assistantToolActivityLabel(toolName, input, name) ?? null;
    };
  const present = (output: BeaverOutcome): BeaverOutcome => {
    const { events: rawEvents = [], ...rest } = output;
    if (output.mutated) onMutationCommitted();
    const documentEvent = rawEvents.find(isDocumentToolEvent);
    const artifact = documentEvent &&
      artifactFor(documentEvent.document_id, documentEvent.version_id);
    return {
      ...rest,
      result: artifact
        ? toolText({ ok: true, artifact, filename: documentEvent.filename })
        : output.result,
      ...(turnScope === "main" && rawEvents.length ? { events: rawEvents } : {}),
    };
  };
  const definition = (
    schema: Tool,
    run: AssistantToolRun,
    policy: {
      specialist?: boolean;
      research?: boolean;
      reader?: readonly ReadSubagentRegion[];
      sequential?: boolean | ((input: Record<string, unknown>) => boolean);
      activity?: (input: Record<string, unknown>) => string | null;
    } = {},
  ): BeaverTool<Context> => ({
    ...schema,
    ...(policy.specialist ? { specialist: true } : {}),
    ...(policy.research ? { research: true } : {}),
    ...(policy.reader ? { reader: policy.reader } : {}),
    ...(policy.sequential ? { sequential: policy.sequential } : {}),
    activity: policy.activity ?? ((input) =>
      assistantToolActivityLabel(schema.name, input) ?? null),
    async execute(input, context, signal, call) {
      const output = await run(call, input, signal, (label) =>
        context.updateActivity?.(call.id, label));
      if (schema.name === "Read" && !input.pattern && output.evidence?.length) {
        const label = assistantReadEvidenceActivityLabel(
          output.evidence,
          documentName(input.file_path),
          input,
        );
        if (label) context.updateActivity?.(call.id, label);
      }
      if (legalEvidenceState) {
        output.evidence?.forEach((evidence) => registerLegalEvidence(
          legalEvidenceState,
          evidence,
          output.evidenceSources?.get(evidence.evidence_id),
        ));
      }
      if (signal.aborted && !output.mutated) {
        throw signal.reason ?? new Error("Tool call cancelled");
      }
      return present(output);
    },
  });

  const [glob, grep, read, edit] = RESOURCE_TOOLS;
  const compareVersions = COMPARE_VERSIONS_TOOLS[0];
  const noteUp = CITATOR_TOOLS[0];

  const tools: BeaverTool<Context>[] = [
    definition(glob, codingWithArtifacts, { reader: ["CA", "US", "UK"], activity: () => null }),
    definition(grep, codingWithArtifacts, {
      reader: ["CA", "US", "UK"],
      activity: documentActivity("Searching", "Grep", "path"),
    }),
    definition(read, codingWithArtifacts, {
      reader: ["CA", "US", "UK"],
      activity: documentActivity("Reading", "Read", "file_path"),
    }),
    definition(edit, codingWithArtifacts, {
      sequential: true,
      activity: documentActivity("Editing", "Edit", "file_path"),
    }),
    definition(WRITE_TOOL, write, { sequential: true }),
    definition(SEARCH_SOURCES_TOOL, sourceSearch, { research: true, reader: ["CA", "US"] }),
    definition(noteUp, runCitator, { research: true, reader: ["CA"] }),
    definition(DOCUMENT_OPERATION_TOOL, documentOperation, {
      specialist: true,
      sequential: true,
      activity: (input) => ({
        metadata: "Updating Library metadata",
        fix_supras: "Fixing supra references",
        delete_and_renumber: "Deleting and renumbering provisions",
        table_of_authorities: "Creating a table of authorities",
      } as Record<string, string>)[String(input.action)] ?? "Updating document",
    }),
    definition(LINT_DOCUMENT_TOOL, (call, input, signal) =>
      runWorkflow(call, { ...input, action: "lint_structure" }, signal), {
      specialist: true,
      reader: ["CA", "US", "UK"],
      activity: () => "Checking document structure",
    }),
    definition(ADVANCED_DOCX_EDIT_TOOL, codingWithArtifacts, { specialist: true, sequential: true }),
    definition(compareVersions, compare, {
      specialist: true,
      sequential: (input) => input.save_redline === true,
    }),
  ];

  if (tabular && legalEvidenceState) {
    const evidence = legalEvidenceState;
    const tabularSchema = TABULAR_TOOLS[0];
    tools.splice(5, 0, {
      ...tabularSchema,
      reader: ["CA", "US", "UK"],
      activity: () => "Reading table cells",
      async execute(input) {
        const read = readTabularCells(
          tabular,
          evidence,
          input.col_indices as number[] | undefined,
          input.row_indices as number[] | undefined,
        );
        return { result: toolText(read.content) };
      },
    });
  }
  return tools;
}

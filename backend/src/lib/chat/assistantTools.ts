import { randomUUID } from "node:crypto";
import { sha256 } from "../hash";
import { SYSTEM_ASSISTANT_WORKFLOWS } from "../systemWorkflows";
import {
  DOCUMENT_RESOURCE_PATTERN,
  parseResourceReference,
  resourceReference,
} from "../resourceReferences";
import {
  type A2AJCompiledDocument,
} from "../legalSources/a2aj";
import {
  readLegalSourcePassage,
  type LegalSourcePassage,
  type LegalSourceReference,
} from "../legalSourceRegistry";
import type { RemoteLegalSourceDocument } from "../legalSources/remoteProvider";
import { fixDocumentSupras } from "../docxDeterministicCleanup";
import { createDocxAuthorityLedger,
  resolveDocxEvidenceCitations } from "../docxEvidenceCitations";
import {
  DEFAULT_DRAFTING_STYLE,
  resolveDraftingOptions,
  type DraftingStyleSettings,
} from "../draftingStyle";
import {
  applyTrackedEdits,
  extractDocxBodyText,
  finalizeTrackedEdits,
  insertTrackedBlocks,
  type EditMode,
} from "../docxTrackedChanges";
import type { LibraryStore } from "../libraryStore";
import type { ProjectStore } from "../projectStore";
import type {
  AssistantEdit,
  StoredAssistantEdit,
  DocumentContent,
  DocumentProvenance,
  DocumentProjectionSource,
  DocumentScope,
  DocumentStore,
} from "../documentStore";
import {
  documentProjectionService,
  type PdfLocatorKind,
} from "../documentProjectionService";
import {
  structureNative,
  type NativeDocument,
  type NativeDocumentBlock,
} from "../structureNative";
import { pdfLifecyclePhase } from "../pdfLifecycleDiagnostics";
import {
  lookupProviderPdfReference,
  rehydrateProviderPdfReference,
} from "../providerPdfLibraryBridge";
import type {
  NormalizedToolCall,
  Tool,
} from "../llm";
import {
  assistantReadEvidenceActivityLabel,
  assistantToolActivityLabel,
  type A2AJReferenceDirection,
} from "./tools/a2ajTools";
import {
  createA2AJPassageEvidence,
  createGovInfoEvidence,
  createGovUkEmploymentTribunalEvidence,
  createTnaEvidence,
  createLibraryEvidence,
  legalEvidenceProseIntegrityErrors,
  legalSourceEvidence,
  modelEvidencePassage,
  registerLegalEvidence,
  restorePriorLegalEvidence,
  type LegalEvidenceReceipt,
  type LegalEvidenceSpan,
  type LegalEvidenceTurnState,
  type RegisteredEvidence,
} from "./legalEvidence";
import { CITATOR_TOOL, executeCitatorTool } from "./tools/citatorTools";
import {
  COMPARE_VERSIONS_TOOL,
  compareDocumentVersions,
} from "./tools/compareVersionsTool";
import {
  SEARCH_SOURCES_TOOL,
  searchSources,
} from "./tools/sourceSearchTools";
import { createLegalSourceSearchCitations } from "./citations";
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
import { projectDocxRedline } from "../docx/redline";
import {
  ADVANCED_DOCX_EDIT_TOOL,
  WRITE_TOOL,
} from "./tools/toolSchemas";
import {
  courtlistenerPdfRendition,
} from "./courtlistenerToolRunner";
import { jsonRecord as objectRecord, trimmedText as trimmed } from "../value";
import { RESOURCE_TOOLS, globPattern as globRegExp } from "./resourceTools";
import {
  supraFixEvent,
  workProductEvent, workProductResult,
} from "./localWorkflowRun";
import {
  MAX_MODEL_TOOL_RESULT_CHARS,
  toolText,
  type BeaverToolPolicy,
  type BeaverOutcome,
  type BeaverTool,
} from "./toolRegistry";
import { tabularTool } from "./tabularCells";
import type { DocIndex, TabularCellStore, WorkflowStore } from "./types";
import type { ReadSubagentAssignment } from "./readSubagents";
import type { AssistantEvent } from "./turnEngine";
import { safeErrorMessage } from "../safeError";
import type { AuthoritiesUserAction,
  AuthoritiesWorkspaceApplication } from "../authoritiesWorkspaceApplication";
import { authoritiesProfileIds, decodeAuthoritiesDraft } from "../authoritiesDomain";
import type { CourtRecordsApplication } from "../courtRecordsApplication";
import { COURT_RECORD_PROFILE_BY_ID } from "../courtRecordContract";
import type { FeaturePreferences } from "../userPreferences";
import type { WorkProductApplication } from "../workProductApplication";
import { WORK_PRODUCT_KINDS, type WorkProductKind } from "../workProduct";
import { createResearchFileState, readResearchFile, researchFileActionSchema,
  researchFileMarkdown, researchQueryReceipt, researchQuerySources,
  researchSourceFromResource, saveResearchFile,
  type ResearchFileAction, type ResearchQueryReceipt } from "../researchFile";
import { researchCaptureRuleSchema, runResearchFileQuery } from "../researchFileQuery";
import { COURT_RECORD_TOOL_PROPERTIES, courtRecordResult,
  courtRecordSlotTool } from "./courtRecordSlotTool";

const DOCUMENT_ID_PROPERTY = {
  type: "string",
  pattern: DOCUMENT_RESOURCE_PATTERN,
  description: "Version-pinned document resource returned by this tool or Glob. Reuse the latest returned resource after every write.",
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
const documentOperationTool = (): Tool & BeaverToolPolicy => ({
  name: "document_operation",
  specialist: true,
  sequential: true,
  activity: (input) => ({
    metadata: "Updating Library metadata",
    fix_supras: "Fixing supra references",
    research: "Updating saved research",
  } as Record<string, string>)[String(input.action)] ?? "Updating document",
  description: "Specialist operation on one version-pinned Library document. " +
    "Actions: metadata saves user-requested classification or notes; research creates or updates " +
    "an ordinary .research.md Library file; fix_supras " +
    "creates native Word supra cross-references. Do not pre-compute filesystem paths.",
  annotations: { readOnlyHint: false },
  inputSchema: objectSchema({
    action: {
      type: "string",
      enum: ["metadata", "research", "fix_supras"],
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
    evidence_ids: { type: "array", uniqueItems: true,
      items: { type: "string", minLength: 1 } },
    query_ids: { type: "array", uniqueItems: true,
      items: { type: "string", minLength: 1 } },
    research_action: { type: "object", description:
      "Use {type:'create',title} without document_id, then reuse its returned resource as document_id. " +
      "{type:'save'} with top-level evidence_ids/query_ids saves verified evidence before annotation; " +
      "{type:'query',text,syntax:'literal'|'terms',target:'sources'|'passages',sourceIds?,labelIds?,limit?}; " +
      "query may instead use rules:[{phrase,direction:'before'|'after',unit:'sentence'|'line'|'paragraph'|'chars',chars?,slot}] and conflict; " +
      "{type:'label',name,parentId?,color?:'#RRGGBB',order?,scope:'source'|'highlight'} creates a label: omit id, " +
      "then use returned label_id for child parentId and later labelIds; supply id only to edit; " +
      "{type:'source',reference:{provider,id,kind,...},labelIds?,badge?,note?} for a current search result returns source_id; " +
      "{type:'annotate',kind:'source',id,labelIds?,badge?,note?} or " +
      "{type:'annotate',kind:'evidence',id,labelIds?,note?}; " +
      "{type:'remove',kind:'label'|'source'|'evidence',id}; {type:'note',markdown}; or " +
      "{type:'memo',title,markdown} creates a linked ordinary Markdown file. Creation is idempotent by filename; " +
      "IDs are opaque: annotate only returned label_id/source_id or matches[].evidence_id." },
  }, ["action"]),
});
const LINT_DOCUMENT_TOOL: Tool & BeaverToolPolicy = {
  name: "lint_document",
  specialist: true,
  reader: ["CA", "US", "UK"],
  activity: () => "Checking document structure",
  description:
    "Read-only structural lint for one version-pinned Library DOCX: broken internal references, missing schedules or exhibits, numbering defects, and duplicate or unused defined terms.",
  annotations: { readOnlyHint: true },
  inputSchema: objectSchema({ document_id: DOCUMENT_ID_PROPERTY }, ["document_id"]),
};
const WORK_PRODUCT_ACTIVITY: Record<string, string> = {
  create: "Creating draft", read: "Reading draft", select: "Opening draft", update: "Updating draft",
  review: "Checking draft", refresh: "Refreshing draft", build: "Building draft",
};
const AUTHORITIES_ACTION = objectSchema({
  type: { type: "string", enum: [
    "set-authority-span", "set-pinpoint-span", "split-occurrence", "merge-occurrence",
    "relink-occurrence", "set-reference", "add-authority", "remove-authority", "exclude-authority",
    "rename-authority", "clear-authority-source", "set-profile", "set-settings",
    "set-output-mode", "set-document-output", "clear-book-part",
  ] },
  occurrence_id: { type: "string", minLength: 1 },
  authority_id: { type: "string" },
  authority_kind: { type: "string", enum: ["case", "legislation", "commentary", "other"] },
  citation: { type: "string", minLength: 1, maxLength: 1_000 },
  name: { type: ["string", "null"], maxLength: 1_000 },
  target_authority_id: { type: "string", minLength: 1 },
  start: { type: "integer", minimum: 0 },
  end: { type: "integer", minimum: 0 },
  cursor: { type: "integer", minimum: 0 },
  reference_kind: { type: "string", enum: ["supra", "ibid", "none"] },
  excluded: { type: "boolean" },
  display_name: { type: "string", maxLength: 1_000 },
  profile_id: { type: "string", enum: authoritiesProfileIds },
  settings: objectSchema({
    source_mode: { type: "string", enum: ["automatic", "manual-originals", "render"] },
    tab_style: { type: "string", enum: ["numeric", "alpha"] },
    table_order: { type: "string", enum: ["first-reference", "alphabetical"] },
    table_delivery: { type: "string", enum: ["native-marks", "native-append", "linked-append"] },
    table_location: { type: "string", enum: ["pages", "pinpoints", "combined"] },
    passage_marking: { type: "string", enum: ["none", "margin", "paragraph", "text", "sidelined"] },
    scanned_pdf_policy: { type: "string", enum: ["page-margin", "cited-pages", "full"] },
    missing_source_policy: { type: "string", enum: ["placeholder", "omit"] },
    filing_medium: { type: "string", enum: ["electronic", "paper"] },
    book_role: { type: "string",
      enum: ["applicant", "respondent", "joint", "appellant", "intervener"] },
  }),
  output_mode: { type: "string", enum: ["table", "book", "both"] },
  enabled: { type: "boolean" },
  slot: { type: "string", enum: ["cover", "index"] },
}, ["type"]);
const workProductTool = (authoritiesEnabled: boolean): Tool & BeaverToolPolicy => ({
  name: "update_work_product",
  specialist: true,
  sequential: true,
  activity: (input) => WORK_PRODUCT_ACTIVITY[String(input.action)] ?? "Updating draft",
  description: "Create, choose, read, review, or update a Court Record or Authorities draft using " +
    "the workspace's fields and Library bindings. Read without draft_id to list drafts. Authorities " +
    "reads return a summary; supply unit_id or occurrence_id for bounded text and absolute UTF-16 " +
    "ranges. Update with one authorities_action, grounded evidence list, authority_id plus a " +
    "version-pinned PDF, or book_slot plus a version-pinned PDF.",
  annotations: { readOnlyHint: false },
  inputSchema: objectSchema({
    action: { type: "string", enum: ["create", "read", "review", "select", "update", "refresh", "build"] },
    kind: { type: "string", enum: ["court-record",
      ...(authoritiesEnabled ? ["authorities"] : [])] },
    draft_id: { type: "string", minLength: 1 },
    title: { type: "string", minLength: 1, maxLength: 300 },
    ...COURT_RECORD_TOOL_PROPERTIES,
    document_id: DOCUMENT_ID_PROPERTY,
    unit_id: { type: "string", minLength: 1 },
    occurrence_id: { type: "string", minLength: 1 },
    text_offset: { type: "integer", minimum: 0 },
    text_limit: { type: "integer", minimum: 1, maximum: 20_000 },
    authority_offset: { type: "integer", minimum: 0 },
    authority_limit: { type: "integer", minimum: 1, maximum: 50 },
    input_role: { type: "string", minLength: 1 },
    authority_id: { type: "string", minLength: 1,
      description: "Authority ID returned by reading an Authorities draft." },
    book_slot: { type: "string", enum: ["cover", "index"] },
    authorities_action: AUTHORITIES_ACTION,
    evidence_ids: { type: "array", minItems: 1, uniqueItems: true,
      items: { type: "string", minLength: 1 } },
  }, ["action", "kind"]),
});

function oneHopLegalScope(
  document: NativeDocument,
  block: NativeDocumentBlock,
  direction: "inbound" | "outbound" | "both",
  includeUnits = false,
) {
  const follow = direction === "inbound"
    ? "in"
    : direction === "outbound" ? "out" : "both";
  return structureNative().graphScope(
    document, block.label, follow, 1, true, includeUnits);
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
  const lintDocument = await documentProjectionService.read({
    documentId: params.documentId,
    versionId: version.id,
    fileType: "docx",
    sourceSha256: version.source_sha256,
    readBytes: () => params.bytes,
  }).catch(() => null);
  const lint = lintDocument ? structureNative().docxStructureLint(lintDocument) : null;
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
  lineNumber?: number;
  span?: [number, number];
  evidenceText?: string;
  handoffCandidate?: boolean;
  source?: {
    documentId: string;
    versionId: string;
    filename?: string;
    locator?: string;
    locatorKind?: "paragraph" | "page" | "section" | "footnote";
    sourceText?: string;
    sourceSha256?: string;
  };
};

const sourceLineStarts = (text: string) =>
  [0, ...Array.from(text.matchAll(/\n/gu), ({ index }) => index + 1)];

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
function legalEvidenceSource(passage: LegalSourcePassage): EvidenceSource {
  const source = passage.documentArtifact;
  if (passage.source.provider !== "a2aj") return { source };
  const native = objectRecord(passage.native);
  return typeof native?.citation === "string"
    ? { document: native as unknown as A2AJCompiledDocument }
    : { source };
}

function cleanSearchEvidenceSpan(
  passage: LegalSourcePassage,
  hit: { at: number; excerpt: string },
): LegalEvidenceSpan {
  const matchEnd = hit.at + hit.excerpt.length;
  const source = passage.documentArtifact;
  if (passage.role === "document" || !passage.blockArtifact) {
    const block = structureNative()
      .smallestContainingDocumentBlock(source, hit.at, matchEnd);
    if (block) return {
      text: block.text,
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

function sourceReference(
  provider: string,
  sourceId: string,
): LegalSourceReference | null {
  return researchSourceFromResource(resourceReference.source(provider, sourceId));
}

function sourceResourceReference(source: LegalSourceReference) {
  if (source.provider === "a2aj") return resourceReference.source("a2aj", JSON.stringify([
    source.id, source.kind === "legislation" ? "laws" : "cases", source.collection ?? "",
  ]));
  if (source.provider === "courtlistener" && source.part) return resourceReference.source(
    "courtlistener-opinion", JSON.stringify([Number(source.id), Number(source.part)]));
  return resourceReference.source(source.provider, source.id);
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
      if (native && ["tna", "govuk-et", "govinfo"].includes(
        passage.source.provider,
      )) {
        const document = native as RemoteLegalSourceDocument;
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
        queryReceipts: [{
          call_id: call.id,
          tool: "Read",
          executed_at: new Date().toISOString(),
          executor_version: "legal-source-pattern-v1",
          input: {
            resource: trimmed(args.file_path),
            pattern,
            ...(locator ? { locator_kind: locatorKind, locator } : {}),
            ...(endLocator ? { end_locator: endLocator } : {}),
            context_blocks: locator
              ? Math.min(2, Math.max(0, Math.trunc(Number(args.context_blocks) || 0)))
              : 0,
            max_results: maxResults,
            context_chars: contextChars,
          },
          results: evidence.map(({ evidence_id }, rank) => ({
            rank: rank + 1,
            evidence_id,
          })),
        }],
      };
    }

    let referenceNeighborhood: Record<string, unknown> | undefined;
    const relatedEvidence: LegalEvidenceReceipt[] = [];
    if (references !== "none") {
      const selected = registered.find(({ passage }) =>
        passage.role === "selected" && passage.blockArtifact);
      const artifact = selected?.passage.documentArtifact;
      const block = selected?.passage.blockArtifact;
      const metadata = selected && objectRecord(selected.passage.native);
      if (artifact && block && metadata && typeof metadata.citation === "string" &&
          typeof metadata.dataset === "string" &&
          (metadata.language === "en" || metadata.language === "fr")) {
        const scope = oneHopLegalScope(
          artifact,
          block,
          references as Exclude<A2AJReferenceDirection, "none">,
          true,
        );
        const candidates = scope?.nodes ?? [];
        const sections: Array<{ label: string; text: string; evidence_ids: string[] }> = [];
        const omitted: string[] = [];
        const sourceSha256 = structureNative().documentRevision(artifact);
        let chars = 0;
        for (const [index, related] of candidates.entries()) {
          if (sections.length === 50 || chars + related.text.length > 32_000) {
            omitted.push(...candidates.slice(index).map(({ label }) => label));
            break;
          }
          chars += related.text.length;
          const receipts = (related.units ?? [related]).filter((unit): unit is NativeDocumentBlock & {
            kind: "paragraph" | "page" | "section" | "footnote";
          } =>
            unit.kind === "paragraph" || unit.kind === "page" ||
            unit.kind === "section" || unit.kind === "footnote"
          ).map((unit) => createA2AJPassageEvidence({
            citation: metadata.citation as string,
            name: typeof metadata.name === "string" ? metadata.name : null,
            dataset: metadata.dataset as string,
            language: metadata.language as "en" | "fr",
            sourceSha256,
            spanText: unit.text,
            start: unit.start,
            end: unit.end,
            externalUrl: typeof metadata.url === "string" ? metadata.url : null,
            sourceClass: "legislation",
            blockId: `${unit.kind}:${unit.label}:${unit.start}:${unit.end}`,
            locator: { kind: unit.kind, label: unit.label },
          }));
          relatedEvidence.push(...receipts);
          receipts.forEach((receipt) => evidenceSources.set(receipt.evidence_id, {
            document: metadata as unknown as A2AJCompiledDocument,
          }));
          sections.push({ label: related.label, text: related.text,
            evidence_ids: receipts.map(({ evidence_id }) => evidence_id) });
        }
        referenceNeighborhood = {
          direction: references,
          depth: 1,
          returned: sections.length,
          truncated: omitted.length > 0,
          limit_reason: omitted.length
            ? sections.length === 50 ? "sections" : "characters"
            : null,
          omitted: [...new Set(omitted)],
          failures: scope ? [] : ["reference graph source unavailable"],
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
        text_sha256: sha256(passage.text),
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
  docIndex?: DocIndex,
  progress?: (label: string) => void,
  signal?: AbortSignal,
): Promise<BeaverOutcome> {
  servedDraftingCache ??= new Map();
  const direct = await readNonDocumentResource(call, args, workflows, scope.userId);
  if (direct) return direct;
  const indexed = new Map(Object.values(docIndex ?? {}).map((item) =>
    [item.document_id, item]));
  let listedFiles: AssistantDocument[] | undefined;
  const files = async () => {
    if (!listedFiles) {
      listedFiles = await scopedDocuments(scope, library, projects, 200, matterId);
      listedFiles.forEach(({ id, filename }) => documentNames.set(id, filename));
    }
    return listedFiles;
  };
  const codingPath = (document: AssistantDocument, versionId = document.current_version_id) =>
    resourceReference.document(document.id, versionId);
  const resolvePath = async (raw: string) => {
    const reference = parseResourceReference(raw.trim());
    if (reference?.kind !== "document") return null;
    const listed = listedFiles?.find(({ id }) => id === reference.documentId);
    if (listed) return listed;
    const record = await documents.metadata(scope, reference.documentId, !matterId);
    const exactIndex = indexed.get(reference.documentId)?.version_id === reference.versionId;
    if (!record || (!exactIndex && (matterId
      ? record.project_id !== matterId
      : record.project_id !== null || record.library_kind !== "file")) ||
      typeof record.filename !== "string" ||
      typeof record.current_version_id !== "string" ||
      typeof record.file_type !== "string") return null;
    const document: AssistantDocument = {
      ...record,
      id: record.id,
      filename: record.filename,
      current_version_id: record.current_version_id,
      file_type: record.file_type,
    };
    documentNames.set(document.id, document.filename);
    return document;
  };
  const referencedVersion = (raw: string) => {
    const reference = parseResourceReference(raw.trim());
    return reference?.kind === "document" ? reference.versionId : undefined;
  };
  const redlineText = async (documentId: string, versionId?: string) => {
    const file = await documents.read(scope, documentId, versionId ?? null, false);
    if (!file || file.fileType.toLowerCase() !== "docx") return null;
    return { versionId: file.version.id, text: (await projectDocxRedline(file.bytes)).text };
  };
  const codingText = async (
    documentId: string,
    versionId?: string,
    mode?: "text" | "drafting" | "redline",
  ) => {
    if (mode === "redline") return redlineText(documentId, versionId);
    const source = await documents.projectionSource(scope, documentId, versionId ?? null);
    if (!source) return null;
    const cacheKey = `${documentId}:${source.versionId}`;
    const cached = mode !== "text" && servedDraftingCache.get(cacheKey);
    if (cached) return {
      versionId: cached.versionId,
      text: structureNative().documentText(cached.document),
    };
    const text = await pdfLifecyclePhase("open.text", documentId, () =>
      documentProjectionService.text({ ...source, readBytes: () =>
        pdfLifecyclePhase("open.source_read", documentId, source.readBytes) }, {
        drafting: mode !== "text", signal,
      }));
    return { versionId: source.versionId, text };
  };
  const codingDocument = async (
    documentId: string,
    versionId?: string,
    mode?: "text" | "drafting" | "redline",
    materializeText = true,
  ) => {
    const raw = mode === "redline" ? await redlineText(documentId, versionId) : null;
    const source = raw
      ? null
      : await documents.projectionSource(scope, documentId, versionId ?? null);
    if (!raw && !source) return null;
    if (source && mode !== "redline" && mode !== "text" &&
        source.fileType.toLowerCase() === "docx") {
      const drafting = await servedDraftingDocument(source, servedDraftingCache);
      if (drafting) return materializeText
        ? { ...drafting, text: structureNative().documentText(drafting.document) }
        : drafting;
    }
    if (raw) {
      const document = await structureNative().deriveDocumentStructure({
        kind: "instrument",
        id: documentId,
        text: raw.text,
        reconstruct_lineation: true,
      });
      return materializeText ? { ...raw, document } : { versionId: raw.versionId, document };
    }
    const projected = await loadNativeDocument(
      documents, scope, documentId, versionId, source ?? undefined,
    );
    if (!projected || !materializeText) return projected;
    return {
      ...projected,
      text: structureNative().documentText(projected.document),
    };
  };
  if (call.name === "Glob") {
    const re = globRegExp(trimmed(args.pattern) || "*");
    const fileRows = docIndex ? Object.entries(docIndex).flatMap(([alias, document]) =>
      document.version_id && (re.test(alias) || re.test(document.filename))
        ? [`${resourceReference.document(document.document_id, document.version_id)}` +
          `\talias=${alias}\tfilename=${document.filename}`] : []) : (await files())
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
      const meta = await resolvePath(requested);
      if (!meta) {
        return fail(`Document resource does not exist: ${requested}`);
      }
      const versionId = referencedVersion(requested);
      const source = await documents.projectionSource(scope, meta.id, versionId ?? null);
      if (!source) return fail("PDF resource/version not found.");
      if (source.fileType.toLowerCase() !== "pdf") {
        return fail("Exact structural Read requires a PDF resource.");
      }
      let physicalPageCount = source.versionId === meta.current_version_id &&
        Number.isSafeInteger(meta.page_count)
        ? Number(meta.page_count)
        : null;
      if (locatorKind === "page" && !trimmed(args.end_locator) && /^[1-9]\d*$/u.test(locator)) {
        if (physicalPageCount === null) {
          try {
            const document = await documentProjectionService.read(source, { signal });
            physicalPageCount = structureNative()
              .pdfDocumentSummary(document).projectionPageCount;
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
        let lookup: PdfLookupResult;
        if (handle) {
          lookup = await documentProjectionService.rehydratePdfEvidence(
            handle,
            {
              documentId: meta.id,
              versionId: source.versionId,
              sourceSha256: source.sourceSha256,
            },
          );
        } else {
          const locatorInput = pdfLocatorParams(args);
          const exactPage = locatorKind === "page" &&
            !trimmed(args.end_locator) && /^[1-9]\d*$/u.test(locator)
            ? Number(locator)
            : null;
          let selectedPages: number[] | undefined;
          if (exactPage) {
            const contextBlocks = Math.max(0, Math.min(2,
              Math.trunc(Number(args.context_blocks) || 0)));
            selectedPages = Array.from(
              {
                length: Math.min(physicalPageCount ?? exactPage + contextBlocks,
                  exactPage + contextBlocks) - Math.max(1, exactPage - contextBlocks) + 1,
              },
              (_, index) => Math.max(1, exactPage - contextBlocks) + index,
            );
          }
          lookup = await documentProjectionService.lookupPdf(source.readBytes, locatorInput, {
            documentId: meta.id,
            versionId: source.versionId,
            sourceSha256: source.sourceSha256,
            pdfProfile: source.pdfProfile,
            pages: selectedPages,
            signal,
            progress: () => progress?.(
              `Reading ${exactPage ? `page ${exactPage} of ` : ""}${meta.filename}`,
            ),
          });
        }
        const evidence = pdfLegalEvidence(
          meta.id,
          source.versionId,
          meta.filename,
          lookup,
        );
        return {
          ...result({
            ...compactPdfLookup(meta.filename, lookup),
            passages: evidence.map(modelEvidencePassage),
            evidence_ids: evidence.map(({ evidence_id }) => evidence_id),
            resource: codingPath(meta, source.versionId),
          }),
          evidence,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message === "PDF evidence source mismatch")
          return fail("PDF evidence does not belong to this resource.");
        return fail(SAFE_PDF_EVIDENCE_ERRORS.has(message)
          ? message : "PDF evidence is unavailable");
      }
    }
    const meta = await resolvePath(requested);
    if (!meta) {
      return fail(`Document resource does not exist: ${requested}`);
    }
    const mode = args.mode as "text" | "drafting" | "redline" | undefined;
    const sectionArg = trimmed(args.section);
    const references = (args.references ?? "none") as
      "none" | "inbound" | "outbound" | "both";
    if (references !== "none" && !sectionArg) {
      return fail("references requires an exact section handle.");
    }
    let document: Awaited<ReturnType<typeof codingDocument>>;
    try {
      document = await codingDocument(
        meta.id,
        referencedVersion(requested),
        mode,
        false,
      );
    } catch {
      return fail(
        `Could not read ${meta.filename}. The document reader failed; retrying will not help.`,
      );
    }
    if (!document) return fail(`File could not be read: ${requested}`);
    const nativeDocument = document.document;
    const limit = (args.limit as number | undefined) ?? 2_000;
    const startChar = (args.start_char as number | undefined) ?? 0;
    const sourceSha256 = structureNative().documentRevision(nativeDocument);
    const source = (
      locator?: string,
      locatorKind?: NonNullable<CodingOutputLine["source"]>["locatorKind"],
    ) => ({
      documentId: meta.id,
      versionId: document.versionId,
      filename: meta.filename,
      sourceSha256,
      ...(locator && locatorKind ? { locator, locatorKind } : {}),
    });
    const windowLines = (
      rows: ReturnType<ReturnType<typeof structureNative>["readDocumentTextWindow"]>["rows"],
      rowSource: CodingOutputLine["source"],
    ): CodingOutputLine[] => rows.map((row) => ({
      rendered: `${String(row.lineNumber).padStart(6, " ")}\t` +
        `${row.truncatedStart ? "…" : ""}${row.text}${row.truncatedEnd ? "…" : ""}`,
      lineNumber: row.lineNumber,
      evidenceText: row.text,
      span: row.span,
      source: rowSource,
    }));
    if (!sectionArg) {
      const offset = (args.offset as number | undefined) ?? 1;
      const window = structureNative().readDocumentTextWindow(
        nativeDocument,
        offset,
        startChar,
        limit,
      );
      if (window.status === "invalid_line") return fail(
        offset > (window.totalLines ?? 0)
          ? `(offset ${offset} is past the end of the file; total lines: ${window.totalLines})`
          : "(empty file)",
      );
      if (window.status === "invalid_character") return fail(
        `(start_char ${startChar} is past the end of line ${offset}; ` +
          `line chars: ${window.lineLength ?? 0})`,
      );
      if (window.status === "split_character") return fail(
        `(start_char ${startChar} splits a Unicode character on line ${offset})`,
      );
      const lines = windowLines(window.rows, source());
      const continuation = window.nextOffset === null
        ? ""
        : `\n\n[TRUNCATED: continue with Read(file_path=${JSON.stringify(requested)}, ` +
          `offset=${window.nextOffset}, limit=${limit}, ` +
          `start_char=${window.nextStartChar ?? 0}).]`;
      return codingTextResult(
        call,
        lines.map(({ rendered }) => rendered).join("\n") + continuation,
        lines,
      );
    }
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
    if (sectionArg) {
      const lookup = structureNative().lookupStructureBlock(
        nativeDocument, sectionArg, 0);
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
        const scope = oneHopLegalScope(
          nativeDocument,
          block,
          references,
        );
        if (!scope) {
          return fail(`Section '${sectionArg}' could not seed a reference scope.`);
        }
        const covered: TextRange[] = [];
        const candidates: CodingOutputLine[] = [];
        for (const [index, node] of [scope.seed, ...scope.nodes].entries()) {
          const open = uncoveredRanges(
            { start: node.start, end: node.end },
            covered,
          );
          for (const range of open) {
            const window = structureNative().readDocumentTextRange(
              nativeDocument, range.start, range.end, undefined, 0xffff_ffff);
            if (window.status !== "ready") {
              return fail(`Section '${node.label}' has an invalid text range.`);
            }
            candidates.push({
              rendered: `=== ${meta.filename} :: Read section="${node.label}" :: ${
                index === 0 ? "target" : "direct reference"
              } ===`,
            }, ...windowLines(window.rows, source(node.label, "section")));
          }
          addCoveredRange(covered, { start: node.start, end: node.end });
        }
        return finish(
          candidates,
          (_kept, truncated) => truncated
            ? "\n(Reference read stopped at the tool-result limit; narrow the direction or read a returned section recipe.)"
            : "",
        );
      }
      const offset = args.offset as number | undefined;
      const window = structureNative().readDocumentTextRange(
        nativeDocument, block.start, block.end, offset, limit);
      const startLine = window.rangeStartLine ?? 0;
      const endLine = window.rangeEndLine ?? 0;
      if (window.status === "invalid_line") {
        return fail(
          `(offset ${offset} is outside section ${block.label}; ` +
            `the section spans lines ${startLine}-${endLine})`,
        );
      }
      if (window.status !== "ready") {
        return fail(`Section '${block.label}' has an invalid text range.`);
      }
      const candidates = windowLines(window.rows, source(block.label, "section"));
      return finish(
        candidates,
        (kept, truncated) => {
          const firstShown = candidates[0]?.lineNumber ?? startLine;
          const lastShown = kept.at(-1)?.lineNumber ?? firstShown;
          const nextOffset = truncated ? lastShown + 1 : window.nextOffset;
          return nextOffset !== null
            ? `\n\n[TRUNCATED: returned section lines ${firstShown}-${lastShown} of ${startLine}-${endLine}; continue with Read(file_path="${requested}", section="${block.label}", offset=${nextOffset}).${truncated ? " Tool-result limit reached." : ""}]`
            : "";
        },
      );
    }
  }

  if (call.name === "Edit" || call.name === "edit_docx_advanced") {
    const requested = trimmed(args.file_path);
    const meta = await resolvePath(requested);
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
        nearest_match: structureNative().quoteRepairSuggestion(
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
  let targets: AssistantDocument[];
  let targetVersionId: string | undefined;
  if (pathArg) {
    const match = await resolvePath(pathArg);
    if (!match)
      return fail(`Document resource does not exist: ${pathArg}`);
    targets = [match];
    targetVersionId = referencedVersion(pathArg);
  } else {
    targets = await files();
  }
  if (!pathArg && trimmed(args.glob)) {
    const globRe = globRegExp(trimmed(args.glob));
    targets = targets.filter(({ filename }) => globRe.test(filename));
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
    let document;
    let nativeDocument: NativeDocument | undefined;
    if (grepSection) {
      const structured = await codingDocument(
        meta.id, targetVersionId, undefined, false,
      );
      document = structured && {
        versionId: structured.versionId,
        text: structureNative().documentText(structured.document),
      };
      nativeDocument = structured?.document;
    } else {
      document = await codingText(meta.id, targetVersionId);
    }
    if (!document) continue;
    const resource = codingPath(meta, document.versionId);
    const lines = document.text.split(/\r?\n/u);
    const starts = sourceLineStarts(document.text);
    let scopeSpan: TextRange | null = null;
    if (grepSection) {
      if (!nativeDocument) continue;
      const lookup = structureNative().lookupStructureBlock(
        nativeDocument, grepSection, 0);
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

async function loadNativeDocument(
  documents: DocumentStore,
  scope: DocumentScope,
  documentId: string,
  versionId?: string,
  projectionSource?: DocumentProjectionSource,
) {
  const source = projectionSource ??
    await documents.projectionSource(scope, documentId, versionId ?? null);
  if (!source) return null;
  const document = await pdfLifecyclePhase("open.projection", documentId, () =>
    documentProjectionService.read({ ...source, readBytes: () =>
      pdfLifecyclePhase("open.source_read", documentId, source.readBytes) }));
  return { versionId: source.versionId, document };
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
const compactEvidence = (receipt: LegalEvidenceReceipt) => ({
  ...modelEvidencePassage(receipt),
  exact_passage: receipt.span_text && receipt.span_text.length > 2_000
    ? `${receipt.span_text.slice(0, 2_000)}…` : receipt.span_text,
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
    const { sourceText, sourceSha256, ...source } = line.source;
    const [start, end] = line.span;
    const spanText = line.evidenceText ?? sourceText?.slice(start, end);
    if (call.name === "Read" && spanText && (sourceText || sourceSha256)) {
      const receipt = createLibraryEvidence({
        documentId: source.documentId,
        versionId: source.versionId,
        filename: source.filename ?? source.documentId,
        sourceText,
        sourceSha256,
        spanText,
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
  const pageNumbers = resolved.lookup.link.page_numbers;
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
    !resolved.state.source_reference ||
    !resolved.state.source_sha256
  ) return [];
  const provider = resolved.state.provider;
  const jurisdiction = provider === "govinfo" ? "US" : "UK";
  const sourceClass = provider === "govinfo" ? "legislation" : "case";
  const title = resolved.params.title || resolved.params.filename || resolved.params.identity;
  const seen = new Set<string>();
  return [...resolved.lookup.before, ...resolved.lookup.units, ...resolved.lookup.after]
    .flatMap((unit) => {
      const key = `${unit.kind}:${unit.id}`;
      if (seen.has(key)) return [];
      seen.add(key);
      const parts = [unit.text, unit.proposition?.sentence ?? "",
        unit.proposition?.passage_since_prior_note ?? ""];
      const normalized = new Set<string>();
      const spanText = parts.map((text) => text.trim()).filter((text) => {
        const identity = text.replace(/\s+/gu, " ").toLowerCase();
        if (!identity || normalized.has(identity)) return false;
        normalized.add(identity);
        return true;
      }).join("\n\n");
      if (!spanText) return [];
      const page = [...new Set(unit.page_numbers)].sort((a, b) => a - b)[0];
      const url = new URL(resolved.params.url);
      if (page) url.hash = `page=${page}`;
      const createEvidence = provider === "tna"
        ? createTnaEvidence
        : provider === "govuk-et"
          ? createGovUkEmploymentTribunalEvidence
          : createGovInfoEvidence;
      return [createEvidence({
        jurisdiction,
        sourceClass,
        stableSourceId: `${resolved.state.source_reference}:${key}`,
        sourceSha256: resolved.state.source_sha256 ?? undefined,
        spanText,
        citation: title,
        name: title,
        dataset: provider,
        version: resolved.params.version ?? undefined,
        externalUrl: url.toString(),
        locatorKind: page ? "page" : "section",
        locatorLabel: page ? `page=${page}` : unit.locator,
      })];
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
      const document = await documentProjectionService.read({
        documentId: params.documentId,
        versionId: file.version.id,
        fileType: file.fileType,
        sourceSha256: file.version.source_sha256,
        pdfProfile: file.pdfProfile,
        readBytes: () => file.bytes,
      });
      if (!structureNative().documentTextBytes(document)) {
        return fail("DOCX body text could not be extracted, so an `at` scope cannot be resolved.");
      }
      resolvedRequests = requests.map((request, index) => {
        const scope = request.scope as unknown as {
          kind: string;
          at: string;
          follow?: "none" | "out" | "in" | "both";
          depth?: number;
        };
        if (scope.kind !== "at") return request;
        const resolved = structureNative().resolveDocumentAddressSpans(
          document,
          scope.at ?? "",
          scope.follow ?? "none",
          scope.depth ?? 1,
        );
        if (resolved.status === "invalid") throw new Error(
          `ops[${index}].scope.at is not a provision or page address`);
        if (resolved.status === "not_addressable") throw new Error(
          `ops[${index}].scope.at is not an addressable block`);
        if (resolved.status !== "found") {
          throw new Error(
            `ops[${index}].scope.at did not resolve (${resolved.status})`);
        }
        return { ...request, scope: { kind: "spans" as const, spans: resolved.spans } };
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
  const document = await documentProjectionService.read({
    documentId,
    versionId: file.version.id,
    fileType: file.fileType,
    sourceSha256: file.version.source_sha256,
    pdfProfile: file.pdfProfile,
    readBytes: () => file.bytes,
  });
  return {
    ok: true,
    document_id: documentId,
    version_id: file.version.id,
    filename: file.filename,
    ...structureNative().docxStructureLint(document),
  };
}

type ServedDrafting = {
  versionId: string;
  document: NativeDocument;
} | null;

async function servedDraftingDocument(
  source: DocumentProjectionSource,
  cache?: Map<string, ServedDrafting>,
): Promise<ServedDrafting> {
  const cacheKey = `${source.documentId}:${source.versionId}`;
  if (cache?.has(cacheKey)) return cache.get(cacheKey)!;
  const document = await structureNative()
    .deriveDocxDocument(await source.readBytes(), source.documentId, true)
    .catch(() => null);
  const result = document ? { versionId: source.versionId, document } : null;
  cache?.set(cacheKey, result);
  return result;
}

type AssistantToolsDependencies = {
  userId: string;
  userEmail?: string;
  documents: DocumentStore;
  library: LibraryStore;
  projects: ProjectStore;
  workProducts: Pick<WorkProductApplication, "create" | "get" | "list" | "resolve">;
  model?: string;
  authorities: Pick<AuthoritiesWorkspaceApplication,
    "importDraft" | "act" | "refresh" | "refreshInput" | "prepareSources" |
      "discrepancies" | "build" |
      "addReceipts" | "attachLibraryPdf">;
  authoritiesId?: string;
  authoritiesRevision?: number;
  courtRecords?: Pick<CourtRecordsApplication, "bindOutput" | "updateDraft">;
  courtRecord?: { id: string; revision: number };
  productFeatures?: FeaturePreferences;
  draftingStyle?: DraftingStyleSettings;
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
  docIndex?: DocIndex;
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
    workProducts,
    model = "assistant",
    authorities,
    authoritiesId,
    authoritiesRevision,
    courtRecords,
    courtRecord,
    productFeatures,
    draftingStyle = DEFAULT_DRAFTING_STYLE,
    workflows,
    scope: turnScope,
    readerAssignment,
    tabular,
    documentNames,
    docIndex,
    resolveArtifact,
    artifactFor,
    onMutationCommitted,
  }: AssistantToolsDependencies,
): BeaverTool<Context>[] {
  const scope: DocumentScope = { userId, userEmail };
  const workProductProjectId = matterId ?? null;
  const availableWorkflows = workflows ?? new Map(
    SYSTEM_ASSISTANT_WORKFLOWS.map(({ id, variant_id, title, skill_md }) => [
      variant_id,
      { workflow_id: id, title, skill_md },
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
    knownDocumentNames.set(document.id, document.filename);
    turnEditState?.set(document.id, { versionId: document.current_version_id,
      parentVersionId: document.current_version_id });
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
    const reference = call.name === "Read"
      ? parseResourceReference(trimmed(args.file_path)) : null;
    if (reference?.kind === "document" &&
        knownDocumentNames.get(reference.documentId)?.toLowerCase().endsWith(".research.md")) {
      const saved = await readResearchFile(documents, scope, reference.documentId);
      if (saved?.versionId === reference.versionId) {
        const notes = saved.state.note.match(/[\s\S]{1,8000}/gu) ?? [],
          labels = Object.values(saved.state.labels).sort((a, b) => a.order - b.order),
          sources = Object.values(saved.state.sources),
          searches = Object.values(saved.state.queries), passages = Object.values(saved.state.evidence),
          chunks = <T,>(values: T[]) => Array.from({ length: Math.ceil(values.length / 100) },
            (_, index) => values.slice(index * 100, index * 100 + 100)),
          strings = (value: unknown) => Array.isArray(value)
            ? value.filter((id): id is string => typeof id === "string") : [],
          queryTail = (queryId: string, field: string, values: unknown[]) =>
            chunks(values.slice(100)).map((items, index) => ({ kind: "search_continuation",
              query_id: queryId, field, offset: 101 + index * 100, items })),
          continuations: Record<string, unknown>[] = [
            ...sources.flatMap((source) => (source.note.slice(300).match(/[\s\S]{1,8000}/gu) ?? [])
              .map((markdown, index) => ({ kind: "source_note_continuation", sourceId: source.id,
                offset: 301 + index * 8000, markdown }))),
            ...searches.flatMap(({ query_id, input, sourceIds, evidenceIds, failures }) => [
              ...queryTail(query_id, "scope.source_ids", strings(input.source_ids)),
              ...queryTail(query_id, "scope.label_ids", strings(input.label_ids)),
              ...queryTail(query_id, "attempted_source_ids", sourceIds),
              ...queryTail(query_id, "evidence_ids", evidenceIds),
              ...queryTail(query_id, "failures", failures),
            ]),
            ...passages.flatMap(({ receipt, note }) =>
              (note.slice(300).match(/[\s\S]{1,8000}/gu) ?? []).map((markdown, index) =>
                ({ kind: "passage_note_continuation", evidence_id: receipt.evidence_id,
                  offset: 301 + index * 8000, markdown }))),
          ],
          total = notes.length + labels.length + sources.length + searches.length +
            passages.length + continuations.length,
          offset = Math.max(0, Math.trunc(Number(args.offset) || 1) - 1),
          limit = Math.max(1, Math.min(20, Math.trunc(Number(args.limit) || 20))),
          page: Record<string, unknown>[] = [];
        let skip = offset;
        const take = <T,>(values: T[], format: (value: T) => Record<string, unknown>) => {
          if (page.length === limit) return;
          if (skip >= values.length) { skip -= values.length; return; }
          const slice = values.slice(skip, skip + limit - page.length); skip = 0;
          page.push(...slice.map(format));
        };
        take(notes, (markdown) => ({ kind: "note", markdown }));
        take(labels, (label) => ({ kind: "label", ...label }));
        take(sources, (source) => ({ kind: "source", sourceId: source.id,
          resource: sourceResourceReference(source.reference),
          reference: Object.fromEntries(["provider", "id", "kind", "title", "citation", "collection"]
            .flatMap((key) => { const value = source.reference[key as keyof typeof source.reference];
              return value == null ? [] : [[key, String(value).slice(0, 300)]]; })),
          labelIds: source.labelIds.slice(0, 20),
          ...(source.badge ? { badge: source.badge } : {}),
          ...(source.note ? { note: source.note.slice(0, 300) } : {}) }));
        take(searches, ({ query_id, executed_at, tool, input, sourceIds, evidenceIds, failures,
          results, slots }) => { const list = (value: unknown) => Array.isArray(value)
            ? value.filter((id): id is string => typeof id === "string").slice(0, 100)
              .map((id) => id.slice(0, 200)) : [];
          const rules = Array.isArray(input.rules) ? input.rules.slice(0, 50).flatMap((value) => {
            const rule = objectRecord(value); return rule ? [{ phrase: String(rule.phrase ?? "").slice(0, 500),
              direction: String(rule.direction ?? "").slice(0, 20),
              unit: String(rule.unit ?? "").slice(0, 20), chars: Number(rule.chars) || null,
              slot: String(rule.slot ?? "").slice(0, 200) }] : []; }) : undefined;
          return { kind: "search", query_id: query_id.slice(0, 200),
            executed_at: executed_at.slice(0, 50), tool: tool.slice(0, 100),
            text: String(input.pattern ?? input.query ?? "").slice(0, 500),
            syntax: String(input.syntax ?? "").slice(0, 50),
            target: String(input.target ?? "").slice(0, 50),
            ...(rules ? { rules } : {}), conflict: String(input.conflict ?? ""),
            scope: { source_ids: list(input.source_ids), label_ids: list(input.label_ids),
              limit: Number(input.limit) || null }, attempted_source_ids: sourceIds.slice(0, 100),
            evidence_ids: evidenceIds.slice(0, 100),
            slots: Object.fromEntries(evidenceIds.slice(0, 100).flatMap((id) =>
              slots[id] ? [[id, slots[id].slice(0, 20)]] : [])),
            failures: failures.slice(0, 100), sources: sourceIds.length || results.length,
            matches: evidenceIds.length || results.length,
            truncated: sourceIds.length > 100 || evidenceIds.length > 100 || failures.length > 100 }; });
        take(passages, ({ receipt, sourceId, labelIds, note }) =>
          ({ kind: "passage", sourceId, evidence_id: receipt.evidence_id.slice(0, 200),
            citation: receipt.citation.slice(0, 500), locator: {
              kind: receipt.locator.kind.slice(0, 50), label: receipt.locator.label.slice(0, 500) },
            exact_passage: receipt.span_text?.slice(0, 1_000) ?? null,
            labelIds: labelIds.slice(0, 20), ...(note ? { note: note.slice(0, 300) } : {}) }));
        take(continuations, (value) => value);
        while (page.length > 1 && JSON.stringify(page).length > 45_000) page.pop();
        const selected = page.flatMap((item) => item.kind === "passage"
          ? [saved.state.evidence[String(item.evidence_id)]?.receipt].filter(
              (value): value is LegalEvidenceReceipt => !!value) : []);
        const restored = await restorePriorLegalEvidence(selected, signal, true),
          verified = new Set(restored.map(({ receipt }) => receipt.evidence_id)),
          safePage = page.map((item) => { if (item.kind !== "passage" ||
            verified.has(String(item.evidence_id))) return item;
          const { exact_passage: _passage, ...summary } = item;
          return { ...summary, kind: "unavailable_passage" }; }),
          evidence = restored.map(({ receipt }) => receipt), evidenceSources = new Map(restored.map(
            ({ receipt, ...source }) => [receipt.evidence_id, source]));
        safePage.forEach((item) => { if (item.kind === "search") {
          const query = saved.state.queries[String(item.query_id)];
          if (query) legalEvidenceState?.queries.set(query.query_id, query);
        } });
        const categories = { notes: { count: notes.length, start: 1 },
          labels: { count: labels.length, start: notes.length + 1 },
          sources: { count: sources.length, start: notes.length + labels.length + 1 },
          searches: { count: searches.length, start: notes.length + labels.length + sources.length + 1 },
          passages: { count: passages.length,
            start: notes.length + labels.length + sources.length + searches.length + 1 },
          continuations: { count: continuations.length,
            start: notes.length + labels.length + sources.length + searches.length +
              passages.length + 1 } };
        return { ...result({ document_id: saved.document.id, filename: saved.document.filename,
          resource: resourceReference.document(saved.document.id, saved.versionId),
          offset: offset + 1, total, categories,
          next_offset: offset + page.length < total ? offset + page.length + 1 : null,
          items: safePage }),
          evidence, evidenceSources };
      }
    }
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
      docIndex,
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
        draftingStyle,
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
      const authorityLedger = await createDocxAuthorityLedger(
        legalEvidenceState, markdown, rendered.bytes, evidence,
        drafting.citationPlacement,
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
            ...(authorityLedger ? { authorityLedger } : {}),
          },
        },
      );
    } catch (error) {
      return fail(
        error instanceof Error ? error.message : "DOCX creation failed",
      );
    }
  };

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
      const workflowEvent = action === "fix_supras" ? supraFixEvent : null;
      const respond = (output: Record<string, unknown>) => withEvent(
        documentResult(output), workflowEvent?.(output, call.id),
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

  const evidenceSeeds = (input: Record<string, unknown>) => {
    const ids = Array.isArray(input.evidence_ids)
      ? input.evidence_ids.map(trimmed)
      : [];
    if (!ids.length || ids.some((id) => !id)) {
      throw new Error("At least one evidence ID is required");
    }
    const grouped = new Map<string, LegalEvidenceReceipt[]>();
    for (const id of ids) {
      const receipt = legalEvidenceState?.evidence.get(id)?.receipt;
      if (!receipt) throw new Error(`Unknown evidence ID: ${id}`);
      const key = structureNative().citationLookupKey(receipt.citation);
      if (!key) throw new Error(`Evidence does not identify an authority: ${id}`);
      const receipts = grouped.get(key);
      if (receipts) receipts.push(receipt); else grouped.set(key, [receipt]);
    }
    return [...grouped].map(([authorityKey, receipts]) => ({ authorityKey, receipts }));
  };

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

  const sourceSearch: AssistantToolRun = async (call, input, signal) => {
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
    const searched = await searchSources(readerAssignment
      ? { ...input, jurisdiction: readerAssignment.jurisdiction }
      : input, signal);
    const resources = Array.isArray(searched.results)
      ? searched.results.flatMap((value) => {
          const resource = objectRecord(value)?.resource;
          return typeof resource === "string" && resource.startsWith("source://")
            ? [resource] : [];
        }).map((resource, rank) => ({ rank: rank + 1, resource }))
      : [];
    return {
      ...result(searched),
      activityCitations: createLegalSourceSearchCitations(searched.results),
      queryReceipts: [{
        call_id: call.id,
        tool: "search_sources",
        executed_at: new Date().toISOString(),
        executor_version: "legal-source-search-v1",
        input: {
          query: searched.query,
          source_types: sourceTypes,
          syntax: input.syntax === "boolean" ? "boolean" : "terms",
          search_type: searched.search_type,
          jurisdiction: readerAssignment?.jurisdiction ?? (trimmed(input.jurisdiction) || null),
          collection: collection || null,
          court: trimmed(input.court) || null,
          speaker: trimmed(input.speaker) || null,
          date_from: trimmed(input.date_from) || null,
          date_to: trimmed(input.date_to) || null,
          sort: trimmed(input.sort) || "relevance",
          limit: Math.max(1, Math.min(20, Math.trunc(Number(input.limit) || 10))),
        },
        results: resources,
      }],
    };
  };
  const updateResearch = documentTool(async (call, input, documentId, signal) => {
    const command = objectRecord(input.research_action);
    if (!command) return fail("research requires research_action");
    const edit = turnEditState?.get(documentId), versionId = edit?.versionId ?? trimmed(input.version_id);
    if (command.type === "memo") {
      const title = trimmed(command.title), markdown = typeof command.markdown === "string"
        ? command.markdown.trim() : "", research = await readResearchFile(documents, scope, documentId);
      if (!title || title.length > 200 || !markdown || markdown.length > 1_000_000)
        return fail("memo requires a title and Markdown content");
      if (!research || research.versionId !== versionId) return fail("Version conflict");
      const filename = safeGeneratedFilename(title, "md"), linked =
        resourceReference.document(research.document.id, research.versionId);
      const document = await documents.create(scope, { filename, fileType: "md",
        bytes: Buffer.from(`# ${title.replace(/[\r\n#]/gu, " ")}\n\n` +
          `[Research file](${linked})\n\n${markdown}\n`),
        projectId: typeof research.document.project_id === "string"
          ? research.document.project_id : null,
        folderId: typeof research.document.folder_id === "string"
          ? research.document.folder_id : typeof research.document.library_folder_id === "string"
            ? research.document.library_folder_id : null,
        libraryKind: research.document.library_kind === "template" ? "template" : "file",
        provenance: { schemaVersion: 1, actor: "assistant", action: "created" } });
      allowedDocumentIds?.add(document.id);
      turnEditState?.set(document.id, { versionId: document.current_version_id,
        parentVersionId: document.current_version_id });
      return documentResult({ ok: true, action: "created", document_id: document.id,
        version_id: document.current_version_id, version_number: document.active_version_number,
        filename: document.filename, file_type: document.file_type,
        resource: resourceReference.document(document.id, document.current_version_id),
        download_url: `/api/single-documents/${encodeURIComponent(document.id)}/file?version_id=${encodeURIComponent(document.current_version_id)}`,
        research: linked });
    }
    let next, queryId: string | undefined, performed: ResearchFileAction | undefined,
      matched: LegalEvidenceReceipt[] = [], queryReceipt: ResearchQueryReceipt | undefined,
      checkpointed = false;
    let savedEvidenceIds: string[] = [];
    if (command.type === "query") {
      const rules = command.rules === undefined ? undefined
        : researchCaptureRuleSchema.array().max(50).parse(command.rules);
      const queried = await runResearchFileQuery(documents, scope, documentId,
        { versionId, text: trimmed(command.text),
        syntax: command.syntax === "literal" ? "literal" : "terms",
        target: command.target === "passages" ? "passages" : "sources",
        limit: Math.max(1, Math.min(5_000, Math.trunc(Number(command.limit) || 500))),
        sourceIds: Array.isArray(command.sourceIds)
          ? command.sourceIds.filter((id): id is string => typeof id === "string").slice(0, 1_000)
          : undefined,
        labelIds: Array.isArray(command.labelIds)
          ? command.labelIds.filter((id): id is string => typeof id === "string").slice(0, 1_000) : [],
        rules, conflict: command.conflict === "prompt" || command.conflict === "longer" ||
          command.conflict === "shorter" || command.conflict === "append" ? command.conflict : "first" },
        { signal, actor: { model, callId: call.id }, assistant: {
          turnVersionId: edit?.versionId, parentVersionId: edit?.parentVersionId } });
      next = queried.file; queryId = queried.queryId; matched = queried.evidence;
      queryReceipt = queried.receipt; checkpointed = queried.checkpointed;
    } else {
      let action: ResearchFileAction;
      if (command.type === "save") {
        if (!legalEvidenceState) throw new Error("No verified legal evidence is available");
        const queryIds = Array.isArray(input.query_ids)
          ? input.query_ids.filter((id): id is string => typeof id === "string") : [];
        const queries = queryIds.map((id) => legalEvidenceState.queries.get(id));
        const evidenceIds = new Set([...(Array.isArray(input.evidence_ids)
          ? input.evidence_ids.filter((id): id is string => typeof id === "string") : []),
          ...queries.flatMap((query) => query?.results.flatMap((item) =>
            "evidence_id" in item ? [item.evidence_id] : []) ?? [])]);
        savedEvidenceIds = [...evidenceIds];
        const evidence = [...evidenceIds].map((id) => legalEvidenceState.evidence.get(id)?.receipt);
        if (evidence.some((item) => !item) || queries.some((item) => !item))
          throw new Error("Unknown evidence or query ID");
        if (!evidence.length && !queries.length) throw new Error("Select evidence_ids or query_ids");
        action = { type: "merge" as const,
          evidence: evidence.filter((item): item is LegalEvidenceReceipt => !!item),
          queries: queries.filter(Boolean).map((receipt) => researchQueryReceipt(receipt!)) };
      } else {
        action = researchFileActionSchema.parse(command);
        if (action.type === "passage") throw new Error("Save verified evidence_ids instead");
        if (action.type === "label" && !action.id) action = { ...action, id: randomUUID() };
        if (action.type === "source") {
          const wanted = action;
          const verified = researchQuerySources(
            [...(legalEvidenceState?.queries.values() ?? [])],
          ).find((source) => source.provider === wanted.reference.provider &&
              source.id === wanted.reference.id && (source.part ?? null) ===
              (wanted.reference.part ?? null));
          if (!verified) throw new Error("Source must be a current verified search result");
          action = { ...wanted, reference: verified };
        }
      }
      performed = action;
      next = await saveResearchFile(documents, scope, documentId, versionId, action,
        { turnVersionId: edit?.versionId, parentVersionId: edit?.parentVersionId });
      if (!next) return fail("Version conflict");
      checkpointed = true;
    }
    const preview = matched.slice(0, 25);
    if (checkpointed) turnEditState?.set(documentId, { versionId: next.versionId,
      parentVersionId: edit?.parentVersionId ?? versionId });
    const sourceId = performed?.type === "source" ? Object.values(next.state.sources).find(({ reference }) =>
        reference.provider === performed.reference.provider && reference.id === performed.reference.id &&
        (reference.part ?? null) === (performed.reference.part ?? null))?.id : undefined;
    const saved = savedEvidenceIds.length ? { evidence_ids: savedEvidenceIds,
      source_ids: [...new Set(savedEvidenceIds.flatMap((id) =>
        next.state.evidence[id]?.sourceId ? [next.state.evidence[id].sourceId] : []))] } : undefined;
    const content = { ok: true, document_id: next.document.id,
      version_id: next.versionId, filename: next.document.filename,
      resource: resourceReference.document(next.document.id, next.versionId),
      ...(performed?.type === "label" ? { label_id: performed.id } : {}),
      ...(sourceId ? { source_id: sourceId } : {}), ...(saved ? { saved } : {}),
      ...(queryId ? { query_id: queryId, match_count: matched.length,
        matches: preview.map(compactEvidence), matches_truncated: matched.length > preview.length } : {}),
      counts: { labels: Object.keys(next.state.labels).length,
        sources: Object.keys(next.state.sources).length,
        passages: Object.keys(next.state.evidence).length,
        searches: Object.keys(next.state.queries).length } };
    return { ...(checkpointed ? mutationResult(content) : result(content)), evidence: preview,
      ...(queryReceipt ? { queryReceipts: [queryReceipt] } : {}) };
  });
  const documentOperation: AssistantToolRun = async (call, input, signal) => {
    switch (input.action) {
      case "metadata":
        if (input.kind !== "file" && input.kind !== "template")
          return Promise.resolve(fail("metadata requires kind"));
        return updateMetadata(call, input, signal);
      case "fix_supras":
        return runWorkflow(call, input, signal);
      case "research":
        if (objectRecord(input.research_action)?.type === "create") {
          const title = trimmed(objectRecord(input.research_action)?.title);
          if (!title || title.length > 200) return Promise.resolve(fail("create requires a title"));
          const filename = safeGeneratedFilename(title, "research.md");
          const existingId = [...knownDocumentNames].find(([, name]) =>
            name.toLowerCase() === filename.toLowerCase())?.[0];
          if (existingId) {
            const saved = await readResearchFile(documents, scope, existingId);
            if (saved) { allowedDocumentIds?.add(existingId);
              return documentResult({ ok: true, action: "selected", document_id: existingId,
                version_id: saved.versionId, filename: saved.document.filename,
                resource: resourceReference.document(existingId, saved.versionId) }); }
          }
          return persistGenerated(filename,
            Buffer.from(researchFileMarkdown(title, createResearchFileState())), {
              schemaVersion: 1, actor: "assistant", action: "created" });
        }
        return updateResearch(call, input, signal);
      default:
        return Promise.resolve(fail("Unknown document operation"));
    }
  };
  const workProductRevisions = new Map<string, number>();
  if (authoritiesId && authoritiesRevision) {
    workProductRevisions.set(authoritiesId, authoritiesRevision);
  }
  const clip = (value: unknown, max = 500) => {
    const text = trimmed(value);
    return text.length > max ? `${text.slice(0, max - 3)}...` : text;
  };
  const workProductChoices = async (kind: WorkProductKind) => {
    const products = await workProducts.list(scope,
      { kind, limit: 50, metadata: true });
    const drafts = products.filter(({ projectId }) => projectId === workProductProjectId)
      .map(({ id, title, revision, updatedAt }) =>
        ({ id, title: clip(title, 300), revision, updated_at: updatedAt }));
    return { drafts, has_more: products.length === 50 };
  };
  const targetWorkProduct = async (input: Record<string, unknown>) => {
    const id = trimmed(input.draft_id) || authoritiesId;
    if (!id) throw new Error("No Authorities draft is active");
    if (authoritiesId && id !== authoritiesId) {
      throw new Error("This assistant is bound to a different Authorities draft");
    }
    const product = await workProducts.get(scope, id);
    if (product.kind !== "authorities" || product.projectId !== workProductProjectId) {
      throw new Error("Draft is outside this chat's work-product scope");
    }
    return { product, revision: workProductRevisions.get(id) ??
      (id === authoritiesId ? authoritiesRevision : undefined) ?? product.revision };
  };
  const workProductPayload = (product: { id: string; kind: WorkProductKind;
    revision: number }, values: Record<string, unknown> = {}) => {
    workProductRevisions.set(product.id, product.revision);
    return workProductResult(product, values);
  };
  const authoritiesPayload = (product: Awaited<ReturnType<typeof authorities.importDraft>>,
    input: Record<string, unknown> = {}, values: Record<string, unknown> = {}) => {
    const draft = decodeAuthoritiesDraft(product.state);
    const outputRoles = Object.keys(product.outputs ?? {});
    if (!draft) return workProductPayload(product, values);
    const authorityOffset = Math.max(0, Math.trunc(Number(input.authority_offset) || 0));
    const authorityLimit = Math.max(1, Math.min(50,
      Math.trunc(Number(input.authority_limit) || 25)));
    const authority = (id: string) => {
      const item = draft.authorities[id];
      if (!item) return null;
      const source = item.source;
      return { id, kind: item.kind, citation: clip(item.citation),
        name: clip(item.displayName ?? item.name),
        excluded: item.excluded, source: { status: source.kind,
          ...(source.kind === "attached" ? { binding_role: source.bindingRole,
            filename: clip(source.filename, 300) } : {}),
          ...(source.kind === "pending-canlii" ? { page_url: clip(source.pageUrl, 1_000) } : {}) } };
    };
    const part = (item: typeof draft.bookParts.cover) => item && ({
      binding_role: item.bindingRole, filename: clip(item.filename, 300),
    });
    const source = draft.import.kind === "document" ? {
      kind: draft.import.kind, filename: clip(draft.import.filename, 300),
      file_type: draft.import.fileType, binding_role: draft.import.bindingRole,
    } : { kind: draft.import.kind };
    const summary: Record<string, unknown> = {
      source,
      output_mode: draft.outputMode,
      settings: { profile_id: draft.settings.profileId,
        source_mode: draft.settings.sourceMode, tab_style: draft.settings.tabStyle,
        table_order: draft.settings.tableOrder, table_delivery: draft.settings.tableDelivery,
        table_location: draft.settings.tableLocation,
        passage_marking: draft.settings.passageMarking,
        scanned_pdf_policy: draft.settings.scannedPdfPolicy,
        missing_source_policy: draft.settings.missingSourcePolicy,
        ...(draft.settings.filingMedium
          ? { filing_medium: draft.settings.filingMedium } : {}),
        ...(draft.settings.bookRole ? { book_role: draft.settings.bookRole } : {}) },
      book_parts: { cover: part(draft.bookParts.cover), index: part(draft.bookParts.index) },
      insert_into_document: draft.insertIntoDocument,
      counts: { units: draft.units.length, occurrences: Object.keys(draft.occurrences).length,
        authorities: draft.authorityOrder.length },
      authorities: draft.authorityOrder.slice(authorityOffset, authorityOffset + authorityLimit)
        .map(authority).filter(Boolean),
      authority_page: { offset: authorityOffset, limit: authorityLimit,
        has_more: authorityOffset + authorityLimit < draft.authorityOrder.length },
    };
    const occurrenceId = trimmed(input.occurrence_id), requestedUnitId = trimmed(input.unit_id);
    if (occurrenceId && requestedUnitId) throw new Error(
      "Read either one unit_id or one occurrence_id");
    const occurrence = occurrenceId ? draft.occurrences[occurrenceId] : null;
    if (occurrenceId && !occurrence) throw new Error(`Unknown occurrence: ${occurrenceId}`);
    const unitId = requestedUnitId || occurrence?.unitId || "";
    const unit = unitId ? draft.units.find(({ id }) => id === unitId) : null;
    if (unitId && !unit) throw new Error(`Unknown unit: ${unitId}`);
    if (unit) {
      const requestedOffset = input.text_offset === undefined ? null : Number(input.text_offset);
      const textOffset = Math.min(unit.text.length, Math.max(0, Math.trunc(requestedOffset ??
        (occurrence ? Math.max(0, occurrence.start - 2_000) : 0))));
      const textLimit = Math.max(1, Math.min(20_000,
        Math.trunc(Number(input.text_limit) || 12_000)));
      const textEnd = Math.min(unit.text.length, textOffset + textLimit);
      summary.unit = { id: unit.id, kind: unit.kind, ordinal: unit.ordinal,
        footnote_id: unit.footnoteId, page_numbers: unit.pageNumbers,
        text: unit.text.slice(textOffset, textEnd), text_offset: textOffset,
        text_end: textEnd, text_length: unit.text.length, has_more: textEnd < unit.text.length,
        occurrences: unit.occurrenceIds.slice(0, 100).flatMap((id) => {
          const item = draft.occurrences[id];
          return item ? [{ id, start: item.start, end: item.end, kind: item.kind,
            citation: clip(item.citation, 300), authority_id: item.authorityId }] : [];
        }), occurrence_count: unit.occurrenceIds.length };
    }
    if (occurrence) {
      const span = (value: typeof occurrence.authoritySpan | null) => value && ({
        start: value.start, end: value.end, text: clip(value.text, 500),
      });
      summary.occurrence = { id: occurrence.id, unit_id: occurrence.unitId,
        start: occurrence.start, end: occurrence.end, text: clip(occurrence.text, 1_000),
        kind: occurrence.kind, citation: clip(occurrence.citation),
        authority_id: occurrence.authorityId, authority_span: span(occurrence.authoritySpan),
        core_span: span(occurrence.coreSpan), pinpoint_span: span(occurrence.pinpointSpan),
        reference: occurrence.reference, pinpoints: occurrence.pinpoints };
    }
    return workProductPayload(product, { draft: summary, output_roles: outputRoles, ...values });
  };
  const authoritiesMutationPayload = (
    product: Awaited<ReturnType<typeof authorities.importDraft>>,
    change: Record<string, unknown>,
  ) => {
    const draft = decodeAuthoritiesDraft(product.state), outputRoles = Object.keys(product.outputs ?? {});
    return workProductPayload(product, { change,
      ...(draft && { state: { output_mode: draft.outputMode,
        profile_id: draft.settings.profileId,
        counts: { units: draft.units.length, occurrences: Object.keys(draft.occurrences).length,
          authorities: draft.authorityOrder.length },
        book_parts: { cover: Boolean(draft.bookParts.cover),
          index: Boolean(draft.bookParts.index) } } }),
      ...(outputRoles.length && { output_roles: outputRoles }) });
  };
  const inputIssues = async (id: string) => {
    const resolution = await workProducts.resolve(scope, id);
    const issues: Record<string, unknown>[] = [];
    for (const [role, item] of Object.entries(resolution.inputs)) {
      if (item.status === "ready") continue;
      if (item.status === "changed") {
        const current = item.current.kind === "local-file"
          ? { filename: clip(item.current.filename, 300) }
          : { document_id: item.current.documentId, version_id: item.current.versionId,
            filename: clip(item.current.filename, 300) };
        issues.push({ role, status: item.status, current, refreshable: true });
      } else if (item.status === "missing") {
        issues.push({ role, status: item.status, reason: item.reason,
          resource: item.resource, resource_id: item.id, refreshable: false });
      } else issues.push({ role, status: item.status, reason: item.reason,
        work_product_id: item.workProductId, refreshable: false });
    }
    return { freshness: resolution.freshness, input_issue_count: issues.length,
      input_issues: issues.slice(0, 50), input_issues_truncated: issues.length > 50 };
  };
  const authorizedDocument = async (input: Record<string, unknown>) => {
    const rawDocument = trimmed(input.document_id);
    const document = rawDocument ? parseResourceReference(rawDocument) : null;
    if (rawDocument && document?.kind !== "document") {
      throw new Error("document_id must be a version-pinned Library document");
    }
    if (document?.kind === "document" && (matterId
      ? !allowedDocumentIds?.has(document.documentId)
      : !await library.document({ ...scope, kind: "file" }, document.documentId))) {
      throw new Error("Document is outside this chat's document scope");
    }
    return document?.kind === "document" ? document : null;
  };
  const authorizedPdf = async (input: Record<string, unknown>) => {
    const document = await authorizedDocument(input);
    if (!document) throw new Error("Select one version-pinned Library PDF");
    const history = await documents.versions(scope, document.documentId);
    const version = history?.versions.find(({ id }) => id === document.versionId);
    if (!version || history?.current_version_id !== version.id ||
        version.file_type.toLowerCase() !== "pdf") {
      throw new Error("Select the current PDF version from Library");
    }
    return { ...document, version };
  };
  const authoritiesAction = (value: unknown): AuthoritiesUserAction | null => {
    const action = objectRecord(value);
    if (!action) return null;
    const type = trimmed(action.type), occurrenceId = trimmed(action.occurrence_id),
      authorityId = trimmed(action.authority_id);
    const occurrence = () => {
      if (!occurrenceId) throw new Error(`${type} requires occurrence_id`);
      return occurrenceId;
    };
    const authority = () => {
      if (!authorityId) throw new Error(`${type} requires authority_id`);
      return authorityId;
    };
    const integer = (key: "start" | "end" | "cursor") => {
      const number = action[key];
      if (!Number.isSafeInteger(number) || Number(number) < 0) {
        throw new Error(`${type} requires a non-negative integer ${key}`);
      }
      return Number(number);
    };
    switch (type) {
      case "add-authority": {
        const kind = trimmed(action.authority_kind), citation = trimmed(action.citation);
        if (!["case", "legislation", "commentary", "other"].includes(kind) || !citation) {
          throw new Error("add-authority requires authority_kind and citation");
        }
        return { type, kind: kind as "case" | "legislation" | "commentary" | "other",
          citation, name: action.name === null ? null : trimmed(action.name) || null };
      }
      case "remove-authority":
        return { type, authorityId: authority() };
      case "set-authority-span":
      case "set-pinpoint-span":
        return { type, occurrenceId: occurrence(), start: integer("start"),
          end: integer("end") };
      case "split-occurrence":
        return { type, occurrenceId: occurrence(), cursor: integer("cursor") };
      case "merge-occurrence":
        return { type, occurrenceId: occurrence() };
      case "relink-occurrence":
        return { type, occurrenceId: occurrence(), authorityId: authorityId || null };
      case "set-reference": {
        const kind = action.reference_kind;
        if (kind !== "supra" && kind !== "ibid" && kind !== "none") {
          throw new Error("set-reference requires reference_kind");
        }
        const targetAuthorityId = trimmed(action.target_authority_id);
        if (kind !== "none" && !targetAuthorityId) {
          throw new Error("set-reference requires target_authority_id");
        }
        return { type, occurrenceId: occurrence(), reference: kind === "none" ? null
          : { kind, targetAuthorityId } };
      }
      case "exclude-authority":
        if (typeof action.excluded !== "boolean") {
          throw new Error("exclude-authority requires excluded");
        }
        return { type, authorityId: authority(), excluded: action.excluded };
      case "rename-authority":
        if (typeof action.display_name !== "string") {
          throw new Error("rename-authority requires display_name");
        }
        return { type, authorityId: authority(), displayName: trimmed(action.display_name) || null };
      case "clear-authority-source":
        return { type, authorityId: authority() };
      case "set-profile": {
        const profileId = trimmed(action.profile_id);
        if (!authoritiesProfileIds.includes(profileId as typeof authoritiesProfileIds[number])) {
          throw new Error("set-profile requires profile_id");
        }
        return { type, profileId } as AuthoritiesUserAction;
      }
      case "set-settings": {
        const input = objectRecord(action.settings);
        if (!input) throw new Error("set-settings requires settings");
        const keys = {
          source_mode: ["sourceMode", ["automatic", "manual-originals", "render"]],
          tab_style: ["tabStyle", ["numeric", "alpha"]],
          table_order: ["tableOrder", ["first-reference", "alphabetical"]],
          table_delivery: ["tableDelivery", ["native-marks", "native-append", "linked-append"]],
          table_location: ["tableLocation", ["pages", "pinpoints", "combined"]],
          passage_marking: ["passageMarking", ["none", "margin", "paragraph", "text", "sidelined"]],
          scanned_pdf_policy: ["scannedPdfPolicy", ["page-margin", "cited-pages", "full"]],
          missing_source_policy: ["missingSourcePolicy", ["placeholder", "omit"]],
          filing_medium: ["filingMedium", ["electronic", "paper"]],
          book_role: ["bookRole",
            ["applicant", "respondent", "joint", "appellant", "intervener"]],
        } as const;
        const settings: Record<string, string> = {};
        for (const [inputKey, [outputKey, allowed]] of Object.entries(keys)) {
          const selected = input[inputKey];
          if (selected === undefined) continue;
          if (typeof selected !== "string" || !(allowed as readonly string[]).includes(selected)) {
            throw new Error(`Invalid Authorities setting: ${inputKey}`);
          }
          settings[outputKey] = selected;
        }
        if (!Object.keys(settings).length) throw new Error("set-settings requires settings");
        return { type, settings } as AuthoritiesUserAction;
      }
      case "set-output-mode":
        if (!["table", "book", "both"].includes(String(action.output_mode))) {
          throw new Error("set-output-mode requires output_mode");
        }
        return { type, outputMode: action.output_mode as "table" | "book" | "both" };
      case "set-document-output":
        if (typeof action.enabled !== "boolean") {
          throw new Error("set-document-output requires enabled");
        }
        return { type, enabled: action.enabled };
      case "clear-book-part":
        if (action.slot !== "cover" && action.slot !== "index") {
          throw new Error("clear-book-part requires slot");
        }
        return { type, slot: action.slot };
      default:
        throw new Error("Select a supported Authorities action");
    }
  };
  const updateWorkProduct: AssistantToolRun = async (call, input, signal) => {
    const kind = input.kind as WorkProductKind;
    const respond = (raw: Record<string, unknown>, mutated = false) => {
      const payload = JSON.stringify(raw).length < MAX_MODEL_TOOL_RESULT_CHARS - 1_000 ? raw : {
        ok: raw.ok, ...(objectRecord(raw.work_product)
          ? { work_product: raw.work_product } : {}), truncated: true,
        detail: "Read again with a narrower unit, occurrence, or authority page.",
      };
      const productId = trimmed(objectRecord(payload.work_product)?.id);
      return withEvent(payload.ok === true
        ? (mutated ? mutationResult(payload) : result(payload))
        : fail(clip(payload.error || "The work product could not be updated", 1_000)),
      workProductEvent(payload, productId ? `work-product:${productId}` : call.id));
    };
    if (!WORK_PRODUCT_KINDS.includes(kind)) {
      return respond({ ok: false, error: "Select a supported work-product kind" });
    }
    if (kind === "authorities" && productFeatures?.authorities === false) {
      return respond({ ok: false, error: "Authorities is turned off in Settings." });
    }
    try {
      const requestedId = trimmed(input.draft_id);
      if (!authoritiesId && !requestedId &&
          (input.action === "read" || input.action === "select")) {
        return respond({ ok: true, ...(await workProductChoices(kind)),
          requested_action: "choose" });
      }
      if (input.action === "create") {
        if (trimmed(input.draft_id)) throw new Error("create does not accept draft_id");
        if (authoritiesId) throw new Error(
          "This assistant is already bound to an Authorities draft");
        if (kind === "court-record") {
          const profileId = trimmed(input.profile_id);
          if (!COURT_RECORD_PROFILE_BY_ID.has(profileId)) {
            throw new Error("Select an available court record format");
          }
          const product = await workProducts.create(scope, { kind,
            title: trimmed(input.title) || "Untitled court record",
            projectId: workProductProjectId,
            state: { profileId, cover: {}, entries: [], bindings: {} } });
          return respond(courtRecordResult(product, { requested_action: "open" }), true);
        }
        const document = await authorizedDocument(input);
        const seeds = input.evidence_ids === undefined ? null : evidenceSeeds(input);
        if (document && seeds) throw new Error("Create Authorities from one source at a time");
        const product = await authorities.importDraft(scope, {
          source: document ? { kind: "document", documentId: document.documentId,
            version: "latest" } : seeds ? { kind: "receipts", seeds } : { kind: "manual" },
          title: trimmed(input.title) || undefined, projectId: workProductProjectId,
        });
        return respond(workProductPayload(product, { requested_action: "open" }), true);
      }
      if (kind === "court-record") {
        if (authoritiesId && input.action === "select") throw new Error(
          "This assistant is bound to an Authorities draft");
        const id = trimmed(input.draft_id);
        if (!id) throw new Error("Select a Court Record draft_id");
        const product = await workProducts.get(scope, id);
        if (product.kind !== "court-record" || product.projectId !== workProductProjectId) {
          throw new Error("Draft is outside this chat's work-product scope");
        }
        if (input.action === "read" || input.action === "select") {
          return respond(courtRecordResult(product, input.action === "select"
            ? { requested_action: "open" } : {}));
        }
        if (input.action !== "update") {
          throw new Error("Open the Court Record to refresh or build it");
        }
        if (!courtRecords) throw new Error("Court Records is unavailable");
        return courtRecordSlotTool<Context>({ scope,
          target: { id: product.id, revision: product.revision },
          projectId: workProductProjectId, allowedDocumentIds, library,
          workProducts, courtRecords, resolveArtifact, onMutationCommitted: () => {},
        }).execute({ ...input, action: "update" }, {} as Context, signal, call);
      }
      const target = await targetWorkProduct(input);
      if (input.action === "read") {
        return respond(authoritiesPayload(target.product, input,
          await inputIssues(target.product.id)));
      }
      if (input.action === "review") {
        const [issues, discrepancies] = await Promise.all([
          inputIssues(target.product.id),
          authorities.discrepancies(scope, target.product.id, signal),
        ]);
        const compact = discrepancies.slice(0, 40).map((item) => ({
          kind: item.kind, occurrence_id: item.occurrenceId,
          authority_id: item.authorityId, footnote_id: item.footnoteId,
          citation: clip(item.citation), authored_quote: clip(item.authoredQuote, 500),
          authored_pinpoint: item.authoredPinpoint,
          cited_locator: item.cited.locator,
          ...(item.found ? { suggested_locator: item.found.locator } : {}),
        }));
        return respond(authoritiesPayload(target.product, input, { ...issues,
          discrepancy_count: discrepancies.length, discrepancies: compact,
          discrepancies_truncated: discrepancies.length > compact.length }));
      }
      if (input.action === "select") {
        return respond(workProductPayload(target.product, { requested_action: "open" }));
      }
      if (input.action === "refresh") {
        const role = trimmed(input.input_role);
        const product = role
          ? await authorities.refreshInput(scope, target.product.id,
            { revision: target.revision, role })
          : await authorities.refresh(scope, target.product.id, target.revision);
        return respond(authoritiesMutationPayload(product,
          role ? { type: "refresh-input", role } : { type: "refresh" }),
        product.revision !== target.product.revision);
      }
      if (input.action === "build") {
        const prepared = await authorities.prepareSources(scope, target.product.id,
          target.revision, signal);
        let built: Awaited<ReturnType<typeof authorities.build>>;
        try { built = await authorities.build(scope, prepared.id, prepared.revision, signal); }
        catch (error) {
          return respond(authoritiesMutationPayload(prepared, { type: "prepare-sources",
            build_error: safeErrorMessage(error, "The outputs could not be built") }),
          prepared.revision !== target.revision);
        }
        return respond(authoritiesMutationPayload(built.product, { type: "build" }), true);
      }
      if (input.action !== "update") throw new Error("Unknown work-product action");
      const authorityId = trimmed(input.authority_id);
      const bookSlot = trimmed(input.book_slot);
      const action = authoritiesAction(input.authorities_action);
      const receipts = input.evidence_ids !== undefined;
      const attachment = Boolean(trimmed(input.document_id) || authorityId || bookSlot);
      if ([Boolean(action), attachment, receipts].filter(Boolean).length !== 1) {
        throw new Error("Update Authorities with exactly one edit, PDF attachment, or evidence list");
      }
      if (action) {
        const product = await authorities.act(scope, target.product.id, target.revision, action);
        return respond(authoritiesMutationPayload(product, { type: action.type }), true);
      }
      if (attachment) {
        if (Boolean(authorityId) === Boolean(bookSlot)) {
          throw new Error("Attach the PDF to one authority_id or one book_slot");
        }
        const document = await authorizedPdf(input);
        if (authorityId) {
          const product = await authorities.attachLibraryPdf(scope, target.product.id, {
            revision: target.revision, authorityId, documentId: document.documentId,
            versionId: document.versionId,
          });
          return respond(authoritiesMutationPayload(product,
            { type: "attach-authority-pdf", authority_id: authorityId }), true);
        }
        if (bookSlot !== "cover" && bookSlot !== "index") {
          throw new Error("Select cover or index as book_slot");
        }
        const binding = { kind: "document" as const, documentId: document.documentId,
          version: "latest" as const };
        const pdf = { bindingRole: `book:${bookSlot}`,
          filename: document.version.filename, sourceSha256: document.version.source_sha256 };
        const bookAction: AuthoritiesUserAction = {
          type: "set-book-part", slot: bookSlot, pdf, binding };
        const product = await authorities.act(scope, target.product.id, target.revision, bookAction);
        return respond(authoritiesMutationPayload(product, {
          type: "attach-book-pdf", book_slot: bookSlot,
        }), true);
      }
      const product = await authorities.addReceipts(scope, target.product.id,
        target.revision, evidenceSeeds(input));
      return respond(authoritiesMutationPayload(product, { type: "add-authorities",
        evidence_count: Array.isArray(input.evidence_ids) ? input.evidence_ids.length : 0 }), true);
    } catch (error) {
      return respond({ ok: false, error: safeErrorMessage(
        error, "The work product could not be updated",
      ) });
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
    schema: Tool & BeaverToolPolicy,
    run: AssistantToolRun,
    policy: BeaverToolPolicy = {},
  ): BeaverTool<Context> => ({
    ...schema,
    ...policy,
    activity: policy.activity ?? schema.activity ?? ((input) =>
      assistantToolActivityLabel(schema.name, input) ?? null),
    async execute(input, context, signal, call) {
      const output = await run(call, input, signal, (label) =>
        context.updateActivity?.(call.id, label));
      if (schema.name === "Read" && output.evidence?.length) {
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
    definition(WRITE_TOOL, write),
    definition(SEARCH_SOURCES_TOOL, sourceSearch),
    definition(CITATOR_TOOL, runCitator),
    ...(turnScope !== "main" ? [] : courtRecord && courtRecords
      ? [courtRecordSlotTool({ scope, target: courtRecord, projectId: workProductProjectId,
          allowedDocumentIds, library, workProducts, courtRecords, resolveArtifact,
          onMutationCommitted })]
      : [definition(workProductTool(productFeatures?.authorities !== false), updateWorkProduct)]),
    definition(documentOperationTool(), documentOperation),
    definition(LINT_DOCUMENT_TOOL, (call, input, signal) =>
      runWorkflow(call, { ...input, action: "lint_structure" }, signal)),
    definition(ADVANCED_DOCX_EDIT_TOOL, codingWithArtifacts),
    definition(COMPARE_VERSIONS_TOOL, compare),
  ];

  if (tabular && legalEvidenceState) {
    tools.splice(5, 0, tabularTool(tabular, legalEvidenceState));
  }
  return tools;
}

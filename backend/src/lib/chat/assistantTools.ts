import { readDocumentProjection } from "../documentApplication";
import { collapseProvisionLabels } from "../provisionLabels";
import { readLegalSourceResource, readLibraryResearchWindow, readResearchWorkspace, restoreResearchEvidence,
  sourceActivityCitations, readResearchContext, readResearchContextInventory, researchResultFilter,
  type ResearchReadContext } from "../researchReader";
import { ApplicationError } from "../applicationError";
import { researchMemoCitation } from "../researchMemo";
import { randomUUID } from "node:crypto";
import { sha256 } from "../hash";
import { SYSTEM_ASSISTANT_WORKFLOWS } from "../systemWorkflows";
import {
  DOCUMENT_RESOURCE_PATTERN,
  parseResourceReference,
  resourceReference,
} from "../resourceReferences";
import {
  type LegalSourceReference,
} from "../legalSources";
import { fixDocxSupras } from "../docxDeterministicCleanup";
import { createDocxAuthorityLedger,
  docxCitationEntries, resolveDocxEvidenceCitations } from "../docxEvidenceCitations";
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
import type { LibraryPageItem, LibraryStore } from "../libraryStore";
import type { ProjectDirectoryItem, ProjectStore } from "../projectStore";
import type {
  AssistantEdit,
  StoredAssistantEdit,
  DocumentContent,
  DocumentProvenance,
  DocumentRecord,
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
} from "../structureNative";
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
} from "./tools/a2ajTools";
import {
  createDirectSourceEvidence,
  createLibraryEvidence,
  legalEvidenceSourceReference,
  legalEvidenceResourceReference,
  legalEvidenceProseIntegrityErrors,
  legalSourceEvidence,
  modelEvidencePassage,
  modelEvidencePreview,
  modelResearchQuery,
  modelResearchQueryPreview,
  readPriorLegalEvidence,
  registerLegalEvidence,
  type LegalEvidenceReceipt,
  type LegalEvidenceTurnState,
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
import {
  applyTextOpsToDocx,
  type TextOpRequest,
} from "../docxTextOps";
import {
  buildPptxPresentation,
  presentationFromMarkdown,
  renderMarkdownDocx,
  renderXlsxWorkbook,
  safeGeneratedFilename,
  workbookFromMarkdown,
} from "./tools/documentOps";
import {
  ADVANCED_DOCX_EDIT_TOOL,
  WRITE_TOOL,
} from "./tools/toolSchemas";
import { jsonRecord as objectRecord, trimmedText as trimmed } from "../value";
import { RESOURCE_TOOLS, globPattern as globRegExp } from "./resourceTools";
import { checkQuotes, decodeQuoteLinks } from "../quoteCheck";
import { createAuthoritiesImporter } from "../authoritiesImport";
import { saveQuoteCheckWorkbook } from "../quoteCheckWorkbook";
import {
  workProductEvent, workProductResult,
} from "./localWorkflowRun";
import {
  MAX_MODEL_TOOL_RESULT_CHARS,
  toolText,
  type BeaverToolPolicy,
  type BeaverOutcome,
  type BeaverTool,
} from "./toolRegistry";
import { tabularTool, type ResearchTableResolver } from "./tabularCells";
import { readResearchFindings } from "./researchTableTool";
import { researchFindingReferenceSchema } from "../researchFindingReference";
import type { DocIndex, WorkflowStore } from "./types";
import type { SourceWorkspaceApplication } from "../sourceWorkspaceApplication";
import type { ResearchOperationContext } from "../researchProvenance";
import type { AuditStore } from "../audit";
import type { AssistantEvent, ReadSubagentAssignment } from "./assistantEvents";
import { safeErrorMessage } from "../safeError";
import type { AuthoritiesUserAction } from "../authoritiesActions";
import type { AuthoritiesWorkspaceApplication } from "../authoritiesWorkspaceApplication";
import { AUTHORITIES_SETTINGS_CHOICES, AUTHORITIES_TOOL_ACTIONS, AUTHORITIES_ACTION_CHOICES, authorityKinds, decodeAuthoritiesUserAction } from
  "../authoritiesActionContract";
import { authoritiesProfileIds, decodeAuthoritiesDraft, type AuthoritiesDraft,
  type AuthorityOccurrence, type AuthorityTextSpan } from "../authoritiesDomain";
import { footnotePropositions, singleSourceFootnote } from "../authoritiesQuotations";
import type { CourtRecordsApplication } from "../courtRecordsApplication";
import { COURT_PROFILE_BY_ID } from "mike/shared/court-record-profiles.mjs";
import type { FeaturePreferences } from "../userPreferences";
import type { WorkProductApplication } from "../workProductApplication";
import { WORK_PRODUCT_KINDS, type WorkProductKind } from "../workProduct";
import { readResearchEvidenceParts,
  researchFileActionSchema, researchReferenceFromEvidence,
  researchQueryReceipt, researchQuerySources,
  researchSourceFromResource, researchSourceKey, researchSourceResource,
  type ResearchEvidence, type ResearchFile, type ResearchFileAction, type ResearchQueryReceipt } from "../researchFile";
import { researchCaptureRuleSchema, runResearchFileQuery } from "../researchFileQuery";
import { COURT_RECORD_TOOL_PROPERTIES, courtRecordPageTool, courtRecordResult,
  courtRecordSlotTool } from "./courtRecordSlotTool";

const DOCUMENT_ID_PROPERTY = {
  type: "string",
  pattern: DOCUMENT_RESOURCE_PATTERN,
  description: "Version-pinned document resource returned by this tool or Glob. Reuse the latest returned resource after every write.",
};
export function modelQuoteCheckReport(report: Awaited<ReturnType<typeof checkQuotes>>, offset: number) {
  return { mode: report.mode, total: report.total, counts: report.counts,
    next_offset: offset + 10 < report.total ? offset + 10 : null,
    citationUnits: report.citationUnits.filter((unit) => report.quotes.some((quote) =>
      quote.unitId === unit.unitId || quote.candidates.some((candidate) => candidate.unitId === unit.unitId)))
      .map(({ unitId, status, reasons, parts }) => ({ unitId, status,
        ...(reasons.length ? { reasons } : {}),
        parts: parts.map(({ start, end, text, fields }) => ({ start, end, text,
          fields: Object.fromEntries(Object.entries(fields).filter(([, value]) =>
            Array.isArray(value) ? value.length : value !== "")) })) })),
    quotes: report.quotes.map((quote) => ({ ...quote,
      context: quote.context.slice(0, 4000), receipt: quote.receipt && {
        resource: researchSourceResource(quote.receipt.source),
        citation: quote.receipt.source.citation, title: quote.receipt.source.title,
        alternateCitation: quote.receipt.source.alternateCitation, date: quote.receipt.source.date,
        locator: quote.receipt.locator, text: quote.receipt.text.slice(0, 8000),
        ...(quote.receipt.text.length > 8000 ? { text_truncated: true } : {}),
        errors: quote.receipt.errors, comparison: quote.receipt.comparison,
      } })) };
}
const objectSchema = (
  properties: Record<string, object>,
  required: string[] = [],
): Tool["inputSchema"] => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});
const documentOperationTool = (research = true): Tool & BeaverToolPolicy => ({
  name: "document_operation",
  specialist: true,
  sequential: true,
  activity: (input) => ({
    metadata: "Updating Library metadata",
    fix_supras: "Fixing supra references",
    research: "Updating saved research",
  } as Record<string, string>)[String(input.action)] ?? "Updating document",
  description: "Specialist operation on one version-pinned Library document. " +
    `Actions: metadata saves user-requested classification or notes; ${research
      ? "research creates or updates an ordinary .research.md Library file; " : ""}fix_supras ` +
    "creates native Word supra cross-references. Do not pre-compute filesystem paths.",
  annotations: { readOnlyHint: false },
  inputSchema: objectSchema({
    action: {
      type: "string",
      enum: research ? ["metadata", "research", "fix_supras"] : ["metadata", "fix_supras"],
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
    ...(research ? { evidence_ids: { type: "array", uniqueItems: true,
      items: { type: "string", minLength: 1 } },
    query_ids: { type: "array", uniqueItems: true,
      items: { type: "string", minLength: 1 } },
    research_action: { type: "object", description:
      "Use {type:'create',title} without document_id, then reuse its returned resource as document_id. " +
      "Read an existing research file before changing it. " +
      "{type:'file-findings',references:[reference from Read findings],typeId:label_id} files original supporting passages under the chosen label. " +
      "{type:'save'} with top-level evidence_ids/query_ids saves verified evidence and returns " +
      "saved:[{evidence_id,source_id}] for annotation; " +
      "Workspace queries save automatically; use save for search_sources query_ids. " +
      "{type:'query',text,syntax:'literal'|'terms',target:'sources'|'passages',sourceIds?,labelIds?,evidenceIds?,members?,unlabelled?,limit?,after?}; members are {sourceId,evidenceIds?}, refined by other filters. Follow coverage.next_after with the same query until null; limit is 25 unless rules capture results into the file; " +
      "query may instead use rules:[{phrase,direction:'before'|'after'|'around',unit:'sentence'|'line'|'paragraph'|'chars',chars?,slot}] where slot is a returned highlight label_id, and conflict; rules also support after; incomplete coverage is never exhaustive; " +
      "{type:'label',name,definition?,parentId?,color?:'#RRGGBB',order?,scope:'source'|'highlight'} creates a label: omit id, " +
      "then use returned label_id for child parentId and later labelIds; supply id only to edit; " +
      "{type:'source',reference:{provider,id,kind,...},labelIds?,note?} for a current search result returns source_id; " +
      "{type:'annotate',kind:'source',id,labelIds?,note?} adds source filings, preserving all existing ancestor and descendant filings; or " +
      "{type:'annotate',kind:'evidence',id,sourceId,labelIds?,note?}; " +
      "{type:'label-selection',target:'sources'|'passages',sourceIds?,evidenceIds?,labelIds?,unlabelled?,assign:[labelId],mode:'add'|'remove'} adds filings or explicitly removes only the named assign labels; replace is allowed only for passages. Removing a human-made or human-approved filing requires acceptance. " +
      "{type:'remove',kind:'label'|'source',id} or {type:'remove',kind:'evidence',id,sourceId}; " +
      "{type:'batch',title,actions:[label/annotate/label-selection/remove-label actions]} groups a change. New labels, filings and edits to model-owned labels apply immediately with History/Undo. Only edits, moves or deletions of human-created or human-approved labels require acceptance. " +
      "{type:'undo',changeId} reverses a recorded change while preserving unrelated work. Read history for change IDs. If the result is pending, tell the user the change is waiting for acceptance; do not report it as completed. " +
      "{type:'note',markdown}; or " +
      "{type:'memo',title,markdown,mode?:'replace'|'append'} writes the workspace memo with " +
      "verified source links from top-level evidence_ids; use [@evidence_id] for inline citations; " +
      "IDs are opaque: annotate only returned label_id/source_id or matches[].evidence_id." } } : {}),
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
  type: { type: "string", enum: AUTHORITIES_TOOL_ACTIONS,
    description: "Boundary work: set-authority-span re-spans one citation over the whole of it — style of cause, neutral citation, parallel cites — re-parsing the span, relinking its authority, and absorbing any other occurrence lying wholly inside it, which is how two detections become one; set-pinpoint-span attaches the pinpoint, whose span must sit outside the authority span and hold a complete pinpoint (\"at para 33\", \"at 411\"); clear-pinpoint detaches a pinpoint that belongs to another citation, leaving the occurrence at its authority span; add-occurrence makes a citation no detector found out of span_text in unitId, which is the only way to add a missed citation; split-occurrence divides one occurrence in two at cursor_text; merge-occurrence merges it into the occurrence before it in the same unit; split, merge and add work in body units and footnotes alike; relink-occurrence points it at another authorityId, or null to unlink; remove-occurrence drops a false positive; set-reference marks a supra or ibid." },
  occurrenceId: { type: "string", minLength: 1,
    description: "Citation occurrence; omit in a bound view to use the focused citation." },
  unitId: { type: "string", minLength: 1,
    description: "add-occurrence: the review unit the new citation sits in, from the read's unit_index; span_text is resolved against it." },
  authorityId: { type: "string",
    description: "An id from the read's authorities list; null in relink-occurrence unlinks." },
  kind: { type: "string", enum: authorityKinds },
  citation: { type: "string", minLength: 1, maxLength: 1_000 },
  name: { type: ["string", "null"], maxLength: 1_000 },
  span_text: { type: "string", minLength: 1, maxLength: 2_000,
    description: "The span, quoted exactly from the unit text the read returned, e.g. \"Bhasin v. Hrynew, 2014 SCC 71\" for the authority span and \"at para 33\" for the pinpoint. Preferred over start/end: it is resolved against the occurrence's unit, so no offset is counted by hand." },
  cursor_text: { type: "string", minLength: 1, maxLength: 2_000,
    description: "split-occurrence: the text the second citation begins with, quoted from the unit; the split falls immediately before it." },
  start: { type: "integer", minimum: 0,
    description: "Span start as an absolute UTF-16 offset in the whole unit text (add the read's text_offset to a position inside its window); omit when span_text or the focused selection gives the span." },
  end: { type: "integer", minimum: 0,
    description: "Span end, exclusive, on the same scale as start." },
  cursor: { type: "integer", minimum: 0,
    description: "split-occurrence: absolute UTF-16 offset in the unit where the citation divides; it must fall strictly inside the occurrence. Omit when cursor_text is given." },
  reference: { ...objectSchema({
    kind: { type: "string", enum: AUTHORITIES_ACTION_CHOICES.reference },
    targetAuthorityId: { type: "string", minLength: 1 },
  }, ["kind", "targetAuthorityId"]), type: ["object", "null"] },
  excluded: { type: "boolean" },
  displayName: { type: ["string", "null"], maxLength: 1_000 },
  profileId: { type: "string", enum: authoritiesProfileIds },
  settings: objectSchema(Object.fromEntries(Object.entries(AUTHORITIES_SETTINGS_CHOICES)
    .map(([key, values]) => [key, { type: "string", enum: values }]))),
  outputMode: { type: "string", enum: AUTHORITIES_ACTION_CHOICES.outputMode },
  enabled: { type: "boolean" },
  cover: objectSchema({
    courtFileNumber: { type: "string", maxLength: 100 },
    partyGroups: { type: "array", maxItems: 50, items: objectSchema({
      role: { type: "string", maxLength: 100 },
      parties: { type: "array", maxItems: 50,
        items: { type: "string", maxLength: 500 } },
    }, ["role", "parties"]) },
    applicationUnder: { type: "string", maxLength: 2_000 },
    title: { type: "string", maxLength: 500 },
  }, ["courtFileNumber", "partyGroups", "applicationUnder", "title"]),
  slot: { type: "string", enum: AUTHORITIES_ACTION_CHOICES.slot },
  id: { type: "string", minLength: 1, maxLength: 200 },
  locator: objectSchema({
    kind: { type: "string", enum: AUTHORITIES_ACTION_CHOICES.locator },
    label: { type: "string", minLength: 1, maxLength: 500 },
  }, ["kind", "label"]),
}, ["type"]);
const workProductTool = (authoritiesEnabled: boolean, bound = false,
  name = "update_work_product"): Tool & BeaverToolPolicy => ({
  name,
  specialist: !bound,
  sequential: true,
  activity: (input) => WORK_PRODUCT_ACTIVITY[String(input.action)] ?? "Updating draft",
  description: (bound ? "Read, review, update, refresh, or build the active Authorities draft. "
    : "Create, read, select, or update Court Record and Authorities drafts. Read without draft_id to list drafts. ") +
    "Read a unit_id or occurrence_id for the unit text with every occurrence in it, its " +
    "authority span, pinpoint span and linked authority; correcting those boundaries is your work, " +
    "not the user's, and authorities_action.span_text quotes the text a span should cover instead of " +
    "counting offsets. Bound reads and citation actions default to the focused citation and " +
    "selection, and each is a button beside it: " +
    "set-authority-span (Use selection as citation), set-pinpoint-span (Use selection as pinpoint), split-occurrence (Split at cursor), merge-occurrence (Merge with previous), remove-occurrence (Not a citation); clear-pinpoint and add-occurrence (unitId + span_text) have no button. Update with authorities_action, " +
    "evidence_ids, authority_id + document_id + source_language, or book_slot + document_id. " +
    "Reuse supplement_id to replace a supplemental PDF or authorities_action.id to remove it. " +
    "An authorities_action returns change.changed: the occurrences this edit altered, added or " +
    "removed, each with before and after, and an empty array where it altered nothing.",
  annotations: { readOnlyHint: false },
  inputSchema: objectSchema({
    action: { type: "string", enum: bound ? ["read", "review", "update", "refresh", "build"]
      : ["create", "read", "review", "select", "update", "refresh", "build"] },
    ...(!bound && {
      kind: { type: "string", enum: ["court-record",
        ...(authoritiesEnabled ? ["authorities"] : [])] },
      draft_id: { type: "string", minLength: 1 },
      title: { type: "string", minLength: 1, maxLength: 300 },
      ...COURT_RECORD_TOOL_PROPERTIES,
    }),
    ...(authoritiesEnabled && {
      document_id: DOCUMENT_ID_PROPERTY,
      unit_id: { type: "string", minLength: 1 },
      occurrence_id: { type: "string", minLength: 1 },
      // Page sizes are served, not policed: over-asking is a shorter page, not a failed call.
      text_offset: { type: "integer", minimum: 0 },
      text_limit: { type: "integer", minimum: 1, description: "Characters; 20000 at most." },
      occurrence_offset: { type: "integer", minimum: 0 },
      occurrence_limit: { type: "integer", minimum: 1, description: "Rows; 25 at most." },
      authority_offset: { type: "integer", minimum: 0 },
      authority_limit: { type: "integer", minimum: 1, description: "Rows; 50 at most." },
      input_role: { type: "string", minLength: 1 },
      authority_id: { type: "string", minLength: 1,
        description: "Authority ID returned by reading an Authorities draft." },
      source_language: { type: "string", enum: ["en", "fr", "bilingual"],
        description: "Official language of a PDF attached to an authority." },
      book_slot: { type: "string", enum: ["cover", "index", "supplemental"] },
      supplement_id: { type: "string", minLength: 1, maxLength: 200 },
      authorities_action: AUTHORITIES_ACTION,
      evidence_ids: { type: "array", minItems: 1, uniqueItems: true,
        items: { type: "string", minLength: 1 } },
    }),
  }, bound ? ["action"] : ["action", "kind"]),
});

/** Quoted text beats hand-counted offsets: the assistant names the text a span should
 * cover and the match nearest the occurrence wins, so boundary work needs no arithmetic. */
function anchoredRange(state: unknown, occurrenceId: string,
  action: Record<string, unknown>): { start?: number; end?: number; cursor?: number } | null {
  const span = trimmed(action.span_text), needle = span || trimmed(action.cursor_text);
  if (!needle) return null;
  const draft = decodeAuthoritiesDraft(state);
  const occurrence = draft?.occurrences[occurrenceId];
  const unitId = trimmed(action.unitId) || occurrence?.unitId;
  const unit = draft?.units.find(({ id }) => id === unitId);
  if (!unit) throw new Error("Quote span_text with the unitId or occurrence_id whose unit it comes from");
  const found: number[] = [];
  for (let at = unit.text.indexOf(needle); at >= 0;
    at = unit.text.indexOf(needle, at + 1)) found.push(at);
  if (!found.length) throw new Error(
    `That text is not in unit ${unit.id}; quote it exactly as the read returned it`);
  const near = occurrence?.unitId === unit.id ? occurrence.start : 0;
  const start = found.reduce((best, at) =>
    Math.abs(at - near) < Math.abs(best - near) ? at : best);
  return span ? { start, end: start + needle.length } : { cursor: start };
}

const documentsFromPage = (items: (LibraryPageItem | ProjectDirectoryItem)[]) =>
  items.flatMap((item) => item.kind === "document"
    ? [item.document] : []);

async function scopedDocuments(
  scope: DocumentScope,
  library: LibraryStore,
  projects: ProjectStore,
  limit = 200,
  matterId?: string | null,
) : Promise<DocumentRecord[]> {
  if (matterId) {
    return documentsFromPage((await projects.directory(
      scope,
      matterId,
      { q: "", parentFolderId: null, limit, after: null },
    )).items);
  }
  const documents: DocumentRecord[] = [];
  let after: [number, string, string] | null = null;
  do {
    const page = await library.page({ ...scope, kind: "file" }, {
      q: "", parentFolderId: null, limit, after, documentsOnly: true,
    });
    documents.push(...documentsFromPage(page.items));
    after = page.nextAfter;
  } while (after);
  return documents;
}

type AssistantEditTurnState = Map<string, {
  versionId: string; workingRevision: number; parentVersionId: string; turnVersionId?: string;
}>;

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
  context_before: edit.contextBefore,
  context_after: edit.contextAfter,
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
  turnId?: string;
  editMode: EditMode;
}) {
  const stale = fail("The active document version changed.");
  const sourceVersionId = params.source.version.id;
  const workingRevision = params.source.version.working_revision;
  const existing = params.turnEditState?.get(params.documentId);
  if (existing && (existing.versionId !== sourceVersionId ||
      existing.workingRevision !== workingRevision)) return stale;
  const finalized = params.edits.length
    ? await finalizeTrackedEdits(
        params.bytes,
        params.edits.flatMap((edit) =>
          [edit.delWId, edit.insWId].filter((id): id is string => !!id),
        ),
        params.editMode,
      )
    : { bytes: params.bytes, status: "pending" as const };
  const committed = await params.documents.commitAssistantVersion(
    params.scope,
    params.documentId,
    {
      sourceVersionId,
      expectedWorkingRevision: workingRevision,
      ...(existing?.turnVersionId ? { turnVersionId: existing.turnVersionId } : {}),
      ...(params.turnId ? { turnId: params.turnId } : {}),
      filename: params.source.version.filename ?? params.source.filename,
      fileType: "docx",
      bytes: finalized.bytes,
      edits: params.edits,
      status: finalized.status,
    },
  );
  if (committed.status !== "committed") return stale;
  const { version, edits: trackedEdits } = committed;
  params.turnEditState?.set(params.documentId, {
    versionId: version.id,
    workingRevision: version.working_revision,
    parentVersionId: existing?.parentVersionId ?? sourceVersionId,
    turnVersionId: version.id,
  });
  return artifactResult({
    type: "document_artifact",
    action: "edited",
    edit_mode: params.editMode,
    document_id: params.documentId,
    version_id: version.id,
    version_number: version.version_number,
    filename: version.filename ?? params.source.filename,
    download_url:
      `/api/single-documents/${encodeURIComponent(params.documentId)}/file` +
      `?version_id=${encodeURIComponent(version.id)}`,
    annotations: editAnnotations(
      params.documentId, version.id, version.version_number, trackedEdits,
    ),
  });
}

const GREP_LINE_CAP = 2_000;

type CodingOutputLine = {
  rendered: string;
  lineNumber?: number;
};

function takeCodingOutputLines(
  lines: CodingOutputLine[],
) {
  // Leave headroom under the result cap for the truncation notice appended below.
  const budget = MAX_MODEL_TOOL_RESULT_CHARS - 1_000;
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
  return (await documents.metadata(scope, documentId))
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

const projectionSource = (documentId: string, file: DocumentContent) => ({
  documentId, versionId: file.version.id, fileType: file.fileType,
  sourceSha256: file.version.source_sha256, pdfProfile: file.pdfProfile,
  readBytes: () => file.bytes,
});

/**
 * A scanned PDF has no text until recognition finishes, so a read of one
 * returns an empty window. Report the running job and its progress instead of
 * an empty file, and say the read is worth repeating.
 */
async function textRecognitionWait(
  documents: DocumentStore,
  scope: DocumentScope,
  documentId: string,
  filename: string,
) {
  const [row] = await documents.parseStates(scope, [documentId]);
  const parse = row?.parse_state;
  if (!parse || (parse.status !== "queued" && parse.status !== "parsing")) return null;
  const total = row.page_count ?? parse.page_count ?? 0;
  const done = parse.pages?.length ?? 0;
  const percent = total ? Math.min(99, Math.round((100 * done) / total)) : null;
  return {
    label: `Waiting on text recognition${percent === null ? "" : ` (${percent}%)`} for ${filename}`,
    status: parse.phase === "ocr" ? "recognizing_text" : "preparing_text",
    ...(percent === null ? {} : { progress: `${percent}%` }),
    next_required_action: `Text recognition is still running on ${filename}. Retry this Read once it finishes.`,
  };
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
        ...compactProviderPdfLookup(resolved, evidence),
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

type CodingShapeDeps = {
  documents: DocumentStore; library: LibraryStore; projects: ProjectStore;
  scope: DocumentScope; matterId?: string | null; workflows: WorkflowStore;
  turnEditState?: AssistantEditTurnState; turnId?: string; editMode: EditMode;
  documentNames: Map<string, string>; docIndex?: DocIndex;
  progress?: (label: string) => void; signal?: AbortSignal;
};

async function runCodingShapeCall(
  call: NormalizedToolCall,
  args: Record<string, unknown>,
  { documents, library, projects, scope, matterId, workflows, turnEditState,
    turnId, editMode, documentNames, docIndex, progress, signal }: CodingShapeDeps,
): Promise<AssistantOutcome> {
  const direct = await readNonDocumentResource(call, args, workflows, scope.userId);
  if (direct) return direct;
  const indexed = new Map(Object.values(docIndex ?? {}).map((item) =>
    [item.document_id, item]));
  let listedFiles: DocumentRecord[] | undefined;
  const files = async () => {
    if (!listedFiles) {
      listedFiles = await scopedDocuments(scope, library, projects, 200, matterId);
      listedFiles.forEach(({ id, filename }) => documentNames.set(id, filename));
    }
    return listedFiles;
  };
  const codingPath = (document: DocumentRecord, versionId = document.current_version_id) =>
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
      : record.project_id !== null || record.library_kind !== "file"))) return null;
    documentNames.set(record.id, record.filename);
    return record;
  };
  const referencedVersion = (raw: string) => {
    const reference = parseResourceReference(raw.trim());
    return reference?.kind === "document" ? reference.versionId : undefined;
  };
  if (call.name === "Glob") {
    const re = globRegExp(trimmed(args.pattern) || "*");
    const fileRows = [...Object.entries(docIndex ?? {}).flatMap(([alias, document]) =>
      document.version_id && (re.test(alias) || re.test(document.filename))
        ? [`${resourceReference.document(document.document_id, document.version_id)}` +
          `\talias=${alias}\tfilename=${document.filename.slice(0, 400)}`] : []),
      ...(await files()).filter((document) => !indexed.has(document.id) &&
        re.test(document.filename)).map((document) =>
        `${codingPath(document)}\tfilename=${document.filename.slice(0, 400)}`)];
    const workflowRows = [...workflows].flatMap(([id, workflow]) => {
      const resource = resourceReference.workflow(id);
      return re.test(resource) ? [`${resource}\ttitle=${workflow.title.slice(0, 400)}`] : [];
    });
    const rows = [...fileRows, ...workflowRows];
    if (!rows.length) return result("No files found");
    const offset = Number(args.offset ?? 1) - 1, limit = Number(args.limit ?? 50), page: string[] = [];
    let chars = 0;
    for (const row of rows.slice(offset, offset + limit)) {
      if (page.length && chars + row.length + 1 > 12_000) break;
      page.push(row); chars += row.length + 1;
    }
    const next = offset + page.length;
    return result([...page, ...(next < rows.length ? [`next_offset=${next + 1} (${rows.length} matches)`] : [])].join("\n"));
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
      let nativePdf: NativeDocument | undefined;
      if (locatorKind === "page" && !trimmed(args.end_locator) && /^[1-9]\d*$/u.test(locator)) {
        if (physicalPageCount === null) {
          try {
            nativePdf = await documentProjectionService.read(source, { signal });
            physicalPageCount = structureNative()
              .pdfDocumentSummary(nativePdf).projectionPageCount;
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
          lookup = await documentProjectionService.lookupPdf(source.readBytes, locatorInput, {
            documentId: meta.id,
            versionId: source.versionId,
            sourceSha256: source.sourceSha256,
            pdfProfile: source.pdfProfile,
            signal,
            progress: () => progress?.(
              `Reading ${exactPage ? `page ${exactPage} of ` : ""}${meta.filename}`,
            ),
          });
        }
        if (lookup.status === "found") nativePdf ??= await documentProjectionService.read(source, { signal });
        if (handle && lookup.status === "found") {
          const request = lookup.requested, canonical = structureNative().queryPdfDocument(nativePdf!,
            request.locator_kind, request.locator, request.end_locator ?? undefined,
            request.context_blocks, request.page ?? undefined, request.occurrence ?? undefined);
          if (canonical.status !== "found" || canonical.payload_sha256 !== lookup.payload_sha256)
            throw new Error("PDF evidence no longer matches the authoritative source artifacts");
        }
        const evidence = nativePdf ? pdfLegalEvidence(
          meta.id,
          source.versionId,
          meta.filename,
          lookup,
          nativePdf,
        ) : [];
        return {
          ...result({
            ...compactPdfLookup(meta.filename, lookup, evidence),
            resource: codingPath(meta, source.versionId),
          }),
          evidence,
          evidenceSources: new Map(evidence.map(({ evidence_id }) => [evidence_id, { source: nativePdf! }])),
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
    let document: Awaited<ReturnType<typeof readDocumentProjection>>;
    try {
      document = await readDocumentProjection(documents, scope, meta.id,
        referencedVersion(requested) ?? null, { mode: mode ?? "drafting", signal });
    } catch {
      return fail(
        `Could not read ${meta.filename}. The document reader failed; retrying will not help.`,
      );
    }
    if (!document) return fail(`File could not be read: ${requested}`);
    const nativeDocument = document.document;
    const limit = (args.limit as number | undefined) ?? 2_000;
    const startChar = (args.start_char as number | undefined) ?? 0;
    if (!sectionArg && !structureNative().documentText(nativeDocument).trim()) {
      const waiting = await textRecognitionWait(documents, scope, meta.id, meta.filename);
      if (waiting) {
        const { label, ...status } = waiting;
        progress?.(label);
        return result({ ok: false, resource: requested, ...status });
      }
    }
    return readLibraryResearchWindow({ documentId: meta.id,
      versionId: document.versionId, filename: meta.filename, document: nativeDocument,
      offset: args.offset as number | undefined, start_char: startChar, limit,
      section: sectionArg, references });
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
        turnId,
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
        turnId,
        editMode,
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
      turnId,
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
  let targets: DocumentRecord[];
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
    const projected = await readDocumentProjection(documents, scope, meta.id,
      targetVersionId ?? null, { mode: "drafting", signal });
    const nativeDocument = projected?.document;
    const document = projected && { versionId: projected.versionId,
      text: structureNative().documentText(projected.document) };
    if (!document) continue;
    const resource = codingPath(meta, document.versionId);
    const lines = document.text.split(/\r?\n/u);
    const starts = grepSection
      ? [0, ...Array.from(document.text.matchAll(/\n/gu), ({ index }) => index + 1)] : [];
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
  return result(
    truncated || rows.length > headLimit || sizeTruncated
      ? mode === "content"
        ? `${body}\n(Results truncated: ${headLimit} lines split evenly across ${fileBuckets.length} matching file${fileBuckets.length === 1 ? "" : "s"}. Narrow the pattern, scope with path=, or raise head_limit.)`
        : `${body}\n(Results truncated, showing first ${headLimit} lines. Narrow the pattern or pass head_limit.)`
      : body,
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

const result = (content: unknown): BeaverOutcome => ({ result: toolText(content, objectRecord(content)?.ok === false) });

type DocumentArtifact = Extract<AssistantEvent, { type: "document_artifact" }>;
type AssistantOutcome = BeaverOutcome |
  (Omit<BeaverOutcome, "result"> & { artifact: DocumentArtifact });
const artifactResult = (artifact: DocumentArtifact): AssistantOutcome => ({ mutated: true, artifact });

function documentResult(content: Record<string, unknown>): AssistantOutcome {
  const action = content.action;
  if (
    content.ok !== true ||
    (action !== "created" && action !== "revised") ||
    typeof content.filename !== "string" ||
    typeof content.document_id !== "string" ||
    typeof content.version_id !== "string" ||
    typeof content.download_url !== "string"
  ) return result(content);
  return artifactResult({
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
        ? content.annotations as DocumentArtifact["annotations"]
        : [],
    }),
  });
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

const withEvent = (output: AssistantOutcome, event: AssistantEvent | null | undefined): AssistantOutcome => event
  ? { ...output, events: [...(output.events ?? []), event] }
  : output;

const fail = (error: string) => result({ ok: false, error });

/** Citation text, authority names and span text a work-product payload carries: the draft's
 * own words, which an answer about the draft quotes back rather than advances as authority. */
function collectDraftCitations(value: unknown, into: Set<string>, span = false) {
  if (Array.isArray(value)) return value.forEach((item) => collectDraftCitations(item, into, span));
  for (const [key, item] of Object.entries(objectRecord(value) ?? {})) {
    if (typeof item !== "string") collectDraftCitations(item, into, key.endsWith("_span"));
    else if ((key === "citation" || key === "name" || (span && key === "text")) &&
      item.trim().length >= 4) into.add(item.trim());
  }
}

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
const WRITE_STAGE_WARNING_MS = 20_000;

function compactPdfLookup(filename: string, lookup: PdfLookupResult, evidence: LegalEvidenceReceipt[]) {
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
  const selected = new Set(lookup.units.map(({ kind, id }) => `${kind}:${id}`)),
    units = [...new Map([...lookup.before, ...lookup.after, ...lookup.units]
      .map((unit) => [`${unit.kind}:${unit.id}`, unit])).values()];
  return {
    ok: true, title: filename,
    handle: lookup.evidence.handle,
    passages: units.map((unit) => {
      const receipt = evidence.find((value) => value.block_id === `node:${unit.id}` ||
        value.stable_source_id.endsWith(`:${unit.kind}:${unit.id}`)),
        text = receipt?.span_text ?? unit.text,
        proposition = Object.fromEntries(Object.entries(unit.proposition ?? {}).filter(([key, value]) =>
          !["sentence", "passage_since_prior_note"].includes(key) ||
          typeof value !== "string" || value.trim() && !text.includes(value.trim()) &&
          (key !== "passage_since_prior_note" || value.trim() !== unit.proposition?.sentence?.trim())));
      return { ...(receipt ? { evidence_id: receipt.evidence_id } : {}),
        kind: unit.kind, locator: unit.locator, text,
        ...(unit.page_numbers.length ? { pages: unit.page_numbers } : {}),
        ...(unit.confidence !== null && unit.confidence < 1 ? { confidence: unit.confidence } : {}),
        ...(Object.keys(proposition).length ? { proposition } : {}),
        ...(unit.note ? { note: { label: unit.note.label,
          ...(unit.note.warnings.length ? { warnings: unit.note.warnings } : {}) } } : {}),
        ...(!selected.has(`${unit.kind}:${unit.id}`) ? { role: "context" } : {}) };
    }),
  };
}

type ReadyProviderPdfLookup = Extract<
  Awaited<ReturnType<typeof lookupProviderPdfReference>>,
  { availability: "ready" }
>;

function compactProviderPdfLookup(resolved: ReadyProviderPdfLookup, evidence: LegalEvidenceReceipt[]) {
  const filename =
    resolved.params.source?.title || resolved.params.title ||
    resolved.params.filename ||
    resolved.params.identity;
  const source = resolved.params.source;
  return {
    ...compactPdfLookup(filename, resolved.lookup, evidence), citation: source?.citation,
    ...(source?.date ? { date: source.date } : {}),
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
  const source = resolved.params.source;
  const provider = source?.provider;
  if (provider !== resolved.state.provider ||
      (provider !== "a2aj" && provider !== "courtlistener" && provider !== "tna" &&
        provider !== "govuk-et" && provider !== "govinfo"))
    throw new Error("Provider PDF legal source identity is unavailable");
  const jurisdiction = provider === "a2aj" ? "CA"
    : provider === "courtlistener" || provider === "govinfo" ? "US" : "UK";
  const sourceClass = source.kind === "case" || source.kind === "legislation"
    ? source.kind : "commentary";
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
      return [createDirectSourceEvidence(provider, {
        jurisdiction,
        sourceClass,
        stableSourceId: `${resolved.state.source_reference}:${key}`,
        sourceReference: source,
        sourceSha256: resolved.state.source_sha256 ?? undefined,
        spanText,
        citation: source.citation ?? source.id,
        name: source.title,
        dataset: source.collection ?? provider,
        language: source.language,
        version: source.date ?? resolved.params.version,
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
  document: NativeDocument,
): LegalEvidenceReceipt[] {
  if (lookup.status !== "found") return [];
  const native = structureNative(), text = native.documentText(document),
    sourceSha256 = native.documentRevision(document), units = [...new Map(
      [...lookup.before, ...lookup.units, ...lookup.after].map((unit) => [unit.id, unit])).values()],
    spans = native.pdfLookupUnitSpans(document, units.map(({ id }) => id));
  return units.flatMap((unit) => {
    if (!unit.text.trim()) return [];
    const span = spans[unit.id];
    if (!span || span.end <= span.start) throw new Error("PDF passage has no canonical document span");
    return [createLibraryEvidence({
      documentId,
      versionId,
      filename,
      sourceSha256,
      spanText: text.slice(span.start, span.end),
      ...span,
      blockId: `node:${unit.id}`,
      locator: { kind: unit.kind, label: unit.locator },
    })];
  });
}

async function runAdvancedDocxEdit(params: {
  args: Record<string, unknown>;
  documents: DocumentStore;
  scope: DocumentScope;
  documentId: string;
  turnEditState?: AssistantEditTurnState;
  turnId?: string;
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
      const document = await documentProjectionService.read(
        projectionSource(params.documentId, file));
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
    if (!applied.replacementCount || !applied.edits.length) {
      return result({
        ...(!applied.replacementCount ? {
          ok: true, action: "no_changes", document_id: params.documentId,
          version_id: file.version.id, change_count: 0,
        } : {
          ok: false, error: "No revision was saved",
          ...(applied.editErrors.length ? { edit_errors: applied.editErrors } : {}),
        }),
        ops: applied.reports.map(({ op, replacements, notes }) => ({
          op, replacements, unchanged_sites: notes,
        })),
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
      turnId: params.turnId,
      editMode: params.editMode,
    });
  } catch (error) {
    return fail(safeErrorMessage(error, "Deterministic text operations failed"));
  }
}

async function runDocxWorkflow(
  action: "fix_supras" | "lint_structure",
  documentId: string,
  versionId: string | undefined,
  { documents, scope, turnEditState, turnId, editMode }:
    Pick<CodingShapeDeps, "documents" | "scope" | "turnEditState" | "turnId" | "editMode">,
): Promise<AssistantOutcome> {
  const file = await activeDocx(documents, scope, documentId, versionId);
  if (action === "fix_supras") {
    const cleanup = await fixDocxSupras(file.bytes);
    if (!cleanup.changes.length) return result({ ok: true, action: "no_changes",
      document_id: documentId, version_id: file.version.id,
      ...cleanup, bytes: undefined, changes: undefined });
    return saveDocxEdits({ documents, scope, documentId, source: file,
      bytes: cleanup.bytes, edits: assistantEdits(cleanup.changes),
      turnEditState, turnId, editMode });
  }
  const document = await documentProjectionService.read(
    projectionSource(documentId, file));
  return result({
    ok: true,
    document_id: documentId,
    version_id: file.version.id,
    filename: file.filename,
    ...structureNative().docxStructureLint(document),
  });
}

export type { WorkProductFocus } from "mike/shared/work-products.mjs";
import type { WorkProductFocus } from "mike/shared/work-products.mjs";

type AssistantToolsDependencies = {
  userId: string;
  userEmail?: string;
  documents: DocumentStore;
  sources?: SourceWorkspaceApplication;
  researchContext?: ResearchReadContext;
  operation?: ResearchOperationContext;
  library: LibraryStore;
  projects: ProjectStore;
  workProducts: Pick<WorkProductApplication, "create" | "get" | "list" | "resolve">;
  model?: string;
  turnId?: string;
  chatId?: string;
  audit?: AuditStore["record"];
  onResearchWorkspace?: (documentId: string, evidence?: LegalEvidenceTurnState) => Promise<ResearchFile | null>;
  authorities: Pick<AuthoritiesWorkspaceApplication,
    "importDraft" | "act" | "refresh" | "refreshInput" | "prepareSources" |
      "discrepancies" | "build" |
      "addReceipts" | "attachLibraryPdf">;
  authoritiesId?: string;
  authoritiesRevision?: number;
  workProductFocus?: WorkProductFocus;
  courtRecords?: Pick<CourtRecordsApplication, "bindOutput" | "updateDraft">;
  courtRecord?: { id: string; revision: number };
  productFeatures?: FeaturePreferences;
  includeResearchTools?: boolean;
  draftingStyle?: DraftingStyleSettings;
  workflows?: WorkflowStore;
  allowedDocumentIds?: Set<string>;
  matterId?: string | null;
  legalEvidence?: LegalEvidenceTurnState;
  edits?: AssistantEditTurnState;
  editMode?: EditMode;
  timeZone?: string;
  scope: "main" | "reader";
  readerAssignment?: ReadSubagentAssignment;
  resolveTabular?: ResearchTableResolver;
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
) => Promise<AssistantOutcome>;

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
    editMode = "manual",
    timeZone,
    documents,
    sources,
    researchContext,
    operation: researchOperation,
    library,
    projects,
    workProducts,
    model = "assistant",
    turnId,
    chatId,
    audit,
    onResearchWorkspace,
    authorities,
    authoritiesId,
    authoritiesRevision,
    workProductFocus,
    courtRecords,
    courtRecord,
    productFeatures,
    includeResearchTools = true,
    draftingStyle = DEFAULT_DRAFTING_STYLE,
    workflows,
    scope: turnScope,
    readerAssignment,
    resolveTabular,
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
  const knownSources = new Map<string, LegalSourceReference>();
  for (const { receipt } of legalEvidenceState?.evidence.values() ?? []) {
    const source = legalEvidenceSourceReference(receipt);
    if (source) knownSources.set(researchSourceResource(source), source);
  }
  const publishGenerated = (document: DocumentRecord, workingRevision = 0) => {
    allowedDocumentIds?.add(document.id);
    knownDocumentNames.set(document.id, document.filename);
    turnEditState?.set(document.id, { versionId: document.current_version_id,
      workingRevision, parentVersionId: document.current_version_id, turnVersionId: document.current_version_id });
    return artifactResult({ type: "document_artifact", action: "created", document_id: document.id,
      version_id: document.current_version_id, version_number: document.active_version_number, filename: document.filename,
      download_url: `/api/single-documents/${encodeURIComponent(document.id)}/file?version_id=${encodeURIComponent(document.current_version_id)}` });
  };
  const persistGenerated = async (filename: string, bytes: Buffer, provenance?: DocumentProvenance) =>
    publishGenerated(await documents.create(scope, { filename,
      fileType: filename.slice(filename.lastIndexOf(".") + 1).toLowerCase(), bytes,
      projectId: matterId, libraryKind: "file", provenance: provenance?.actor === "assistant" && turnId
        ? { ...provenance, turnId } : provenance }));
  const coding: AssistantToolRun = async (call, args, signal, progress) => {
    const requested = trimmed(args.file_path);
    if (call.name === "Read" && requested === "selection") return researchContext?.subjects
      ? readResearchContextInventory(researchContext, { offset: Number(args.offset) || 1, limit: Number(args.limit) || 20 })
      : fail("No research scope is selected");
    if (call.name === "Read" && requested === "findings") {
      if (!sources || !researchContext?.workspace) return fail("Open a Sources workspace to read its findings");
      const reference = args.section ? researchFindingReferenceSchema.parse(JSON.parse(String(args.section))) : undefined,
        offset = Math.max(0, Math.trunc(Number(args.offset) || 1) - 1), limit = Math.max(1, Math.trunc(Number(args.limit) || (reference ? 1 : 20)));
      return readResearchFindings({ sources, scope, workspaceId: researchContext.workspace.documentId,
        findingRefs: researchContext.findingRefs,
        ...(researchContext.restricted ? { subjects: researchContext.subjects ?? [] } : {}) }, {
        reference, ...(args.pattern ? { evidence_id: String(args.pattern) } : {}),
        ...(reference ? { text_offset: Number(args.start_char) || 0 }
          : { offset, limit: Math.min(50, limit) }),
      });
    }
    if (call.name === "Read" && legalEvidenceState) {
      const inScope = researchResultFilter(researchContext), permittedEvidence = [...legalEvidenceState.evidence.values()]
        .filter(({ receipt }) => inScope({ resource: legalEvidenceResourceReference(receipt) ?? "", evidence: [receipt] }));
      if (requested === "evidence" || requested === "queries") {
        const offset = Math.max(0, Number(args.offset ?? 1) - 1), limit = Math.min(50, Number(args.limit ?? 20));
        const values = requested === "evidence"
          ? permittedEvidence.slice(offset, offset + limit)
            .map(({ receipt }) => { const { preview: _preview, ...entry } = modelEvidencePreview(receipt); return entry; })
          : [...legalEvidenceState.queries.values()].slice(offset, offset + limit).map(modelResearchQueryPreview);
        const total = requested === "evidence" ? permittedEvidence.length : legalEvidenceState.queries.size;
        return result({ total, items: values, next_offset: offset + limit < total ? offset + limit + 1 : null });
      }
      if (/^e_/u.test(requested)) {
        const saved = researchContext?.subjects?.flatMap(({ savedEvidence }) => savedEvidence ?? [])
          .find(({ evidence_id }) => evidence_id === requested);
        if (saved && !legalEvidenceState.evidence.has(requested)) registerLegalEvidence(legalEvidenceState, saved);
        const entry = readPriorLegalEvidence(legalEvidenceState, requested);
        return entry && inScope({ resource: legalEvidenceResourceReference(entry.receipt) ?? "", evidence: [entry.receipt] })
          ? { ...result(modelEvidencePassage(entry.receipt)), evidence: [entry.receipt] } : fail("Evidence unavailable in the selected scope");
      }
      if (/^q_/u.test(requested)) {
        const query = legalEvidenceState.queries.get(requested);
        const offset = Math.max(0, Number(args.offset ?? 1) - 1), limit = Math.min(50, Number(args.limit ?? 20));
        return query ? result({ ...modelResearchQuery(query), results: query.results.slice(offset, offset + limit),
          total: query.results.length, next_offset: offset + limit < query.results.length
            ? offset + limit + 1 : null }) : fail("Search receipt not found");
      }
    }
    const reference = call.name === "Read" ? parseResourceReference(requested) : null;
    const workspaceId = reference?.kind === "document" &&
      (reference.documentId === researchContext?.workspace?.documentId ||
        knownDocumentNames.get(reference.documentId)?.toLowerCase().endsWith(".research.md")) ? reference.documentId : undefined;
    if (workspaceId && sources) {
      const saved = await sources.get(scope, workspaceId);
      if (saved) {
        if (researchContext && !researchContext.restricted) Object.assign(researchContext,
          await sources.context(scope, saved.document.id));
        turnEditState?.set(saved.document.id, { versionId: saved.versionId, workingRevision: saved.workingRevision,
          parentVersionId: saved.versionId, turnVersionId: turnEditState?.get(saved.document.id)?.turnVersionId });
        return readResearchWorkspace(documents, scope, saved, args, signal, legalEvidenceState, researchContext);
      }
    }
    if (researchContext?.subjects && (reference?.kind === "source" || reference?.kind === "document") && !workspaceId) {
      const selected = researchContext.subjects?.filter(({ resource }) => resource === requested) ?? [];
      const locatorKey = (label: string) => JSON.stringify(collapseProvisionLabels([label], String(args.locator_kind)) ?? [label]),
        saved = String(args.locator ?? "").split(/\s*,\s*/u).map((label) =>
          selected.flatMap(({ savedEvidence }) => savedEvidence ?? []).find(({ locator }) =>
            locator.kind === args.locator_kind && locatorKey(locator.label) === locatorKey(label)));
      if (saved.every((receipt) => receipt !== undefined) && legalEvidenceState && !args.context_blocks && !args.pattern && !args.section &&
        (!args.end_locator || args.end_locator === args.locator) && (!args.references || args.references === "none")) {
        saved.forEach((receipt) => registerLegalEvidence(legalEvidenceState, receipt));
        if (saved.every(({ evidence_id }) => readPriorLegalEvidence(legalEvidenceState, evidence_id)))
          return { ...result(saved.length === 1 ? modelEvidencePassage(saved[0]) : saved.map(modelEvidencePassage)), evidence: saved };
      }
      if (selected.some(({ evidence }) => evidence !== undefined) || !args.locator_kind && !args.section && !args.pattern && !args.references &&
          args.mode !== "drafting" && args.mode !== "redline") return readResearchContext(documents, scope, researchContext,
        { resource: requested, offset: Number(args.offset) || 1, start_char: Number(args.start_char) || 0,
          limit: Number(args.limit) || 100, signal, callId: call.id, reader: readerAssignment });
      if (researchContext.restricted && !selected.length) return fail("Source is outside the selected research scope");
    }
    const sourceRead = await readLegalSourceResource(call, args, {
      userId,
      signal,
      reader: readerAssignment,
      knownSources,
    });
    if (sourceRead) return sourceRead;
    return runCodingShapeCall(call, args, {
      documents, library, projects, scope, matterId, turnEditState, turnId,
      workflows: availableWorkflows, editMode, documentNames: knownDocumentNames,
      docIndex, progress, signal,
    });
  };
  const documentTool = (
    run: (
      call: Readonly<NormalizedToolCall>,
      input: Record<string, unknown>,
      documentId: string,
      signal: AbortSignal,
    ) => Promise<AssistantOutcome>,
  ): AssistantToolRun => async (call, input, signal) => {
    const reference = trimmed(input.document_id);
    const resource = reference ? parseResourceReference(reference) : null;
    if (reference && resource?.kind !== "document")
      return fail("document_id must be a document resource returned by Glob");
    const resolved = resource?.kind === "document"
      ? { ...input, document_id: resource.documentId, version_id: resource.versionId }
      : input;
    const documentId = trimmed(resolved.document_id);
    if (documentId && (matterId
      ? allowedDocumentIds && !allowedDocumentIds.has(documentId)
      : !await library.document({ ...scope, kind: "file" }, documentId))) {
      return fail("Document is outside this chat's document scope");
    }
    return run(call, resolved, documentId, signal);
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
    // A stage can wait on work this process cannot see: every long native call is a
    // libuv thread-pool task, and a Write queued behind PDF preparation logs nothing
    // at all while it waits. Name the stage that is still waiting.
    const stage = async <T>(name: string, run: () => Promise<T>) => {
      const started = Date.now();
      const watchdog = setInterval(() => console.warn(
        `[write] stage ${name} exceeded ${Math.round((Date.now() - started) / 1000)}s`,
        { filename }), WRITE_STAGE_WARNING_MS);
      watchdog.unref();
      try { return await run(); } finally { clearInterval(watchdog); }
    };
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
      const cited = docxCitationEntries(legalEvidenceState, args.citations);
      if (legalEvidenceState) {
        const integrityErrors = legalEvidenceProseIntegrityErrors(
          markdown,
          cited.flatMap(({ input }) => input.evidenceIds),
          legalEvidenceState,
        );
        if (integrityErrors.length) {
          console.warn("[write] draft integrity rejected", { filename, errors: integrityErrors });
          return fail(`Draft integrity check failed: ${integrityErrors.join("; ")}`);
        }
      }
      const evidence = await stage("passage-links", async () =>
        resolveDocxEvidenceCitations(legalEvidenceState, args.citations));
      const rendered = await stage("render", () => renderMarkdownDocx(
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
      ));
      const authorityLedger = await stage("authority-ledger", () => createDocxAuthorityLedger(
        legalEvidenceState, rendered.bytes, evidence, rendered.appearances,
      ));
      return stage("persist", () => persistGenerated(
        filename,
        rendered.bytes,
        {
          schemaVersion: 1,
          actor: "assistant",
          action: "created",
          generation: {
            rendererVersion: "beaver.docx-markdown.v2",
            markdownSha256: sha256(markdown),
            fieldValuesSha256: sha256(JSON.stringify(args.fields ?? {})),
            sourceRegistrySha256: sha256(
              JSON.stringify(args.citations ?? {}),
            ),
            evidenceBindings: evidence.bindings,
            ...(authorityLedger ? { authorityLedger } : {}),
          },
        },
      ));
    } catch (error) {
      console.warn("[write] failed", { filename, error: error instanceof Error ? error.message : String(error) });
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
    async (_call, args, documentId) => {
      const action = args.action as "fix_supras" | "lint_structure";
      try {
        return await runDocxWorkflow(action, documentId,
          trimmed(args.version_id) || undefined,
          { documents, scope, turnEditState, turnId, editMode });
      } catch (error) {
        return fail(safeErrorMessage(error, action === "fix_supras"
          ? "DOCX supra cleanup failed" : "DOCX structural lint failed"));
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
          const entry = objectRecord(value);
          const resource = entry?.resource;
          const source = typeof resource === "string" ? researchSourceFromResource(resource) : null;
          if (source) {
            knownSources.set(researchSourceResource(source), { ...source,
              title: trimmed(entry?.title) || null, citation: trimmed(entry?.citation) || source.citation,
              url: trimmed(entry?.url) || null });
          }
          return typeof resource === "string" && resource.startsWith("source://")
            ? [resource] : [];
        }).map((resource, rank) => ({ rank: rank + 1, resource }))
      : [];
    const { query: _query, ...modelSearch } = searched;
    return {
      ...result({ ...modelSearch, ...(Array.isArray(searched.results) ? {
        results: searched.results.map((value) => {
          const { provider: _provider, id: _id, passageStart: _start,
            passageEnd: _end, ...hit } = objectRecord(value) ?? {};
          return Object.fromEntries(Object.entries(hit).filter(([, value]) =>
            value !== null && value !== undefined && value !== ""));
        }),
      } : {}) }),
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
    if (!sources) return fail("Sources workspace operations are unavailable");
    const operation = { audit, executor: "assistant" as const, model, turnId, chatId,
      ...researchOperation, callId: call.id };
    const edit = turnEditState?.get(documentId), versionId = edit?.versionId ?? trimmed(input.version_id);
    if (!edit) return fail("Read the research file before changing it");
    if (command.type === "file-findings") {
      const saved = await sources.saveFindings(scope, documentId, {
        references: researchFindingReferenceSchema.array().min(1).max(500).parse(command.references),
        typeId: trimmed(command.typeId) || undefined, versionId, workingRevision: edit.workingRevision ?? 0 }, operation);
      Object.assign(edit, { versionId: saved.file.versionId, workingRevision: saved.file.workingRevision });
      return result({ filed: saved.saved, version_id: saved.file.versionId, working_revision: saved.file.workingRevision });
    }
    if (command.type === "memo") {
      const title = trimmed(command.title), markdown = typeof command.markdown === "string"
        ? command.markdown.trim() : "", research = await sources.get(scope, documentId);
      if (!title || title.length > 200 || !markdown || markdown.length > 250_000)
        return fail("memo requires a title and Markdown content");
      if (!research || research.versionId !== versionId ||
          research.workingRevision !== edit.workingRevision) return fail("Version conflict");
      const ids = [...new Set(Array.isArray(input.evidence_ids)
        ? input.evidence_ids.map(trimmed).filter(Boolean) : [])], wanted = new Set(ids),
        sourceByKey = new Map(Object.values(research.state.sources).map((source) =>
          [researchSourceKey(source.reference), source])), sourceIds = [...new Set(ids.flatMap((id) => {
          const receipt = legalEvidenceState?.evidence.get(id)?.receipt,
            reference = receipt && researchReferenceFromEvidence(receipt);
          return reference ? [sourceByKey.get(researchSourceKey(reference))?.id].filter(
            (value): value is string => !!value) : []; }))],
        savedEvidence = new Map<string, ResearchEvidence>();
      for (let offset = 0; offset < sourceIds.length; offset += 100)
        [...(await readResearchEvidenceParts(documents, scope, research,
          sourceIds.slice(offset, offset + 100))).values()].flatMap(Object.values)
          .forEach((item) => { if (wanted.has(item.receipt.evidence_id))
            savedEvidence.set(item.receipt.evidence_id, item); });
      const citations = ids.map((id) => {
          const saved = legalEvidenceState?.evidence.has(id) ? savedEvidence.get(id) : undefined,
            receipt = saved?.receipt, source = saved && research.state.sources[saved.sourceId];
          if (!receipt || !source) return null;
          return researchMemoCitation(research, source, receipt).markdown;
        });
      if (citations.some((citation) => citation === null)) return fail("Unknown or unsaved evidence ID");
      const links = new Map(ids.map((id, index) => [id, citations[index]!]));
      if ([...markdown.matchAll(/\[@([^\]\n]+)\]/gu)].some((match) => !links.has(match[1])))
        return fail("Use saved evidence IDs in inline citations: [@evidence_id]");
      const body = markdown.replace(/^#\s+[^\r\n]*(?:\r?\n)+/u, "")
        .replace(/\[@([^\]\n]+)\]/gu, (_marker, id: string) => links.get(id)!);
      const memo = `${command.mode === "append" && research.state.note ? `${research.state.note}\n\n` : ""}` +
        `## ${title.replace(/[\r\n#]/gu, " ")}\n\n${body}`;
      const { file: next } = await sources.update(scope, documentId, { versionId, workingRevision: edit.workingRevision,
        action: { type: "note", markdown: memo, expectedMarkdown: research.state.note } },
      { operation, assistant: { turnVersionId: edit.turnVersionId, turnId }, signal });
      turnEditState?.set(documentId, { versionId: next.versionId, workingRevision: next.workingRevision,
        parentVersionId: edit.parentVersionId, turnVersionId: next.versionId });
      return mutationResult({ ok: true, action: "updated", document_id: next.document.id,
        version_id: next.versionId, filename: next.document.filename,
        resource: resourceReference.document(next.document.id, next.versionId) });
    }
    let next, pendingChange, queryId: string | undefined, performed: ResearchFileAction | undefined,
      matched: LegalEvidenceReceipt[] = [], queryReceipt: ResearchQueryReceipt | undefined,
      checkpointed = false, coverage: Awaited<ReturnType<typeof runResearchFileQuery>>["coverage"] | undefined;
    let savedEvidenceIds: string[] = [];
    if (command.type === "query") {
      const rules = command.rules === undefined ? undefined
        : researchCaptureRuleSchema.array().max(50).parse(command.rules);
      const queried = await sources.query(scope, documentId,
        { versionId, workingRevision: edit.workingRevision, text: trimmed(command.text),
        syntax: command.syntax === "literal" ? "literal" : "terms",
        target: command.target === "passages" ? "passages" : "sources",
        limit: Math.max(1, Math.min(rules?.length ? 5_000 : 25,
          Math.trunc(Number(command.limit) || 25))),
        ...(command.after !== undefined ? { after: String(command.after) } : {}),
        sourceIds: Array.isArray(command.sourceIds)
          ? command.sourceIds.filter((id): id is string => typeof id === "string")
          : undefined,
        evidenceIds: Array.isArray(command.evidenceIds) ? command.evidenceIds.map(trimmed).filter(Boolean) : undefined,
        members: command.members as import("../researchSelection").ResearchSelection["members"],
        labelIds: Array.isArray(command.labelIds)
          ? command.labelIds.filter((id): id is string => typeof id === "string") : [],
        unlabelled: command.unlabelled === true || undefined,
        rules, conflict: command.conflict === "prompt" || command.conflict === "longer" ||
          command.conflict === "shorter" || command.conflict === "append" ? command.conflict : "first" },
          { signal, operation, context: researchContext?.workspace?.documentId === documentId ? researchContext : undefined,
            actor: { model, callId: call.id }, priorQueries: legalEvidenceState?.queries.values(),
            assistant: { turnVersionId: edit.turnVersionId, turnId } });
      next = queried.file; queryId = queried.receipt.query_id; matched = queried.evidence;
      if (command.target === "passages") matched = (await restoreResearchEvidence(
        documents, scope, matched, signal)).map(({ receipt }) => receipt);
      queryReceipt = queried.receipt; checkpointed = queried.checkpointed; coverage = queried.coverage;
    } else {
      let action: ResearchFileAction;
      if (command.type === "save") {
        if (!legalEvidenceState) throw new Error("No verified legal evidence is available");
        const queryIds = Array.isArray(input.query_ids)
          ? input.query_ids.filter((id): id is string => typeof id === "string") : [];
        const queries = queryIds.map((id) => legalEvidenceState.queries.get(id));
        const evidenceIds = new Set(Array.isArray(input.evidence_ids)
          ? input.evidence_ids.filter((id): id is string => typeof id === "string") : []);
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
        if (action.type === "label") {
          if (action.id && !(await sources.get(scope, documentId))
            ?.state.labels[action.id]) throw new Error("Unknown label ID");
          if (!action.id) action = { ...action, id: randomUUID() };
        }
        if (action.type === "source") {
          const wanted = action, verified = researchQuerySources(
            [...(legalEvidenceState?.queries.values() ?? [])],
          ).filter((source) => source.provider === wanted.reference.provider &&
              source.id === wanted.reference.id && source.kind === wanted.reference.kind &&
              (source.part ?? null) === (wanted.reference.part ?? null) &&
              (!wanted.reference.family || source.family === wanted.reference.family) &&
              (!wanted.reference.collection || source.collection === wanted.reference.collection) &&
              (!wanted.reference.language || source.language === wanted.reference.language));
          if (verified.length !== 1)
            throw new Error("Source must identify one current verified search result");
          action = { ...wanted, reference: { ...wanted.reference, ...verified[0] } };
        }
      }
      performed = action;
      ({ file: next, pendingChange } = await sources.update(scope, documentId, { versionId, workingRevision: edit.workingRevision, action },
        { operation, assistant: { turnVersionId: edit.turnVersionId, turnId }, signal }));
      checkpointed = next.versionId !== versionId ||
        next.workingRevision !== edit.workingRevision;
    }
    const preview = matched.slice(0, 25);
    if (researchContext?.workspace?.documentId === documentId && !researchContext.restricted)
      Object.assign(researchContext, await sources.context(scope, documentId));
    if (checkpointed) turnEditState?.set(documentId, { versionId: next.versionId,
      workingRevision: next.workingRevision,
      parentVersionId: edit.parentVersionId, turnVersionId: next.versionId });
    const sourceByKey = new Map(Object.values(next.state.sources).map((source) =>
      [researchSourceKey(source.reference), source])), sourceId = performed?.type === "source"
      ? sourceByKey.get(researchSourceKey(performed.reference))?.id : undefined;
    const saved = savedEvidenceIds.flatMap((evidence_id) => {
      const receipt = legalEvidenceState?.evidence.get(evidence_id)?.receipt,
        reference = receipt && researchReferenceFromEvidence(receipt),
        source = reference && sourceByKey.get(researchSourceKey(reference));
      return source ? [{ evidence_id, source_id: source.id }] : [];
    });
    const content = { ok: true, document_id: next.document.id, status: pendingChange ? "pending" : "applied",
      ...(pendingChange ? { applied: false, change_id: pendingChange.id, message: "This change is waiting for acceptance. It has not been applied. Tell the user it is pending, not completed." } : { applied: true }),
      version_id: next.versionId, filename: next.document.filename,
      resource: resourceReference.document(next.document.id, next.versionId),
      proposals: next.state.proposals ?? [], history: next.state.history,
      ...(performed?.type === "label" ? { label_id: performed.id } : {}),
      ...(sourceId ? { source_id: sourceId } : {}), ...(saved.length ? { saved } : {}),
      ...(queryId ? { query_id: queryId, match_count: matched.length, coverage,
        ...(queryReceipt?.failures.length ? { failures: queryReceipt.failures } : {}),
        matches: preview.map(compactEvidence), ...(matched.length > preview.length
          ? { matches_truncated: true } : {}) } : {}),
      counts: { labels: Object.keys(next.state.labels).length,
        sources: Object.keys(next.state.sources).length,
        passages: Object.values(next.state.sources).reduce((sum, source) =>
          sum + (source.passages?.count ?? 0), 0),
        searches: next.state.queries?.count ?? 0 } };
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
        if (!includeResearchTools) return Promise.resolve(fail("Research is unavailable in this chat"));
        if (objectRecord(input.research_action)?.type === "create") {
          const title = trimmed(objectRecord(input.research_action)?.title);
          if (!title || title.length > 200) return Promise.resolve(fail("create requires a title"));
          if (!sources) return fail("Sources workspace operations are unavailable");
          // Reuse this chat's bound workspace; repeated creates otherwise orphan Library files.
          const createActor = { audit, executor: "assistant" as const, model, turnId, chatId,
            ...researchOperation, callId: call.id };
          let file = chatId ? await sources.ensure(scope, { chatId, title, projectId: matterId }, createActor)
            : await sources.create(scope, { title, projectId: matterId }, createActor);
          onMutationCommitted();
          if (onResearchWorkspace) file = await onResearchWorkspace(file.document.id, legalEvidenceState) ?? file;
          return publishGenerated(file.document, file.workingRevision);
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
    const id = trimmed(input.draft_id);
    if (!id) throw new Error("Select an Authorities draft_id");
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
  // Boundary work reads spans, not just rows: every listing carries what it would correct.
  const span = (value: AuthorityTextSpan | null) => value && ({ start: value.start,
    end: value.end, text: clip(value.text, 500) });
  const boundaries = (item: AuthorityOccurrence) => ({
    start: item.start, end: item.end, kind: item.kind, citation: clip(item.citation, 300),
    authority_id: item.authorityId, authority_span: span(item.authoritySpan),
    pinpoint_span: span(item.pinpointSpan), pinpoints: item.pinpoints,
    ...(item.reference ? { reference: item.reference } : {}) });
  const authorityLabel = (draft: AuthoritiesDraft, id: string | null) => {
    const item = id ? draft.authorities[id] : null;
    return id ? { id, label: clip([item?.displayName ?? item?.name, item?.citation]
      .filter(Boolean).join(", "), 200) || id } : null;
  };
  // The reply narrates the edit, not the draft: unless the mutation result says what
  // this call moved, the model reads back the final state and reports nothing changed.
  const authoritiesChanges = (before: AuthoritiesDraft, after: AuthoritiesDraft) => {
    const ids = [...new Set([...Object.keys(before.occurrences),
      ...Object.keys(after.occurrences)])];
    const changed = ids.flatMap((id) => {
      const was = before.occurrences[id], now = after.occurrences[id];
      if (!now) return [{ occurrence_id: id, unit_id: was.unitId,
        status: "removed", ...boundaries(was) }];
      if (!was) return [{ occurrence_id: id, unit_id: now.unitId,
        status: "added", ...boundaries(now) }];
      const fields: Record<string, unknown> = {};
      const differs = (key: string, left: unknown, right: unknown) => {
        if (JSON.stringify(left ?? null) !== JSON.stringify(right ?? null)) {
          fields[key] = { before: left ?? null, after: right ?? null };
        }
      };
      differs("citation", clip(was.citation, 300), clip(now.citation, 300));
      differs("kind", was.kind, now.kind);
      differs("authority_span", span(was.authoritySpan), span(now.authoritySpan));
      differs("pinpoint_span", span(was.pinpointSpan), span(now.pinpointSpan));
      differs("pinpoints", was.pinpoints, now.pinpoints);
      differs("authority", authorityLabel(before, was.authorityId),
        authorityLabel(after, now.authorityId));
      differs("reference", was.reference, now.reference);
      return Object.keys(fields).length ? [{ occurrence_id: id, unit_id: now.unitId,
        status: "updated", ...fields }] : [];
    });
    // add-occurrence and relink-occurrence mint and orphan authorities, and the
    // authority list is the half of the edit the occurrence rows cannot show.
    const minted = (from: AuthoritiesDraft, to: AuthoritiesDraft) => to.authorityOrder
      .filter((id) => !from.authorityOrder.includes(id)).slice(0, 20)
      .flatMap((id) => { const item = authorityLabel(to, id); return item ? [item] : []; });
    const added = minted(before, after), removed = minted(after, before);
    return { changed: changed.slice(0, 50),
      ...(changed.length > 50 ? { changed_truncated: true } : {}),
      ...(added.length ? { authorities_added: added } : {}),
      ...(removed.length ? { authorities_removed: removed } : {}) };
  };
  const authoritiesPayload = (product: Awaited<ReturnType<typeof authorities.importDraft>>,
    input: Record<string, unknown> = {}, values: Record<string, unknown> = {}) => {
    const draft = decodeAuthoritiesDraft(product.state);
    if (!draft) return workProductPayload(product, values);
    const focus = product.id === authoritiesId ? workProductFocus : undefined;
    const requestedUnitId = trimmed(input.unit_id), requestedOccurrenceId = trimmed(input.occurrence_id);
    const targeted = Boolean(requestedUnitId || requestedOccurrenceId);
    const occurrenceId = requestedOccurrenceId || (!requestedUnitId ? focus?.itemId : "") || "";
    if (occurrenceId && requestedUnitId) throw new Error(
      "Read either one unit_id or one occurrence_id");
    const occurrence = occurrenceId ? draft.occurrences[occurrenceId] : null;
    if (occurrenceId && !occurrence) throw new Error(`Unknown occurrence: ${occurrenceId}`);
    const unitId = requestedUnitId || occurrence?.unitId || "";
    const unit = unitId ? draft.units.find(({ id }) => id === unitId) : null;
    if (unitId && !unit) throw new Error(`Unknown unit: ${unitId}`);
    const authorityIds = targeted ? [...new Set((occurrence ? [occurrence.id] : unit!.occurrenceIds)
      .flatMap((id) => {
        const item = draft.occurrences[id];
        return item ? [item.authorityId, item.reference?.targetAuthorityId]
          .filter((id): id is string => Boolean(id)) : [];
      }))] : draft.authorityOrder;
    const authorityOffset = Math.max(0, Math.trunc(Number(input.authority_offset) || 0));
    const authorityLimit = Math.max(1, Math.min(50,
      Math.trunc(Number(input.authority_limit) || 25)));
    const occurrenceOffset = Math.max(0,
      Math.trunc(Number(input.occurrence_offset) || 0));
    const occurrenceLimit = Math.max(1, Math.min(25,
      Math.trunc(Number(input.occurrence_limit) || 25)));
    const boundResource = (bindingRole: string) => {
      const binding = draft.bindings[bindingRole];
      return binding?.kind === "document" && typeof binding.version === "object"
        ? resourceReference.document(binding.documentId, binding.version.versionId) : null;
    };
    const authority = (id: string) => {
      const item = draft.authorities[id];
      if (!item) return null;
      const source = item.source;
      return { id, kind: item.kind, citation: clip(item.citation),
        name: clip(item.displayName ?? item.name),
        excluded: item.excluded, source: { status: source.kind,
          ...(source.kind === "attached" ? { pdf_count: source.sources.length,
            pdfs: source.sources.map(({ bindingRole, filename, language }) => ({
              binding_role: bindingRole, filename: clip(filename, 300), language,
              ...((resource) => resource ? { resource } : {})(boundResource(bindingRole)),
            })) } : {}),
          ...(source.kind === "pending-canlii" ? { page_url: clip(source.pageUrl, 1_000) } : {}) } };
    };
    const part = (item: typeof draft.bookParts.cover) => item && ({
      binding_role: item.bindingRole, filename: clip(item.filename, 300),
    });
    const source = draft.import.kind === "document" ? {
      kind: draft.import.kind, filename: clip(draft.import.filename, 300),
      file_type: draft.import.fileType, binding_role: draft.import.bindingRole,
      ...((resource) => resource ? { resource } : {})(boundResource(draft.import.bindingRole)),
    } : { kind: draft.import.kind };
    const summary: Record<string, unknown> = { ...(!targeted && {
      source,
      output_mode: draft.outputMode,
      cover: draft.cover,
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
      book_parts: { cover: part(draft.bookParts.cover), index: part(draft.bookParts.index),
        supplements: draft.bookParts.supplements.map(({ id, bindingRole, filename }) => ({
          id, binding_role: bindingRole, filename: clip(filename, 300),
        })) },
      insert_into_document: draft.insertIntoDocument,
      counts: { units: draft.units.length, occurrences: Object.keys(draft.occurrences).length,
        authorities: draft.authorityOrder.length },
      // Unit ids are not guessable: without them a sweep probes past the last unit.
      unit_index: draft.units.slice(0, 200).map(({ id, kind, ordinal, occurrenceIds }) =>
        ({ id, kind, ordinal, occurrence_count: occurrenceIds.length })),
      }),
      authorities: authorityIds.slice(authorityOffset, authorityOffset + authorityLimit)
        .map(authority).filter(Boolean),
      authority_page: { offset: authorityOffset, limit: authorityLimit,
        has_more: authorityOffset + authorityLimit < authorityIds.length },
    };
    if (!occurrenceId && !requestedUnitId) {
      const ids = draft.units.flatMap(({ occurrenceIds }) => occurrenceIds);
      summary.occurrence_index = ids.slice(occurrenceOffset,
        occurrenceOffset + occurrenceLimit).flatMap((id) => {
        const item = draft.occurrences[id];
        return item ? [{ id, unit_id: item.unitId, ...boundaries(item) }] : [];
      });
      summary.occurrence_page = { offset: occurrenceOffset, limit: occurrenceLimit,
        has_more: occurrenceOffset + occurrenceLimit < ids.length };
    }
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
          return item ? [{ id, ...boundaries(item) }] : [];
        }), occurrence_count: unit.occurrenceIds.length };
    }
    if (occurrence) {
      summary.occurrence = { id: occurrence.id, unit_id: occurrence.unitId,
        ...boundaries(occurrence), text: clip(occurrence.text, 1_000),
        core_span: span(occurrence.coreSpan), reference: occurrence.reference };
      if (occurrence.id === focus?.itemId) summary.focus = {
        occurrence_id: occurrence.id, selection: focus.selection ?? null };
    }
    return workProductPayload(product, { draft: summary,
      ...(!targeted && { output_roles: Object.keys(product.outputs ?? {}) }), ...values });
  };
  const authoritiesMutationPayload = (
    product: Awaited<ReturnType<typeof authorities.importDraft>>,
    change: Record<string, unknown>,
    before?: AuthoritiesDraft | null,
  ) => {
    const draft = decodeAuthoritiesDraft(product.state), outputRoles = Object.keys(product.outputs ?? {});
    return workProductPayload(product, {
      change: { ...change, ...(before && draft ? authoritiesChanges(before, draft) : {}) },
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
    // Freshness is the output's, not the draft's: as "unbuilt" it read back as an absent draft.
    return { output_freshness: resolution.freshness, input_issue_count: issues.length,
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
    const version = await documents.metadata(scope, document.documentId);
    if (!version || version.current_version_id !== document.versionId ||
        version.file_type.toLowerCase() !== "pdf") {
      throw new Error("Select the current PDF version from Library");
    }
    return { ...document, version: { filename: version.filename,
      source_sha256: version.source_sha256 } };
  };
  const authoritiesAction = (value: unknown,
    product: { id: string; state: unknown }): AuthoritiesUserAction | null => {
    const action = objectRecord(value);
    if (!action) return null;
    const focus = product.id === authoritiesId ? workProductFocus : undefined;
    const occurrenceId = trimmed(action.occurrenceId) || focus?.itemId,
      selection = occurrenceId === focus?.itemId ? focus?.selection : undefined;
    const anchor = anchoredRange(product.state, occurrenceId ?? "", action);
    return decodeAuthoritiesUserAction({ ...action, occurrenceId,
      start: action.start ?? anchor?.start ?? selection?.start,
      end: action.end ?? anchor?.end ?? selection?.end,
      cursor: action.cursor ?? anchor?.cursor ?? selection?.start });
  };
  const activeCourtTool = courtRecord && courtRecords ? courtRecordSlotTool<Context>({
    scope, target: courtRecord, projectId: workProductProjectId,
    allowedDocumentIds, library, workProducts, courtRecords, documents, resolveArtifact,
    onMutationCommitted: () => {},
  }) : null;
  // Every assistant can look at a page; the Court Record only adds entry_id (Eli, 2026-09-10).
  const pageTool = courtRecordPageTool<Context>({
    scope, target: courtRecord ?? undefined, projectId: workProductProjectId,
    allowedDocumentIds, library, workProducts, documents, resolveArtifact,
  });
  const updateWorkProduct: AssistantToolRun = async (call, input, signal) => {
    const kind = input.kind as WorkProductKind;
    const respond = (raw: Record<string, unknown>, mutated = false,
      evidence?: LegalEvidenceReceipt[]) => {
      const payload = JSON.stringify(raw).length < MAX_MODEL_TOOL_RESULT_CHARS - 1_000 ? raw : {
        ok: raw.ok, ...(objectRecord(raw.work_product)
          ? { work_product: raw.work_product } : {}), truncated: true,
        detail: "Read again with a narrower unit, occurrence, or authority page.",
      };
      const productId = trimmed(objectRecord(payload.work_product)?.id);
      if (legalEvidenceState && productId && productId === authoritiesId) {
        collectDraftCitations(payload, legalEvidenceState.reportedCitations ??= new Set());
      }
      const outcome = withEvent(payload.ok === true
        ? (mutated ? mutationResult(payload) : result(payload))
        : fail(clip(payload.error || "The work product could not be updated", 1_000)),
      workProductEvent(payload, productId ? `work-product:${productId}` : call.id));
      return evidence?.length ? { ...outcome, evidence } : outcome;
    };
    if (!WORK_PRODUCT_KINDS.includes(kind)) {
      return respond({ ok: false, error: "Select a supported work-product kind" });
    }
    if (kind === "authorities" && productFeatures?.authorities === false) {
      return respond({ ok: false, error: "Authorities is turned off in Settings." });
    }
    try {
      const requestedId = trimmed(input.draft_id);
      if (!requestedId &&
          (input.action === "read" || input.action === "select")) {
        return respond({ ok: true, ...(await workProductChoices(kind)),
          requested_action: "choose" });
      }
      if (input.action === "create") {
        if (trimmed(input.draft_id)) throw new Error("create does not accept draft_id");
        if (kind === "court-record") {
          const profileId = trimmed(input.profile_id);
          if (!COURT_PROFILE_BY_ID.has(profileId)) {
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
        const id = trimmed(input.draft_id);
        if (!id) throw new Error("Select a Court Record draft_id");
        const product = await workProducts.get(scope, id);
        if (product.kind !== "court-record" || product.projectId !== workProductProjectId) {
          throw new Error("Draft is outside this chat's work-product scope");
        }
        if (activeCourtTool && id === courtRecord?.id && input.action !== "select") {
          if (input.action !== "read" && input.action !== "update") {
            throw new Error("Open the Court Record to refresh or build it");
          }
          return activeCourtTool.execute(input, {} as Context, signal, call);
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
          workProducts, courtRecords, documents, resolveArtifact, onMutationCommitted: () => {},
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
        // A verdict has to rest on the passage that proves it, so the retrieved
        // source passage is returned as evidence rather than described in prose.
        const receipts: LegalEvidenceReceipt[] = [];
        const compact = discrepancies.slice(0, 40).map((item) => {
          const receipt = item.citedPassage && legalSourceEvidence(item.citedPassage);
          if (receipt) receipts.push(receipt);
          return { kind: item.kind, occurrence_id: item.occurrenceId,
            authority_id: item.authorityId, footnote_id: item.footnoteId,
            citation: clip(item.citation), proposition: clip(item.proposition, 700),
            authored_quote: clip(item.authoredQuote, 500),
            authored_pinpoint: item.authoredPinpoint,
            cited_locator: item.cited.locator,
            ...(receipt ? { source_evidence_id: receipt.evidence_id } : {}),
            ...(item.found ? { suggested_locator: item.found.locator } : {}) };
        });
        const offset = Math.max(0, Math.trunc(Number(input.occurrence_offset) || 0));
        const limit = Math.max(1, Math.min(25, Math.trunc(Number(input.occurrence_limit) || 10)));
        const flagged = new Set(discrepancies.map(({ occurrenceId }) => occurrenceId));
        const draft = decodeAuthoritiesDraft(target.product.state);
        const propositions = draft ? footnotePropositions(draft.units) : new Map();
        // Every proposition the draft advances is in issue, machine-checkable or not.
        const worklist = (draft?.units ?? []).flatMap((unit) => {
          const occurrence = draft && singleSourceFootnote(draft, unit);
          const proposition = unit.footnoteId && propositions.get(unit.footnoteId)?.text;
          if (!occurrence?.authorityId || !proposition) return [];
          const authority = draft!.authorities[occurrence.authorityId];
          const reason = flagged.has(occurrence.id) ? null
            : !authority?.sourceIdentity ? "no source attached"
              : occurrence.pinpoints.length !== 1 ? "no single pinpoint to check"
                : null;
          return [{ occurrence_id: occurrence.id, footnote_id: unit.footnoteId,
            citation: clip(occurrence.citation, 300), authority_id: occurrence.authorityId,
            proposition: clip(proposition, 700), pinpoints: occurrence.pinpoints,
            verdict_required: true,
            ...(flagged.has(occurrence.id) ? { machine_finding: true } : {}),
            ...(reason ? { unverified: reason } : {}) }];
        });
        // Checkable propositions first: a review that runs out of budget should
        // spend it on verdicts it can prove, not on sources nobody attached.
        worklist.sort((left, right) =>
          Number(Boolean(right.machine_finding)) - Number(Boolean(left.machine_finding)) ||
          Number(Boolean(left.unverified)) - Number(Boolean(right.unverified)) ||
          (left.footnote_id ?? 0) - (right.footnote_id ?? 0));
        return respond(authoritiesPayload(target.product, input, { ...issues,
          discrepancy_count: discrepancies.length, discrepancies: compact,
          discrepancies_truncated: discrepancies.length > compact.length,
          proposition_count: worklist.length,
          propositions: worklist.slice(offset, offset + limit),
          proposition_page: { offset, limit, has_more: offset + limit < worklist.length } }),
        false, receipts);
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
      const supplementId = trimmed(input.supplement_id);
      const action = authoritiesAction(input.authorities_action, target.product);
      const receipts = input.evidence_ids !== undefined;
      const attachment = Boolean(trimmed(input.document_id) || authorityId || bookSlot || supplementId);
      if ([Boolean(action), attachment, receipts].filter(Boolean).length !== 1) {
        throw new Error("Update Authorities with exactly one edit, PDF attachment, or evidence list");
      }
      if (action) {
        const before = decodeAuthoritiesDraft(target.product.state);
        const product = await authorities.act(scope, target.product.id, target.revision, action);
        return respond(authoritiesMutationPayload(product, { type: action.type,
          ...(action.type === "remove-book-supplement" ? { supplement_id: action.id } : {}) },
        before), true);
      }
      if (attachment) {
        if (supplementId && bookSlot !== "supplemental") {
          throw new Error("supplement_id requires the supplemental book_slot");
        }
        if (Boolean(authorityId) === Boolean(bookSlot)) {
          throw new Error("Attach the PDF to one authority_id or one book_slot");
        }
        const document = await authorizedPdf(input);
        if (authorityId) {
          const sourceLanguage = trimmed(input.source_language);
          if (sourceLanguage !== "en" && sourceLanguage !== "fr" &&
              sourceLanguage !== "bilingual") {
            throw new Error("source_language is required for an authority PDF");
          }
          const product = await authorities.attachLibraryPdf(scope, target.product.id, {
            revision: target.revision, documentId: document.documentId,
            versionId: document.versionId, target: {
              kind: "authority", authorityId, language: sourceLanguage,
            },
          });
          return respond(authoritiesMutationPayload(product,
            { type: "attach-authority-pdf", authority_id: authorityId,
              source_language: sourceLanguage }), true);
        }
        if (bookSlot !== "cover" && bookSlot !== "index" && bookSlot !== "supplemental") {
          throw new Error("Select cover, index, or supplemental as book_slot");
        }
        const product = await authorities.attachLibraryPdf(scope, target.product.id, {
          revision: target.revision, documentId: document.documentId,
          versionId: document.versionId,
          target: { kind: "book", slot: bookSlot, ...(supplementId ? { supplementId } : {}) },
        });
        const partId = bookSlot === "supplemental" ? supplementId ||
          decodeAuthoritiesDraft(product.state)?.bookParts.supplements.at(-1)?.id : undefined;
        return respond(authoritiesMutationPayload(product, {
          type: "attach-book-pdf", book_slot: bookSlot,
          ...(partId ? { supplement_id: partId } : {}),
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
  const documentName = (value: unknown) => {
    const raw = trimmed(value);
    const resolved = resolveArtifact(raw) ?? raw;
    const reference = parseResourceReference(resolved);
    const source = reference?.kind === "source" ? researchSourceFromResource(resolved) : null;
    if (source) return knownSources.get(researchSourceResource(source))?.title ?? undefined;
    return knownDocumentNames.get(reference?.kind === "document"
      ? reference.documentId : resolved);
  };
  const documentActivity = (verb: string, toolName: string, key: string) =>
    (input: Record<string, unknown>) => {
      const name = documentName(input[key]);
      if (toolName === "Edit" && name) return `${verb} ${name}`;
      return assistantToolActivityLabel(toolName, input, name) ?? null;
    };
  const present = (output: AssistantOutcome): BeaverOutcome => {
    if (output.mutated) onMutationCommitted();
    let rendered: BeaverOutcome;
    if ("artifact" in output) {
      const { artifact, ...rest } = output;
      rendered = { ...rest, result: toolText({ ok: true,
        artifact: artifactFor(artifact.document_id, artifact.version_id),
        filename: artifact.filename }), events: [artifact, ...(rest.events ?? [])] };
    } else rendered = output;
    const { events = [], ...rest } = rendered;
    return {
      ...rest,
      ...(turnScope === "main" && events.length ? { events } : {}),
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
      let output: AssistantOutcome;
      try { output = await run(call, input, signal, (label) => context.updateActivity?.(call.id, label)); }
      catch (error) { if (error instanceof ApplicationError) return present(fail(error.message)); throw error; }
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
    definition({ name: "quote_check", specialist: true, sequential: true, description: "Mechanically compare document quotations with cited sources. Returns quote IDs, citation candidates and source passages; follow next_offset. Resolve ambiguous attribution with links. Read surrounding sources to assess proposition support and misconstruction. For a requested workbook, set export_workbook; optional per-quote analysis appears in a separate AI column. The complete workbook is saved beside the input.",
      inputSchema: { type: "object", additionalProperties: false,
        properties: { document_id: { type: "string" },
          offset: { type: "integer", minimum: 0 },
          export_workbook: { type: "boolean" },
          analysis: { type: "array", maxItems: 500, items: { type: "object", additionalProperties: false,
            properties: { quoteId: { type: "string" }, text: { type: "string", maxLength: 20000 } },
            required: ["quoteId", "text"] } },
          links: { type: "array", maxItems: 500, items: { type: "object", additionalProperties: false,
            properties: { quoteId: { type: "string" }, occurrenceId: { type: "string" } },
            required: ["quoteId", "occurrenceId"] } } }, required: ["document_id"] } },
      async (_call, input, signal, progress) => {
        const document = await authorizedDocument(input);
        if (!document) throw new Error("Select a version-pinned Library document.");
        if (legalEvidenceState) (legalEvidenceState.reviewDocumentIds ??= new Set()).add(document.documentId);
        const source = await documents.projectionSource(scope, document.documentId, document.versionId);
        if (!source) throw new Error("Document version not found.");
        const draft = await createAuthoritiesImporter(documents).draft(scope, {
          kind: "document", documentId: document.documentId,
          version: { versionId: document.versionId, sha256: source.sourceSha256 } });
        const offset = Number(input.offset ?? 0);
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a non-negative integer");
        const report = await checkQuotes(draft, decodeQuoteLinks(input.links), signal,
          (done, total) => progress?.(`Checking quotation ${done} of ${total}`), undefined,
          input.export_workbook === true ? undefined : { offset, limit: 10 });
        if (input.export_workbook === true) {
          if (input.analysis !== undefined && (!Array.isArray(input.analysis) || input.analysis.length > 500 ||
            input.analysis.some((item) => !item || typeof item.quoteId !== "string" ||
              typeof item.text !== "string" || item.text.length > 20000))) throw new Error("Invalid per-quote analysis.");
          const analysis = input.analysis === undefined ? undefined : Object.fromEntries(
            (input.analysis as Array<{ quoteId: string; text: string }>).map(({ quoteId, text }) => [quoteId, text]));
          const workbook = await saveQuoteCheckWorkbook(documents, scope, document.documentId,
            report, analysis, document.versionId);
          allowedDocumentIds?.add(workbook.id);
          return artifactResult({ type: "document_artifact", action: "created", document_id: workbook.id,
            version_id: workbook.current_version_id, version_number: workbook.active_version_number,
            filename: workbook.filename,
            download_url: `/api/single-documents/${encodeURIComponent(workbook.id)}/file?version_id=${encodeURIComponent(workbook.current_version_id)}` });
        }
        return result(modelQuoteCheckReport(report, offset));
      }),
    definition(glob, codingWithArtifacts, { reader: ["CA", "US", "UK"], activity: () => null }),
    definition(grep, codingWithArtifacts, {
      reader: ["CA", "US", "UK"],
      activity: documentActivity("Searching", "Grep", "path"),
    }),
    definition(read, codingWithArtifacts, {
      reader: ["CA", "US", "UK"],
      activity: documentActivity("Reading", "Read", "file_path"),
      activityCitations: (input) => {
        const raw = trimmed(input.file_path), resource = resolveArtifact(raw) ?? raw;
        const reference = parseResourceReference(resource);
        const source = researchSourceFromResource(resource);
        if (source) {
          const known = knownSources.get(researchSourceResource(source));
          return known ? sourceActivityCitations([known]) : [];
        }
        const filename = documentName(resource);
        return reference?.kind === "document" && filename ? [{
          kind: "document", ref: 1, document_id: reference.documentId,
          version_id: reference.versionId, filename, quotes: [],
        }] : [];
      },
    }),
    definition(edit, codingWithArtifacts, {
      sequential: true,
      activity: documentActivity("Editing", "Edit", "file_path"),
    }),
    definition(WRITE_TOOL, write),
    definition(SEARCH_SOURCES_TOOL, sourceSearch),
    definition(CITATOR_TOOL, runCitator, { specialist: true }),
    ...(turnScope !== "main" ? [] : [
      definition(pageTool, (call, input, signal) =>
        pageTool.execute(input, {} as Context, signal, call), { specialist: false }),
      ...(activeCourtTool ? [definition(activeCourtTool, (call, input, signal) =>
        activeCourtTool.execute(input, {} as Context, signal, call), { specialist: false })]
        : authoritiesId ? [definition(workProductTool(true, true), (call, input, signal) =>
          updateWorkProduct(call, { ...input, kind: "authorities", draft_id: authoritiesId }, signal))] : []),
      definition(workProductTool(productFeatures?.authorities !== false, false,
        activeCourtTool || authoritiesId ? "manage_work_products" : "update_work_product"), updateWorkProduct),
    ]),
    definition(documentOperationTool(includeResearchTools), documentOperation, { specialist: !researchContext?.workspace }),
    definition(LINT_DOCUMENT_TOOL, (call, input, signal) =>
      runWorkflow(call, { ...input, action: "lint_structure" }, signal)),
    definition(ADVANCED_DOCX_EDIT_TOOL, codingWithArtifacts),
    definition(COMPARE_VERSIONS_TOOL, compare),
  ];

  if (resolveTabular) {
    tools.splice(5, 0, tabularTool(resolveTabular, researchContext));
  }
  return tools;
}

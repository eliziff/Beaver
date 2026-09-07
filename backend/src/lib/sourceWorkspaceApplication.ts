import { randomUUID } from "node:crypto";
import { ApplicationError, type ApplicationScope } from "./applicationError";
import type { AuditStore } from "./audit";
import type { ChatStore } from "./chatStore";
import type { DocumentStore } from "./documentStore";
import { sha256 } from "./hash";
import { commitResearchFile, createResearchFileState, pageResearchItems, readResearchFile,
  researchFileMarkdown, researchQueryReceipt, researchSourceResource, researchReferenceFromEvidence,
  visitResearchEvidenceParts,
  type ResearchEvidence, type ResearchFileAction, type ResearchFile,
  type ResearchQueryReceipt, type ResearchSourceReference } from "./researchFile";
import { runResearchFileQuery, verifyResearchPassage, type ResearchFileQueryInput } from "./researchFileQuery";
import { readResearchMemoCitation } from "./researchMemo";
import { resolveChatFindings, selectFindingClaims, type ResearchFinding } from "./researchChat";
import { researchFindingReferenceSchema, researchFindingKey, researchFindingWithin, type ResearchFindingReference } from "./researchFindingReference";
import { researchSelectionSchema, resolveResearchSelection, type ResearchSelection, type ResearchSubject } from "./researchSelection";
import { researchResultFilter } from "./researchReader";
import type { ResearchOperationContext } from "./researchProvenance";
import { priorLegalEvidenceReceipts, priorLegalResearchQueryReceipts,
  legalEvidenceResourceReference,
  type LegalEvidenceReceipt, type LegalResearchQueryReceipt } from "./chat/legalEvidence";
import type { AssistantEvent, LegalEvidenceReceiptEvent } from "./chat/assistantEvents";
import { parseResourceReference } from "./resourceReferences";
import { researchTableArrangement, type ResearchImportInput } from "./tabular/researchImport";
import type { TabularApplication } from "./tabular/application";
import { tabularSubjectId, type TabularCellContent, type TabularColumn,
  type TabularRepository, type TabularReview } from "./tabularStore";

type Scope = ApplicationScope;
type Operation = ResearchOperationContext;
type Observations = { evidence?: LegalEvidenceReceipt[]; queries?: Array<LegalResearchQueryReceipt | ResearchQueryReceipt>;
  sources?: ResearchSourceReference[]; chats?: string[]; tables?: string[] };
type Binding = { chatId?: string; tableId?: string; selection?: ResearchSelection | null };
type FindingsInput = { references?: ResearchFindingReference[]; sourceIds?: string[]; reference?: ResearchFindingReference; chatId?: string;
  messageIds?: string[]; offset: number; limit: number; subjects?: ResearchSubject[] };
type FindingsPage = { items: ResearchFinding[]; total: number; next_offset: number | null; is_running: boolean };
type ColumnLabelInput = { reviewId: string; columnIndex: number; rowIds?: string[]; parentId?: string;
  basis?: string; request?: string; mapping?: Array<{ value: string; label: string | null }> };
type TableInput = { tableId?: string; chatId?: string; messageIds?: string[];
  title?: string; request?: string; basis?: string; replaceTableId?: string; expectedVersion?: string;
  selection?: ResearchSelection; findingRefs?: ResearchFindingReference[] } & Partial<ResearchImportInput>;
const workspaceTitle = (filename: string) => filename.replace(/\.research\.md$/iu, "");

/** The Sources workspace use cases share the existing document, chat and table persistence ports. */
export function createSourceWorkspaceApplication(documents: DocumentStore, dependencies: {
  chats: ChatStore; tables: TabularRepository; tabular(): Promise<TabularApplication>; audit?: AuditStore["record"];
  isTableRunning?(reviewId: string, ownerId: string): Promise<boolean>;
}) {
  const operation = (value?: Operation): Operation => ({ executor: "human", audit: dependencies.audit, ...value });
  const get = (scope: Scope, id: string) => readResearchFile(documents, scope, id);
  const required = async (scope: Scope, id: string) => await get(scope, id)
    ?? fail(404, "Sources workspace not found");
  function fail(status: number, message: string, details?: Record<string, string>): never {
    throw new ApplicationError(status, message, details); }
  const conflict = (message: string): never => fail(409, message, { code: "revision_conflict" });

  // Reuse only deliberately grounded output as research membership; ordinary reads remain history.
  const groundedSources = (events: AssistantEvent[]) => {
    const ids = new Set(events.flatMap((event) => event.type === "legal_evidence_receipt" && event.status === "passed"
      ? event.claims.flatMap(({ evidence_ids }) => evidence_ids)
      : event.type === "subagent_run" && event.status === "completed" && event.grounding?.status === "passed"
        ? event.grounding.claims.flatMap(({ evidence_ids }) => evidence_ids) : []));
    return priorLegalEvidenceReceipts(events).filter(({ evidence_id }) => ids.has(evidence_id))
      .flatMap((receipt) => researchReferenceFromEvidence(receipt) ?? []);
  };
  async function collect(scope: Scope, id: string, input: Observations, actor?: Operation): Promise<ResearchFile> {
    const queries = input.queries?.map((query) => "sourceIds" in query ? query : researchQueryReceipt(query));
    for (let attempt = 0; attempt < 10; attempt++) {
      const current = await required(scope, id), saved = await commitResearchFile(documents, scope, current,
        { type: "merge", ...input, queries }, undefined, operation(actor));
      if (saved) return saved;
    }
    return conflict("The workspace changed. Try this operation again.");
  }
  async function observe(scope: Scope, id: string, event: LegalEvidenceReceiptEvent, actor?: Operation) {
    return collect(scope, id, { evidence: event.evidence, queries: event.queries, sources: groundedSources([event]),
      ...(actor?.chatId ? { chats: [actor.chatId] } : {}), ...(actor?.reviewId ? { tables: [actor.reviewId] } : {}) }, actor);
  }
  async function create(scope: Scope, input: { title: string; projectId?: string | null; folderId?: string | null } & Observations,
    actor?: Operation): Promise<ResearchFile> {
    const title = input.title.trim().replace(/\.research\.md$/iu, "");
    if (!title || title.length > 300) return fail(400, "A workspace title is required");
    const document = await documents.create(scope, { filename: `${title}.research.md`, fileType: "md",
      projectId: input.projectId ?? null, libraryKind: "file",
      folderId: input.folderId ?? null,
      ...(actor?.executor === "assistant" ? { provenance: { schemaVersion: 1 as const, actor: "assistant" as const,
        action: "created" as const, ...(actor.turnId ? { turnId: actor.turnId } : {}) } } : {}),
      bytes: Buffer.from(researchFileMarkdown(title, createResearchFileState())) });
    const { title: _title, projectId: _projectId, folderId: _folderId, ...observations } = input;
    try { return await collect(scope, document.id, observations, actor); }
    catch (error) { await documents.deleteDocument(scope, document.id, true).catch(() => undefined); throw error; }
  }
  async function update(scope: Scope, id: string, input: { versionId: string; workingRevision: number;
    action: ResearchFileAction }, options: { operation?: Operation; signal?: AbortSignal;
      assistant?: { turnVersionId?: string; turnId?: string } } = {}) {
    const current = await required(scope, id);
    if (current.versionId !== input.versionId || current.workingRevision !== input.workingRevision)
      return conflict("The workspace changed. Reload it before editing.");
    const requested = input.action, action = requested.type === "merge" ? requested
      : await verifyResearchPassage(current, requested, undefined, { documents, scope }),
      file = await commitResearchFile(documents, scope, current, action, options.assistant, operation(options.operation))
        ?? conflict("The workspace changed. Reload it before editing."),
      sourceId = requested.type === "passage" ? requested.sourceId : requested.type === "source"
        ? Object.values(file.state.sources).find(({ reference }) => researchSourceResource(reference) ===
          researchSourceResource(requested.reference))?.id : undefined,
      receipt = sourceId && action.type === "merge" ? action.evidence?.[0] : undefined;
    return { file, ...(sourceId ? { sourceId } : {}), ...(receipt ? { evidenceId: receipt.evidence_id, receipt } : {}) };
  }
  const query = (scope: Scope, id: string, input: ResearchFileQueryInput,
    options: Parameters<typeof runResearchFileQuery>[4] = {}) => runResearchFileQuery(documents, scope, id,
      input, { ...options, operation: operation(options.operation) });
  async function revision(scope: Scope, id: string, input: { kind: "passages" | "evidence" | "queries" | "history"; sourceId?: string }) {
    const file = await required(scope, id), source = input.sourceId && file.state.sources[input.sourceId];
    if (input.sourceId && !source) return fail(404, "Workspace source not found");
    const contentRevision = input.kind === "history" ? file.state.history?.sha256 ?? ""
      : input.kind === "queries" ? file.state.queries?.sha256 ?? ""
        : source ? source.passages?.sha256 ?? "" : sha256(JSON.stringify(Object.values(file.state.sources)
          .map(({ id, passages }) => [id, passages?.sha256 ?? ""])));
    return { file, contentRevision };
  }
  async function items(scope: Scope, id: string, input: { kind: "passages" | "evidence" | "queries" | "history";
    sourceId?: string; offset: number; limit: number }) {
    const { file, contentRevision } = await revision(scope, id, input);
    return { ...await pageResearchItems(documents, scope, file, input.kind, input.offset, input.limit,
      input.sourceId && (input.kind === "passages" || input.kind === "evidence") ? [input.sourceId] : undefined), contentRevision };
  }
  async function citation(scope: Scope, id: string, sourceId: string, evidenceId?: string) {
    return readResearchMemoCitation(documents, scope, await required(scope, id), sourceId, evidenceId);
  }
  async function selection(scope: Scope, id: string, selected: ResearchSelection = { target: "sources" },
    options: { availableOnly?: boolean } = {}) {
    return resolveResearchSelection(documents, scope, { ...researchSelectionSchema.parse(selected), researchFileId: id },
      undefined, options);
  }
  async function context(scope: Scope, id: string, selected?: ResearchSelection) {
    const resolved = await selection(scope, id, selected, { availableOnly: true });
    if (selected?.findingRefs) {
      const found = await findings(scope, id, { references: selected.findingRefs, subjects: resolved.subjects, offset: 0, limit: 10_000 });
      if (new Set(found.items.map(({ reference }) => researchFindingKey(reference))).size !==
          new Set(selected.findingRefs.map(researchFindingKey)).size)
        return fail(400, "A selected finding is unavailable or outside this research scope");
    }
    return { workspace: { documentId: id, versionId: resolved.versionId, workingRevision: resolved.workingRevision },
      subjects: resolved.subjects, ...(selected ? { restricted: true } : {}),
      ...(selected?.findingRefs ? { findingRefs: selected.findingRefs } : {}) };
  }
  async function collectView(scope: Scope, id: string, input: Binding, actor?: Operation): Promise<ResearchFile> {
    if (input.chatId) {
      const [chat, transcript] = await Promise.all([dependencies.chats.get(scope, input.chatId),
        dependencies.chats.transcript(scope, input.chatId)]);
      if (!chat || !transcript) return fail(404, "Chat not found");
      const events = transcript.flatMap(({ content }) => Array.isArray(content) ? content : []);
      await collect(scope, id, { chats: [chat.id], evidence: priorLegalEvidenceReceipts(events), sources: groundedSources(events),
        queries: priorLegalResearchQueryReceipts(events) }, actor);
    }
    if (input.tableId) {
      const detail = await (await dependencies.tabular()).detail(scope, input.tableId);
      const subjects = detail.review.scope_config?.subjects ?? [], known = new Set(subjects.map(tabularSubjectId)),
        metadata = await documents.metadataMany(scope, detail.review.document_ids.filter((id) => !known.has(id)));
      await collect(scope, id, { tables: [detail.review.id], sources: [...subjects.map(({ reference }) => reference),
        ...metadata.map((document) => ({ provider: "library" as const, kind: "document" as const,
          id: document.id, versionId: document.current_version_id, title: document.filename }))],
      evidence: detail.cells.flatMap((cell) => cell.content?.evidence ?? []) }, actor);
    }
    return required(scope, id);
  }
  async function bind(scope: Scope, id: string, input: Binding, actor?: Operation): Promise<ResearchFile> {
    const file = await required(scope, id);
    if (!input.chatId && !input.tableId) return fail(400, "Select a chat or table");
    const chat = input.chatId ? await dependencies.chats.get(scope, input.chatId) : null,
      table = input.tableId ? await dependencies.tables.detail(scope, input.tableId) : null;
    if (input.chatId && (!chat || chat.user_id !== scope.userId)) return fail(404, "Chat not found");
    if (input.tableId && (!table || !table.review.is_owner)) return fail(404, "Table not found");
    if (file.document.project_id && chat?.project_id && file.document.project_id !== chat.project_id ||
        table && table.review.project_id !== file.document.project_id)
      return fail(400, "The selected view belongs to another project");
    const tableWorkspace = table?.review.scope_config?.research_file_id;
    if (tableWorkspace && tableWorkspace !== id && input.selection)
      return fail(400, "This table uses another Sources workspace. Create a table view for the requested selection.");
    if (input.selection) await selection(scope, id, input.selection);
    const saved = await collectView(scope, id, input, actor);
    if (chat) {
      if (!await dependencies.chats.update(scope, chat.id, { researchFileId: id,
        researchSelection: input.selection ?? null })) return fail(404, "Chat not found");
    }
    if (table && input.tableId) {
      if (!tableWorkspace || tableWorkspace === id && input.selection)
        await (await dependencies.tabular()).update(scope, input.tableId, { research_file_id: id,
          ...(input.selection ? { research_selection: input.selection } : {}), expected_version: table.review.updated_at }, actor);
    }
    return saved;
  }
  async function ensure(scope: Scope, input: Binding & { title?: string; projectId?: string | null }, actor?: Operation): Promise<ResearchFile> {
    const chat = input.chatId ? await dependencies.chats.get(scope, input.chatId) : null,
      table = input.tableId ? await dependencies.tables.detail(scope, input.tableId) : null;
    if (input.chatId && !chat || input.tableId && !table) return fail(404, "Selected view not found");
    const existing = chat?.research_file_id ?? table?.review.scope_config?.research_file_id;
    if (existing && await get(scope, existing)) return bind(scope, existing, input, actor);
    const file = await create(scope, { title: input.title ?? table?.review.title ?? chat?.title ?? "Research",
      projectId: input.projectId ?? table?.review.project_id ?? chat?.project_id ?? null }, actor);
    return input.chatId || input.tableId ? bind(scope, file.document.id, input, actor) : file;
  }

  function resolver(scope: Scope, file: ResearchFile) {
    const chatCache = new Map<string, ReturnType<typeof resolveChatFindings>>(),
      tableCache = new Map<string, ReturnType<TabularRepository["detail"]>>();
    const checked = new Set<string>();
    const authorize = async (evidence: LegalEvidenceReceipt[]) => {
      for (const receipt of evidence) {
        const resource = legalEvidenceResourceReference(receipt), parsed = resource ? parseResourceReference(resource) : null;
        if (parsed?.kind !== "document" || checked.has(resource!)) continue;
        if (!await documents.projectionSource(scope, parsed.documentId, parsed.versionId))
          return fail(404, "An original supporting document is unavailable");
        checked.add(resource!);
      }
    };
    const chatFindings = (id: string) => {
      if (!chatCache.has(id)) chatCache.set(id, resolveChatFindings(dependencies.chats, documents, scope,
        { researchFileId: file.document.id, chatId: id }));
      return chatCache.get(id)!;
    };
    const tableDetail = (id: string) => {
      if (!tableCache.has(id)) tableCache.set(id, dependencies.tables.detail(scope, id));
      return tableCache.get(id)!;
    };
    async function resolve(reference: ResearchFindingReference, trail = new Set<string>()): Promise<ResearchFinding | null> {
      const ref = researchFindingReferenceSchema.parse(reference), key = JSON.stringify(ref);
      if (trail.has(key) || trail.size > 100) return fail(409, "The table arrangement contains a circular finding reference");
      if (ref.kind === "answer") {
        if (!file.state.chats?.includes(ref.chatId)) return fail(404, "Chat is outside this workspace");
        const finding = (await chatFindings(ref.chatId)).findings.find((finding) =>
          finding.question.id === ref.answerId && finding.resource === ref.resource);
        if (finding) await authorize(finding.evidence);
        const source = finding && file.state.sources[finding.sourceId];
        if (source?.reference.kind === "document" && !await documents.projectionSource(scope,
          source.reference.id, source.reference.versionId)) return fail(404, "Finding source is unavailable");
        return finding ? selectFindingClaims(finding, ref) : null;
      }
      if (!file.state.tables?.includes(ref.reviewId)) return fail(404, "Table is outside this workspace");
      const detail = await tableDetail(ref.reviewId), column = detail?.review.columns_config.find(({ index }) => index === ref.columnIndex);
      if (!detail || !column) return null;
      const cell = detail.cells.find((cell) => cell.document_id === ref.rowId && cell.column_index === ref.columnIndex);
      if (cell?.status !== "done" || !cell.content) return null;
      const content = cell.content, source = Object.values(file.state.sources).find(({ reference }) =>
        researchSourceResource(reference) === content.resource);
      if (!source) return null;
      await authorize(content.evidence);
      if (source.reference.kind === "document" && !await documents.projectionSource(scope, source.reference.id,
        source.reference.versionId)) return fail(404, "Finding source is unavailable");
      const { evidence, resource, origin: _origin, ...answer } = content;
      return selectFindingClaims({ reference: { ...ref, claimIndices: undefined }, kind: "result", sourceId: source.id, resource,
        question: { id: `${ref.reviewId}:${column.index}`, title: column.name, prompt: column.prompt,
          format: column.format, tags: column.tags }, answer, evidence,
        origin: { reviewId: ref.reviewId, rowId: ref.rowId, columnIndex: ref.columnIndex } }, ref);
    }
    return { resolve, chatFindings, tableDetail };
  }
  async function finding(scope: Scope, id: string, reference: ResearchFindingReference): Promise<ResearchFinding | null> {
    return resolver(scope, await required(scope, id)).resolve(reference);
  }
  async function findings(scope: Scope, id: string, input: FindingsInput): Promise<FindingsPage> {
    const file = await required(scope, id), read = resolver(scope, file), found: ResearchFinding[] = [],
      inScope = researchResultFilter(input.subjects ? { subjects: input.subjects, restricted: true } : undefined),
      include = (value: ResearchFinding | null) => { if (value && inScope(value) &&
        (!input.sourceIds || input.sourceIds.includes(value.sourceId))) found.push(value); };
    if (input.reference) {
      if (input.references && !input.references.some((ref) => researchFindingWithin(input.reference!, ref)))
        return fail(400, "Finding is outside the current selection");
      include(await read.resolve(input.reference));
    } else if (input.references) {
      for (const ref of input.references) include(await read.resolve(ref));
    } else {
      for (const chatId of input.chatId ? [input.chatId] : file.state.chats ?? []) {
        if (!file.state.chats?.includes(chatId)) return fail(404, "Chat is outside this workspace");
        if (!await dependencies.chats.get(scope, chatId)) continue;
        for (const item of (await read.chatFindings(chatId)).findings)
          if (!input.messageIds || input.messageIds.includes(item.origin.messageId)) include(await read.resolve(item.reference));
      }
      if (!input.chatId) for (const tableId of file.state.tables ?? []) {
        const detail = await read.tableDetail(tableId); if (!detail) continue;
        for (const rowId of detail.review.document_ids) for (const { index } of detail.review.columns_config)
          include(await read.resolve({ kind: "cell", reviewId: tableId, rowId, columnIndex: index }));
      }
    }
    const is_running = (await Promise.all((file.state.tables ?? []).map(async (id) => {
      const detail = await read.tableDetail(id);
      return detail && await dependencies.isTableRunning?.(id, detail.review.user_id) || false;
    }))).some(Boolean);
    return { items: found.slice(input.offset, input.offset + input.limit), total: found.length, is_running,
      next_offset: input.offset + input.limit < found.length ? input.offset + input.limit : null };
  }
  async function views(scope: Scope, id: string) {
    const file = await required(scope, id), chats = [], tables = [];
    for (const chatId of file.state.chats ?? []) { const chat = await dependencies.chats.get(scope, chatId);
      if (chat) chats.push({ id: chat.id, title: chat.title }); }
    for (const tableId of file.state.tables ?? []) { const detail = await dependencies.tables.detail(scope, tableId);
      if (detail) tables.push({ id: detail.review.id, title: detail.review.title,
        columns: detail.review.columns_config, row_count: detail.review.document_ids.length,
        research_file_id: detail.review.scope_config?.research_file_id }); }
    return { chats, tables };
  }
  async function prepareTable(scope: Scope, id: string, input: TableInput, actor?: Operation, signal?: AbortSignal) {
    if (input.chatId) await collectView(scope, id, { chatId: input.chatId }, actor);
    for (const ref of input.findingRefs ?? []) await collectView(scope, id,
      ref.kind === "answer" ? { chatId: ref.chatId } : { tableId: ref.reviewId }, actor);
    const file = await required(scope, id);
    let selected = input.findingRefs ? await Promise.all(input.findingRefs.map(async (ref) =>
      await finding(scope, id, ref) ?? fail(404, "Finding not found"))) :
      (await findings(scope, id, { chatId: input.chatId, messageIds: input.messageIds, offset: 0, limit: 100_000 })).items;
    if (input.messageIds?.some((messageId) => !selected.some(({ origin }) => origin.messageId === messageId)))
      return fail(400, "A selected message contains no grounded findings");
    const selectedScope = input.selection ?? { target: "sources" as const,
      ...(input.chatId || input.findingRefs ? { sourceIds: [...new Set(selected.map(({ sourceId }) => sourceId))] } : {}) };
    if (selectedScope.findingRefs) selected = selectedScope.findingRefs.flatMap((ref) => {
      const value = selected.find(({ reference }) => researchFindingWithin(ref, reference));
      return [selectFindingClaims(value ?? fail(404, "A selected finding is unavailable. Refresh the research selection."), ref)];
    });
    const resolved = await selection(scope, id, selectedScope), permitted = researchResultFilter({ subjects: resolved.subjects, restricted: true });
    selected = selected.filter(permitted);
    if (input.replaceTableId) selected = selected.filter(({ origin }) => origin.reviewId !== input.replaceTableId);
    if (resolved.subjects.length > 500) return fail(413, "Select at most 500 sources for one review");
    const parts = new Map<string, Record<string, ResearchEvidence>>();
    await visitResearchEvidenceParts(documents, scope, file, resolved.subjects.map(({ sourceId }) => sourceId),
      (batch) => batch.forEach((value, key) => parts.set(key, value)));
    const imported = { rows: input.rows ?? "sources", labelId: input.labelId, columns: input.columns } as ResearchImportInput;
    const build = (options: ResearchImportInput) => researchTableArrangement(file, resolved.subjects, parts,
      [{ title: "Grounded research", findings: selected }], options);
    let plan = build(imported), title = input.title ?? workspaceTitle(file.document.filename);
    const app = await dependencies.tabular();
    if (input.request) {
      const design = await app.design(scope, { request: input.request, title, current: plan.columns_config,
        documentNames: plan.arrangement.rows.slice(0, 50).map(({ title }) => title.slice(0, 300)) }, signal, plan.fields);
      title = design.title;
      plan = build({ ...imported, columns: design.columns_config.map((column) => ({ ...column,
        fieldIds: design.mappings?.find(({ index }) => index === column.index)?.fieldIds ?? [] })) });
    }
    const createInput = { title, project_id: file.document.project_id ?? undefined, research_file_id: id,
      research_selection: selectedScope, arrangement: plan.arrangement, columns_config: plan.columns_config };
    const prepared = await app.previewResearch(scope, createInput);
    if (prepared.config.versionId !== file.versionId || prepared.config.workingRevision !== file.workingRevision)
      return conflict("The research changed. Refresh the preview.");
    const references = selected.map(({ reference }) => reference);
    prepared.config.researchImport = { rows: imported.rows, labelId: imported.labelId, columns: plan.columns };
    prepared.config.findings = { references, sourceIds: [...new Set(selected.map(({ sourceId }) => sourceId))] };
    // The preview and its stale check use the very cells that would be written,
    // including a result that changed while canonical references were resolved.
    const seeded = new Map(prepared.seedCells?.map((cell) => [`${cell.document_id}:${cell.column_index}`, cell.content]));
    plan.preview = plan.arrangement.rows.slice(0, 3).map((row) => ({ title: row.title, values: plan.columns.map((column) => {
      const answer = seeded.get(`${row.id}:${column.index}`);
      return answer?.summary ?? answer?.claims.map(({ text }) => text).join("\n") ?? "";
    }) }));
    const basis = sha256(JSON.stringify([file.versionId, file.workingRevision, prepared.config.subjects, prepared.seedCells,
      selected.map(({ reference, answer, evidence }) => [reference, answer, evidence]) ]));
    return { plan, title, basis, selectedScope, prepared, createInput, findingRefs: references,
      versionId: file.versionId, workingRevision: file.workingRevision };
  }
  async function tablePlan(scope: Scope, id: string, input: TableInput = {}, signal?: AbortSignal) {
    const { plan, title, basis, selectedScope, versionId, workingRevision, findingRefs } = await prepareTable(scope, id, input, undefined, signal);
    return { title, basis, selection: selectedScope, versionId, workingRevision, findingRefs,
      columns: plan.columns, fields: plan.fields, reuse: plan.reuse, preview: plan.preview, arrangement: { rows: plan.arrangement.rows } };
  }
  async function table(scope: Scope, id: string, input: TableInput = {}, actor?: Operation): Promise<TabularReview> {
    if (input.tableId) { await bind(scope, id, { tableId: input.tableId, selection: input.selection }, actor);
      return (await (await dependencies.tabular()).detail(scope, input.tableId)).review; }
    if (input.request) return fail(400, "Preview the suggested design before creating the review");
    const result = await prepareTable(scope, id, input, actor);
    if (input.basis && input.basis !== result.basis) return conflict("The research changed. Refresh the preview before applying it.");
    if (!result.plan.arrangement.rows.length) return fail(400, "This selection contains no research sources or passages");
    if (!result.plan.columns_config.length) return fail(400, "Add a question or select existing work to compare");
    const app = await dependencies.tabular();
    if (input.replaceTableId) {
      const current = await app.detail(scope, input.replaceTableId);
      if (!current?.review.is_owner || current.review.scope_config?.research_file_id !== id) return fail(404, "Review not found");
      if (current.review.is_running)
        return conflict("Stop the running review before refreshing its research.");
      if (!input.expectedVersion || current.review.updated_at !== input.expectedVersion) return conflict("The review changed. Refresh it before updating.");
      // Refresh is explicit and reviewable. Existing results and configuration can be restored together.
      const changed = await dependencies.tables.update(scope, current.review.id, input.expectedVersion, {
        title: result.title, columns: result.plan.columns_config, documentIds: result.prepared.config.subjects.map(tabularSubjectId),
        scopeConfig: result.prepared.config, seedCells: result.prepared.seedCells,
        operation: { executor: "human", ...actor, propose: true, title: "Refresh from research" } });
      if (changed.status !== "committed") return conflict("The review changed. Try again.");
      return changed.value;
    }
    return app.create(scope, result.createInput, actor, result.prepared);
  }
  /** Only claim-bound support is eligible. The client supplies IDs, never trusted receipts. */
  async function saveHighlights(scope: Scope, id: string, input: { references: ResearchFindingReference[];
    evidenceIds: string[]; typeId?: string; versionId: string; workingRevision: number }, actor?: Operation) {
    const file = await required(scope, id);
    if (file.versionId !== input.versionId || file.workingRevision !== input.workingRevision)
      return conflict("The research changed. Reload before saving these passages.");
    const read = resolver(scope, file), supported = new Map<string, LegalEvidenceReceipt>();
    for (const ref of input.references) {
      const value = await read.resolve(ref) ?? fail(404, "A selected result is unavailable");
      const ids = new Set(value.answer.claims.flatMap(({ evidence_ids }) => evidence_ids));
      value.evidence.forEach((receipt) => {
        if (ids.has(receipt.evidence_id) && receipt.scope === "passage") supported.set(receipt.evidence_id, receipt);
      });
    }
    const evidence = [...new Set(input.evidenceIds)].map((id) => supported.get(id) ?? fail(400, "A selected passage does not support these results"));
    if (!evidence.length) return fail(400, "Select at least one supporting passage");
    if (input.typeId && file.state.labels[input.typeId]?.scope !== "highlight") return fail(400, "Choose a highlight type");
    return await commitResearchFile(documents, scope, file, { type: "merge", evidence,
      labels: Object.fromEntries(evidence.map(({ evidence_id }) => [evidence_id, input.typeId ? [input.typeId] : []])) },
      undefined, operation(actor)) ?? conflict("The research changed. Reload before saving these passages.");
  }
  const columnValues = (column: TabularColumn, content: TabularCellContent) => {
    if (column.format === "yes_no") return typeof content.value === "boolean" ? [content.value ? "Yes" : "No"] : [];
    const value = content.value ?? content.summary ?? content.claims.map(({ text }) => text).join("\n");
    return (Array.isArray(value) ? value : [value]).flatMap((item) =>
      typeof item === "string" && item.trim() ? [item.trim()] : []);
  };
  async function columnLabelData(scope: Scope, id: string, input: ColumnLabelInput) {
    const file = await required(scope, id);
    if (!file.state.tables?.includes(input.reviewId)) return fail(404, "Table is outside this research set");
    const detail = await (await dependencies.tabular()).detail(scope, input.reviewId),
      column = detail.review.columns_config.find(({ index }) => index === input.columnIndex);
    if (!column) return fail(404, "Column not found");
    if (input.rowIds?.some((id) => !detail.review.document_ids.includes(id))) return fail(404, "A selected row is unavailable");
    if (input.parentId && file.state.labels[input.parentId]?.scope !== "source") return fail(400, "Choose a source label parent");
    const sources = new Map((detail.review.scope_config?.subjects ?? []).map((subject) =>
      [tabularSubjectId(subject), subject.sourceId])), values = new Map<string, string[]>();
    for (const cell of detail.cells) {
      const sourceId = sources.get(cell.document_id);
      if (cell.column_index !== input.columnIndex || cell.status !== "done" || !cell.content || !sourceId ||
          input.rowIds && !input.rowIds.includes(cell.document_id)) continue;
      if (!file.state.sources[sourceId]) return fail(409, "A row's source was removed from the research set");
      for (const value of columnValues(column, cell.content)) {
        const assigned = values.get(value) ?? []; if (!assigned.includes(sourceId)) assigned.push(sourceId);
        values.set(value, assigned);
      }
    }
    if (!values.size) return fail(400, "This column has no completed values to label");
    if (values.size > 200 || [...values.keys()].reduce((sum, value) => sum + value.length, 0) > 40_000)
      return fail(413, "Select fewer rows before mapping this column to labels");
    const basis = sha256(JSON.stringify([file.versionId, file.workingRevision, detail.review.updated_at, column, [...values]]));
    return { file, column, values, basis };
  }
  async function columnLabelPlan(scope: Scope, id: string, input: ColumnLabelInput, signal?: AbortSignal) {
    const { column, values, basis } = await columnLabelData(scope, id, input);
    const mapping = input.request ? await (await dependencies.tabular()).labelMapping(scope,
      { request: input.request, column: column.name, values: [...values.keys()] }, signal) :
      [...values.keys()].map((value) => ({ value, label: value.length <= 200 ? value : null }));
    return { title: column.name, basis, mapping: mapping.map((item) => ({ ...item, sources: values.get(item.value)!.length })) };
  }
  async function columnLabels(scope: Scope, id: string, input: ColumnLabelInput, actor?: Operation): Promise<ResearchFile> {
    if (input.request) return fail(400, "Preview the label mapping before applying it");
    const { file, column, values, basis } = await columnLabelData(scope, id, input);
    if (input.basis && input.basis !== basis) return conflict("The column or research changed. Refresh the label preview.");
    const mapping = input.mapping ?? [...values.keys()].map((value) => ({ value, label: value }));
    if (mapping.length !== values.size || new Set(mapping.map(({ value }) => value)).size !== values.size ||
        mapping.some(({ value, label }) => !values.has(value) || label !== null && (!label.trim() || label.length > 200)))
      return fail(400, "Map each original value exactly once to a label or an explicit skip");
    const groups = new Map<string, Set<string>>();
    for (const { value, label } of mapping) if (label !== null) {
      const group = groups.get(label.trim()) ?? new Set<string>();
      values.get(value)!.forEach((sourceId) => group.add(sourceId)); groups.set(label.trim(), group);
    }
    if (!groups.size) return fail(400, "Choose at least one label");
    if (groups.size > 49) return fail(413, "Consolidate the values into at most 49 labels before applying");
    const parentId = input.parentId ?? randomUUID(), children = [...groups].map(([name, sourceIds]) => {
      const existing = Object.values(file.state.labels).find((label) => label.scope === "source" && label.parentId === parentId && label.name === name);
      return { name, sourceIds: [...sourceIds], id: existing?.id ?? randomUUID(), existing: !!existing };
    });
    const actions = [
      ...(!input.parentId ? [{ type: "label" as const, id: parentId, name: column.name, parentId: null, scope: "source" as const }] : []),
      ...children.filter(({ existing }) => !existing).map(({ name, id: labelId }) => ({ type: "label" as const,
        id: labelId, name, parentId, scope: "source" as const })),
      ...children.map(({ sourceIds, id: labelId }) => ({ type: "label-selection" as const, target: "sources" as const,
        sourceIds, assign: [labelId], mode: "add" as const })),
    ];
    return await commitResearchFile(documents, scope, file, { type: "batch", propose: true,
      title: `Labels from ${column.name}`.slice(0, 200), actions },
      undefined, operation(actor)) ?? conflict("The research changed. Reload before applying labels.");
  }

  return { get, create, update, query, collect, observe, revision, items, citation, bind, ensure, selection,
    context, finding, findings, views, tablePlan, table, saveHighlights, columnLabelPlan, columnLabels };
}

export type SourceWorkspaceApplication = ReturnType<typeof createSourceWorkspaceApplication>;

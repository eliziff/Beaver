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
import { researchFindingReferenceSchema, type ResearchFindingReference } from "./researchFindingReference";
import { researchSelectionSchema, resolveResearchSelection, type ResearchSelection, type ResearchSubject } from "./researchSelection";
import { researchResultFilter } from "./researchReader";
import type { ResearchOperationContext } from "./researchProvenance";
import { priorLegalEvidenceReceipts, priorLegalResearchQueryReceipts,
  legalEvidenceResourceReference,
  type LegalEvidenceReceipt, type LegalResearchQueryReceipt } from "./chat/legalEvidence";
import type { AssistantEvent, LegalEvidenceReceiptEvent } from "./chat/assistantEvents";
import { parseResourceReference } from "./resourceReferences";
import { resolveResearchArrangement, type ResearchArrangement } from "./tabular/researchArrangement";
import { researchImportCatalog, defaultResearchImport, researchImportPlan,
  type ResearchImportInput, type ResearchImportDesign } from "./tabular/researchImport";
import { researchLabelPlan, type ResearchLabelDesign } from "./researchLabelDesign";
import type { TabularApplication } from "./tabular/application";
import { tabularSubjectId, type TabularCellContent, type TabularColumn,
  type TabularRepository, type TabularReview } from "./tabularStore";

type Scope = ApplicationScope;
type Operation = ResearchOperationContext;
type Observations = { evidence?: LegalEvidenceReceipt[]; queries?: Array<LegalResearchQueryReceipt | ResearchQueryReceipt>;
  sources?: ResearchSourceReference[]; chats?: string[]; tables?: string[] };
type Binding = { chatId?: string; tableId?: string; selection?: ResearchSelection | null };
type FindingsInput = { sourceIds?: string[]; reference?: ResearchFindingReference; chatId?: string;
  messageIds?: string[]; references?: ResearchFindingReference[]; offset: number; limit: number; subjects?: ResearchSubject[] };
type FindingsPage = { items: ResearchFinding[]; total: number; next_offset: number | null; is_running: boolean };
type TableInput = { tableId?: string; chatId?: string; messageIds?: string[];
  selection?: ResearchSelection; findingRefs?: ResearchFindingReference[];
  fingerprint?: string; design?: ResearchImportDesign; request?: string; model?: string } & Partial<ResearchImportInput>;
type LabelInput = Omit<TableInput, "design"> & { design?: ResearchLabelDesign };

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
    return { workspace: { documentId: id, versionId: resolved.versionId, workingRevision: resolved.workingRevision },
      subjects: resolved.subjects, ...(selected?.findingRefs ? { findingRefs: selected.findingRefs } : {}), ...(selected ? { restricted: true } : {}) };
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

  /** One operation owns raw reads and indexes; recursive finding promises are never cached. */
  async function readFindings(scope: Scope, id: string) {
    const once = <K, T>(load: (key: K) => Promise<T>) => {
      const values = new Map<K, Promise<T>>();
      return (key: K) => {
        if (!values.has(key)) values.set(key, load(key));
        return values.get(key)!;
      };
    };
    const cellKey = (row: string, column: number) => JSON.stringify([row, column]);
    const tableDetail = once(async (id: string) => {
      const detail = await dependencies.tables.detail(scope, id);
      if (!detail) return null;
      const arrangement = detail.review.scope_config?.arrangement,
        rows = new Map<string, ResearchArrangement["rows"]>(), mappings = new Map<string, ResearchArrangement["cells"]>();
      for (const row of arrangement?.rows ?? []) rows.set(row.id, [...(rows.get(row.id) ?? []), row]);
      for (const cell of arrangement?.cells ?? []) {
        const key = cellKey(cell.rowId, cell.columnIndex); mappings.set(key, [...(mappings.get(key) ?? []), cell]);
      }
      return { ...detail, rows, mappings,
        columns: new Map(detail.review.columns_config.map((column) => [column.index, column])),
        byCell: new Map(detail.cells.map((cell) => [cellKey(cell.document_id, cell.column_index), cell])) };
    });
    const transcript = once(async (id: string) => {
      const [chat, rows] = await Promise.all([dependencies.chats.get(scope, id), dependencies.chats.transcript(scope, id)]);
      return chat ? rows ?? fail(404, "Chat not found") : null;
    });
    const open: (id: string) => Promise<ReturnType<typeof reader>> = once(async (id: string) => reader(await required(scope, id)));
    const available = once(async (resource: string | null) => {
      const parsed = resource ? parseResourceReference(resource) : null;
      return parsed?.kind !== "document" || !!await documents.projectionSource(scope, parsed.documentId, parsed.versionId);
    });
    function reader(file: ResearchFile) {
      const sources = new Map(Object.values(file.state.sources).map((source) => [researchSourceResource(source.reference), source])),
        chatIds = new Set(file.state.chats), tableIds = new Set(file.state.tables);
      const chatFindings = once(async (id: string) => {
        if (!chatIds.has(id)) return fail(404, "Chat is outside this workspace");
        const rows = await transcript(id);
        if (!rows) return null;
        const items = resolveChatFindings(file, id, rows);
        return { items, byAnswer: new Map(items.map((item) => [JSON.stringify([item.question.id, item.resource]), item])) };
      });
      async function authorize(item: ResearchFinding | null): Promise<ResearchFinding | null> {
        if (!item) return null;
        for (const receipt of item.evidence) if (!await available(legalEvidenceResourceReference(receipt)))
          return fail(404, "An original supporting document is unavailable");
        const source = file.state.sources[item.sourceId];
        if (source?.reference.kind === "document" && !await available(researchSourceResource(source.reference)))
          return fail(404, "Finding source is unavailable");
        return item;
      }
      const arrange = (input: Omit<Parameters<typeof resolveResearchArrangement>[0], "documents" | "scope" | "file">) =>
        resolveResearchArrangement({ ...input, documents, scope, file, resolveFinding: input.resolveFinding ?? resolve });
      async function resolve(reference: ResearchFindingReference, trail = new Set<string>()): Promise<ResearchFinding | null> {
        const ref = researchFindingReferenceSchema.parse(reference), key = JSON.stringify(ref);
        if (trail.has(key) || trail.size > 100) return fail(409, "The table arrangement contains a circular finding reference");
        if (ref.kind === "answer") {
          const chat = await chatFindings(ref.chatId) ?? fail(404, "Chat not found"),
            item = await authorize(chat.byAnswer.get(JSON.stringify([ref.answerId, ref.resource])) ?? null);
          return item ? selectFindingClaims(item, ref) : null;
        }
        if (!tableIds.has(ref.reviewId)) return fail(404, "Table is outside this workspace");
        const detail = await tableDetail(ref.reviewId), column = detail?.columns.get(ref.columnIndex);
        if (!detail || !column) return null;
        let cell = detail.byCell.get(cellKey(ref.rowId, ref.columnIndex));
        const config = detail.review.scope_config;
        const mappings = detail.mappings.get(cellKey(ref.rowId, ref.columnIndex));
        if (!config?.frozen && mappings) {
          const owner = await open(config?.research_file_id ?? file.document.id),
            resolved = await owner.arrange({ columns: detail.review.columns_config,
              arrangement: { rows: detail.rows.get(ref.rowId) ?? [], cells: mappings },
              storedCells: cell ? [cell] : [], resolveFinding: (next) => owner.resolve(next, new Set([...trail, key])) });
          cell = resolved.cells.find((cell) => cell.document_id === ref.rowId && cell.column_index === ref.columnIndex);
        }
        if (cell?.status !== "done" || !cell.content) return null;
        const source = sources.get(cell.content.resource);
        if (!source) return null;
        const { evidence, resource, origin: _origin, ...answer } = cell.content;
        return authorize({ reference: ref, kind: "result", sourceId: source.id, resource,
          question: { id: `${ref.reviewId}:${column.index}`, title: column.name, prompt: column.prompt,
            format: column.format, tags: column.tags }, answer, evidence,
          origin: { reviewId: ref.reviewId, rowId: ref.rowId, columnIndex: ref.columnIndex } });
      }
      async function list(input: FindingsInput): Promise<FindingsPage> {
        const found: ResearchFinding[] = [],
          inScope = researchResultFilter(input.subjects ? { subjects: input.subjects, restricted: true } : undefined),
          include = (value: ResearchFinding | null) => { if (value && inScope(value) &&
            (!input.sourceIds || input.sourceIds.includes(value.sourceId))) found.push(value); };
        if (input.reference) {
          if (input.references && !input.references.some((ref) => {
            const requested = researchFindingReferenceSchema.parse(input.reference), allowed = researchFindingReferenceSchema.parse(ref);
            return requested.kind === "cell" ? JSON.stringify(requested) === JSON.stringify(allowed)
              : allowed.kind === "answer" && requested.chatId === allowed.chatId && requested.answerId === allowed.answerId &&
                requested.resource === allowed.resource && (!allowed.claimIndices || !!requested.claimIndices &&
                  requested.claimIndices.every((index) => allowed.claimIndices!.includes(index)));
          })) return fail(400, "This finding is outside the selected results");
          include(await resolve(input.reference));
        } else if (input.references) {
          for (const ref of input.references) include(await resolve(ref));
        } else {
          for (const chatId of input.chatId ? [input.chatId] : chatIds) {
            for (const item of (await chatFindings(chatId))?.items ?? [])
              if (!input.messageIds || input.messageIds.includes(item.origin.messageId!)) include(await authorize(item));
          }
          if (!input.chatId) for (const tableId of tableIds) {
            const detail = await tableDetail(tableId); if (!detail) continue;
            for (const rowId of detail.review.document_ids) for (const { index } of detail.review.columns_config)
              include(await resolve({ kind: "cell", reviewId: tableId, rowId, columnIndex: index }));
          }
        }
        const is_running = (await Promise.all([...tableIds].map(async (id) => {
          const detail = await tableDetail(id);
          return detail && await dependencies.isTableRunning?.(id, detail.review.user_id) || false;
        }))).some(Boolean);
        return { items: found.slice(input.offset, input.offset + input.limit), total: found.length, is_running,
          next_offset: input.offset + input.limit < found.length ? input.offset + input.limit : null };
      }
      return { file, resolve, arrange, list };
    }
    return open(id);
  }
  const findings = async (scope: Scope, id: string, input: FindingsInput) => (await readFindings(scope, id)).list(input);
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
  async function importCatalog(scope: Scope, id: string, input: Omit<TableInput, "design">) {
    const read = await readFindings(scope, id), { file } = read;
    const refs = input.findingRefs ?? input.selection?.findingRefs;
    const selected = refs
      ? await Promise.all(refs.map(async (ref) => await read.resolve(ref) ?? fail(404, "Finding not found")))
      : (await read.list({ chatId: input.chatId, messageIds: input.messageIds,
        offset: 0, limit: 100_000 })).items;
    if (input.chatId && !selected.length) return fail(400, "This chat has no grounded findings to convert");
    if (input.messageIds?.some((messageId) => !selected.some(({ origin }) => origin.messageId === messageId)))
      return fail(400, "A selected message has no grounded findings");
    const selectedSources = input.chatId || refs ? new Set(selected.map(({ sourceId }) => sourceId)) : null;
    const resolved = await resolveResearchSelection(documents, scope, { researchFileId: id,
      ...researchSelectionSchema.parse(input.selection ?? { target: "sources",
        ...(selectedSources ? { sourceIds: [...selectedSources] } : {}) }) }, file);
    const subjects = resolved.subjects.filter(({ sourceId }) => !selectedSources || selectedSources.has(sourceId));
    const parts = new Map<string, Record<string, ResearchEvidence>>();
    await visitResearchEvidenceParts(documents, scope, file, subjects.map(({ sourceId }) => sourceId),
      (batch) => batch.forEach((value, key) => parts.set(key, value)));
    const catalog = researchImportCatalog(file, subjects, parts, selected,
      { rows: input.rows ?? "sources", labelId: input.labelId });
    if (!catalog.rows.length) return fail(400, "No sources or saved passages match this conversion");
    // Retain the very findings fingerprinted in the preview, rather than reread
    // a concurrently regenerated table cell between acceptance and persistence.
    const captured = new Map<string, ResearchFinding>(), groups = new Map<string, ResearchFinding[]>();
    const key = (ref: ResearchFindingReference) => ref.kind === "cell"
      ? JSON.stringify([ref.kind, ref.reviewId, ref.rowId, ref.columnIndex])
      : JSON.stringify([ref.kind, ref.chatId, ref.answerId, ref.resource]);
    for (const item of selected) { const id = key(item.reference); groups.set(id, [...(groups.get(id) ?? []), item]); }
    for (const { reference } of catalog.entries) {
      if (reference.kind !== "answer" && reference.kind !== "cell") continue;
      const original = groups.get(key(reference))?.find(({ reference: item }) => item.kind !== "answer" || !item.claimIndices ||
        reference.kind === "answer" && !!reference.claimIndices && reference.claimIndices.every((index) => item.claimIndices!.includes(index)));
      if (original) captured.set(JSON.stringify(reference), selectFindingClaims(original, reference));
    }
    return { file, catalog, resolveFinding: async (ref: ResearchFindingReference): Promise<ResearchFinding | null> =>
      captured.get(JSON.stringify(ref)) ?? null };
  }
  async function previewTable(scope: Scope, id: string, input: TableInput, signal?: AbortSignal) {
    const { catalog } = await importCatalog(scope, id, input);
    const design = input.request ? await (await dependencies.tabular()).designResearch(scope, catalog, input.request, { model: input.model, signal })
      : input.design ?? defaultResearchImport(catalog);
    const { arrangement: _arrangement, columns_config: _columns, ...preview } = researchImportPlan(catalog, design);
    return preview;
  }
  /** The chat-to-workspace organizing step: one model-proposed ontology, reviewed before it becomes research operations. */
  async function previewLabels(scope: Scope, id: string, input: LabelInput, signal?: AbortSignal) {
    const { file, catalog } = await importCatalog(scope, id, input);
    const target = input.rows ?? "sources";
    const design = input.design ?? await (await dependencies.tabular()).designLabels(scope, catalog, file, target,
      input.request ?? fail(400, "Describe the label set you want"), { model: input.model, signal });
    const { actions: _actions, ...plan } = researchLabelPlan(file, catalog, design, target);
    return { ...plan, design, fingerprint: catalog.fingerprint };
  }
  async function applyLabels(scope: Scope, id: string, input: LabelInput, actor?: Operation): Promise<ResearchFile> {
    const { file, catalog } = await importCatalog(scope, id, input);
    if (input.fingerprint !== catalog.fingerprint)
      return conflict("This research changed after the proposal. Review the refreshed proposal before applying it.");
    const { title, propose, actions } = researchLabelPlan(file, catalog,
      input.design ?? fail(400, "Propose a label set before applying it"), input.rows ?? "sources");
    return await commitResearchFile(documents, scope, file, { type: "batch", title, actions, ...(propose ? { propose } : {}) },
      undefined, operation(actor)) ?? conflict("The workspace changed. Reload it before editing.");
  }
  async function table(scope: Scope, id: string, input: TableInput = {}, actor?: Operation): Promise<TabularReview> {
    if (input.tableId) { await bind(scope, id, { tableId: input.tableId, selection: input.selection }, actor);
      return (await (await dependencies.tabular()).detail(scope, input.tableId)).review; }
    const { file, catalog, resolveFinding } = await importCatalog(scope, id, input);
    if (input.design && (!input.fingerprint || input.fingerprint !== catalog.fingerprint))
      return conflict("This research changed after the preview. Review the refreshed mapping before creating the table.");
    const plan = researchImportPlan(catalog, input.design ?? defaultResearchImport(catalog));
    const review = await (await dependencies.tabular()).create(scope, { title: plan.design.title,
      project_id: file.document.project_id ?? undefined, research_file_id: id,
      arrangement: plan.arrangement, columns_config: plan.columns_config }, actor,
      { freeze: true, resolveFinding, expectedResearch: { versionId: file.versionId, workingRevision: file.workingRevision } });
    return review;
  }
  async function saveFindings(scope: Scope, id: string, input: { references: ResearchFindingReference[];
    typeId?: string; versionId: string; workingRevision: number }, actor?: Operation) {
    const read = await readFindings(scope, id), { file } = read;
    if (file.versionId !== input.versionId || file.workingRevision !== input.workingRevision)
      return conflict("The research set changed. Reload before saving these highlights.");
    if (input.typeId && file.state.labels[input.typeId]?.scope !== "highlight")
      return fail(400, "Choose a highlight type from this research set");
    const evidence = new Map<string, LegalEvidenceReceipt>();
    for (const reference of input.references) {
      const item = await read.resolve(reference) ?? fail(404, "Finding not found"),
        support = new Set(item.answer.claims.flatMap(({ evidence_ids }) => evidence_ids));
      if ([...support].some((id) => !item.evidence.some(({ evidence_id }) => evidence_id === id)))
        return fail(409, "An original supporting passage is unavailable");
      for (const receipt of item.evidence) if (support.has(receipt.evidence_id)) {
        if (receipt.scope !== "passage" || !receipt.span_text) return fail(400, "Highlighting requires an exact supporting passage");
        evidence.set(receipt.evidence_id, receipt);
      }
    }
    if (!evidence.size) return fail(400, "These findings contain no supporting passages to highlight");
    const saved = await commitResearchFile(documents, scope, file, { type: "merge", evidence: [...evidence.values()],
      labels: Object.fromEntries([...evidence.keys()].map((key) => [key, input.typeId ? [input.typeId] : []])) },
    undefined, operation(actor)) ?? conflict("The research set changed. Reload before saving.");
    return { file: saved, saved: evidence.size };
  }
  const columnValues = (column: TabularColumn, content: TabularCellContent) => {
    if (content.outcome === "not_found") return [];
    if (column.format === "yes_no") return typeof content.value === "boolean" ? [content.value ? "Yes" : "No"] : [];
    const values = Array.isArray(content.value) ? content.value : [content.value];
    return values.flatMap((value) => {
      if (typeof value !== "string" || !value.trim()) return [];
      if (value.trim().length > 200) return fail(400, "Consolidate long column values before creating labels; no values were truncated");
      return [value.trim()];
    });
  };
  async function columnLabels(scope: Scope, id: string, input: { reviewId: string; columnIndex: number; rowIds?: string[] },
    actor?: Operation): Promise<ResearchFile> {
    const file = await required(scope, id);
    if (!file.state.tables?.includes(input.reviewId)) return fail(404, "Table is outside this workspace");
    const detail = await (await dependencies.tabular()).detail(scope, input.reviewId),
      column = detail.review.columns_config.find(({ index }) => index === input.columnIndex);
    if (!column) return fail(404, "Column not found");
    if (column.format !== "tag" && column.format !== "yes_no")
      return fail(400, "Only tag and yes/no columns become labels");
    if (input.rowIds?.some((id) => !detail.review.document_ids.includes(id))) return fail(400, "A selected row is outside this table");
    const sources = new Map((detail.review.scope_config?.subjects ?? []).map((subject) =>
      [tabularSubjectId(subject), subject.sourceId])), values = new Map<string, string[]>();
    for (const cell of detail.cells) {
      const sourceId = sources.get(cell.document_id);
      if (cell.column_index !== input.columnIndex || input.rowIds && !input.rowIds.includes(cell.document_id) ||
          cell.status !== "done" || !cell.content || !sourceId) continue;
      for (const value of columnValues(column, cell.content)) {
        const assigned = values.get(value) ?? []; if (!assigned.includes(sourceId)) assigned.push(sourceId);
        values.set(value, assigned);
      }
    }
    if (!values.size) return fail(400, "This column has no completed values to label");
    if (values.size > 49) return fail(400, "Consolidate this column's values before creating labels; no values were omitted");
    const parentId = randomUUID(), children = [...values.keys()].sort().map((value) =>
      ({ value, id: randomUUID() }));
    const actions = [
      { type: "label" as const, id: parentId, name: column.name, parentId: null, scope: "source" as const },
      ...children.map(({ value, id: labelId }) => ({ type: "label" as const, id: labelId, name: value,
        parentId, scope: "source" as const })),
      ...children.map(({ value, id: labelId }) => ({ type: "label-selection" as const, target: "sources" as const,
        sourceIds: values.get(value)!, assign: [labelId], mode: "add" as const })),
    ];
    return await commitResearchFile(documents, scope, file, { type: "batch", propose: true,
      title: `Labels from ${column.name}`.slice(0, 200), actions },
    undefined, operation(actor)) ?? conflict("The workspace changed. Reload it before editing.");
  }

  return { get, create, update, query, collect, observe, revision, items, citation, bind, ensure, selection,
    context, readFindings, findings, views, table, previewTable, previewLabels, applyLabels, saveFindings, columnLabels };
}

export type SourceWorkspaceApplication = ReturnType<typeof createSourceWorkspaceApplication>;

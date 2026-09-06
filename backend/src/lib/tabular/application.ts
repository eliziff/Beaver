import { z } from "zod";
import { randomUUID } from "node:crypto";
import { runChatTurn } from "../chat/turnEngine";
import { throwIfAborted } from "../llm/abort";
import type { DocumentStore } from "../documentStore";
import type { ProjectStore } from "../projectStore";
import { providerForModel, type Provider, type UserApiKeys } from "../llm";
import { pageRequest, pageResponse } from "../pagination";
import type { UserModelSettings } from "../userApplication";
import {
  type TabularCell,
  type TabularCellContent,
  type TabularColumn,
  type TabularScope,
  type TabularRepository,
  type TabularSelection,
  type TabularOperation,
  type TabularReview,
  tabularSubjectId,
  type WriteResult,
} from "../tabularStore";
import { ApplicationError, reject as fail } from "../applicationError";
import { parseResourceReference, resourceReference } from "../resourceReferences";
import { resolveResearchSelection } from "../researchSelection";
import { commitResearchFile, createResearchFileState, readResearchFile,
  researchFileMarkdown } from "../researchFile";
import { extractTabularAnswers, tabularFormatDescription } from "./extraction";
import type { TabularAgents } from "./agents";
import type { resolveChatFindings } from "../researchChat";
import type { AuditStore } from "../audit";
import type { ResearchOperationContext } from "../researchProvenance";
import { researchArrangementSchema, resolveResearchArrangement, type ResearchArrangement } from "./researchArrangement";

const MAX_MODEL_CHARS = 1_000_000;
const id = z.string().trim().min(1).max(200);
const projectId = z.string({
  required_error: "project_id must be a non-empty string or null",
  invalid_type_error: "project_id must be a non-empty string or null",
}).trim().min(1, "project_id must be a non-empty string or null").max(200);
const column = z.object({
  index: z.number().int().nonnegative().max(10_000),
  name: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(20_000),
  format: z.string().trim().min(1).max(80).optional(),
  tags: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
}).strict();
const columns = z.array(column).max(100).superRefine((value, context) => {
  const seen = new Set<number>();
  value.forEach(({ index }, position) => {
    if (seen.has(index)) context.addIssue({ code: "custom", path: [position, "index"],
      message: "Column indices must be unique" });
    seen.add(index);
  });
});
const ids = z.array(id).max(500).transform((value) => [...new Set(value)]);
const rowId = z.string().trim().min(1).max(4_000);
const rowIds = z.array(rowId).max(500).transform((value) => [...new Set(value)]);
const modelOptions = {
  model: z.string().trim().min(1).max(200).optional(),
  reasoning_effort: z.string().trim().min(1).max(32).optional(),
};
const researchSelection = z.object({ sourceIds: ids.optional(), labelIds: ids.optional(),
  evidenceIds: ids.optional(), target: z.enum(["sources", "passages"]),
  unlabelled: z.boolean().optional() }).strict();
const researchInput = { research_file_id: id.optional(), research_selection: researchSelection.optional(),
  arrangement: researchArrangementSchema.nullable().optional() };

export const tabularDtos = {
  id,
  history: z.object({ offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
    limit: z.coerce.number().int().min(1).max(100).default(50) }).strict(),
  change: z.object({ id, action: z.enum(["accept", "reject", "undo"]), expected_version: z.string().min(1).max(100) }).strict(),
  list: z.object({
    q: z.string().trim().max(500).optional(), project_id: id.optional(),
    scope: z.enum(["all", "in-project", "standalone"]).optional(),
    limit: z.string().regex(/^\d{1,3}$/u).optional(),
    cursor: z.string().max(2_048).optional(),
  }).strict(),
  create: z.object({
    title: z.string().trim().max(300).optional(), document_ids: rowIds.optional(), ...researchInput,
    columns_config: columns, workflow_id: id.optional(), project_id: projectId.optional(),
  }).strict(),
  update: z.object({
    title: z.string().trim().max(300).nullable().optional(),
    document_ids: rowIds.optional(), columns_config: columns.optional(), ...researchInput,
    workflow_id: id.nullable().optional(),
    project_id: projectId.nullable().optional(),
    shared_with: z.array(z.string().trim().toLowerCase().email().max(320)).max(100)
      .transform((value) => [...new Set(value)]).optional(),
    expected_version: z.string().max(100).optional(),
  }).strict(),
  prompt: z.object({
    title: z.string().trim().min(1).max(200),
    format: z.string().trim().min(1).max(80).default("text"),
    documentName: z.string().trim().max(500).default(""),
    tags: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
  }).strict(),
  clear: z.object({ document_ids: z.array(rowId, {
    required_error: "document_ids is required",
    invalid_type_error: "document_ids is required",
  }).min(1, "document_ids is required").max(500)
    .transform((value) => [...new Set(value)]) }).strict(),
  regenerate: z.object({ document_id: z.string({
    required_error: "document_id and column_index are required",
    invalid_type_error: "document_id and column_index are required",
  }).trim().min(1, "document_id and column_index are required").max(4_000),
    column_index: z.number({
      required_error: "document_id and column_index are required",
      invalid_type_error: "document_id and column_index are required",
    }).int().nonnegative(),
    ...modelOptions }).strict(),
  generate: z.object(modelOptions).strict().default({}),
};

type Dependencies = {
  agents?: TabularAgents;
  runTurn?: typeof runChatTurn;
  audit?: AuditStore["record"];
  settings: (userId: string) => Promise<UserModelSettings>;
  resolveAnswers?: (scope: TabularScope, researchFileId: string, chatId: string) =>
    Promise<Awaited<ReturnType<typeof resolveChatFindings>>["findings"]>;
};

const value = <T>(result: WriteResult<T>, noun: string) => {
  if (result.status === "committed") return result.value;
  if (result.status === "missing") return fail(404, `${noun} not found`);
  return fail(409, `${noun} changed; reload and try again`);
};
const providerLabel = (provider: Provider) => ({ claude: "Anthropic", openai: "OpenAI",
  deepseek: "DeepSeek", openrouter: "OpenRouter", meta: "Meta", codex: "Codex",
  "opencode-go": "OpenCode Go",
  "claude-p": "Anthropic", ollama: "Ollama", gemini: "Gemini" })[provider];
const modelKey = (model: string, apiKeys: UserApiKeys) => {
  const provider = providerForModel(model);
  if (provider === "codex" || provider === "claude-p" || provider === "ollama") return;
  if (apiKeys[provider]?.trim()) return;
  throw new ApplicationError(422,
    `${providerLabel(provider)} API key is required to use ${model}. Add an API key or select a different tabular review model.`,
    { code: "missing_api_key", provider, model });
};
const json = (raw: string) => JSON.parse(raw.replace(/^```(?:json)?\s*/iu, "")
  .replace(/\s*```$/u, "").trim()) as Record<string, unknown>;
function exportCell(cell: TabularCell | undefined) {
  if (!cell || cell.status === "pending" || cell.status === "generating") return "";
  if (cell.status === "error") return "Error";
  return cell.content?.summary ?? "";
}

export function createTabularApplication(
  store: TabularRepository,
  documents: DocumentStore,
  projects: ProjectStore,
  dependencies: Dependencies,
) {
  const turn = dependencies.runTurn ?? runChatTurn;
  const settings = dependencies.settings;
  const running = (review: { id: string; user_id: string }) =>
    dependencies.agents?.active(review.id, review.user_id) ?? Promise.resolve(false);
  const assertIdle = async (review: { id: string; user_id: string }) => {
    if (await running(review)) throw new ApplicationError(
      409, "Stop the running review first.", { code: "review_running" });
  };
  const enqueue = async (scope: TabularScope, review: TabularReview,
    input: z.infer<typeof tabularDtos.generate>, assignments: { documentId: string; columnIndex?: number }[]) => {
    if (!dependencies.agents) return fail(503, "Tabular agents are unavailable");
    const user = await settings(scope.userId), model = input.model ?? user.tabular_model;
    modelKey(model, user.api_keys);
    const jobs = await dependencies.agents.enqueue(scope, { reviewId: review.id, ownerId: review.user_id,
      assignments: assignments.map((assignment) => {
        const subject = review.scope_config?.subjects.find((subject) => tabularSubjectId(subject) === assignment.documentId);
        return { ...assignment, sourceDocumentId: subject ? subject.reference.kind === "document" ? subject.reference.id : null
          : parseResourceReference(assignment.documentId)?.kind === "source" ? null : assignment.documentId };
      }), model, reasoningEffort: input.reasoning_effort });
    if (jobs.length && !jobs.some(({ created }) => created)) throw new ApplicationError(
      409, "This tabular review is already running.", { code: "review_running" });
    return { jobs, model };
  };
  const placement = async (scope: TabularScope, ids: string[], projectId: string | null,
    previous?: TabularSelection): Promise<TabularSelection> => {
    if (projectId && !await projects.get(scope, projectId)) fail(404, "Project not found");
    const unique = [...new Set(ids)], byId = new Map(previous?.subjects.map((subject) => [tabularSubjectId(subject), subject])),
      documentIds = [...new Set(unique.flatMap((id) => {
        const subject = byId.get(id);
        return subject ? subject.reference.kind === "document" ? [subject.reference.id] : []
          : parseResourceReference(id)?.kind !== "source" ? [id] : [];
      }))];
    const values = await documents.metadataMany(scope, documentIds);
    if (values.length !== documentIds.length || values.some((value) => projectId && value.project_id !== projectId))
      fail(404, "Document not found");
    if (previous?.research_file_id && !(await documents.metadataMany(scope, [previous.research_file_id])).length)
      fail(404, "Research set not found");
    return { ...previous, subjects: unique.map((id) => {
      const existing = byId.get(id);
      if (existing) return existing;
      const document = values.find((value) => value.id === id);
      if (!document) return fail(404, "Source not found");
      return { sourceId: id, resource: resourceReference.document(id, document.current_version_id), sourceSha256: document.source_sha256,
        reference: { provider: "library", kind: "document", id, versionId: document.current_version_id,
          title: document.filename } };
    }) };
  };
  const selection = async (scope: TabularScope, input: { document_ids?: string[];
    research_file_id?: string; research_selection?: z.infer<typeof researchSelection>;
    arrangement?: ResearchArrangement | null },
    projectId: string | null, previous?: TabularSelection, columns: TabularColumn[] = []) => {
    const fileId = input.research_file_id ?? previous?.research_file_id,
      arrangement = input.arrangement === undefined ? previous?.arrangement : input.arrangement;
    if ((input.research_selection || arrangement) && !fileId) fail(400, "Research set is required");
    if (arrangement && fileId) {
      const file = await readResearchFile(documents, scope, fileId);
      if (!file) return fail(404, "Research set not found");
      const resolved = await resolveResearchArrangement({ documents, scope, file, arrangement, columns,
        storedCells: [], strict: true, resolveAnswers: dependencies.resolveAnswers
          ? (chatId) => dependencies.resolveAnswers!(scope, fileId, chatId) : undefined });
      return placement(scope, arrangement.rows.map(({ id }) => id), projectId, {
        research_file_id: fileId, versionId: file.versionId, workingRevision: file.workingRevision,
        subjects: resolved.subjects, arrangement,
        ...(previous?.research_file_id === fileId && previous.findings ? { findings: previous.findings } : {}) });
    }
    if (fileId && (input.research_file_id || input.research_selection || input.arrangement === null)) {
      const resolved = await resolveResearchSelection(documents, scope, {
        researchFileId: fileId, target: "sources", ...input.research_selection });
      return placement(scope, resolved.subjects.map(tabularSubjectId), projectId,
        { ...resolved, research_file_id: fileId,
          ...(previous?.research_file_id === fileId && previous.findings ? { findings: previous.findings } : {}) });
    }
    return placement(scope, input.document_ids ?? [], projectId, previous);
  };
  const subjectDocuments = async (scope: TabularScope, review: { document_ids: string[];
    project_id: string | null; scope_config?: TabularSelection }) => {
    const config = await placement(scope, review.document_ids, review.project_id, review.scope_config);
    const metadata = await documents.metadataMany(scope, [...new Set(config.subjects.flatMap(({ reference }) =>
      reference.kind === "document" ? [reference.id] : []))]);
    const file = config.arrangement && config.research_file_id
      ? await readResearchFile(documents, scope, config.research_file_id) : null;
    return config.subjects.map((subject) => ({
      ...metadata.find((document) => document.id === subject.reference.id),
      id: tabularSubjectId(subject), filename: config.arrangement?.rows.find(({ id }) => id === subject.rowId)?.title
        ?? subject.reference.title ?? subject.sourceId,
      ...(config.arrangement ? { group: (config.arrangement.rows.find(({ id }) => id === subject.rowId)?.group ?? [])
        .map((id) => file?.state.labels[id]?.name ?? "Removed label") } : {}),
      resource: subject.resource, reference: subject.reference,
    }));
  };
  const resolvedDetail = async (scope: TabularScope, reviewId: string) => {
    const detail = await store.detail(scope, reviewId);
    if (!detail) return fail(404, "Review not found");
    const config = detail.review.scope_config;
    if (!config?.arrangement || !config.research_file_id) return detail;
    const file = await readResearchFile(documents, scope, config.research_file_id);
    if (!file) return fail(404, "Research set not found");
    const resolved = await resolveResearchArrangement({ documents, scope, file, arrangement: config.arrangement,
      columns: detail.review.columns_config, storedCells: detail.cells,
      resolveAnswers: dependencies.resolveAnswers
        ? (chatId) => dependencies.resolveAnswers!(scope, file.document.id, chatId) : undefined });
    return { ...detail, cells: resolved.cells };
  };
  const mappedCell = (config: TabularSelection | undefined, rowId: string, columnIndex: number) =>
    config?.arrangement?.cells.some((cell) => cell.rowId === rowId && cell.columnIndex === columnIndex) ?? false;
  const mergeWorkspace = async (scope: TabularScope, reviewId: string,
    selection: TabularSelection, evidence: TabularCellContent["evidence"],
    operation: Omit<ResearchOperationContext, "audit"> = { executor: "human" }) => {
    if (!selection.research_file_id) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await readResearchFile(documents, scope, selection.research_file_id);
      if (!current) return fail(404, "Research set not found");
      if (await commitResearchFile(documents, scope, current, { type: "merge",
        sources: selection.subjects.map(({ reference }) => reference), evidence,
        tables: [reviewId] }, undefined, dependencies.audit
          ? { audit: dependencies.audit, ...operation, reviewId } : undefined)) return;
    }
    fail(409, "Research set changed; retry the extraction");
  };

  async function modelText(input: { model: string; system: string; user: string;
    apiKeys: UserApiKeys; reasoningEffort?: string; signal?: AbortSignal }) {
    const result = await turn({ model: input.model, systemPrompt: input.system,
      messages: [{ role: "user", content: input.user }], createTools: () => [],
      emit() {}, apiKeys: input.apiKeys, reasoningEffort: input.reasoningEffort,
      signal: input.signal, subagentMode: "none", separateContentBlocks: false,
    });
    if (result.fullText.length > MAX_MODEL_CHARS)
      return fail(502, "Model output exceeded the tabular extraction limit");
    return result.fullText;
  }


  const cellWrite = async (scope: TabularScope, cell: TabularCell,
    status: TabularCell["status"], content: TabularCellContent | null, expectedReviewVersion?: string,
    operation?: TabularOperation) => value(
      await store.setCell(scope, { reviewId: cell.review_id, documentId: cell.document_id,
        columnIndex: cell.column_index, expected: { status: cell.status, content: cell.content,
          ...(typeof cell.updated_at === "string" ? { updated_at: cell.updated_at } : {}) },
        status, content, expectedReviewVersion, operation }), "Cell");


  async function generateDocument(scope: TabularScope,
    item: TabularSelection["subjects"][number] & { id: string }, config: TabularColumn[],
    cells: Map<string, TabularCell>, model: string, apiKeys: UserApiKeys,
    reasoningEffort: string | undefined, signal?: AbortSignal, force = false,
    reviewVersion?: string, selection?: TabularSelection, jobId?: string) {
    const pending = config.filter((column) => {
      if (mappedCell(selection, item.id, column.index)) return false;
      const existing = cells.get(`${item.id}:${column.index}`);
      return force || existing?.status !== "done" || !existing.content;
    });
    if (!pending.length) return;
    const generationId = jobId ?? randomUUID(), operation = (cell: TabularCell): TabularOperation => ({
      executor: "assistant", model, title: "Generate table answer", changeKey: `${generationId}:${cell.id}` });
    for (const column of pending) {
      const key = `${item.id}:${column.index}`, current = cells.get(key);
      if (!current) return fail(404, "Cell not found");
      const changed = await cellWrite(scope, current, "generating", null, reviewVersion, operation(current));
      cells.set(key, changed);
    }
    let received: Set<number>;
    try {
      received = await extractTabularAnswers({ model, apiKeys, reasoningEffort, subject: item,
        documents, scope, runTurn: turn,
        columns: pending, signal, accept: async (index, result) => {
          const key = `${item.id}:${index}`, current = cells.get(key)!;
          if (selection) await mergeWorkspace(scope, current.review_id, selection, result.evidence,
            { executor: "assistant", model, jobId });
          throwIfAborted(signal);
          const changed = await cellWrite(scope, current, "done", result, reviewVersion, operation(current));
          cells.set(key, changed);
          await dependencies.audit?.({ userId: scope.userId, userEmail: scope.userEmail,
            action: "tabular.cell", surface: "tabular", reviewId: current.review_id, model,
            detail: { initiator_user_id: scope.userId, executor: "assistant", job_id: jobId,
              column_index: index, resource: result.resource, question_revision: reviewVersion,
              evidence_ids: result.evidence.map(({ evidence_id }) => evidence_id),
              outcome: result.outcome, coverage: result.coverage } }).catch(() => undefined);
        } });
    } catch (error) {
      for (const column of pending) {
        const key = `${item.id}:${column.index}`, current = cells.get(key)!;
        if (current.status !== "generating") continue;
        const changed = await cellWrite(
          scope, current, signal?.aborted ? "pending" : "error", null, reviewVersion, operation(current),
        )
          .catch(() => null);
        if (changed) cells.set(key, changed);
      }
      throw error;
    }
    for (const column of pending) if (!received.has(column.index)) {
      const key = `${item.id}:${column.index}`, current = cells.get(key)!;
      const changed = await cellWrite(scope, current, "error", null, reviewVersion, operation(current));
      cells.set(key, changed);
    }
  }

  async function runAgent(scope: TabularScope, input: {
    reviewId: string; documentId: string; model?: string;
    reasoningEffort?: string; columnIndex?: number; jobId?: string;
  }, signal?: AbortSignal) {
    const detail = await store.detail(scope, input.reviewId);
    if (!detail) return fail(404, "Review not found");
    if (!detail.review.document_ids.includes(input.documentId))
      return fail(404, "Document not found");
    const config = input.columnIndex === undefined
      ? detail.review.columns_config
      : detail.review.columns_config.filter(({ index }) => index === input.columnIndex);
    if (!config.length) return fail(400,
      input.columnIndex === undefined ? "No columns configured" : "Column not found");
    const user = await settings(scope.userId);
    const model = input.model ?? user.tabular_model;
    modelKey(model, user.api_keys);
    const cells = new Map(detail.cells.map((cell) =>
      [`${cell.document_id}:${cell.column_index}`, cell]));
    const frozen = await placement(scope, [input.documentId],
      detail.review.project_id, detail.review.scope_config);
    const subject = frozen.subjects.find((value) => tabularSubjectId(value) === input.documentId)!;
    await generateDocument(scope, { ...subject, id: input.documentId },
      config, cells, model, user.api_keys, input.reasoningEffort, signal,
      input.columnIndex !== undefined, detail.review.updated_at, frozen, input.jobId);
    return input.columnIndex === undefined
      ? null
      : cells.get(`${input.documentId}:${input.columnIndex}`)?.content ?? null;
  }

  return {
    runAgent,
    async fromFindings(scope: TabularScope, resolved: Awaited<ReturnType<typeof resolveChatFindings>>) {
      const { file, findings } = resolved;
      if (!findings.length) return fail(400, "No grounded findings selected");
      const chosen = { chatId: findings[0].origin.chatId,
        answerIds: [...new Set(findings.map(({ question }) => question.id))].sort(),
        sourceIds: [...new Set(findings.map(({ sourceId }) => sourceId))].sort() };
      for (const tableId of file.state.tables ?? []) {
        const existing = await store.detail(scope, tableId);
        if (existing?.review.scope_config?.research_file_id === file.document.id &&
            JSON.stringify(existing.review.scope_config.findings) === JSON.stringify(chosen))
          return { ...existing.review, needs_arrangement: !existing.review.scope_config.arrangement };
      }
      const subjects = [...new Map(findings.map(({ sourceId, resource }) => [resource, {
        sourceId, resource, reference: file.state.sources[sourceId].reference,
      }])).values()];
      if (subjects.length > 500) return fail(400, "Select at most 500 sources");
      const scopeConfig = await placement(scope, subjects.map(tabularSubjectId), file.document.project_id,
        { research_file_id: file.document.id, versionId: file.versionId,
          workingRevision: file.workingRevision, subjects, findings: chosen });
      const review = value(await store.create(scope, { projectId: file.document.project_id,
        title: file.document.filename.replace(/\.research\.md$/iu, ""), columns: [],
        documentIds: subjects.map(tabularSubjectId), scopeConfig }), "Review");
      try { await mergeWorkspace(scope, review.id, scopeConfig, []); }
      catch (error) { await store.delete(scope, review.id, review.updated_at).catch(() => undefined); throw error; }
      return { ...review, needs_arrangement: true };
    },
    async list(scope: TabularScope, input: z.infer<typeof tabularDtos.list>) {
      const q = input.q?.toLocaleLowerCase() ?? "", projectId = input.project_id ?? null;
      if (projectId && !await projects.get(scope, projectId)) fail(404, "Project not found");
      const listScope = input.scope ?? "all", filters = { q, project_id: projectId, scope: listScope };
      const { after, limit } = pageRequest<[string, string]>(input, "tabular-review",
        filters, ["string", "string"]);
      const page = await store.page(scope, { projectId, scope: listScope, q, limit, after });
      const items = await Promise.all(page.items.map(async (item) => {
        const id = typeof item.project_id === "string" ? item.project_id : null;
        const owner = id ? await projects.get(scope, id) : null;
        return { ...item, project_name: typeof owner?.name === "string" ? owner.name : null };
      }));
      return pageResponse("tabular-review", filters, { ...page, items });
    },
    async create(scope: TabularScope, input: z.infer<typeof tabularDtos.create>,
      operation?: TabularOperation) {
      const projectId = input.project_id ?? null;
      const scopeConfig = await selection(scope, input, projectId, undefined, input.columns_config);
      const review = value(await store.create(scope, { title: input.title,
        projectId, documentIds: scopeConfig.subjects.map(tabularSubjectId), scopeConfig,
        columns: input.columns_config, workflowId: input.workflow_id, operation }), "Review");
      try { await mergeWorkspace(scope, review.id, scopeConfig, [], operation); }
      catch (error) { await store.delete(scope, review.id, review.updated_at).catch(() => undefined); throw error; }
      return review;
    },
    async detail(scope: TabularScope, reviewId: string) {
      const detail = await resolvedDetail(scope, reviewId);
      return { ...detail, review: { ...detail.review,
        is_running: await running(detail.review) },
      documents: await subjectDocuments(scope, detail.review) };
    },
    async workspace(scope: TabularScope, reviewId: string) {
      const detail = await store.detail(scope, reviewId);
      if (!detail) return fail(404, "Review not found");
      let config = await placement(scope, detail.review.document_ids,
        detail.review.project_id, detail.review.scope_config);
      if (!config.research_file_id) {
        await assertIdle(detail.review);
        const title = detail.review.title?.trim() || "Tabular Review";
        const document = await documents.create(scope, { filename: `${title}.research.md`, fileType: "md",
          projectId: detail.review.project_id, libraryKind: "file",
          bytes: Buffer.from(researchFileMarkdown(title, createResearchFileState())) });
        config = { ...config, research_file_id: document.id };
        const changed = await store.update(scope, reviewId, detail.review.updated_at, { scopeConfig: config });
        if (changed.status !== "committed") {
          await documents.deleteDocument(scope, document.id, true);
          value(changed, "Review");
        }
      }
      await mergeWorkspace(scope, reviewId, config, detail.cells.flatMap((cell) =>
        cell.status === "done" ? cell.content?.evidence ?? [] : []));
      return { research_file_id: config.research_file_id! };
    },
    async export(scope: TabularScope, reviewId: string) {
      const detail = await resolvedDetail(scope, reviewId);
      const columns = [...detail.review.columns_config].sort((a, b) => a.index - b.index);
      const cells = new Map(detail.cells.map((cell) =>
        [`${cell.document_id}:${cell.column_index}`, cell]));
      const documentsById = new Map((await subjectDocuments(scope, detail.review))
        .map((document) => [document.id, document]));
      const rows = [
        ["Document", ...columns.map(({ name }) => name)],
        ...detail.review.document_ids.map((documentId) => [
          String(documentsById.get(documentId)?.filename ?? documentId),
          ...columns.map(({ index }) => exportCell(cells.get(`${documentId}:${index}`))),
        ]),
      ];
      const XLSX = await import("xlsx");
      const workbook = XLSX.utils.book_new();
      const worksheet = XLSX.utils.aoa_to_sheet(rows);
      worksheet["!cols"] = rows[0].map((_value, index) => ({
        wch: Math.min(60, Math.max(20, ...rows.map((row) => String(row[index] ?? "").length))),
      }));
      XLSX.utils.book_append_sheet(workbook, worksheet, "Review");
      return {
        filename: `${detail.review.title?.trim() || "Tabular Review"}.xlsx`,
        bytes: Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" })),
      };
    },
    async people(scope: TabularScope, reviewId: string) {
      return await store.people(scope, reviewId) ?? fail(404, "Review not found");
    },
    async update(scope: TabularScope, reviewId: string,
      input: z.infer<typeof tabularDtos.update>, operation?: TabularOperation) {
      if (input.shared_with?.includes(scope.userEmail?.trim().toLowerCase() ?? ""))
        return fail(400, "You cannot share a tabular review with yourself.");
      const current = await store.detail(scope, reviewId);
      if (!current) return fail(404, "Review not found");
      await assertIdle(current.review);
      if (!current.review.is_owner && (input.columns_config !== undefined || input.research_file_id !== undefined ||
          input.arrangement !== undefined))
        return fail(403, "Only the review owner can change columns");
      if (!current.review.is_owner && input.shared_with !== undefined)
        return fail(403, "Only the review owner can change sharing");
      if (!current.review.is_owner && input.project_id !== undefined)
        return fail(403, "Only the review owner can move a review");
      if (input.shared_with) {
        const missing = await store.missingRecipient(scope, input.shared_with);
        if (missing) fail(400, `${missing} does not belong to a Beaver user.`);
      }
      const nextProject = input.project_id === undefined
        ? current.review.project_id : input.project_id;
      const nextSelection = input.document_ids === undefined && input.project_id === undefined &&
        input.research_file_id === undefined && input.research_selection === undefined && input.arrangement === undefined &&
        !(input.columns_config && current.review.scope_config?.arrangement) ? undefined : await selection(scope,
          { ...input, document_ids: input.document_ids ?? current.review.document_ids },
          nextProject, current.review.scope_config, input.columns_config ?? current.review.columns_config);
      return value(await store.update(scope, reviewId,
        input.expected_version ?? current.review.updated_at, {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.project_id !== undefined ? { projectId: input.project_id } : {}),
          ...(input.columns_config !== undefined ? { columns: input.columns_config } : {}),
          ...(input.workflow_id !== undefined ? { workflowId: input.workflow_id } : {}),
          ...(nextSelection ? { documentIds: nextSelection.subjects.map(tabularSubjectId), scopeConfig: nextSelection } : {}),
          ...(input.shared_with !== undefined ? { sharedWith: input.shared_with } : {}),
          operation,
        }), "Review");
    },
    async history(scope: TabularScope, reviewId: string, input: z.infer<typeof tabularDtos.history>) {
      return await store.history(scope, reviewId, input) ?? fail(404, "Review not found");
    },
    async change(scope: TabularScope, reviewId: string, input: z.infer<typeof tabularDtos.change>,
      operation?: TabularOperation) {
      const current = await store.detail(scope, reviewId);
      if (!current) return fail(404, "Review not found");
      await assertIdle(current.review);
      return value(await store.change(scope, reviewId, input.id, input.action, input.expected_version, operation), "Review");
    },
    async answers(scope: TabularScope, researchFileId: string, input: {
      chat_id: string; offset: number; limit: number; answer_id?: string; resource?: string }) {
      const file = await readResearchFile(documents, scope, researchFileId);
      if (!file?.state.chats?.includes(input.chat_id)) return fail(404, "Chat is outside the current workspace");
      if (!dependencies.resolveAnswers) return fail(503, "Saved chat answers are unavailable");
      const findings = (await dependencies.resolveAnswers(scope, researchFileId, input.chat_id))
        .filter((finding) => (!input.answer_id || finding.question.id === input.answer_id) &&
          (!input.resource || finding.resource === input.resource));
      if (input.answer_id && !findings.length) return fail(404, "Saved answer not found");
      return { items: findings.slice(input.offset, input.offset + input.limit), total: findings.length,
        next_offset: input.offset + input.limit < findings.length ? input.offset + input.limit : null };
    },
    async remove(scope: TabularScope, reviewId: string) {
      const current = await store.detail(scope, reviewId);
      if (!current || !current.review.is_owner) return fail(404, "Review not found");
      await assertIdle(current.review);
      value(await store.delete(scope, reviewId, current.review.updated_at), "Review");
    },
    deleteAll: (scope: TabularScope) => store.deleteAll(scope),
    async clear(scope: TabularScope, reviewId: string,
      input: z.infer<typeof tabularDtos.clear>) {
      const detail = await store.detail(scope, reviewId);
      if (!detail) return fail(404, "Review not found");
      await assertIdle(detail.review);
      const allowed = new Set(detail.review.document_ids);
      if (input.document_ids.some((documentId) => !allowed.has(documentId)))
        return fail(404, "Document not found");
      const selected = new Set(input.document_ids);
      for (const cell of detail.cells) if (selected.has(cell.document_id) &&
        !mappedCell(detail.review.scope_config, cell.document_id, cell.column_index) &&
        (cell.status !== "pending" || cell.content !== null))
        await cellWrite(scope, cell, "pending", null, detail.review.updated_at, { executor: "human", title: "Clear table answer" });
    },
    async prompt(scope: TabularScope, input: z.infer<typeof tabularDtos.prompt>,
      signal?: AbortSignal) {
      const config = await settings(scope.userId);
      const raw = await modelText({ model: config.title_model, apiKeys: config.api_keys,
        system: 'Write legal-review extraction prompts. Return only {"prompt":string}. Do not include response-format instructions.',
        user: `Column title: ${input.title}\nDocument: ${input.documentName || "unspecified"}\nExpected response: ${tabularFormatDescription(input)}`,
        signal });
      try {
        const prompt = String(json(raw).prompt ?? "").trim().slice(0, 20_000);
        if (prompt) return { prompt, source: "llm" as const };
      } catch {}
      return fail(502, "LLM returned an invalid prompt");
    },
    async regenerate(scope: TabularScope, reviewId: string,
      input: z.infer<typeof tabularDtos.regenerate>) {
      const detail = await store.detail(scope, reviewId);
      if (!detail) return fail(404, "Review not found");
      await assertIdle(detail.review);
      if (!detail.review.document_ids.includes(input.document_id))
        return fail(404, "Document not found");
      if (!detail.review.columns_config.some(({ index }) => index === input.column_index))
        return fail(400, "Column not found");
      if (mappedCell(detail.review.scope_config, input.document_id, input.column_index))
        return fail(400, "This cell references existing research; edit its arrangement to change it");
      const { jobs: [job] } = await enqueue(scope, detail.review, input,
        [{ documentId: input.document_id, columnIndex: input.column_index }]);
      return { job_id: job.id, queued: true };
    },
    async generate(scope: TabularScope, reviewId: string,
      input: z.infer<typeof tabularDtos.generate>) {
      const detail = await store.detail(scope, reviewId);
      if (!detail) return fail(404, "Review not found");
      await assertIdle(detail.review);
      if (!detail.review.columns_config.length) return fail(400, "No columns configured");
      if (!detail.review.document_ids.length) return fail(400, "No documents configured");
      const pending = new Set(detail.cells.filter((cell) =>
        !mappedCell(detail.review.scope_config, cell.document_id, cell.column_index) &&
        (cell.status !== "done" || !cell.content)).map((cell) => cell.document_id));
      const { jobs, model } = await enqueue(scope, detail.review, input,
        detail.review.document_ids.filter((id) => pending.has(id)).map((documentId) => ({ documentId })));
      if (jobs.some(({ created }) => created)) await store.recordGeneration(scope, {
        reviewId, title: detail.review.title, projectId: detail.review.project_id,
        model, failed: false,
      }).catch(() => undefined);
      return { job_ids: jobs.map(({ id }) => id),
        queued: jobs.filter(({ created }) => created).length };
    },
    async stop(scope: TabularScope, reviewId: string) {
      const detail = await store.detail(scope, reviewId);
      if (!detail) return fail(404, "Review not found");
      return { stopped: await dependencies.agents?.cancel(
        reviewId, detail.review.user_id,
      ) ?? false };
    },
  };
}

export type TabularApplication = ReturnType<typeof createTabularApplication>;

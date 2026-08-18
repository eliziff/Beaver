import { z } from "zod";
import { textParserFor } from "../chat/tools/documentOps";
import { runChatTurn } from "../chat/turnEngine";
import type { DocumentStore } from "../documentStore";
import { throwIfAborted } from "../llm/abort";
import { providerForModel, type Provider, type UserApiKeys } from "../llm";
import { encodePageCursor, pageRequest } from "../pagination";
import { getUserModelSettings } from "../userSettings";
import {
  TabularStoreError,
  type TabularCell,
  type TabularCellContent,
  type TabularColumn,
  type TabularScope,
  type TabularStore,
  type WriteResult,
} from "../tabularStore";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_DOCUMENT_CHARS = 120_000;
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
const modelOptions = {
  model: z.string().trim().min(1).max(200).optional(),
  reasoning_effort: z.string().trim().min(1).max(32).optional(),
};

export const tabularDtos = {
  id,
  list: z.object({
    q: z.string().trim().max(500).optional(), project_id: id.optional(),
    scope: z.enum(["all", "in-project", "standalone"]).optional(),
    limit: z.string().regex(/^\d{1,3}$/u).optional(),
    cursor: z.string().max(2_048).optional(),
  }).strict(),
  create: z.object({
    title: z.string().trim().max(300).optional(), document_ids: ids,
    columns_config: columns, workflow_id: id.optional(), project_id: projectId.optional(),
  }).strict(),
  update: z.object({
    title: z.string().trim().max(300).nullable().optional(),
    document_ids: ids.optional(), columns_config: columns.optional(),
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
  clear: z.object({ document_ids: z.array(id, {
    required_error: "document_ids is required",
    invalid_type_error: "document_ids is required",
  }).min(1, "document_ids is required").max(500)
    .transform((value) => [...new Set(value)]) }).strict(),
  regenerate: z.object({ document_id: z.string({
    required_error: "document_id and column_index are required",
    invalid_type_error: "document_id and column_index are required",
  }).trim().min(1, "document_id and column_index are required").max(200),
    column_index: z.number({
      required_error: "document_id and column_index are required",
      invalid_type_error: "document_id and column_index are required",
    }).int().nonnegative(),
    ...modelOptions }).strict(),
  generate: z.object(modelOptions).strict().default({}),
};

type Settings = Awaited<ReturnType<typeof getUserModelSettings>>;
type Emit = (event: { type: "cell_update"; document_id: string;
  column_index: number; content: TabularCellContent | null;
  status: TabularCell["status"] }) => void;
type Dependencies = {
  runTurn?: typeof runChatTurn;
  settings?: (userId: string) => Promise<Settings>;
};

const fail = (status: number, message: string): never => {
  throw new TabularStoreError(status, message);
};
const value = <T>(result: WriteResult<T>, noun: string) => {
  if (result.status === "committed") return result.value;
  if (result.status === "missing") return fail(404, `${noun} not found`);
  return fail(409, `${noun} changed; reload and try again`);
};
const providerLabel = (provider: Provider) => ({ claude: "Anthropic", openai: "OpenAI",
  deepseek: "DeepSeek", openrouter: "OpenRouter", meta: "Meta", codex: "Codex",
  "claude-p": "Anthropic", ollama: "Ollama", gemini: "Gemini" })[provider];
const modelKey = (model: string, apiKeys: UserApiKeys) => {
  const provider = providerForModel(model);
  if (provider === "codex" || provider === "claude-p" || provider === "ollama") return;
  if (apiKeys[provider]?.trim()) return;
  throw Object.assign(new TabularStoreError(422,
    `${providerLabel(provider)} API key is required to use ${model}. Add an API key or select a different tabular review model.`),
  { code: "missing_api_key", provider, model });
};
const suffix = (format?: string, tags?: string[]) => ({
  bulleted_list: ' Use a markdown bulleted list only in "summary".',
  number: ' Use one number only in "summary".',
  percentage: ' Use one percentage only in "summary".',
  monetary_amount: ' Use one monetary value, including its currency, in "summary".',
  currency: ' Use only currency codes wrapped like [[USD]] in "summary".',
  yes_no: ' Use only [[Yes]] or [[No]] in "summary".',
  date: ' Use DD Month YYYY in "summary".',
  tag: tags?.length ? ` Use exactly one of ${tags.map((tag) => `[[${tag}]]`).join(", ")} in "summary".` : "",
})[format ?? ""] ?? "";
const cleanResult = (raw: Record<string, unknown>): TabularCellContent => ({
  summary: String(raw.summary ?? raw.value ?? "").trim().slice(0, 8_000) || "Not addressed",
  flag: ["green", "grey", "yellow", "red"].includes(String(raw.flag))
    ? String(raw.flag) : "grey",
  reasoning: String(raw.reasoning ?? "").slice(0, 16_000),
});
const json = (raw: string) => JSON.parse(raw.replace(/^```(?:json)?\s*/iu, "")
  .replace(/\s*```$/u, "").trim()) as Record<string, unknown>;

export function createTabularApplication(
  store: TabularStore,
  documents: DocumentStore,
  dependencies: Dependencies = {},
) {
  const turn = dependencies.runTurn ?? runChatTurn;
  const settings = dependencies.settings ?? getUserModelSettings;

  async function modelText(input: { model: string; system: string; user: string;
    apiKeys: UserApiKeys; reasoningEffort?: string; signal?: AbortSignal;
    onDelta?: (delta: string) => void }) {
    const limit = new AbortController(), signal = input.signal
      ? AbortSignal.any([input.signal, limit.signal]) : limit.signal;
    let streamed = "", overflow = false;
    try {
      const result = await turn({ model: input.model, systemPrompt: input.system,
        messages: [{ role: "user", content: input.user }], createTools: () => [],
        emit(event) {
          const item = event as { type?: unknown; text?: unknown };
          if (item.type !== "content_delta" || typeof item.text !== "string") return;
          streamed += item.text;
          if (streamed.length > MAX_MODEL_CHARS) { overflow = true; limit.abort(); return; }
          input.onDelta?.(item.text);
        }, done() {}, apiKeys: input.apiKeys, reasoningEffort: input.reasoningEffort,
        signal, subagentMode: "none", separateContentBlocks: false,
      });
      if (overflow || result.fullText.length > MAX_MODEL_CHARS)
        return fail(502, "Model output exceeded the tabular extraction limit");
      return result.fullText || streamed;
    } catch (error) {
      if (overflow) return fail(502, "Model output exceeded the tabular extraction limit");
      throw error;
    }
  }

  async function document(scope: TabularScope, documentId: string, signal?: AbortSignal) {
    throwIfAborted(signal);
    const content = await documents.read(scope, documentId, null, false);
    throwIfAborted(signal);
    if (!content) return fail(404, "Document not found");
    if (content.bytes.byteLength > MAX_FILE_BYTES)
      return fail(413, "Document exceeds the 25 MB tabular extraction limit");
    const parser = textParserFor(content.fileType.toLowerCase()) ?? textParserFor("docx");
    const markdown = parser ? await parser.run(content.bytes) : "";
    throwIfAborted(signal);
    return { id: documentId, filename: content.filename.slice(0, 500),
      markdown: markdown.slice(0, MAX_DOCUMENT_CHARS) };
  }

  const cellWrite = async (scope: TabularScope, cell: TabularCell,
    status: TabularCell["status"], content: TabularCellContent | null) => value(
      await store.setCell(scope, { reviewId: cell.review_id, documentId: cell.document_id,
        columnIndex: cell.column_index, expected: { status: cell.status, content: cell.content },
        status, content }), "Cell");

  async function extract(input: { model: string; apiKeys: UserApiKeys;
    reasoningEffort?: string; document: Awaited<ReturnType<typeof document>>;
    columns: TabularColumn[]; signal?: AbortSignal;
    accept(index: number, result: TabularCellContent): Promise<void> }) {
    const description = input.columns.map((column) =>
      `Column ${column.index} — "${column.name}": ${column.prompt}${suffix(column.format, column.tags)} If not found, state "Not Found".`).join("\n");
    const system = `You are a legal document analyst. Return one minified JSON object per line:
{"column_index":number,"summary":string,"flag":"green"|"grey"|"yellow"|"red","reasoning":string}
Process columns in order. Cite factual claims as [[page:N||quote:verbatim excerpt <=25 words]]. Output JSON lines only.`;
    let buffer = "", sawDelta = false, pending = Promise.resolve();
    const received = new Set<number>();
    const processLine = async (line: string) => {
      if (!line.trim() || line.trim().startsWith("```")) return;
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(line.trim()) as Record<string, unknown>; } catch { return; }
      const index = parsed.column_index;
      if (typeof index !== "number" || received.has(index) ||
        !input.columns.some((column) => column.index === index)) return;
      received.add(index);
      await input.accept(index, cleanResult(parsed));
    };
    const delta = (value: string) => {
      sawDelta = true; buffer += value;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        pending = pending.then(() => processLine(line)); newline = buffer.indexOf("\n");
      }
    };
    const raw = await modelText({ model: input.model, system,
      user: `Document: ${input.document.filename}\n\n${input.document.markdown}\n\n---\nColumns:\n${description}`,
      apiKeys: input.apiKeys, reasoningEffort: input.reasoningEffort,
      signal: input.signal, onDelta: delta });
    if (!sawDelta) buffer = raw;
    if (buffer.trim()) pending = pending.then(() => processLine(buffer));
    await pending;
    return received;
  }

  async function generateDocument(scope: TabularScope,
    item: Awaited<ReturnType<typeof document>>, config: TabularColumn[],
    cells: Map<string, TabularCell>, model: string, apiKeys: UserApiKeys,
    reasoningEffort: string | undefined, emit: Emit, signal?: AbortSignal) {
    const pending = config.filter((column) => {
      const existing = cells.get(`${item.id}:${column.index}`);
      return existing?.status !== "done" || !existing.content;
    });
    for (const column of pending) {
      const key = `${item.id}:${column.index}`, current = cells.get(key);
      if (!current) return fail(404, "Cell not found");
      const changed = await cellWrite(scope, current, "generating", null);
      cells.set(key, changed); emit({ type: "cell_update", document_id: item.id,
        column_index: column.index, content: null, status: "generating" });
    }
    let received: Set<number>;
    try {
      received = await extract({ model, apiKeys, reasoningEffort, document: item,
        columns: pending, signal, accept: async (index, result) => {
          const key = `${item.id}:${index}`, current = cells.get(key)!;
          const changed = await cellWrite(scope, current, "done", result);
          cells.set(key, changed); emit({ type: "cell_update", document_id: item.id,
            column_index: index, content: result, status: "done" });
        } });
    } catch (error) {
      for (const column of pending) {
        const key = `${item.id}:${column.index}`, current = cells.get(key)!;
        if (current.status !== "generating") continue;
        const changed = await cellWrite(scope, current, "error", null).catch(() => null);
        if (changed) cells.set(key, changed);
      }
      throw error;
    }
    for (const column of pending) if (!received.has(column.index)) {
      const key = `${item.id}:${column.index}`, current = cells.get(key)!;
      const changed = await cellWrite(scope, current, "error", null);
      cells.set(key, changed); emit({ type: "cell_update", document_id: item.id,
        column_index: column.index, content: null, status: "error" });
    }
  }

  return {
    async list(scope: TabularScope, input: z.infer<typeof tabularDtos.list>) {
      const q = input.q?.toLocaleLowerCase() ?? "", projectId = input.project_id ?? null;
      const listScope = input.scope ?? "all", filters = { q, project_id: projectId, scope: listScope };
      const { after, limit } = pageRequest<[string, string]>(input, "tabular-review",
        filters, ["string", "string"]);
      const page = await store.page(scope, { projectId, scope: listScope, q, limit, after });
      return { items: page.items, next_cursor: page.nextAfter
        ? encodePageCursor("tabular-review", filters, page.nextAfter) : null };
    },
    async create(scope: TabularScope, input: z.infer<typeof tabularDtos.create>) {
      return value(await store.create(scope, { title: input.title,
        projectId: input.project_id ?? null, documentIds: input.document_ids,
        columns: input.columns_config, workflowId: input.workflow_id }), "Review");
    },
    async detail(scope: TabularScope, reviewId: string) {
      return await store.detail(scope, reviewId) ?? fail(404, "Review not found");
    },
    async people(scope: TabularScope, reviewId: string) {
      return await store.people(scope, reviewId) ?? fail(404, "Review not found");
    },
    async update(scope: TabularScope, reviewId: string,
      input: z.infer<typeof tabularDtos.update>) {
      if (input.shared_with?.includes(scope.userEmail?.trim().toLowerCase() ?? ""))
        return fail(400, "You cannot share a tabular review with yourself.");
      const current = await store.detail(scope, reviewId);
      if (!current) return fail(404, "Review not found");
      if (!current.review.is_owner && input.columns_config !== undefined)
        return fail(403, "Only the review owner can change columns");
      if (!current.review.is_owner && input.shared_with !== undefined)
        return fail(403, "Only the review owner can change sharing");
      if (!current.review.is_owner && input.project_id !== undefined)
        return fail(403, "Only the review owner can move a review");
      return value(await store.update(scope, reviewId,
        input.expected_version ?? current.review.updated_at, {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.project_id !== undefined ? { projectId: input.project_id } : {}),
          ...(input.columns_config !== undefined ? { columns: input.columns_config } : {}),
          ...(input.document_ids !== undefined ? { documentIds: input.document_ids } : {}),
          ...(input.shared_with !== undefined ? { sharedWith: input.shared_with } : {}),
        }), "Review");
    },
    async remove(scope: TabularScope, reviewId: string) {
      const current = await store.detail(scope, reviewId);
      if (!current || !current.review.is_owner) return fail(404, "Review not found");
      value(await store.delete(scope, reviewId, current.review.updated_at), "Review");
    },
    async clear(scope: TabularScope, reviewId: string,
      input: z.infer<typeof tabularDtos.clear>) {
      const detail = await store.detail(scope, reviewId);
      if (!detail) return fail(404, "Review not found");
      const allowed = new Set(detail.review.document_ids);
      if (input.document_ids.some((documentId) => !allowed.has(documentId)))
        return fail(404, "Document not found");
      const selected = new Set(input.document_ids);
      for (const cell of detail.cells) if (selected.has(cell.document_id) &&
        (cell.status !== "pending" || cell.content !== null))
        await cellWrite(scope, cell, "pending", null);
    },
    async prompt(scope: TabularScope, input: z.infer<typeof tabularDtos.prompt>,
      signal?: AbortSignal) {
      const config = await settings(scope.userId);
      const descriptions: Record<string, string> = { text: "free-form text",
        bulleted_list: "a bulleted list", number: "a single number",
        percentage: "a percentage", monetary_amount: "a monetary amount",
        currency: "a currency code", yes_no: "Yes or No", date: "a date",
        tag: input.tags.length ? `one of: ${input.tags.join(", ")}` : "a tag" };
      const raw = await modelText({ model: config.title_model, apiKeys: config.api_keys,
        system: 'Write legal-review extraction prompts. Return only {"prompt":string}. Do not include response-format instructions.',
        user: `Column title: ${input.title}\nDocument: ${input.documentName || "unspecified"}\nExpected response: ${descriptions[input.format] ?? "free-form text"}`,
        signal });
      try {
        const prompt = String(json(raw).prompt ?? "").trim().slice(0, 20_000);
        if (prompt) return { prompt, source: "llm" as const };
      } catch {}
      return fail(502, "LLM returned an invalid prompt");
    },
    async regenerate(scope: TabularScope, reviewId: string,
      input: z.infer<typeof tabularDtos.regenerate>, signal?: AbortSignal) {
      const detail = await store.detail(scope, reviewId);
      if (!detail) return fail(404, "Review not found");
      const config = detail.review.columns_config.find(({ index }) => index === input.column_index);
      if (!config) return fail(400, "Column not found");
      if (!detail.review.document_ids.includes(input.document_id))
        return fail(404, "Document not found");
      const user = await settings(scope.userId), model = input.model ?? user.tabular_model;
      modelKey(model, user.api_keys);
      const current = detail.cells.find((cell) => cell.document_id === input.document_id &&
        cell.column_index === input.column_index);
      if (!current) return fail(404, "Cell not found");
      const item = await document(scope, input.document_id, signal);
      let active = await cellWrite(scope, current, "generating", null), result: TabularCellContent | null = null;
      let received: Set<number>;
      try {
        received = await extract({ model, apiKeys: user.api_keys,
          reasoningEffort: input.reasoning_effort, document: item, columns: [config], signal,
          accept: async (_index, content) => { result = content;
            active = await cellWrite(scope, active, "done", content); } });
      } catch (error) {
        if (active.status === "generating")
          await cellWrite(scope, active, "error", null).catch(() => undefined);
        throw error;
      }
      if (!received.size) { await cellWrite(scope, active, "error", null); return fail(500, "Generation failed"); }
      return result!;
    },
    async generate(scope: TabularScope, reviewId: string,
      input: z.infer<typeof tabularDtos.generate>, signal?: AbortSignal) {
      const detail = await store.detail(scope, reviewId);
      if (!detail) return fail(404, "Review not found");
      if (!detail.review.columns_config.length) return fail(400, "No columns configured");
      const user = await settings(scope.userId), model = input.model ?? user.tabular_model;
      modelKey(model, user.api_keys);
      return { run: async (emit: Emit) => {
        const cells = new Map(detail.cells.map((cell) =>
          [`${cell.document_id}:${cell.column_index}`, cell]));
        let failed = true;
        try {
          for (const documentId of detail.review.document_ids) {
            throwIfAborted(signal);
            await generateDocument(scope, await document(scope, documentId, signal),
              detail.review.columns_config, cells, model, user.api_keys,
              input.reasoning_effort, emit, signal);
          }
          failed = false;
        } finally {
          await store.recordGeneration(scope, { reviewId, title: detail.review.title,
            projectId: detail.review.project_id, model, failed }).catch(() => undefined);
        }
      } };
    },
  };
}

export type TabularApplication = ReturnType<typeof createTabularApplication>;

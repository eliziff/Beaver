import { Router, type Response } from "express";
import { requireAuth } from "../middleware/auth";
import { textParserFor } from "../lib/chat/tools/documentOps";
import {
    completeText,
    providerForModel,
    streamChatWithTools,
    type Provider,
    type UserApiKeys,
} from "../lib/llm";
import { getUserModelSettings } from "../lib/userSettings";
import { safeErrorLog, safeErrorMessage } from "../lib/safeError";
import {
    encodePageCursor,
    pageRequest,
    PageCursorError,
} from "../lib/pagination";
import type { DocumentStore } from "../lib/documentStore";
import {
    TabularStoreError,
    type TabularColumn,
    type TabularScope,
    type TabularStore,
} from "../lib/tabularStore";

function formatPromptSuffix(format?: string, tags?: string[]): string {
    switch (format) {
        case "bulleted_list":
            return ' The "summary" field in your JSON response must be a markdown bulleted list only — no prose. Format: each item on its own line, prefixed with "* " (asterisk + single space), e.g.\n* First item\n* Second item\n* Third item';
        case "number":
            return ' The "summary" field in your JSON response must be a single number only. No units or explanation.';
        case "percentage":
            return ' The "summary" field in your JSON response must be a single percentage value only (e.g. 42%). No explanation.';
        case "monetary_amount":
            return ' The "summary" field in your JSON response must be the monetary value only, including currency symbol (e.g. $1,234.56). No explanation.';
        case "currency":
            return ' The "summary" field in your JSON response must contain only the currency code(s). Wrap each code in double square brackets, e.g. [[USD]] or [[EUR]]. No other text.';
        case "yes_no":
            return ' The "summary" field in your JSON response must be [[Yes]] or [[No]] only. The "reasoning" field MUST include an inline citation [[page:N||quote:verbatim excerpt ≤25 words]] pointing to the exact language in the document that supports the Yes/No answer.';
        case "date":
            return ' The "summary" field in your JSON response must be the date only in DD Month YYYY format (e.g. 1 January 2024). If a range, give both dates separated by an em dash. The "reasoning" field MUST include an inline citation [[page:N||quote:verbatim excerpt ≤25 words]] pointing to the exact place in the document where the date is found.';
        case "tag":
            return tags?.length
                ? ` The \"summary\" field in your JSON response must contain exactly one tag wrapped in double square brackets. Available tags: ${tags.map((t) => `[[${t}]]`).join(", ")}. No other text. The \"reasoning\" field MUST include an inline citation [[page:N||quote:verbatim excerpt ≤25 words]] pointing to the exact language in the document that supports the chosen tag.`
                : "";
        default:
            return "";
    }
}

export function createTabularRouter(
    tabularData: TabularStore,
    documents: DocumentStore,
) {
const tabularRouter = Router();
tabularRouter.use(requireAuth);

const tabularScope = (res: Response): TabularScope => ({
    userId: res.locals.userId as string,
    userEmail: res.locals.userEmail as string | undefined,
});

const storeError = (res: Response, error: unknown) => {
    if (!(error instanceof TabularStoreError)) throw error;
    res.status(error.status).json({ detail: error.message });
};

function providerLabel(provider: Provider): string {
    if (provider === "claude") return "Anthropic";
    if (provider === "openai") return "OpenAI";
    if (provider === "deepseek") return "DeepSeek";
    if (provider === "openrouter") return "OpenRouter";
    if (provider === "meta") return "Meta";
    if (provider === "codex") return "Codex";
    return "Gemini";
}

function missingModelApiKey(model: string, apiKeys: UserApiKeys) {
    const provider = providerForModel(model);
    // Keyless transports: codex (CLI auth), claude-p (subscription CLI),
    // ollama (local server).
    if (provider === "codex" || provider === "claude-p" || provider === "ollama")
        return null;
    if (apiKeys[provider]?.trim()) return null;
    return {
        provider,
        model,
        detail: `${providerLabel(provider)} API key is required to use ${model}. Add an API key or select a different tabular review model.`,
    };
}

function tabularColumns(value: unknown): TabularColumn[] {
    return Array.isArray(value) ? (value as TabularColumn[]) : [];
}

async function documentMarkdown(content: Awaited<
    ReturnType<DocumentStore["read"]>
>
) {
    if (!content) return null;
    const { bytes } = content;
    const buffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    return {
        filename: content.filename,
        markdown: await extractDocumentMarkdown(buffer, content.fileType),
    };
}

tabularRouter.get("/", async (req, res) => {
  try {
    const q = typeof req.query.q === "string"
      ? req.query.q.trim().toLocaleLowerCase()
      : "";
    const projectId = typeof req.query.project_id === "string" && req.query.project_id
      ? req.query.project_id
      : null;
    const scope = req.query.scope === "in-project" || req.query.scope === "standalone"
      ? req.query.scope
      : "all";
    const filters = { q, project_id: projectId, scope };
    const { after, limit } = pageRequest<[string, string]>(
      req.query, "tabular-review", filters, ["string", "string"]);
    const page = await tabularData.page(tabularScope(res), {
        projectId, scope, q, limit, after,
    });
    res.json({
        items: page.items,
        next_cursor: page.nextAfter
            ? encodePageCursor("tabular-review", filters, page.nextAfter)
            : null,
    });
  } catch (error) {
    if (error instanceof PageCursorError)
        return void res.status(400).json({ detail: error.message });
    if (error instanceof TabularStoreError)
        return void res.status(error.status).json({ detail: error.message });
    throw error;
  }
});

tabularRouter.post("/", async (req, res) => {
    const { title, document_ids, columns_config, workflow_id, project_id } =
        req.body as {
            title?: string;
            document_ids: string[];
            columns_config: { index: number; name: string; prompt: string }[];
            workflow_id?: string;
            project_id?: string;
        };

    try {
        const review = await tabularData.create(tabularScope(res), {
            title,
            projectId: typeof project_id === "string" && project_id.trim()
                ? project_id.trim()
                : null,
            documentIds: Array.isArray(document_ids) ? document_ids : [],
            columns: tabularColumns(columns_config),
            workflowId: workflow_id,
        });
        res.status(201).json(review);
    } catch (error) {
        if (error instanceof TabularStoreError) return void storeError(res, error);
        res.status(400).json({
            detail: safeErrorMessage(error, "Invalid tabular review"),
        });
    }
});

// Register before /:reviewId routes.
tabularRouter.post("/prompt", async (req, res) => {
    const userId = res.locals.userId as string;
    const title =
        typeof req.body.title === "string" ? req.body.title.trim() : "";
    if (!title)
        return void res.status(400).json({ detail: "title is required" });

    const format: string =
        typeof req.body.format === "string" ? req.body.format : "text";
    const documentName: string =
        typeof req.body.documentName === "string"
            ? req.body.documentName.trim()
            : "";
    const tags: string[] = Array.isArray(req.body.tags)
        ? req.body.tags.filter((t: unknown) => typeof t === "string")
        : [];

    const formatDescriptions: Record<string, string> = {
        text: "free-form text",
        bulleted_list: "a bulleted list",
        number: "a single number",
        percentage: "a percentage value",
        monetary_amount: "a monetary amount",
        currency: "a currency code",
        yes_no: "Yes or No",
        date: "a date",
        tag: tags.length ? `one of these tags: ${tags.join(", ")}` : "a tag",
    };
    const formatHint = formatDescriptions[format] ?? "free-form text";
    const tagsNote =
        format === "tag" && tags.length
            ? `\nAvailable tags: ${tags.join(", ")}`
            : "";
    const docNote = documentName ? `\nDocument type/name: ${documentName}` : "";

    const userMessage =
        `Column title: ${title}` +
        docNote +
        `\nExpected response format: ${formatHint}` +
        tagsNote +
        `\n\nWrite the best extraction prompt for a legal tabular review column with this title. ` +
        `Do NOT include any instruction about the response format in the prompt — ` +
        `format handling is applied separately and must not be duplicated inside the prompt text.`;

    try {
        const { title_model, api_keys } = await getUserModelSettings(userId);
        const raw = await completeText({
            model: title_model,
            systemPrompt:
                'You write high-quality column prompts for legal tabular review workflows. Return only valid JSON with a single field: {"prompt": string}. The prompt you write must focus solely on what to extract — never on how to format the response.',
            user: userMessage,
            maxTokens: 512,
            apiKeys: api_keys,
        });
        const parsed = JSON.parse(
            raw
                .replace(/^```(?:json)?\n?/i, "")
                .replace(/\n?```$/, "")
                .trim(),
        ) as { prompt?: unknown };
        if (typeof parsed.prompt === "string" && parsed.prompt.trim()) {
            res.json({ prompt: parsed.prompt.trim(), source: "llm" });
        } else {
            res.status(502).json({ detail: "LLM returned an empty prompt" });
        }
    } catch {
        res.status(502).json({ detail: "Failed to generate prompt from LLM" });
    }
});

tabularRouter.get("/:reviewId", async (req, res) => {
    try {
        const detail = await tabularData.detail(
            tabularScope(res),
            req.params.reviewId,
        );
        if (!detail)
            return void res.status(404).json({ detail: "Review not found" });
        res.json(detail);
    } catch (error) {
        storeError(res, error);
    }
});

tabularRouter.get("/:reviewId/people", async (req, res) => {
    try {
        const people = await tabularData.people(
            tabularScope(res),
            req.params.reviewId,
        );
        if (!people)
            return void res.status(404).json({ detail: "Review not found" });
        res.json(people);
    } catch (error) {
        storeError(res, error);
    }
});

tabularRouter.patch("/:reviewId", async (req, res) => {
    const body = req.body ?? {};
    const userEmail = res.locals.userEmail as string | undefined;
    const titleUpdateProvided = Object.hasOwn(body, "title");
    const titleUpdate = body.title === null
        ? null
        : typeof body.title === "string"
          ? body.title
          : undefined;
    if (titleUpdateProvided && titleUpdate === undefined)
        return void res.status(400).json({
            detail: "title must be a string or null",
        });
    const projectIdUpdateProvided = Object.hasOwn(body, "project_id");
    const projectIdUpdate =
        body.project_id === null
            ? null
            : typeof body.project_id === "string" && body.project_id.trim()
              ? body.project_id.trim()
              : undefined;
    if (projectIdUpdateProvided && projectIdUpdate === undefined) {
        return void res.status(400).json({
            detail: "project_id must be a non-empty string or null",
        });
    }
    // shared_with edits are owner-only — gated below after we know who's
    // making the call. Normalize lowercase + dedupe + drop empties.
    let sharedWithUpdate: string[] | undefined;
    if (Array.isArray(body.shared_with)) {
        const normalizedUserEmail = userEmail?.trim().toLowerCase();
        const normalized = [...new Set<string>(body.shared_with.flatMap((raw: unknown) =>
            typeof raw === "string" && raw.trim()
                ? [raw.trim().toLowerCase()]
                : [],
        ))];
        if (
            normalizedUserEmail &&
            normalized.includes(normalizedUserEmail)
        ) {
            return void res.status(400).json({
                detail: "You cannot share a tabular review with yourself.",
            });
        }
        sharedWithUpdate = normalized;
    }

    try {
        const updated = await tabularData.update(
            tabularScope(res),
            req.params.reviewId,
            {
                ...(titleUpdateProvided ? { title: titleUpdate } : {}),
                ...(projectIdUpdateProvided
                    ? { projectId: projectIdUpdate }
                    : {}),
                ...(Array.isArray(body.columns_config)
                    ? { columns: tabularColumns(body.columns_config) }
                    : {}),
                ...(Array.isArray(body.document_ids)
                    ? {
                          documentIds: body.document_ids.filter(
                              (value: unknown): value is string =>
                                  typeof value === "string",
                          ),
                      }
                    : {}),
                ...(sharedWithUpdate !== undefined
                    ? { sharedWith: sharedWithUpdate }
                    : {}),
            },
        );
        if (!updated)
            return void res.status(404).json({ detail: "Review not found" });
        res.json(updated);
    } catch (error) {
        storeError(res, error);
    }
});

tabularRouter.delete("/:reviewId", async (req, res) => {
    try {
        if (!await tabularData.delete(tabularScope(res), req.params.reviewId))
            return void res.status(404).json({ detail: "Review not found" });
        res.status(204).send();
    } catch (error) {
        storeError(res, error);
    }
});

// Reset rows in place so their identity and relationships survive.
tabularRouter.post("/:reviewId/clear-cells", async (req, res) => {
    const { document_ids } = req.body as { document_ids?: string[] };

    if (!Array.isArray(document_ids) || document_ids.length === 0)
        return void res
            .status(400)
            .json({ detail: "document_ids is required" });

    try {
        if (!await tabularData.clearCells(
            tabularScope(res),
            req.params.reviewId,
            document_ids,
        ))
            return void res.status(404).json({ detail: "Review not found" });
        res.status(204).send();
    } catch (error) {
        storeError(res, error);
    }
});

tabularRouter.post(
    "/:reviewId/regenerate-cell",
    async (req, res) => {
        const userId = res.locals.userId as string;
        const { reviewId } = req.params;
        const { document_id, column_index } = req.body as {
            document_id: string;
            column_index: number;
            model?: string;
            reasoning_effort?: string;
        };

        if (!document_id || column_index == null)
            return void res
                .status(400)
                .json({ detail: "document_id and column_index are required" });
        try {
            const scope = tabularScope(res);
            const detail = await tabularData.detail(scope, reviewId);
            if (!detail)
                return void res.status(404).json({ detail: "Review not found" });
            const column = detail.review.columns_config.find(
                ({ index }) => index === column_index,
            );
            if (!column)
                return void res.status(400).json({ detail: "Column not found" });
            if (!detail.review.document_ids.includes(document_id))
                return void res.status(404).json({ detail: "Document not found" });
            const { tabular_model, api_keys } = await getUserModelSettings(userId);
            const selectedModel =
                typeof req.body.model === "string" && req.body.model.trim()
                    ? req.body.model.trim()
                    : tabular_model;
            const missingKey = missingModelApiKey(selectedModel, api_keys);
            if (missingKey)
                return void res.status(422).json({
                    code: "missing_api_key",
                    ...missingKey,
                });
            const document = await documentMarkdown(
                await documents.read(scope, document_id, null, false),
            );
            if (!document)
                return void res.status(404).json({ detail: "Document not found" });
            await tabularData.setCell(scope, {
                reviewId,
                documentId: document_id,
                columnIndex: column_index,
                content: null,
                status: "generating",
            });
            const result = await queryTabularCell(
                selectedModel,
                document.filename,
                document.markdown,
                column.prompt,
                column.format,
                column.tags,
                api_keys,
            );
            await tabularData.setCell(scope, {
                reviewId,
                documentId: document_id,
                columnIndex: column_index,
                content: result,
                status: result ? "done" : "error",
            });
            if (!result)
                return void res.status(500).json({ detail: "Generation failed" });
            res.json(result);
        } catch (error) {
            storeError(res, error);
        }
    },
);

tabularRouter.post("/:reviewId/generate", async (req, res) => {
    const userId = res.locals.userId as string;
    const { reviewId } = req.params;
    const scope = tabularScope(res);
    const detail = await tabularData.detail(scope, reviewId);
    if (!detail)
        return void res.status(404).json({ detail: "Review not found" });
    const columns = detail.review.columns_config;
    if (!columns.length)
        return void res.status(400).json({ detail: "No columns configured" });
    const { tabular_model, api_keys } = await getUserModelSettings(userId);
    const selectedModel =
        typeof req.body?.model === "string" && req.body.model.trim()
            ? req.body.model.trim()
            : tabular_model;
    const reasoningEffort =
        typeof req.body?.reasoning_effort === "string"
            ? req.body.reasoning_effort.trim().slice(0, 32) || undefined
            : undefined;
    const missingKey = missingModelApiKey(selectedModel, api_keys);
    if (missingKey)
        return void res.status(422).json({
            code: "missing_api_key",
            ...missingKey,
        });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    const write = (value: unknown) =>
        res.write(`data: ${JSON.stringify(value)}\n\n`);
    const writeCell = async (
        documentId: string,
        columnIndex: number,
        content: CellResult | null,
        status: "generating" | "done" | "error",
    ) => {
        await tabularData.setCell(scope, {
            reviewId,
            documentId,
            columnIndex,
            content,
            status,
        });
        write({
            type: "cell_update",
            document_id: documentId,
            column_index: columnIndex,
            content,
            status,
        });
    };
    const cells = new Map(detail.cells.map((cell) => [
        `${cell.document_id}:${cell.column_index}`,
        cell,
    ]));
    let failed = false;
    try {
        await Promise.all(detail.review.document_ids.map(async (documentId) => {
            const document = await documentMarkdown(
                await documents.read(scope, documentId, null, false),
            );
            if (document)
                await generateTabularDocument(
                    { id: documentId, ...document },
                    columns,
                    cells,
                    selectedModel,
                    api_keys,
                    reasoningEffort,
                    writeCell,
                );
        }));
        res.write("data: [DONE]\n\n");
    } catch (error) {
        failed = true;
        console.error("[tabular/generate]", safeErrorLog(error));
        write({ type: "error", message: safeErrorMessage(error, "Stream error") });
        res.write("data: [DONE]\n\n");
    } finally {
        void tabularData.recordGeneration(scope, {
            reviewId,
            title: detail.review.title,
            projectId: detail.review.project_id,
            model: selectedModel,
            failed,
        });
        res.end();
    }
    return;
});

async function queryTabularCell(
    model: string,
    filename: string,
    documentText: string,
    columnPrompt: string,
    format?: string,
    tags?: string[],
    apiKeys?: import("../lib/llm").UserApiKeys,
) {
    const suffix = formatPromptSuffix(format as never, tags);
    const fullPrompt = `${columnPrompt}${suffix} If not found, state "Not Found". Leave all reasoning and explanation in the "reasoning" field only.`;

    const EXTRACTION_SYSTEM = `You are a legal document analyst. Return ONLY valid JSON:
{"summary": string, "flag": "green"|"grey"|"yellow"|"red", "reasoning": string}

The "summary" and "reasoning" field values may use markdown formatting (bullets, bold, italics, etc.) — the values are still plain JSON strings (escape newlines as \\n), but the text inside will be rendered as markdown in the UI.

The "summary" field must contain only the extracted value with inline citations — no explanation or reasoning. Every factual claim in "summary" must be followed immediately by a citation in the format [[page:N||quote:exact quoted text]], where N is the page number and the quote is a short verbatim excerpt (≤ 25 words). The quote must be narrowly scoped to the specific claim it supports — extract only the exact words that support that statement, not the surrounding sentence or paragraph. Do not have multiple claims share the same long quote; if two different statements need different evidence, give each its own short, narrowly-scoped quote. All reasoning and explanation belongs in "reasoning" only, which may also contain citations.`;

    let raw: string;
    try {
        raw = await completeText({
            model,
            systemPrompt: EXTRACTION_SYSTEM,
            user: `Document: ${filename}\n\n${documentText.slice(0, 120_000)}\n\n---\nInstruction: ${fullPrompt}`,
            maxTokens: 2048,
            apiKeys,
        });
    } catch (err) {
        console.error("[queryTabularCell] completion failed", safeErrorLog(err));
        return null;
    }
    try {
        const parsed = JSON.parse(
            raw
                .replace(/^```(?:json)?\n?/i, "")
                .replace(/\n?```$/, "")
                .trim(),
        ) as {
            summary?: unknown;
            value?: unknown;
            flag?: unknown;
            reasoning?: unknown;
        };
        return {
            summary:
                String(parsed.summary ?? parsed.value ?? "").trim() ||
                "Not addressed",
            flag: (["green", "grey", "yellow", "red"] as const).includes(
                parsed.flag as "green",
            )
                ? (parsed.flag as "green")
                : "grey",
            reasoning: String(parsed.reasoning ?? ""),
        };
    } catch {
        return raw.trim()
            ? {
                  summary: raw.trim().slice(0, 500),
                  flag: "grey" as const,
                  reasoning: "",
              }
            : null;
    }
}

type CellResult = {
    summary: string;
    flag: "green" | "grey" | "yellow" | "red";
    reasoning: string;
};
type Column = {
    index: number;
    name: string;
    prompt: string;
    format?: string;
    tags?: string[];
};

async function generateTabularDocument(
    document: { id: string; filename: string; markdown: string },
    columns: Column[],
    existingCells: Map<string, { status?: unknown; content?: unknown }>,
    model: string,
    apiKeys: UserApiKeys,
    reasoningEffort: string | undefined,
    writeCell: (
        documentId: string,
        columnIndex: number,
        content: CellResult | null,
        status: "generating" | "done" | "error",
    ) => Promise<void> | void,
    onQueryError?: (error: unknown, documentId: string) => void,
) {
    const pendingColumns = columns.filter((column) => {
        const cell = existingCells.get(`${document.id}:${column.index}`);
        return cell?.status !== "done" || !cell.content;
    });
    if (pendingColumns.length === 0) return;

    for (const column of pendingColumns) {
        await writeCell(document.id, column.index, null, "generating");
    }

    const received = new Set<number>();
    try {
        await queryTabularAllColumns(
            model,
            document.filename,
            document.markdown,
            pendingColumns,
            async (columnIndex, result) => {
                received.add(columnIndex);
                await writeCell(document.id, columnIndex, result, "done");
            },
            apiKeys,
            reasoningEffort,
        );
    } catch (error) {
        if (onQueryError) onQueryError(error, document.id);
        else throw error;
    }

    for (const column of pendingColumns) {
        if (received.has(column.index)) continue;
        await writeCell(document.id, column.index, null, "error");
    }
}

async function queryTabularAllColumns(
    model: string,
    filename: string,
    documentText: string,
    columns: Column[],
    onResult: (columnIndex: number, result: CellResult) => Promise<void>,
    apiKeys?: import("../lib/llm").UserApiKeys,
    reasoningEffort?: string,
): Promise<void> {
    const columnsDesc = columns
        .map((col) => {
            const suffix = formatPromptSuffix(col.format as never, col.tags);
            const fullPrompt = `${col.prompt}${suffix} If not found, state "Not Found".`;
            return `Column ${col.index} — "${col.name}": ${fullPrompt}`;
        })
        .join("\n");

    const SYSTEM = `You are a legal document analyst. Extract information for each column listed below.

For each column, output exactly one minified JSON object on its own line (no line breaks inside the JSON), then a newline. Process columns in order and output each result as soon as you finish it.

Line format:
{"column_index": <N>, "summary": <string>, "flag": <"green"|"grey"|"yellow"|"red">, "reasoning": <string>}

Rules:
- "summary": the extracted value with inline citations [[page:N||quote:verbatim excerpt ≤25 words]] after every factual claim. No explanation or reasoning here. Quotes must be narrowly scoped to the specific claim — extract only the exact supporting words, not the full surrounding sentence. Do not reuse one long quote across multiple statements; give each claim its own short, precise quote.
- "flag": green = standard/favorable, yellow = needs attention, red = problematic/unfavorable, grey = neutral/not found
- "reasoning": brief explanation of the extraction
- The "summary" and "reasoning" string VALUES may use markdown (bullets, bold, italics, etc.) — escape newlines as \\n inside the JSON string. This markdown is rendered in the UI.
- Output ONLY the JSON lines themselves. Do NOT wrap the response in markdown code fences (e.g. \`\`\`json), and do not add any preamble or summary.`;

    const USER = `Document: ${filename}\n\n${documentText.slice(0, 120_000)}\n\n---\nColumns to extract:\n${columnsDesc}`;

    let contentBuffer = "";
    const pending: Promise<unknown>[] = [];

    const processLine = async (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
            const parsed = JSON.parse(trimmed) as {
                column_index?: unknown;
                summary?: unknown;
                flag?: unknown;
                reasoning?: unknown;
            };
            if (typeof parsed.column_index !== "number") return;
            const col = columns.find((c) => c.index === parsed.column_index);
            if (!col) return;
            await onResult(parsed.column_index, {
                summary: String(parsed.summary ?? "").trim() || "Not addressed",
                flag: (["green", "grey", "yellow", "red"] as const).includes(
                    parsed.flag as "green",
                )
                    ? (parsed.flag as CellResult["flag"])
                    : "grey",
                reasoning: String(parsed.reasoning ?? ""),
            });
        } catch {
        }
    };

    try {
        await streamChatWithTools({
            model,
            systemPrompt: SYSTEM,
            messages: [{ role: "user", content: USER }],
            tools: [],
            apiKeys,
            enableThinking: Boolean(reasoningEffort),
            reasoningEffort,
            callbacks: {
                onContentDelta: (delta) => {
                    contentBuffer += delta;
                    let newlineIdx: number;
                    while ((newlineIdx = contentBuffer.indexOf("\n")) !== -1) {
                        const completedLine = contentBuffer.slice(
                            0,
                            newlineIdx,
                        );
                        contentBuffer = contentBuffer.slice(newlineIdx + 1);
                        pending.push(processLine(completedLine));
                    }
                },
            },
        });
    } catch (err) {
        console.error("[queryTabularAllColumns] stream failed", safeErrorLog(err));
    }

    if (contentBuffer.trim()) pending.push(processLine(contentBuffer));
    await Promise.all(pending);
}

async function extractDocumentMarkdown(
    buf: ArrayBuffer,
    fileType: string | null | undefined,
): Promise<string> {
    try {
        const parser =
            textParserFor((fileType ?? "").toLowerCase()) ??
            textParserFor("docx");
        return parser ? await parser.run(Buffer.from(buf)) : "";
    } catch {
        return "";
    }
}

return tabularRouter;
}

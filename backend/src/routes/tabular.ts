import { Router, type Response } from "express";
import { readFile } from "node:fs/promises";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { downloadFile } from "../lib/storage";
import {
    attachActiveVersionPaths,
    loadActiveVersion,
} from "../lib/documentVersions";
import { docxToPdf, normalizeDocxZipPaths } from "../lib/convert";
import {
    isPresentationDocumentType,
    isSpreadsheetDocumentType,
    isWordDocumentType,
} from "../lib/documentTypes";
import { extractPresentationText } from "../lib/officeText";
import { spreadsheetToLLMText } from "../lib/spreadsheet";
import {
    type ChatMessage,
    type TabularCellStore,
} from "../lib/chat/types";
import { readTabularCells } from "../lib/chat/tools/toolDispatcher";
import { TABULAR_TOOLS } from "../lib/chat/tools/toolSchemas";
import { isAbortError } from "../lib/llm/abort";
import {
    completeText,
    providerForModel,
    streamChatWithTools,
    type OpenAIToolSchema,
    type Provider,
    type UserApiKeys,
} from "../lib/llm";
import { getUserModelSettings } from "../lib/userSettings";
import {
    checkProjectAccess,
    ensureReviewAccess,
    filterAccessibleDocumentIds,
} from "../lib/access";
import { safeErrorLog, safeErrorMessage } from "../lib/safeError";
import { isAnonymousLocalMode } from "../lib/localMode";
import {
    getLocalVersionFiles,
    listLocalDocumentsById,
} from "../lib/localDocumentStore";
import { legalKnowledgeGraphStore } from "../lib/legalKnowledgeGraphStore";
import { appUrl } from "../lib/appRoutes";
import {
    localTabularStore,
    type LocalTabularColumn,
} from "../lib/localTabularStore";

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

export const tabularRouter = Router();

function providerLabel(provider: Provider): string {
    if (provider === "claude") return "Anthropic";
    if (provider === "openai") return "OpenAI";
    if (provider === "deepseek") return "DeepSeek";
    if (provider === "openrouter") return "OpenRouter";
    if (provider === "codex") return "Codex";
    return "Gemini";
}

function missingModelApiKey(model: string, apiKeys: UserApiKeys) {
    const provider = providerForModel(model);
    if (provider === "codex") return null;
    if (apiKeys[provider]?.trim()) return null;
    return {
        provider,
        model,
        detail: `${providerLabel(provider)} API key is required to use ${model}. Add an API key or select a different tabular review model.`,
    };
}

function localColumns(value: unknown): LocalTabularColumn[] {
    return Array.isArray(value) ? (value as LocalTabularColumn[]) : [];
}

async function accessibleLocalDocumentIds(
    userId: string,
    requested: unknown,
    projectId: string | null,
) {
    const ids = Array.isArray(requested)
        ? requested.filter((id): id is string => typeof id === "string")
        : [];
    const owned = new Set(
        (await listLocalDocumentsById(userId, ids)).map(
            (document) => document.id as string,
        ),
    );
    if (!projectId) return ids.filter((id) => owned.has(id));
    const matterDocuments =
        legalKnowledgeGraphStore().listMatterDocumentIds(userId, projectId);
    if (!matterDocuments) return null;
    const attached = new Set(matterDocuments);
    return ids.filter((id) => owned.has(id) && attached.has(id));
}

async function localDocumentMarkdown(userId: string, documentId: string) {
    const files = await getLocalVersionFiles(userId, [documentId]);
    const file = files.get(documentId);
    if (!file) return null;
    const bytes = await readFile(file.path);
    const buffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    let markdown = "";
    try {
        markdown = await extractDocumentMarkdown(buffer, file.fileType);
    } catch (error) {
        console.error(
            `[tabular/local] extraction error doc=${documentId}`,
            safeErrorLog(error),
        );
    }
    return { filename: file.filename, markdown };
}

tabularRouter.get("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    if (isAnonymousLocalMode()) {
        const projectId =
            typeof req.query.project_id === "string" && req.query.project_id
                ? req.query.project_id
                : undefined;
        res.json(localTabularStore().list(userId, projectId));
        return;
    }
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();

    const projectIdFilter =
        typeof req.query.project_id === "string" && req.query.project_id
            ? (req.query.project_id as string)
            : null;

    const { data, error } = await db.rpc("get_tabular_reviews_overview", {
        p_user_id: userId,
        p_user_email: userEmail ?? null,
        p_project_id: projectIdFilter,
    });
    if (error) return void res.status(500).json({ detail: error.message });

    res.json(data ?? []);
});

tabularRouter.post("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { title, document_ids, columns_config, workflow_id, project_id } =
        req.body as {
            title?: string;
            document_ids: string[];
            columns_config: { index: number; name: string; prompt: string }[];
            workflow_id?: string;
            project_id?: string;
        };

    if (isAnonymousLocalMode()) {
        const projectId =
            typeof project_id === "string" && project_id.trim()
                ? project_id.trim()
                : null;
        const allowedDocumentIds = await accessibleLocalDocumentIds(
            userId,
            document_ids,
            projectId,
        );
        if (!allowedDocumentIds) {
            return void res.status(404).json({ detail: "Project not found" });
        }
        try {
            const review = localTabularStore().create({
                userId,
                title,
                projectId,
                columns: localColumns(columns_config),
                documentIds: allowedDocumentIds,
                workflowId: workflow_id,
            });
            res.status(201).json(review);
        } catch (error) {
            res.status(400).json({
                detail: safeErrorMessage(error, "Invalid tabular review"),
            });
        }
        return;
    }

    const db = createServerSupabase();
    if (project_id) {
        const access = await checkProjectAccess(
            project_id,
            userId,
            userEmail,
            db,
        );
        if (!access.ok)
            return void res.status(404).json({ detail: "Project not found" });
    }
    const allowedDocumentIds = Array.isArray(document_ids)
        ? await filterAccessibleDocumentIds(
              document_ids,
              userId,
              userEmail,
              db,
          )
        : [];
    const { data: review, error } = await db
        .from("tabular_reviews")
        .insert({
            user_id: userId,
            title: title ?? null,
            columns_config,
            document_ids: allowedDocumentIds,
            project_id: project_id ?? null,
            workflow_id: workflow_id ?? null,
        })
        .select("*")
        .single();
    if (error || !review)
        return void res
            .status(500)
            .json({ detail: error?.message ?? "Failed to create review" });

    const cells = allowedDocumentIds.flatMap((docId) =>
        columns_config.map((col) => ({
            review_id: review.id,
            document_id: docId,
            column_index: col.index,
            status: "pending",
        })),
    );
    if (cells.length) await db.from("tabular_cells").insert(cells);

    res.status(201).json(review);
});

// Register before /:reviewId routes.
tabularRouter.post("/prompt", requireAuth, async (req, res) => {
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

tabularRouter.get("/:reviewId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    if (isAnonymousLocalMode()) {
        const store = localTabularStore();
        const detail = store.detail(userId, reviewId);
        if (!detail)
            return void res
                .status(404)
                .json({ detail: "Review not found" });
        const documents = await listLocalDocumentsById(
            userId,
            detail.review.document_ids,
        );
        res.json({
            ...detail,
            documents: documents.map((document) => ({
                ...document,
                project_id: detail.review.project_id,
                folder_id: null,
            })),
        });
        return;
    }
    const db = createServerSupabase();

    const { data: review, error } = await db
        .from("tabular_reviews")
        .select("*")
        .eq("id", reviewId)
        .single();
    if (error || !review)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });

    const { data: cells } = await db
        .from("tabular_cells")
        .select("*")
        .eq("review_id", reviewId);
    const cellDocIds = [...new Set((cells ?? []).map((c) => c.document_id))];
    const hasExplicitDocIds = Array.isArray(review.document_ids);
    const explicitDocIds = hasExplicitDocIds
        ? (review.document_ids as string[])
        : [];
    const docIds =
        hasExplicitDocIds
            ? explicitDocIds
            : cellDocIds;
    const docsResult =
        docIds.length > 0
            ? await db.from("documents").select("*").in("id", docIds)
            : { data: [] as Record<string, unknown>[] };
    const docs = (docsResult.data ?? []) as unknown as {
        id: string;
        current_version_id?: string | null;
    }[];
    await attachActiveVersionPaths(db, docs);

    res.json({
        review: { ...review, is_owner: access.isOwner },
        cells: (cells ?? []).map((cell) => ({
            ...cell,
            content: parseCellContent(cell.content),
        })),
        documents: docs,
    });
});

tabularRouter.get("/:reviewId/people", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    if (isAnonymousLocalMode()) {
        if (!localTabularStore().get(userId, reviewId)) {
            return void res
                .status(404)
                .json({ detail: "Review not found" });
        }
        res.json({
            owner: {
                user_id: userId,
                email: null,
                display_name: null,
            },
            members: [],
        });
        return;
    }
    const db = createServerSupabase();

    const { data: review } = await db
        .from("tabular_reviews")
        .select("id, user_id, project_id, shared_with")
        .eq("id", reviewId)
        .single();
    if (!review)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });

    const sharedWith: string[] = (
        Array.isArray(review.shared_with)
            ? (review.shared_with as string[])
            : []
    ).map((e) => (e ?? "").toLowerCase());

    // Use the mirrored profile email so sharing checks do not scan auth.users.
    const { loadProfileUsersByEmail } = await import("../lib/userLookup");
    const { userByEmail, userById } = await loadProfileUsersByEmail(db);

    const ownerInfo = userById.get(review.user_id as string);
    res.json({
        owner: {
            user_id: review.user_id,
            email: ownerInfo?.email ?? null,
            display_name: ownerInfo?.display_name ?? null,
        },
        members: sharedWith.map((email) => {
            const u = userByEmail.get(email);
            const display_name = u?.display_name ?? null;
            return { email, display_name };
        }),
    });
});

tabularRouter.patch("/:reviewId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    if (isAnonymousLocalMode()) {
        const body = req.body ?? {};
        const projectChanged = Object.hasOwn(body, "project_id");
        const current = localTabularStore().get(userId, reviewId);
        if (!current)
            return void res
                .status(404)
                .json({ detail: "Review not found" });
        const targetProjectId = projectChanged
            ? typeof body.project_id === "string" && body.project_id.trim()
                ? body.project_id.trim()
                : null
            : current.project_id;
        if (
            targetProjectId &&
            !legalKnowledgeGraphStore().getMatter(userId, targetProjectId)
        ) {
            return void res
                .status(404)
                .json({ detail: "Target project not found" });
        }
        const nextDocumentIds = Object.hasOwn(body, "document_ids")
            ? await accessibleLocalDocumentIds(
                  userId,
                  body.document_ids,
                  targetProjectId,
              )
            : undefined;
        if (nextDocumentIds === null) {
            return void res
                .status(404)
                .json({ detail: "Target project not found" });
        }
        try {
            const updated = localTabularStore().update(userId, reviewId, {
                ...(Object.hasOwn(body, "title")
                    ? { title: body.title }
                    : {}),
                ...(projectChanged
                    ? { projectId: targetProjectId }
                    : {}),
                ...(Object.hasOwn(body, "columns_config")
                    ? { columns: localColumns(body.columns_config) }
                    : {}),
                ...(nextDocumentIds !== undefined
                    ? { documentIds: nextDocumentIds }
                    : {}),
            });
            res.json(updated);
        } catch (error) {
            res.status(400).json({
                detail: safeErrorMessage(error, "Invalid tabular review"),
            });
        }
        return;
    }
    const updates: Record<string, unknown> = {};
    if (req.body.title != null) updates.title = req.body.title;
    const projectIdUpdateProvided = req.body.project_id !== undefined;
    const projectIdUpdate =
        req.body.project_id === null
            ? null
            : typeof req.body.project_id === "string" &&
                req.body.project_id.trim()
              ? req.body.project_id.trim()
              : undefined;
    if (projectIdUpdateProvided && projectIdUpdate === undefined) {
        return void res.status(400).json({
            detail: "project_id must be a non-empty string or null",
        });
    }
    // shared_with edits are owner-only — gated below after we know who's
    // making the call. Normalize lowercase + dedupe + drop empties.
    let sharedWithUpdate: string[] | undefined;
    if (Array.isArray(req.body.shared_with)) {
        const normalizedUserEmail = userEmail?.trim().toLowerCase();
        const seen = new Set<string>();
        const cleaned: string[] = [];
        for (const raw of req.body.shared_with) {
            if (typeof raw !== "string") continue;
            const e = raw.trim().toLowerCase();
            if (!e || seen.has(e)) continue;
            if (normalizedUserEmail && e === normalizedUserEmail) {
                return void res.status(400).json({
                    detail: "You cannot share a tabular review with yourself.",
                });
            }
            seen.add(e);
            cleaned.push(e);
        }
        sharedWithUpdate = cleaned;
    }
    updates.updated_at = new Date().toISOString();

    const db = createServerSupabase();
    const { data: existingReview, error: reviewError } = await db
        .from("tabular_reviews")
        .select("*")
        .eq("id", reviewId)
        .single();
    if (reviewError || !existingReview)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(
        existingReview,
        userId,
        userEmail,
        db,
    );
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });
    if (req.body.columns_config != null) {
        if (!access.isOwner) {
            return void res.status(403).json({
                detail: "Only the review owner can change columns",
            });
        }
        updates.columns_config = req.body.columns_config;
    }
    if (sharedWithUpdate !== undefined) {
        if (!access.isOwner)
            return void res
                .status(403)
                .json({ detail: "Only the review owner can change sharing" });
        const { findMissingUserEmails } = await import("../lib/userLookup");
        const missingSharedUsers = await findMissingUserEmails(
            db,
            sharedWithUpdate,
        );
        if (missingSharedUsers.length > 0) {
            return void res.status(400).json({
                detail: `${missingSharedUsers[0]} does not belong to a Beaver user.`,
            });
        }
        updates.shared_with = sharedWithUpdate;
    }
    if (projectIdUpdateProvided) {
        if (!access.isOwner) {
            return void res.status(403).json({
                detail: "Only the review owner can move a review",
            });
        }
        if (projectIdUpdate) {
            const projectAccess = await checkProjectAccess(
                projectIdUpdate,
                userId,
                userEmail,
                db,
            );
            if (!projectAccess.ok) {
                return void res
                    .status(404)
                    .json({ detail: "Target project not found" });
            }
        }
        updates.project_id = projectIdUpdate;
    }

    const { data: updatedReview, error: updateError } = await db
        .from("tabular_reviews")
        .update(updates)
        .eq("id", reviewId)
        .select("*")
        .single();
    if (updateError || !updatedReview)
        return void res.status(500).json({
            detail: updateError?.message ?? "Failed to update review",
        });

    let persistedDocumentIds: string[] | undefined;
    if (
        Array.isArray(req.body.columns_config) ||
        Array.isArray(req.body.document_ids)
    ) {
        const { data: existingCells } = await db
            .from("tabular_cells")
            .select("document_id,column_index")
            .eq("review_id", reviewId);
        const existingKeys = new Set(
            (existingCells ?? []).map(
                (cell) => `${cell.document_id}:${cell.column_index}`,
            ),
        );

        let documentIds: string[];

        if (Array.isArray(req.body.document_ids)) {
            // document_ids is the new source of truth — delete removed docs' cells
            const requestedDocIds = req.body.document_ids as string[];
            const existingDocIds = (existingCells ?? []).map(
                (cell) => cell.document_id,
            );
            const existingDocIdSet = new Set(existingDocIds);
            const newDocCandidates = requestedDocIds.filter(
                (id) => !existingDocIdSet.has(id),
            );
            const newDocAllowed = await filterAccessibleDocumentIds(
                newDocCandidates,
                userId,
                userEmail,
                db,
            );
            const newDocAllowedSet = new Set(newDocAllowed);
            const newDocIds = requestedDocIds.filter(
                (id) => existingDocIdSet.has(id) || newDocAllowedSet.has(id),
            );
            const removedDocIds = existingDocIds.filter(
                (id) => !newDocIds.includes(id),
            );

            if (removedDocIds.length > 0) {
                const { error: deleteError } = await db
                    .from("tabular_cells")
                    .delete()
                    .eq("review_id", reviewId)
                    .in("document_id", removedDocIds);
                if (deleteError)
                    return void res
                        .status(500)
                        .json({ detail: deleteError.message });
            }

            documentIds = newDocIds;
        } else {
            documentIds = [
                ...new Set(
                    (existingCells ?? []).map((cell) => cell.document_id),
                ),
            ];
        }

        if (Array.isArray(req.body.document_ids)) {
            persistedDocumentIds = documentIds;
            const { error: documentIdsError } = await db
                .from("tabular_reviews")
                .update({
                    document_ids: documentIds,
                    updated_at: new Date().toISOString(),
                })
                .eq("id", reviewId);
            if (documentIdsError)
                return void res.status(500).json({
                    detail: documentIdsError.message,
                });
        }

        const activeColumns = Array.isArray(req.body.columns_config)
            ? req.body.columns_config
            : (updatedReview.columns_config ?? []);
        const newCells = documentIds.flatMap((documentId) =>
            activeColumns
                .filter(
                    (column: { index: number }) =>
                        !existingKeys.has(`${documentId}:${column.index}`),
                )
                .map((column: { index: number }) => ({
                    review_id: reviewId,
                    document_id: documentId,
                    column_index: column.index,
                    status: "pending",
                })),
        );

        if (newCells.length > 0) {
            const { error: insertError } = await db
                .from("tabular_cells")
                .insert(newCells);
            if (insertError)
                return void res
                    .status(500)
                    .json({ detail: insertError.message });
        }
    }

    res.json({
        ...updatedReview,
        ...(persistedDocumentIds ? { document_ids: persistedDocumentIds } : {}),
    });
});

tabularRouter.delete("/:reviewId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { reviewId } = req.params;
    if (isAnonymousLocalMode()) {
        if (!localTabularStore().delete(userId, reviewId)) {
            return void res
                .status(404)
                .json({ detail: "Review not found" });
        }
        res.status(204).send();
        return;
    }
    const db = createServerSupabase();
    const { error } = await db
        .from("tabular_reviews")
        .delete()
        .eq("id", reviewId)
        .eq("user_id", userId);
    if (error) return void res.status(500).json({ detail: error.message });
    res.status(204).send();
});

// Reset rows in place so their identity and relationships survive.
tabularRouter.post("/:reviewId/clear-cells", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const { document_ids } = req.body as { document_ids?: string[] };

    if (!Array.isArray(document_ids) || document_ids.length === 0)
        return void res
            .status(400)
            .json({ detail: "document_ids is required" });

    if (isAnonymousLocalMode()) {
        if (
            !localTabularStore().clearCells(
                userId,
                reviewId,
                document_ids,
            )
        ) {
            return void res
                .status(404)
                .json({ detail: "Review not found" });
        }
        res.status(204).send();
        return;
    }

    const db = createServerSupabase();
    const { data: review, error: reviewError } = await db
        .from("tabular_reviews")
        .select("id, user_id, project_id")
        .eq("id", reviewId)
        .single();
    if (reviewError || !review)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });

    const { error } = await db
        .from("tabular_cells")
        .update({ content: null, status: "pending" })
        .eq("review_id", reviewId)
        .in("document_id", document_ids);
    if (error) return void res.status(500).json({ detail: error.message });
    res.status(204).send();
});

tabularRouter.post(
    "/:reviewId/regenerate-cell",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
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

        if (isAnonymousLocalMode()) {
            const review = localTabularStore().get(userId, reviewId);
            if (!review)
                return void res
                    .status(404)
                    .json({ detail: "Review not found" });
            const column = review.columns_config.find(
                (candidate) => candidate.index === column_index,
            );
            if (!column)
                return void res
                    .status(400)
                    .json({ detail: "Column not found" });
            if (!review.document_ids.includes(document_id)) {
                return void res
                    .status(404)
                    .json({ detail: "Document not found" });
            }
            const document = await localDocumentMarkdown(
                userId,
                document_id,
            );
            if (!document)
                return void res
                    .status(404)
                    .json({ detail: "Document not found" });
            const { tabular_model, api_keys } =
                await getUserModelSettings(userId);
            const selectedModel =
                typeof req.body.model === "string" && req.body.model.trim()
                    ? req.body.model.trim()
                    : tabular_model;
            const missingKey = missingModelApiKey(
                selectedModel,
                api_keys,
            );
            if (missingKey) {
                return void res.status(422).json({
                    code: "missing_api_key",
                    ...missingKey,
                });
            }
            localTabularStore().setCell({
                userId,
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
            localTabularStore().setCell({
                userId,
                reviewId,
                documentId: document_id,
                columnIndex: column_index,
                content: result,
                status: result ? "done" : "error",
            });
            if (!result) {
                return void res
                    .status(500)
                    .json({ detail: "Generation failed" });
            }
            res.json(result);
            return;
        }

        const db = createServerSupabase();
        const { data: review, error: reviewError } = await db
            .from("tabular_reviews")
            .select("*")
            .eq("id", reviewId)
            .single();
        if (reviewError || !review)
            return void res.status(404).json({ detail: "Review not found" });
        const access = await ensureReviewAccess(review, userId, userEmail, db);
        if (!access.ok)
            return void res.status(404).json({ detail: "Review not found" });

        const column = (
            review.columns_config as {
                index: number;
                name: string;
                prompt: string;
                format?: string;
                tags?: string[];
            }[]
        ).find((c) => c.index === column_index);
        if (!column)
            return void res.status(400).json({ detail: "Column not found" });

        const docAllowed = await filterAccessibleDocumentIds(
            [document_id],
            userId,
            userEmail,
            db,
        );
        if (docAllowed.length === 0)
            return void res.status(404).json({ detail: "Document not found" });
        const { data: doc } = await db
            .from("documents")
            .select("id, current_version_id")
            .eq("id", document_id)
            .single();
        if (!doc)
            return void res.status(404).json({ detail: "Document not found" });
        const docActive = await loadActiveVersion(document_id, db);

        const { tabular_model, api_keys } = await getUserModelSettings(
            userId,
            db,
        );
        const selectedModel =
            typeof req.body.model === "string" && req.body.model.trim()
                ? req.body.model.trim()
                : tabular_model;
        const missingKey = missingModelApiKey(selectedModel, api_keys);
        if (missingKey) {
            return void res.status(422).json({
                code: "missing_api_key",
                ...missingKey,
            });
        }

        await db
            .from("tabular_cells")
            .update({ status: "generating", content: null })
            .eq("review_id", reviewId)
            .eq("document_id", document_id)
            .eq("column_index", column_index);

        let markdown = "";
        if (docActive) {
            const buf = await downloadFile(docActive.storage_path);
            if (buf) {
                try {
                    markdown = await extractDocumentMarkdown(
                        buf,
                        docActive.file_type,
                    );
                } catch (err) {
                    console.error(
                        `[regenerate-cell] extraction error doc=${document_id}`,
                        err,
                    );
                }
            }
        }

        const result = await queryTabularCell(
            selectedModel,
            docActive?.filename?.trim() || "Untitled document",
            markdown,
            column.prompt,
            column.format,
            column.tags,
            api_keys,
        );

        if (!result) {
            await db
                .from("tabular_cells")
                .update({ status: "error" })
                .eq("review_id", reviewId)
                .eq("document_id", document_id)
                .eq("column_index", column_index);
            return void res.status(500).json({ detail: "Generation failed" });
        }

        await db
            .from("tabular_cells")
            .update({ content: JSON.stringify(result), status: "done" })
            .eq("review_id", reviewId)
            .eq("document_id", document_id)
            .eq("column_index", column_index);

        res.json(result);
    },
);

tabularRouter.post("/:reviewId/generate", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    if (isAnonymousLocalMode()) {
        const store = localTabularStore();
        const detail = store.detail(userId, reviewId);
        if (!detail)
            return void res
                .status(404)
                .json({ detail: "Review not found" });
        const columns = detail.review.columns_config;
        if (columns.length === 0) {
            return void res
                .status(400)
                .json({ detail: "No columns configured" });
        }
        const { tabular_model, api_keys } =
            await getUserModelSettings(userId);
        const selectedModel =
            typeof req.body?.model === "string" && req.body.model.trim()
                ? req.body.model.trim()
                : tabular_model;
        const reasoningEffort =
            typeof req.body?.reasoning_effort === "string"
                ? req.body.reasoning_effort.trim().slice(0, 32) || undefined
                : undefined;
        const missingKey = missingModelApiKey(selectedModel, api_keys);
        if (missingKey) {
            return void res.status(422).json({
                code: "missing_api_key",
                ...missingKey,
            });
        }

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
            store.setCell({
                userId,
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
        const cellByKey = new Map(
            detail.cells.map((cell) => [
                `${cell.document_id}:${cell.column_index}`,
                cell,
            ]),
        );

        try {
            for (const documentId of detail.review.document_ids) {
                const document = await localDocumentMarkdown(userId, documentId);
                if (!document) continue;
                await generateTabularDocument(
                    { id: documentId, ...document },
                    columns,
                    cellByKey,
                    selectedModel,
                    api_keys,
                    reasoningEffort,
                    writeCell,
                );
            }
            res.write("data: [DONE]\n\n");
        } catch (error) {
            console.error(
                "[tabular/local/generate]",
                safeErrorLog(error),
            );
            write({
                type: "error",
                message: safeErrorMessage(error, "Stream error"),
            });
            res.write("data: [DONE]\n\n");
        } finally {
            res.end();
        }
        return;
    }
    const db = createServerSupabase();

    const { data: review, error: reviewError } = await db
        .from("tabular_reviews")
        .select("*")
        .eq("id", reviewId)
        .single();
    if (reviewError || !review)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });

    const columns: {
        index: number;
        name: string;
        prompt: string;
        format?: string;
        tags?: string[];
    }[] = review.columns_config ?? [];
    if (columns.length === 0)
        return void res.status(400).json({ detail: "No columns configured" });

    const { data: cells } = await db
        .from("tabular_cells")
        .select("*")
        .eq("review_id", reviewId);
    const cellMap = new Map<string, Record<string, unknown>>();
    for (const cell of cells ?? [])
        cellMap.set(`${cell.document_id}:${cell.column_index}`, cell);

    const docIds = [...new Set((cells ?? []).map((c) => c.document_id))];
    const allowedDocIds = new Set(
        await filterAccessibleDocumentIds(docIds, userId, userEmail, db),
    );
    let docs: Record<string, unknown>[] = [];
    if (docIds.length > 0) {
        const filteredIds = docIds.filter((id) => allowedDocIds.has(id));
        const { data } =
            filteredIds.length > 0
                ? await db
                      .from("documents")
                      .select("id, current_version_id")
                      .in("id", filteredIds)
                : { data: [] as Record<string, unknown>[] };
        docs = data ?? [];
    } else if (review.project_id) {
        const { data } = await db
            .from("documents")
            .select("id, current_version_id")
            .eq("project_id", review.project_id)
            .order("created_at", { ascending: true });
        docs = data ?? [];
    }
    await attachActiveVersionPaths(
        db,
        docs as {
            id: string;
            current_version_id?: string | null;
        }[],
    );

    const { tabular_model, api_keys } = await getUserModelSettings(userId, db);
    const selectedModel =
        typeof req.body?.model === "string" && req.body.model.trim()
            ? req.body.model.trim()
            : tabular_model;
    const reasoningEffort =
        typeof req.body?.reasoning_effort === "string"
            ? req.body.reasoning_effort.trim().slice(0, 32) || undefined
            : undefined;
    const missingKey = missingModelApiKey(selectedModel, api_keys);
    if (missingKey) {
        return void res.status(422).json({
            code: "missing_api_key",
            ...missingKey,
        });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const write = (line: string) => res.write(line);

    const writeCell = async (
        documentId: string,
        columnIndex: number,
        content: CellResult | null,
        status: "generating" | "done" | "error",
    ) => {
        const event = `data: ${JSON.stringify({
            type: "cell_update",
            document_id: documentId,
            column_index: columnIndex,
            content,
            status,
        })}\n\n`;
        const existingCell = cellMap.get(`${documentId}:${columnIndex}`);
        if (status === "generating") {
            write(event);
            if (existingCell) {
                await db
                    .from("tabular_cells")
                    .update({ status, content: null })
                    .eq("id", existingCell.id);
            } else {
                await db.from("tabular_cells").insert({
                    review_id: reviewId,
                    document_id: documentId,
                    column_index: columnIndex,
                    status,
                });
            }
            return;
        }
        await db
            .from("tabular_cells")
            .update({
                ...(content ? { content: JSON.stringify(content) } : {}),
                status,
            })
            .eq("review_id", reviewId)
            .eq("document_id", documentId)
            .eq("column_index", columnIndex);
        write(event);
    };

    try {
        await Promise.all(
            docs.map(async (doc) => {
                const docId = doc.id as string;
                let markdown = "";

                const filename =
                    (typeof doc.filename === "string" && doc.filename.trim()
                        ? doc.filename.trim()
                        : "Untitled document");
                const storagePath =
                    typeof doc.storage_path === "string" ? doc.storage_path : "";
                const fileType =
                    typeof doc.file_type === "string" ? doc.file_type : "";
                if (storagePath) {
                    const buf = await downloadFile(storagePath);
                    if (buf) {
                        try {
                            markdown = await extractDocumentMarkdown(
                                buf,
                                fileType,
                            );
                        } catch (err) {
                            console.error(
                                `[tabular/generate] extraction error doc=${docId}`,
                                err,
                            );
                        }
                    }
                }

                await generateTabularDocument(
                    { id: docId, filename, markdown },
                    columns,
                    cellMap,
                    selectedModel,
                    api_keys,
                    reasoningEffort,
                    writeCell,
                    (error, documentId) =>
                        console.error(
                            `[tabular/generate] queryTabularAllColumns error doc=${documentId}`,
                            safeErrorLog(error),
                        ),
                );
            }),
        );

        write("data: [DONE]\n\n");
    } catch (err) {
        console.error("[tabular/generate] stream error", safeErrorLog(err));
        try {
            write(
                `data: ${JSON.stringify({ type: "error", message: safeErrorMessage(err, "Stream error") })}\n\ndata: [DONE]\n\n`,
            );
        } catch {
        }
    } finally {
        res.end();
    }
});

tabularRouter.get("/:reviewId/chats", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    if (isAnonymousLocalMode()) {
        if (!localTabularStore().get(userId, reviewId)) {
            return void res.status(404).json({ detail: "Review not found" });
        }
        return void res.json([]);
    }
    const db = createServerSupabase();

    const { data: review, error } = await db
        .from("tabular_reviews")
        .select("id, user_id, project_id")
        .eq("id", reviewId)
        .single();
    if (error || !review)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });

    // Show every member's chats for the review (collaborative), not just
    // the requester's. Per-chat access is gated above by review access.
    const { data: chats } = await db
        .from("tabular_review_chats")
        .select("id, title, created_at, updated_at, user_id")
        .eq("review_id", reviewId)
        .order("updated_at", { ascending: false });

    res.json(chats ?? []);
});

tabularRouter.delete(
    "/:reviewId/chats/:chatId",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const { reviewId, chatId } = req.params;
        if (isAnonymousLocalMode()) {
            if (!localTabularStore().get(userId, reviewId)) {
                return void res
                    .status(404)
                    .json({ detail: "Review not found" });
            }
            return void res.status(204).send();
        }
        const db = createServerSupabase();
        // Owner-only delete — sibling collaborators shouldn't be able to wipe
        // each other's threads.
        const { error } = await db
            .from("tabular_review_chats")
            .delete()
            .eq("id", chatId)
            .eq("user_id", userId);
        if (error) return void res.status(500).json({ detail: error.message });
        res.status(204).send();
    },
);

tabularRouter.patch(
    "/:reviewId/chats/:chatId",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const { chatId } = req.params;
        const title =
            typeof req.body?.title === "string" ? req.body.title.trim() : "";
        if (!title)
            return void res.status(400).json({ detail: "Title is required" });
        if (isAnonymousLocalMode()) {
            if (!localTabularStore().get(userId, req.params.reviewId)) {
                return void res
                    .status(404)
                    .json({ detail: "Review not found" });
            }
            return void res.status(404).json({ detail: "Chat not found" });
        }
        const db = createServerSupabase();
        // Owner-only rename — mirrors the delete rule above.
        const { error } = await db
            .from("tabular_review_chats")
            .update({ title: title.slice(0, 200) })
            .eq("id", chatId)
            .eq("user_id", userId);
        if (error) return void res.status(500).json({ detail: error.message });
        res.status(204).send();
    },
);

tabularRouter.get(
    "/:reviewId/chats/:chatId/messages",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { reviewId, chatId } = req.params;
        if (isAnonymousLocalMode()) {
            if (!localTabularStore().get(userId, reviewId)) {
                return void res
                    .status(404)
                    .json({ detail: "Review not found" });
            }
            return void res.json([]);
        }
        const db = createServerSupabase();

        const { data: review } = await db
            .from("tabular_reviews")
            .select("id, user_id, project_id")
            .eq("id", reviewId)
            .single();
        if (!review)
            return void res.status(404).json({ detail: "Review not found" });
        const access = await ensureReviewAccess(review, userId, userEmail, db);
        if (!access.ok)
            return void res.status(404).json({ detail: "Review not found" });

        const { data: chat, error: chatError } = await db
            .from("tabular_review_chats")
            .select("id, review_id")
            .eq("id", chatId)
            .single();
        if (chatError || !chat || chat.review_id !== reviewId)
            return void res.status(404).json({ detail: "Chat not found" });

        const { data: messages } = await db
            .from("tabular_review_chat_messages")
            .select("id, role, content, annotations, created_at")
            .eq("chat_id", chatId)
            .order("created_at", { ascending: true });

        res.json(messages ?? []);
    },
);


type TabularParsedCitation = {
    ref: number;
    col_index: number;
    row_index: number;
    quote: string;
};

const TABULAR_CITATIONS_BLOCK_RE = /<CITATIONS>\s*([\s\S]*?)\s*<\/CITATIONS>/;

function parseTabularCitations(text: string): TabularParsedCitation[] {
    const match = text.match(TABULAR_CITATIONS_BLOCK_RE);
    if (!match) return [];
    try {
        return JSON.parse(match[1]) as TabularParsedCitation[];
    } catch {
        return [];
    }
}

function extractTabularAnnotations(
    fullText: string,
    tabularStore: TabularCellStore,
) {
    return parseTabularCitations(fullText).map((c) => ({
        type: "tabular_citation" as const,
        ref: c.ref,
        col_index: c.col_index,
        row_index: c.row_index,
        col_name:
            tabularStore.columns[c.col_index]?.name ?? `Col ${c.col_index}`,
        doc_name:
            tabularStore.documents[c.row_index]?.filename ??
            `Row ${c.row_index}`,
        quote: c.quote,
    }));
}


function buildTabularMessages(
    messages: ChatMessage[],
    tabularStore: TabularCellStore,
    reviewTitle: string,
): unknown[] {
    const docList = tabularStore.documents
        .map((d, i) => `- ROW:${i} "${d.filename}"`)
        .join("\n");
    const colList = tabularStore.columns
        .map((c, i) => `- COL:${i} "${c.name}"`)
        .join("\n");

    const systemContent = `You are Beaver, an AI legal assistant. You are helping with the tabular review titled "${reviewTitle}".

The review extracts specific fields from multiple legal documents into a structured table.
You do NOT have the cell content yet — call read_table_cells to fetch the cells you need before answering.

DOCUMENTS (rows):
${docList || "- (none)"}

COLUMNS (fields):
${colList || "- (none)"}

TABULAR CITATION INSTRUCTIONS:
When you reference specific cell content, place a numbered marker [1], [2], etc. inline in your prose at the point of reference.

After your complete response, append a <CITATIONS> block containing a JSON array with one entry per marker:

<CITATIONS>
[
  {"ref": 1, "col_index": 0, "row_index": 2, "quote": "verbatim text from the cell"},
  {"ref": 2, "col_index": 1, "row_index": 0, "quote": "another excerpt"}
]
</CITATIONS>

Rules:
- col_index and row_index are 0-based (matching the COL/ROW numbers listed above)
- Only cite cells you have read via read_table_cells
- quote should be verbatim text from the cell's summary
- Omit <CITATIONS> if you make no citations
- Do not fabricate cell content
- Answer in clear, concise prose. You may use markdown formatting.`;

    const formatted: unknown[] = [{ role: "system", content: systemContent }];
    for (const msg of messages) {
        formatted.push({ role: msg.role, content: msg.content ?? "" });
    }
    return formatted;
}

async function streamLocalTabularChat(params: {
    res: Response;
    model: string;
    reasoningEffort?: string;
    apiKeys: UserApiKeys;
    messages: ChatMessage[];
    tabularStore: TabularCellStore;
    reviewTitle: string;
}) {
    const formatted = buildTabularMessages(
        params.messages,
        params.tabularStore,
        params.reviewTitle,
    ) as { role: "system" | "user" | "assistant"; content: string }[];
    const write = (event: unknown) =>
        params.res.write(`data: ${JSON.stringify(event)}\n\n`);
    const abort = new AbortController();
    params.res.on("close", () => abort.abort());
    params.res.setHeader("Content-Type", "text/event-stream");
    params.res.setHeader("Cache-Control", "no-cache");
    params.res.setHeader("Connection", "keep-alive");
    params.res.setHeader("X-Accel-Buffering", "no");
    params.res.flushHeaders();

    try {
        const result = await streamChatWithTools({
            model: params.model,
            systemPrompt: formatted[0]?.content ?? "",
            messages: formatted.slice(1).map((message) => ({
                role:
                    message.role === "assistant"
                        ? ("assistant" as const)
                        : ("user" as const),
                content: message.content,
            })),
            tools: TABULAR_TOOLS as OpenAIToolSchema[],
            apiKeys: params.apiKeys,
            enableThinking: true,
            reasoningEffort: params.reasoningEffort,
            abortSignal: abort.signal,
            callbacks: {
                onContentDelta: (text) =>
                    write({ type: "content_delta", text }),
                onReasoningDelta: (text) =>
                    write({ type: "reasoning_delta", text }),
                onReasoningBlockEnd: () =>
                    write({ type: "reasoning_block_end" }),
                onToolCallStart: (call) =>
                    write({ type: "tool_call_start", name: call.name }),
            },
            runTools: async (calls) =>
                calls.map((call) => {
                    if (call.name !== "read_table_cells") {
                        return {
                            tool_use_id: call.id,
                            content: "Tool unavailable.",
                        };
                    }
                    const columns = Array.isArray(call.input.col_indices)
                        ? call.input.col_indices.filter(
                              (value): value is number =>
                                  Number.isSafeInteger(value),
                          )
                        : undefined;
                    const rows = Array.isArray(call.input.row_indices)
                        ? call.input.row_indices.filter(
                              (value): value is number =>
                                  Number.isSafeInteger(value),
                          )
                        : undefined;
                    const selected = readTabularCells(
                        params.tabularStore,
                        columns,
                        rows,
                    );
                    write({
                        type: "doc_read_start",
                        filename: selected.label,
                    });
                    write({ type: "doc_read", filename: selected.label });
                    return {
                        tool_use_id: call.id,
                        content: selected.content,
                    };
                }),
        });
        write({
            type: "citations",
            citations: extractTabularAnnotations(
                result.fullText,
                params.tabularStore,
            ),
        });
        params.res.write("data: [DONE]\n\n");
    } catch (error) {
        if (!isAbortError(error)) {
            write({
                type: "content_delta",
                text: safeErrorMessage(error, "Tabular chat failed"),
            });
            params.res.write("data: [DONE]\n\n");
        }
    } finally {
        params.res.end();
    }
}


tabularRouter.post("/:reviewId/chat", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const {
        messages,
        chat_id: existingChatId,
        review_title: clientReviewTitle,
        project_name: clientProjectName,
        model: requestedModel,
        reasoning_effort: requestedReasoningEffort,
    } = req.body as {
        messages: ChatMessage[];
        chat_id?: string;
        review_title?: string;
        project_name?: string;
        model?: string;
        reasoning_effort?: string;
    };

    const lastUser = [...(messages ?? [])]
        .reverse()
        .find((m) => m.role === "user");
    if (!lastUser?.content?.trim()) {
        return void res
            .status(400)
            .json({ detail: "messages must include a user message" });
    }

    if (isAnonymousLocalMode()) {
        const detail = localTabularStore().detail(userId, reviewId);
        if (!detail)
            return void res
                .status(404)
                .json({ detail: "Review not found" });
        const { tabular_model, api_keys } =
            await getUserModelSettings(userId);
        const selectedModel =
            typeof requestedModel === "string" && requestedModel.trim()
                ? requestedModel.trim()
                : tabular_model;
        const missingKey = missingModelApiKey(selectedModel, api_keys);
        if (missingKey) {
            return void res.status(422).json({
                code: "missing_api_key",
                ...missingKey,
            });
        }
        const documents = await listLocalDocumentsById(
            userId,
            detail.review.document_ids,
        );
        const tabularStore: TabularCellStore = {
            app_url: appUrl({
                kind: "tabular-review",
                id: reviewId,
                projectId: detail.review.project_id,
            }),
            columns: [...detail.review.columns_config].sort(
                (left, right) => left.index - right.index,
            ),
            documents: documents.map((document) => ({
                id: document.id as string,
                filename:
                    typeof document.filename === "string" &&
                    document.filename.trim()
                        ? document.filename.trim()
                        : "Untitled document",
            })),
            cells: new Map(
                detail.cells.map((cell) => [
                    `${cell.column_index}:${cell.document_id}`,
                    parseCellContent(cell.content),
                ]),
            ),
        };
        await streamLocalTabularChat({
            res,
            model: selectedModel,
            reasoningEffort:
                typeof requestedReasoningEffort === "string"
                    ? requestedReasoningEffort.trim().slice(0, 32) ||
                      undefined
                    : undefined,
            apiKeys: api_keys,
            messages,
            tabularStore,
            reviewTitle: detail.review.title || "Untitled Review",
        });
        return;
    }

    const [cloudContext, cloudStreaming] = await Promise.all([
        import("../lib/chat/contextBuilders"),
        import("../lib/chat/streaming"),
    ]);
    const {
        buildCancelledAssistantMessage,
        stripTransientAssistantEvents,
    } = cloudContext;
    const { AssistantStreamError, runLLMStream } = cloudStreaming;

    const db = createServerSupabase();
    const { data: review, error } = await db
        .from("tabular_reviews")
        .select("*")
        .eq("id", reviewId)
        .single();
    if (error || !review)
        return void res.status(404).json({ detail: "Review not found" });
    const reviewAccess = await ensureReviewAccess(
        review,
        userId,
        userEmail,
        db,
    );
    if (!reviewAccess.ok)
        return void res.status(404).json({ detail: "Review not found" });

    const { data: cells } = await db
        .from("tabular_cells")
        .select("*")
        .eq("review_id", reviewId);

    const docIds = [
        ...new Set((cells ?? []).map((c: any) => c.document_id as string)),
    ];
    let docs: {
        id: string;
        filename: string;
        current_version_id?: string | null;
    }[] = [];
    if (docIds.length > 0) {
        const { data } = await db
            .from("documents")
            .select("id, current_version_id")
            .in("id", docIds)
            .order("created_at", { ascending: true });
        const attachedDocs = (data ?? []) as {
            id: string;
            current_version_id?: string | null;
            filename?: string | null;
        }[];
        await attachActiveVersionPaths(db, attachedDocs);
        docs = attachedDocs.map((doc) => ({
            ...doc,
            filename:
                (typeof doc.filename === "string" && doc.filename.trim()) ||
                "Untitled document",
        }));
    }

    const sortedColumns = (
        (review.columns_config ?? []) as { index: number; name: string }[]
    ).sort((a, b) => a.index - b.index);

    const tabularStore: TabularCellStore = {
        app_url: appUrl({
            kind: "tabular-review",
            id: reviewId,
            projectId: review.project_id,
        }),
        columns: sortedColumns,
        documents: docs,
        cells: new Map(
            (cells ?? []).map((c: any) => [
                `${c.column_index}:${c.document_id}`,
                parseCellContent(c.content),
            ]),
        ),
    };

    const { tabular_model, api_keys } = await getUserModelSettings(userId, db);
    const selectedModel =
        typeof requestedModel === "string" && requestedModel.trim()
            ? requestedModel.trim()
            : tabular_model;
    const reasoningEffort =
        typeof requestedReasoningEffort === "string"
            ? requestedReasoningEffort.trim().slice(0, 32) || undefined
            : undefined;
    const missingKey = missingModelApiKey(selectedModel, api_keys);
    if (missingKey) {
        return void res.status(422).json({
            code: "missing_api_key",
            ...missingKey,
        });
    }

    let chatId = existingChatId ?? null;
    let chatTitle: string | null = null;
    const isFirstExchange =
        messages.filter((m) => m.role === "user").length === 1;

    if (chatId) {
        // The chat must belong to this exact review and to the requester.
        // Review access alone is not enough: otherwise a user could reuse one
        // of their chats from a different review in this route.
        const { data: existing } = await db
            .from("tabular_review_chats")
            .select("id, title, review_id, user_id")
            .eq("id", chatId)
            .single();
        const canUse =
            !!existing &&
            existing.review_id === reviewId &&
            existing.user_id === userId;
        if (!canUse || !existing) chatId = null;
        else chatTitle = existing.title;
    }

    if (!chatId) {
        const { data: newChat } = await db
            .from("tabular_review_chats")
            .insert({ review_id: reviewId, user_id: userId })
            .select("id, title")
            .single();
        chatId = newChat?.id ?? null;
        chatTitle = newChat?.title ?? null;
    }

    if (chatId) {
        await db.from("tabular_review_chat_messages").insert({
            chat_id: chatId,
            role: "user",
            content: lastUser.content,
        });
    }

    const apiMessages = buildTabularMessages(
        messages,
        tabularStore,
        review.title || "Untitled Review",
    );

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    const write = (line: string) => res.write(line);
    const streamAbort = new AbortController();
    let streamFinished = false;
    res.on("close", () => {
        if (!streamFinished) streamAbort.abort();
    });

    if (chatId) {
        write(`data: ${JSON.stringify({ type: "chat_id", chatId })}\n\n`);
    }

    try {
        const { fullText, events } = await runLLMStream({
            apiMessages,
            docStore: new Map(),
            docIndex: {},
            userId,
            db,
            write,
            extraTools: TABULAR_TOOLS,
            includeResearchTools: false,
            tabularStore,
            buildCitations: (text) =>
                extractTabularAnnotations(text, tabularStore),
            model: selectedModel,
            apiKeys: api_keys,
            reasoningEffort,
            signal: streamAbort.signal,
        });

        const persistedEvents = stripTransientAssistantEvents(events);
        const annotations = extractTabularAnnotations(fullText, tabularStore);

        if (chatId) {
            await db.from("tabular_review_chat_messages").insert({
                chat_id: chatId,
                role: "assistant",
                content: persistedEvents.length ? persistedEvents : null,
                annotations: annotations.length ? annotations : null,
            });
            await db
                .from("tabular_review_chats")
                .update({ updated_at: new Date().toISOString() })
                .eq("id", chatId);
        }

        if (chatId && isFirstExchange && !chatTitle && lastUser.content) {
            const { title_model } = await getUserModelSettings(userId, db);
            const title = await generateChatTitle(
                title_model,
                lastUser.content,
                {
                    reviewTitle: clientReviewTitle ?? review.title ?? null,
                    projectName: clientProjectName ?? null,
                },
                api_keys,
            );
            if (title) {
                await db
                    .from("tabular_review_chats")
                    .update({ title })
                    .eq("id", chatId);
                write(
                    `data: ${JSON.stringify({ type: "chat_title", chatId, title })}\n\n`,
                );
            }
        }
    } catch (err) {
        if (isAbortError(err)) {
            console.log("[tabular/chat] client aborted stream", { chatId });
            if (chatId && err instanceof AssistantStreamError) {
                const partial = buildCancelledAssistantMessage({
                    fullText: err.fullText,
                    events: err.events,
                    buildCitations: (fullText) =>
                        extractTabularAnnotations(fullText, tabularStore),
                });
                const annotations = partial.citations;
                const { error: saveError } = await db
                    .from("tabular_review_chat_messages")
                    .insert({
                        chat_id: chatId,
                        role: "assistant",
                        content: partial.events.length ? partial.events : null,
                        annotations: annotations.length
                            ? annotations
                            : null,
                    });
                if (saveError) {
                    console.error(
                        "[tabular/chat] failed to save aborted stream",
                        saveError,
                    );
                }
                await db
                    .from("tabular_review_chats")
                    .update({ updated_at: new Date().toISOString() })
                    .eq("id", chatId);
            }
            return;
        }
        console.error("[tabular/chat] error", safeErrorLog(err));
        const message = safeErrorMessage(err, "Stream error");
        const errorEvents = err instanceof AssistantStreamError
            ? stripTransientAssistantEvents(err.events)
            : [{ type: "error" as const, message }];
        const errorFullText =
            err instanceof AssistantStreamError ? err.fullText : "";
        if (chatId) {
            try {
                const annotations = extractTabularAnnotations(
                    errorFullText,
                    tabularStore,
                );
                const { error: saveError } = await db
                    .from("tabular_review_chat_messages")
                    .insert({
                        chat_id: chatId,
                        role: "assistant",
                        content: errorEvents.length ? errorEvents : null,
                        annotations: annotations.length ? annotations : null,
                    });
                if (saveError)
                    console.error("[tabular/chat] failed to save error", saveError);
            } catch (saveErr) {
                console.error("[tabular/chat] failed to save error", saveErr);
            }
        }
        try {
            write(
                `data: ${JSON.stringify({ type: "error", message })}\n\n`,
            );
            write("data: [DONE]\n\n");
        } catch {
        }
    } finally {
        streamFinished = true;
        res.end();
    }
});

function parseCellContent(
    raw: unknown,
): { summary: string; flag?: string; reasoning?: string } | null {
    if (!raw) return null;
    if (typeof raw === "object" && raw !== null && "summary" in raw) {
        const c = raw as {
            summary?: unknown;
            flag?: unknown;
            reasoning?: unknown;
        };
        return {
            summary: String(c.summary ?? ""),
            flag: (["green", "grey", "yellow", "red"] as const).includes(
                c.flag as "green",
            )
                ? (c.flag as string)
                : undefined,
            reasoning: typeof c.reasoning === "string" ? c.reasoning : "",
        };
    }
    if (typeof raw === "string") {
        try {
            const p = JSON.parse(raw) as {
                summary?: unknown;
                value?: unknown;
                flag?: unknown;
                reasoning?: unknown;
            };
            return {
                summary: String(p.summary ?? p.value ?? "").trim(),
                flag: (["green", "grey", "yellow", "red"] as const).includes(
                    p.flag as "green",
                )
                    ? (p.flag as string)
                    : undefined,
                reasoning: typeof p.reasoning === "string" ? p.reasoning : "",
            };
        } catch {
            return { summary: raw, flag: "grey", reasoning: "" };
        }
    }
    return null;
}

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

async function generateChatTitle(
    model: string,
    firstUserMessage: string,
    context?: { reviewTitle?: string | null; projectName?: string | null },
    apiKeys?: import("../lib/llm").UserApiKeys,
): Promise<string | null> {
    try {
        const contextLines: string[] = [];
        if (context?.projectName)
            contextLines.push(`Project: ${context.projectName}`);
        if (context?.reviewTitle)
            contextLines.push(`Tabular review: ${context.reviewTitle}`);
        const contextBlock = contextLines.length
            ? `This chat is in the context of a tabular review.\n${contextLines.join("\n")}\n\n`
            : "";

        const raw = await completeText({
            model,
            user: `${contextBlock}Generate a short title (4-6 words) for a chat that starts with the message below. The title should reflect the user's specific question, not the review or project name. Return only the title, no punctuation, no quotes:\n\n${firstUserMessage}`,
            maxTokens: 64,
            apiKeys,
        });
        return raw.trim().slice(0, 80) || null;
    } catch {
        return null;
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
    const normalizedType = (fileType ?? "").toLowerCase();
    if (normalizedType === "pdf") return extractPdfMarkdown(buf);
    if (normalizedType === "docx") return extractDocxMarkdown(buf);
    if (isSpreadsheetDocumentType(normalizedType)) {
        return spreadsheetToLLMText(Buffer.from(buf));
    }
    if (normalizedType === "pptx") {
        return extractPresentationText(Buffer.from(buf));
    }
    if (
        isPresentationDocumentType(normalizedType) ||
        isWordDocumentType(normalizedType)
    ) {
        const pdfBuf = await docxToPdf(Buffer.from(buf));
        const pdfArrayBuffer = pdfBuf.buffer.slice(
            pdfBuf.byteOffset,
            pdfBuf.byteOffset + pdfBuf.byteLength,
        ) as ArrayBuffer;
        return extractPdfMarkdown(pdfArrayBuffer);
    }
    return extractDocxMarkdown(buf);
}

async function extractPdfMarkdown(buf: ArrayBuffer): Promise<string> {
    try {
        const pdfjsLib = await import(
            "pdfjs-dist/legacy/build/pdf.mjs" as string
        );
        const pdf = await (
            pdfjsLib as unknown as {
                getDocument: (opts: unknown) => {
                    promise: Promise<{
                        numPages: number;
                        getPage: (n: number) => Promise<{
                            getTextContent: () => Promise<{
                                items: { str?: string; hasEOL?: boolean }[];
                            }>;
                        }>;
                    }>;
                };
            }
        ).getDocument({
            // Untrusted uploads: never let pdf.js compile font programs via eval.
            data: new Uint8Array(buf),
            isEvalSupported: false,
        }).promise;
        const pages: string[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const tc = await page.getTextContent();
            const text = tc.items
                .filter((it): it is { str: string } => "str" in it)
                .map((it) => it.str)
                .join(" ")
                .trim();
            if (text) pages.push(`## Page ${i}\n\n${text}`);
        }
        return pages.join("\n\n");
    } catch {
        return "";
    }
}

async function extractDocxMarkdown(buf: ArrayBuffer): Promise<string> {
    try {
        const mammoth = await import("mammoth");
        const normalized = await normalizeDocxZipPaths(Buffer.from(buf));
        const { value: html } = await mammoth.convertToHtml({
            buffer: normalized,
        });
        return html
            .replace(
                /<h([1-6])[^>]*>(.*?)<\/h\1>/gi,
                (_, l, t) => "#".repeat(Number(l)) + " " + t + "\n\n",
            )
            .replace(/<strong[^>]*>(.*?)<\/strong>/gi, "**$1**")
            .replace(/<li[^>]*>(.*?)<\/li>/gi, "- $1\n")
            .replace(/<p[^>]*>(.*?)<\/p>/gi, "$1\n\n")
            .replace(/<[^>]+>/g, "")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    } catch {
        return "";
    }
}

import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth";
import { asyncRoute } from "../lib/asyncRoute";
import { ChatStoreError, type ChatScope, type ChatStore } from "../lib/chatStore";
import { ChatApplicationError, chatTurnInputSchema,
  type ChatApplication } from "../lib/chat/chatApplication";
import { beginChatTurn, finishChatTurn } from "../lib/chatTurns";
import type { ChatTurnQueue } from "../lib/chatTurnQueue";
import type { PublicAssistantEvent } from "../lib/chat/assistantEvents";
import { CODEX_THREAD_ID } from "../lib/llm/codex";
import { requestAbortController, startSse, writeSse } from "../lib/httpStreaming";
import { safeErrorLog } from "../lib/safeError";
import { jsonRecord } from "../lib/value";
import { ApplicationError } from "../lib/applicationError";
import { z } from "zod";
import { researchSelectionSchema } from "../lib/researchSelection";

const historyQuery = z.object({
  search_scope: z.enum(["all", "titles", "transcripts"]).default("all"),
  search_context: z.enum(["assistant", "reviews", "all"]).default("assistant"),
  created_from: z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString()).optional(),
  created_to: z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString()).optional(),
  sort: z.enum(["newest", "oldest"]).default("newest"),
}).refine((value) => !value.created_from || !value.created_to || value.created_from < value.created_to,
  "Created through must be after Created from");

const text = (value: unknown, max = 20_000) => {
  const parsed = typeof value === "string" ? value.trim() : "";
  return parsed.length <= max ? parsed : "";
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
type Handler = (req: Request, res: Response, scope: ChatScope) => Promise<unknown>;
function route(handler: Handler) {
  return asyncRoute(async (req, res) => {
    try {
      await handler(req, res, {
        userId: res.locals.userId as string,
        userEmail: res.locals.userEmail as string | undefined,
      });
    } catch (error) {
      if (error instanceof ChatStoreError) {
        return void res.status(error.status).json({ detail: error.message });
      }
      if (error instanceof ChatApplicationError) {
        return void res.status(error.status).json({
          ...(error.code ? { code: error.code } : {}),
          ...(error.currentVersion !== undefined
            ? { current_version: error.currentVersion } : {}),
          detail: error.message,
        });
      }
      if (error instanceof ApplicationError) {
        return void res.status(error.status).json({
          detail: error.message,
          ...(error.details ?? {}),
        });
      }
      console.error("[chat] operation failed", safeErrorLog(error));
      if (!res.headersSent) res.status(500).json({ detail: "Chat operation failed" });
      else res.end();
    }
  });
}

function optionalId(value: unknown, label: string) {
  if (value === undefined) return { provided: false, value: null } as const;
  if (value === null) return { provided: true, value: null } as const;
  const parsed = text(value, 200);
  if (!parsed) throw new ChatApplicationError(400,
    `${label} must be a non-empty string or null`);
  return { provided: true, value: parsed } as const;
}

export function createChatRouter(
  chats: ChatStore,
  application: ChatApplication,
  turns: ChatTurnQueue,
) {
  const router = Router();
  router.use(requireAuth);

  const streamTurn = async (
    req: Request,
    res: Response,
    scope: ChatScope,
    jobId: string,
    initialChatId?: string,
  ) => {
    const controller = requestAbortController(req, res);
    const emit = (event: PublicAssistantEvent) => writeSse(res, event);
    let accepted = false, versionSent = false, chatId = initialChatId;
    startSse(res);
    emit({ type: "turn_queued", jobId });
    try {
      const completed = await turns.observe(scope, jobId, controller.signal, (event) => {
        if (event.type === "chat_id") {
          accepted = true;
          chatId = event.chatId;
        }
        if (event.type === "transcript_version") versionSent = true;
        emit(event);
      });
      if (completed.status === "failed") emit({
        type: "error",
        message: "The assistant response stopped unexpectedly. You can retry this turn.",
        retryable: true,
        accepted,
      });
      if (completed.status === "cancelled") emit(
        { type: "turn_status", status: "cancelled" });
      const result = jsonRecord(completed.result);
      if (typeof result?.chat_id === "string") chatId = result.chat_id;
      const current = chatId ? await chats.get(scope, chatId) : null;
      if (!versionSent) emit({
        type: "transcript_version",
        transcriptVersion: current?.transcript_version ?? 0,
      });
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      if (!res.destroyed && !res.writableEnded) {
        res.write("data: [DONE]\n\n");
        res.end();
      }
    }
  };

  router.get("/", route(async (req, res, scope) => {
    const query = historyQuery.safeParse(req.query);
    if (!query.success) throw new ChatApplicationError(400, "Invalid history filters");
    const tabularReviewId = text(req.query.tabular_review_id, 200) || undefined;
    const limit = Number.parseInt(String(req.query.limit ?? ""), 10);
    const offset = Number.parseInt(String(req.query.offset ?? ""), 10);
    res.json(await chats.list(scope, {
      ...(tabularReviewId ? { tabularReviewId } : {}),
      limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 20,
      offset: Number.isFinite(offset) ? Math.max(offset, 0) : 0,
      search: text(req.query.search, 200) || undefined,
      searchScope: query.data.search_scope, createdFrom: query.data.created_from,
      searchContext: query.data.search_context,
      createdTo: query.data.created_to, sort: query.data.sort,
    }));
  }));

  router.get("/recycling-bin", route(async (_req, res, scope) => {
    res.json(await chats.deleted(scope));
  }));

  router.post("/create", route(async (req, res, scope) => {
    const project = optionalId(req.body?.project_id, "project_id");
    const review = optionalId(req.body?.tabular_review_id, "tabular_review_id");
    const research = optionalId(req.body?.research_file_id, "research_file_id");
    if (project.value && review.value) throw new ChatApplicationError(400,
      "A chat cannot belong to both a project and a tabular review");
    const chat = await (research.value ? application.create(scope, {
      projectId: project.value, tabularReviewId: review.value, researchFileId: research.value,
      researchSelection: researchSelectionSchema.nullish().parse(req.body?.research_selection),
    }) : chats.create(scope, {
      projectId: project.value,
      tabularReviewId: review.value,
    }));
    res.json({ id: chat.id });
  }));

  router.get("/:chatId", route(async (req, res, scope) => {
    const after = Number(req.query.after_version);
    const active = !!await turns.activeJob(scope, req.params.chatId);
    if (Number.isSafeInteger(after) && active &&
        (await chats.get(scope, req.params.chatId))?.transcript_version === after)
      return void res.status(204).send();
    const detail = await chats.detail(scope, req.params.chatId);
    if (!detail) return void res.status(404).json({ detail: "Chat not found" });
    res.json({
      chat: {
        ...detail.chat,
        turn_in_progress: active,
      },
      messages: detail.messages,
    });
  }));

  router.post("/:chatId/stop", route(async (req, res, scope) => {
    if (!await chats.get(scope, req.params.chatId)) {
      return void res.status(404).json({ detail: "Chat not found" });
    }
    res.json({ stopped: await turns.cancel(scope, req.params.chatId) });
  }));

  router.post("/jobs/:jobId/stop", route(async (req, res, scope) => {
    res.json({ stopped: await turns.cancelJob(scope, req.params.jobId) });
  }));

  router.post("/jobs/:jobId/tool-result", route(async (req, res, scope) => {
    const callId = text(req.body?.callId, 100);
    if (!UUID.test(callId)) {
      return void res.status(400).json({ detail: "callId must be a UUID" });
    }
    if (Buffer.byteLength(JSON.stringify(req.body?.result ?? null)) > 100 * 1024) {
      return void res.status(413).json({ detail: "Tool result is too large" });
    }
    if (!await turns.clientResult(scope, req.params.jobId, callId, req.body?.result)) {
      return void res.status(404).json({ detail: "Response is no longer running" });
    }
    res.status(204).send();
  }));

  router.get("/jobs/:jobId/stream", route(async (req, res, scope) => {
    if (!await turns.job(scope, req.params.jobId)) {
      return void res.status(404).json({ detail: "Response not found" });
    }
    await streamTurn(req, res, scope, req.params.jobId);
  }));

  router.get("/:chatId/stream", route(async (req, res, scope) => {
    if (!await chats.get(scope, req.params.chatId)) {
      return void res.status(404).json({ detail: "Chat not found" });
    }
    const job = await turns.activeJob(scope, req.params.chatId);
    if (!job) return void res.status(409).json({ detail: "No response is running" });
    await streamTurn(req, res, scope, job.id, req.params.chatId);
  }));

  router.post("/:chatId/steer", route(async (req, res, scope) => {
    if (!await chats.get(scope, req.params.chatId)) {
      return void res.status(404).json({ detail: "Chat not found" });
    }
    const id = text(req.body?.id), instruction = text(req.body?.text);
    if (!CODEX_THREAD_ID.test(id) || !instruction) {
      return void res.status(400).json({ detail: "id and text are required" });
    }
    if (!await turns.steer(scope, req.params.chatId, { id, text: instruction })) {
      return void res.status(409).json({
        detail: "No steerable response is running",
      });
    }
    res.json({ steered: true });
  }));

  router.post("/:chatId/compact", route(async (req, res, scope) => {
    if (await turns.activeJob(scope, req.params.chatId)) {
      throw new ChatApplicationError(409, "A response is already running",
        "chat_turn_in_progress");
    }
    const controller = requestAbortController(req, res);
    let claimedChatId: string | null = null;
    try {
      res.json(await application.compact(scope, {
        chatId: req.params.chatId,
        model: text(req.body?.model, 200) || undefined,
      }, controller.signal, (chatId) => {
        if (!beginChatTurn(chatId, controller)) return false;
        claimedChatId = chatId;
        return true;
      }));
    } finally {
      if (claimedChatId) finishChatTurn(claimedChatId, controller);
    }
  }));

  router.patch("/:chatId", route(async (req, res, scope) => {
    const body = jsonRecord(req.body) ?? {};
    const titleProvided = Object.hasOwn(body, "title");
    const projectProvided = Object.hasOwn(body, "project_id");
    const draftProvided = Object.hasOwn(body, "draft");
    const draft = body.draft === null ? null : jsonRecord(body.draft);
    if (draftProvided && body.draft !== null && (!draft || typeof draft.content !== "string"))
      return void res.status(400).json({ detail: "Draft content is required" });
    if (!titleProvided && !projectProvided && !draftProvided) return void res.status(400).json({
      detail: "title, project_id or draft is required",
    });
    const title = titleProvided ? text(body.title, 200) : undefined;
    if (titleProvided && !title) return void res.status(400).json({
      detail: "title is required",
    });
    const project = projectProvided
      ? optionalId(body.project_id, "project_id") : null;
    const chat = await chats.update(scope, req.params.chatId, {
      ...(title ? { title } : {}),
      ...(projectProvided ? { projectId: project!.value } : {}),
      ...(draftProvided ? { draft } : {}),
    });
    if (!chat) return void res.status(404).json({ detail: "Chat not found" });
    res.json({ id: chat.id, title: chat.title, project_id: chat.project_id });
  }));

  router.delete("/:chatId", route(async (req, res, scope) => {
    if (!await chats.trash(scope, req.params.chatId)) {
      return void res.status(404).json({ detail: "Chat not found" });
    }
    res.status(204).send();
  }));
  router.post("/:chatId/restore", route(async (req, res, scope) => {
    if (!await chats.restore(scope, req.params.chatId)) {
      return void res.status(404).json({ detail: "Chat not found" });
    }
    res.status(204).send();
  }));
  router.delete("/:chatId/permanent", route(async (req, res, scope) => {
    if (!await chats.remove(scope, req.params.chatId)) {
      return void res.status(404).json({ detail: "Chat not found" });
    }
    res.status(204).send();
  }));
  router.post("/:chatId/generate-title", route(async (req, res, scope) => {
    const message = text(req.body?.message);
    if (!message) return void res.status(400).json({ detail: "message is required" });
    const title = await chats.generateTitle(scope, req.params.chatId, message);
    if (!title) return void res.status(404).json({ detail: "Chat not found" });
    res.json({ title });
  }));

  router.post("/", route(async (req, res, scope) => {
    const parsed = chatTurnInputSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({
      detail: parsed.error.issues[0]?.message ?? "Invalid chat turn",
    });
    const chat = parsed.data.chat_id
      ? await chats.get(scope, parsed.data.chat_id) : null;
    if (parsed.data.chat_id && !chat) {
      return void res.status(404).json({ detail: "Chat not found" });
    }
    if (chat && parsed.data.project_id !== undefined &&
        chat.project_id !== (parsed.data.project_id ?? null)) {
      throw new ChatApplicationError(400, "project_id does not match chat");
    }
    if (chat && parsed.data.tabular_review_id !== undefined &&
        chat.tabular_review_id !== (parsed.data.tabular_review_id ?? null)) {
      throw new ChatApplicationError(400, "tabular_review_id does not match chat");
    }
    if (!chat && parsed.data.expected_version !== 0) {
      throw new ChatApplicationError(409, "Chat changed",
        "chat_version_conflict", 0);
    }
    if (chat && chat.transcript_version !== parsed.data.expected_version) {
      throw new ChatApplicationError(409, "Chat changed",
        "chat_version_conflict", chat.transcript_version);
    }
    const queued = await turns.enqueue(scope, parsed.data);
    if (!queued.created) throw new ChatApplicationError(409,
      "A response is already running", "chat_turn_in_progress",
      chat?.transcript_version ?? 0);
    await streamTurn(req, res, scope, queued.job.id, chat?.id);
  }));

  return router;
}

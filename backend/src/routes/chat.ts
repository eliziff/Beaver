import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth";
import { asyncRoute } from "../lib/asyncRoute";
import {
  ChatStoreError,
  type ChatScope,
  type ChatStore,
} from "../lib/chatStore";
import {
  ChatApplicationError,
  chatTurnInputSchema,
  type ChatApplication,
  type EventSink,
} from "../lib/chat/chatApplication";
import {
  abortChatTurn,
  beginChatTurn,
  chatTurnInProgress,
  finishChatTurn,
  setChatTurnControl,
  steerChatTurn,
} from "../lib/chatTurns";
import {
  CODEX_THREAD_ID,
} from "../lib/llm/codex";
import { requestAbortController, startSse, writeSse } from "../lib/httpStreaming";
import { safeErrorLog } from "../lib/safeError";
import { jsonRecord } from "../lib/value";

const text = (value: unknown, max = 20_000) => {
  const parsed = typeof value === "string" ? value.trim() : "";
  return parsed.length <= max ? parsed : "";
};
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
) {
  const router = Router();
  router.use(requireAuth);

  router.get("/", route(async (req, res, scope) => {
    const tabularReviewId = text(req.query.tabular_review_id, 200) || undefined;
    const limit = Number.parseInt(String(req.query.limit ?? ""), 10);
    res.json(await chats.list(scope, {
      ...(tabularReviewId ? { tabularReviewId } : {}),
      limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 20,
    }));
  }));

  router.get("/recycling-bin", route(async (_req, res, scope) => {
    res.json(await chats.deleted(scope));
  }));

  router.post("/create", route(async (req, res, scope) => {
    const project = optionalId(req.body?.project_id, "project_id");
    const review = optionalId(req.body?.tabular_review_id, "tabular_review_id");
    if (project.value && review.value) throw new ChatApplicationError(400,
      "A chat cannot belong to both a project and a tabular review");
    const chat = await chats.create(scope, {
      projectId: project.value,
      tabularReviewId: review.value,
    });
    res.json({ id: chat.id });
  }));

  router.get("/:chatId", route(async (req, res, scope) => {
    const detail = await chats.detail(scope, req.params.chatId);
    if (!detail) return void res.status(404).json({ detail: "Chat not found" });
    res.json({
      chat: {
        ...detail.chat,
        turn_in_progress: chatTurnInProgress(req.params.chatId),
      },
      messages: detail.messages,
    });
  }));

  router.post("/:chatId/stop", route(async (req, res, scope) => {
    if (!await chats.get(scope, req.params.chatId)) {
      return void res.status(404).json({ detail: "Chat not found" });
    }
    res.json({ stopped: abortChatTurn(req.params.chatId) });
  }));

  router.post("/:chatId/steer", route(async (req, res, scope) => {
    if (!await chats.get(scope, req.params.chatId)) {
      return void res.status(404).json({ detail: "Chat not found" });
    }
    const id = text(req.body?.id), instruction = text(req.body?.text);
    if (!CODEX_THREAD_ID.test(id) || !instruction) {
      return void res.status(400).json({ detail: "id and text are required" });
    }
    if (!await steerChatTurn(req.params.chatId, { id, text: instruction })) {
      return void res.status(409).json({
        detail: "No steerable response is running",
      });
    }
    res.json({ steered: true });
  }));

  router.post("/:chatId/compact", route(async (req, res, scope) => {
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
    if (!titleProvided && !projectProvided) return void res.status(400).json({
      detail: "title or project_id is required",
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
    const controller = requestAbortController(req, res);
    let claimedChatId: string | null = null;
    let started = false;
    const sink: EventSink = {
      claim(chatId) {
        if (!beginChatTurn(chatId, controller)) return false;
        claimedChatId = chatId;
        return true;
      },
      start() {
        startSse(res);
        started = true;
      },
      emit: (event) => writeSse(res, event),
      setControl: (control) => {
        if (claimedChatId) setChatTurnControl(claimedChatId, controller, control);
      },
    };
    try {
      await application.turn(scope, parsed.data, sink, controller.signal);
    } catch (error) {
      if (!res.headersSent && error instanceof ChatApplicationError) {
        return void res.status(error.status).json({
          ...(error.code ? { code: error.code } : {}),
          ...(error.currentVersion !== undefined
            ? { current_version: error.currentVersion } : {}),
          detail: error.message,
        });
      }
      if (!res.headersSent) throw error;
      console.error("[chat] streaming turn failed", safeErrorLog(error));
    } finally {
      if (claimedChatId) {
        if (started && !res.destroyed && !res.writableEnded) {
          res.write("data: [DONE]\n\n");
        }
        finishChatTurn(claimedChatId, controller);
      }
      if (started && !res.destroyed && !res.writableEnded) {
        res.end();
      }
    }
  }));

  return router;
}

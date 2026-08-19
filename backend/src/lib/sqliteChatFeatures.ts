import type { ChatApplicationFeatures } from "./chat/chatApplication";
import { beaverCodexHome } from "./llm/codexAppServer";
import { compactCodexSession } from "./llm/codex";
import { providerForModel } from "./llm/models";
import { claimProviderSession, deleteProviderSession,
  providerSessionCompatibilityKey, readProviderSession,
  writeProviderSession } from "./providerSessionStore";
import { safeErrorLog } from "./safeError";

export const sqliteChatFeatures: Partial<ChatApplicationFeatures> = {
  providerSession: {
    async claim(input) {
      if (input.provider !== "codex") {
        deleteProviderSession(input.chatId);
        return null;
      }
      const compatibilityKey = providerSessionCompatibilityKey({ schema_version: 5,
        transport: "app-server-v2", model: input.model,
        reasoning_effort: input.reasoningEffort?.trim() || "max",
        service_tier: input.serviceTier?.trim().toLowerCase() || "default",
        scope: { user_id: input.auth.userId, project_id: input.projectId },
        auth: { command: process.env.CODEX_COMMAND?.trim() || "codex",
          codex_home: beaverCodexHome(), api_key_sha256: process.env.CODEX_API_KEY
            ? providerSessionCompatibilityKey(process.env.CODEX_API_KEY) : null } });
      let continuationId: string | undefined;
      try {
        continuationId = claimProviderSession({ userId: input.auth.userId,
          chatId: input.chatId, projectId: input.projectId, compatibilityKey,
          transcriptVersion: input.expectedVersion })?.continuation_id;
      } catch (error) {
        console.warn("[chat] provider continuation unavailable", safeErrorLog(error));
      }
      return { continuationId, promptCacheKey: providerSessionCompatibilityKey({
        schema_version: 1, provider: input.provider, chat_id: input.chatId }),
      save(nextContinuationId, version) {
        if (!nextContinuationId) return void deleteProviderSession(input.chatId);
        writeProviderSession({ userId: input.auth.userId, chatId: input.chatId,
          projectId: input.projectId, continuationId: nextContinuationId,
          compatibilityKey, transcriptVersion: version });
      } };
    },
    async compact({ auth, chatId, model, signal }) {
      const session = readProviderSession(auth.userId, chatId);
      if (providerForModel(model) !== "codex" || !session)
        return { handled: false, save: (_version: number) => undefined };
      await compactCodexSession({ continuationId: session.continuation_id,
        apiKey: process.env.CODEX_API_KEY, abortSignal: signal });
      return { handled: true, save(version) {
        writeProviderSession({ userId: session.user_id, chatId: session.chat_id,
          projectId: session.project_id, continuationId: session.continuation_id,
          compatibilityKey: session.compatibility_key, transcriptVersion: version,
          createdAt: session.created_at });
      } };
    },
  },
};

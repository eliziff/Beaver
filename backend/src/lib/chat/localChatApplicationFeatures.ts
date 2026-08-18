import type { ChatMessageRecord } from "../chatStore";
import type { ChatApplicationFeatures } from "./chatApplication";
import {
  appendLocalPdfPinpointLinks,
  providerPdfReferencesForTurn,
} from "./localPdfEvidenceState";
import { citationUrls } from "./citations";
import { readLocalPdfEvidenceReceipt } from "../localPdfLookup";
import {
  claimAnonymousCodexSession,
  deleteAnonymousProviderSessions,
  providerSessionCompatibilityKey,
  readAnonymousCodexSession,
  writeAnonymousCodexSession,
} from "../anonymousProviderSessionStore";
import { beaverCodexHome } from "../llm/codexAppServer";
import { compactCodexSession } from "../llm/codex";
import { providerForModel } from "../llm/models";
import { safeErrorLog } from "../safeError";

const EVENT = "local_pdf_evidence_handles";
const MAX = 20;
const HANDLE = /^mike-evidence:v1:[0-9a-f]{64}$/u;
const PROVIDER_REFERENCE =
  /^mike-provider-pdf:v1:(?:a2aj|courtlistener|govinfo|govuk-et|tna):[0-9a-f]{64}:[0-9a-f]{64}$/u;
type Item =
  | { handle: string; document_id: string; version_id: string }
  | { handle: string; source_reference: string };
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
const provider = (item: Item): item is Extract<Item, { source_reference: string }> =>
  "source_reference" in item;
const key = (item: Item) => provider(item)
  ? `${item.handle}\0${item.source_reference}` : item.handle;

function item(value: unknown): Item | null {
  const row = record(value), handle = String(row?.handle ?? "").trim();
  if (!HANDLE.test(handle)) return null;
  const source_reference = String(row?.source_reference ?? "").trim();
  if (PROVIDER_REFERENCE.test(source_reference)) return { handle, source_reference };
  const document_id = String(row?.document_id ?? "").trim();
  const version_id = String(row?.version_id ?? "").trim();
  return document_id && version_id ? { handle, document_id, version_id } : null;
}

function prior(messages: ChatMessageRecord[], allowed: ReadonlySet<string>) {
  const assistant = [...messages].reverse().find(({ role }) => role === "assistant");
  const event = Array.isArray(assistant?.content)
    ? [...assistant.content].reverse().map(record).find((row) =>
        row?.type === EVENT && row.schema_version === 1)
    : null;
  const seen = new Set<string>();
  return (Array.isArray(event?.handles) ? event.handles : [])
    .map(item)
    .filter((value): value is Item => {
      if (!value || seen.has(key(value)) ||
          (!provider(value) && !allowed.has(value.document_id))) return false;
      seen.add(key(value));
      return true;
    }).slice(0, MAX);
}

async function active(handles: ReadonlySet<string>, allowed: ReadonlySet<string>) {
  const groups = await Promise.all([...handles].filter((handle) => HANDLE.test(handle))
    .slice(-MAX).map(async (handle): Promise<Item[]> => {
      const references = providerPdfReferencesForTurn(handles, handle);
      if (references.length) return references.map((source_reference) => ({
        handle, source_reference,
      }));
      try {
        const { source } = await readLocalPdfEvidenceReceipt(handle);
        return allowed.has(source.document_id) ? [{
          handle, document_id: source.document_id, version_id: source.version_id,
        }] : [];
      } catch {
        return [];
      }
    }));
  return groups.flat();
}

function prompt(items: Item[]) {
  if (!items.length) return "";
  return `DURABLE LOCAL PDF EVIDENCE FROM PRIOR TURNS:\n${items.map((value) =>
    provider(value)
      ? `- provider handle=${JSON.stringify(value.handle)} reference_id=${JSON.stringify(value.source_reference)}`
      : `- library handle=${JSON.stringify(value.handle)} document_id=${JSON.stringify(value.document_id)} version_id=${JSON.stringify(value.version_id)}`,
  ).join("\n")}\nRehydrate exact prior material with Read on its resource and evidence handle only when the current request needs it. Do not expose opaque handles or resource references to the user.`;
}

export const localChatApplicationFeatures: ChatApplicationFeatures = {
  async load() {
    return { includeResearchTools: true };
  },
  evidence: {
    async prepare({ auth, messages, allowedDocumentIds }) {
      const previous = prior(messages, allowedDocumentIds);
      return {
        prompt: prompt(previous),
        transformText(text, citations, handles) {
          return appendLocalPdfPinpointLinks(
            text,
            auth.userId,
            handles,
            allowedDocumentIds,
            citationUrls(citations),
          );
        },
        async event(handles) {
          const seen = new Set<string>();
          const registry = [
            ...await active(handles, allowedDocumentIds),
            ...previous,
          ].filter((value) => {
            if (seen.has(key(value))) return false;
            seen.add(key(value)); return true;
          }).slice(0, MAX);
          return registry.length ? {
            type: EVENT, schema_version: 1, handles: registry,
          } : null;
        },
      };
    },
  },
  providerSession: {
    async claim(input) {
      if (input.provider !== "codex") {
        deleteAnonymousProviderSessions(input.chatId);
        return null;
      }
      const compatibilityKey = providerSessionCompatibilityKey({
        schema_version: 5,
        transport: "app-server-v2",
        model: input.model,
        reasoning_effort: input.reasoningEffort?.trim() || "max",
        service_tier: input.serviceTier?.trim().toLowerCase() || "default",
        scope: { user_id: input.auth.userId, project_id: input.projectId },
        auth: {
          command: process.env.CODEX_COMMAND?.trim() || "codex",
          codex_home: beaverCodexHome(),
          api_key_sha256: process.env.CODEX_API_KEY
            ? providerSessionCompatibilityKey(process.env.CODEX_API_KEY) : null,
        },
      });
      let continuationId: string | undefined;
      try {
        continuationId = claimAnonymousCodexSession({
          userId: input.auth.userId,
          chatId: input.chatId,
          projectId: input.projectId,
          compatibilityKey,
          transcriptVersion: input.expectedVersion,
        })?.continuation_id;
      } catch (error) {
        console.warn("[chat] provider continuation unavailable", safeErrorLog(error));
      }
      return {
        continuationId,
        promptCacheKey: providerSessionCompatibilityKey({
          schema_version: 1, provider: input.provider, chat_id: input.chatId,
        }),
        save(nextContinuationId, version) {
          if (!nextContinuationId) {
            deleteAnonymousProviderSessions(input.chatId);
            return;
          }
          writeAnonymousCodexSession({
            userId: input.auth.userId,
            chatId: input.chatId,
            projectId: input.projectId,
            continuationId: nextContinuationId,
            compatibilityKey,
            transcriptVersion: version,
          });
        },
      };
    },
    async compact({ auth, chatId, model, signal }) {
      const session = readAnonymousCodexSession(auth.userId, chatId);
      if (providerForModel(model) !== "codex" || !session) {
        return { handled: false, save: (_version: number) => undefined };
      }
      await compactCodexSession({
        continuationId: session.continuation_id,
        apiKey: process.env.CODEX_API_KEY,
        abortSignal: signal,
      });
      return {
        handled: true,
        save(version) {
          writeAnonymousCodexSession({
            userId: session.user_id,
            chatId: session.chat_id,
            projectId: session.project_id,
            continuationId: session.continuation_id,
            compatibilityKey: session.compatibility_key,
            transcriptVersion: version,
            createdAt: session.created_at,
          });
        },
      };
    },
  },
};

// Authoritative matter state: provenance-bearing, versioned, reversible.
// Pure module (no I/O). The event log is append-only durable history; the
// projection is the derived working view. See
// docs/beaver-evaluation-context-plan.md §11 (Issue 9).
//
// Deferred: deriveDeterministicUpdates(chatEvents) — mapping deterministic
// chat/tool events (doc_created, doc_edited, accepted edits) onto state
// events needs the chat event types that live in hot files; it lands with
// the route wiring, not here.

import { randomUUID } from "node:crypto";
import { z } from "zod";

const uuidSchema = z
  .string()
  .regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu);

export const MATTER_STATE_KINDS = [
  "instruction",
  "fact",
  "disputed_fact",
  "authority",
  "document_version",
  "accepted_edit",
  "open_question",
  "deadline",
  "privacy_flag",
] as const;

const provenanceSchema = z
  .object({
    originating_turn: z.string().min(1).max(200),
    source_id: z.string().max(500).nullable(),
    locator: z.string().max(500).nullable(),
    quote_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
  })
  .strict();

export const matterStateItemSchema = z
  .object({
    id: uuidSchema,
    kind: z.enum(MATTER_STATE_KINDS),
    /** Exact literal text — citations, pinpoints, quotations stay verbatim. */
    text: z.string().min(1).max(2000),
    data: z.record(z.string(), z.unknown()),
    status: z.enum(["active", "superseded", "retracted"]),
    provenance: provenanceSchema,
    superseded_by: uuidSchema.nullable(),
  })
  .strict();

export type MatterStateItem = z.infer<typeof matterStateItemSchema>;

const eventBase = {
  event_id: uuidSchema,
  turn: z.string().min(1).max(200),
  at: z.string().datetime(),
};

const addEventSchema = z
  .object({ ...eventBase, op: z.literal("add"), item: matterStateItemSchema })
  .strict();
const supersedeEventSchema = z
  .object({
    ...eventBase,
    op: z.literal("supersede"),
    target_id: uuidSchema,
    replacement: matterStateItemSchema,
  })
  .strict();
const retractEventSchema = z
  .object({
    ...eventBase,
    op: z.literal("retract"),
    target_id: uuidSchema,
    reason: z.string().min(1).max(2000),
  })
  .strict();
const revertEventSchema = z
  .object({
    ...eventBase,
    op: z.literal("revert"),
    target_event_id: uuidSchema,
  })
  .strict();

export const matterStateEventSchema = z.discriminatedUnion("op", [
  addEventSchema,
  supersedeEventSchema,
  retractEventSchema,
  revertEventSchema,
]);

export type MatterStateEvent = z.infer<typeof matterStateEventSchema>;

export const matterStateLogSchema = z
  .object({
    schema_version: z.literal(1),
    chat_id: uuidSchema,
    project_id: uuidSchema.nullable(),
    jurisdictions: z.array(z.string().min(1).max(50)),
    law_as_of: z.string().date().nullable(),
    events: z.array(matterStateEventSchema),
  })
  .strict();

export type MatterStateLog = z.infer<typeof matterStateLogSchema>;

export function createMatterStateLog(
  chatId: string,
  projectId: string | null = null,
): MatterStateLog {
  return matterStateLogSchema.parse({
    schema_version: 1,
    chat_id: chatId,
    project_id: projectId,
    jurisdictions: [],
    law_as_of: null,
    events: [],
  });
}

export type MatterStateProjection = {
  /** Items currently in force, in first-added order. */
  active: MatterStateItem[];
  /** Items no longer in force; `status` distinguishes superseded from retracted. */
  superseded: MatterStateItem[];
};

/**
 * Deterministic replay of the append-only log. A revert undoes the effect of
 * the referenced event, but the reverted event remains in the log as durable
 * history. Superseded items carry a `superseded_by` back-link; retracted
 * items stay retrievable with the retract reason in `data.retract_reason`.
 */
export function projectMatterState(log: MatterStateLog): MatterStateProjection {
  // An event is undone iff some *effective* revert targets it. Reverts only
  // target earlier events, so effectiveness resolves scanning last-to-first.
  const undone = new Set<string>();
  for (let i = log.events.length - 1; i >= 0; i -= 1) {
    const event = log.events[i];
    if (event.op === "revert" && !undone.has(event.event_id)) {
      undone.add(event.target_event_id);
    }
  }

  const items = new Map<string, MatterStateItem>();
  for (const event of log.events) {
    if (undone.has(event.event_id)) continue;
    if (event.op === "add") {
      items.set(event.item.id, {
        ...event.item,
        status: "active",
        superseded_by: null,
      });
    } else if (event.op === "supersede") {
      const target = items.get(event.target_id);
      if (target) {
        items.set(target.id, {
          ...target,
          status: "superseded",
          superseded_by: event.replacement.id,
        });
      }
      items.set(event.replacement.id, {
        ...event.replacement,
        status: "active",
        superseded_by: null,
      });
    } else if (event.op === "retract") {
      const target = items.get(event.target_id);
      if (target) {
        items.set(target.id, {
          ...target,
          status: "retracted",
          superseded_by: null,
          data: { ...target.data, retract_reason: event.reason },
        });
      }
    }
    // "revert" has no forward effect of its own.
  }

  const projection: MatterStateProjection = { active: [], superseded: [] };
  for (const item of items.values()) {
    (item.status === "active" ? projection.active : projection.superseded).push(
      item,
    );
  }
  return projection;
}

export type RejectedUpdate = { reason: string; raw: unknown };

export type ApplyProposedResult = {
  log: MatterStateLog;
  accepted: MatterStateEvent[];
  rejected: RejectedUpdate[];
};

// Model proposals get a forgiving envelope: the server mints event_id/at and
// stamps the real turn; item ids, data, status, and provenance fields are
// defaulted when omitted. The substantive payload is still schema-checked.
const proposedItemSchema = z
  .object({
    id: uuidSchema.optional(),
    kind: z.enum(MATTER_STATE_KINDS),
    text: z.string().min(1).max(2000),
    data: z.record(z.string(), z.unknown()).optional(),
    status: z.enum(["active", "superseded", "retracted"]).optional(),
    provenance: provenanceSchema.partial().optional(),
    superseded_by: uuidSchema.nullable().optional(),
  })
  .strict();

const proposedEventSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), item: proposedItemSchema }).strict(),
  z
    .object({
      op: z.literal("supersede"),
      target_id: uuidSchema,
      replacement: proposedItemSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("retract"),
      target_id: uuidSchema,
      reason: z.string().min(1).max(2000),
    })
    .strict(),
  z
    .object({ op: z.literal("revert"), target_event_id: uuidSchema })
    .strict(),
]);

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      issue.path.length > 0
        ? `${issue.path.join(".")}: ${issue.message}`
        : issue.message,
    )
    .join("; ");
}

function completeItem(
  proposed: z.infer<typeof proposedItemSchema>,
  turnId: string,
): MatterStateItem {
  return {
    id: proposed.id ?? randomUUID(),
    kind: proposed.kind,
    text: proposed.text,
    data: proposed.data ?? {},
    status: "active",
    provenance: {
      originating_turn: proposed.provenance?.originating_turn ?? turnId,
      source_id: proposed.provenance?.source_id ?? null,
      locator: proposed.provenance?.locator ?? null,
      quote_sha256: proposed.provenance?.quote_sha256 ?? null,
    },
    superseded_by: null,
  };
}

/**
 * Validate model-proposed state updates and append the acceptable ones.
 * Never throws: every malformed entry is rejected individually with an
 * actionable reason so a weak model can repair and retry, and one bad entry
 * never sinks its well-formed siblings. The input log is not mutated.
 */
export function applyProposedUpdates(
  log: MatterStateLog,
  turnId: string,
  proposed: unknown,
): ApplyProposedResult {
  const rejected: RejectedUpdate[] = [];
  const accepted: MatterStateEvent[] = [];

  if (!Array.isArray(proposed)) {
    return {
      log,
      accepted,
      rejected: [
        {
          reason:
            "proposed updates must be a JSON array of event objects " +
            '(e.g. [{"op":"add","item":{...}}])',
          raw: proposed,
        },
      ],
    };
  }

  const events = [...log.events];
  const knownItemIds = new Set<string>();
  const knownEventIds = new Set<string>();
  for (const event of log.events) {
    knownEventIds.add(event.event_id);
    if (event.op === "add") knownItemIds.add(event.item.id);
    if (event.op === "supersede") knownItemIds.add(event.replacement.id);
  }

  for (const raw of proposed) {
    const parsed = proposedEventSchema.safeParse(raw);
    if (!parsed.success) {
      rejected.push({ reason: describeIssues(parsed.error), raw });
      continue;
    }
    const update = parsed.data;
    if (
      (update.op === "supersede" || update.op === "retract") &&
      !knownItemIds.has(update.target_id)
    ) {
      rejected.push({
        reason: `target_id ${update.target_id} does not match any known state item`,
        raw,
      });
      continue;
    }
    if (update.op === "revert" && !knownEventIds.has(update.target_event_id)) {
      rejected.push({
        reason: `target_event_id ${update.target_event_id} does not match any logged event`,
        raw,
      });
      continue;
    }

    const envelope = {
      event_id: randomUUID(),
      turn: turnId,
      at: new Date().toISOString(),
    };
    const event: MatterStateEvent =
      update.op === "add"
        ? { ...envelope, op: "add", item: completeItem(update.item, turnId) }
        : update.op === "supersede"
          ? {
              ...envelope,
              op: "supersede",
              target_id: update.target_id,
              replacement: completeItem(update.replacement, turnId),
            }
          : update.op === "retract"
            ? {
                ...envelope,
                op: "retract",
                target_id: update.target_id,
                reason: update.reason,
              }
            : {
                ...envelope,
                op: "revert",
                target_event_id: update.target_event_id,
              };
    const checked = matterStateEventSchema.safeParse(event);
    if (!checked.success) {
      rejected.push({ reason: describeIssues(checked.error), raw });
      continue;
    }
    events.push(checked.data);
    knownEventIds.add(checked.data.event_id);
    if (checked.data.op === "add") knownItemIds.add(checked.data.item.id);
    if (checked.data.op === "supersede") {
      knownItemIds.add(checked.data.replacement.id);
    }
    accepted.push(checked.data);
  }

  return { log: { ...log, events }, accepted, rejected };
}

function supersededMarker(item: MatterStateItem): string {
  const disposition =
    item.status === "superseded"
      ? `superseded by ${item.superseded_by}`
      : "retracted";
  const text =
    item.text.length > 120 ? `${item.text.slice(0, 117)}...` : item.text;
  return `${item.id} [${item.kind}, ${disposition}] ${text}`;
}

/**
 * Compact fenced-JSON prompt block: active items in full (exact literals,
 * provenance intact), superseded/retracted items as one-line markers so the
 * model knows they existed and were displaced without paying their full cost.
 */
export function renderMatterStateBlock(
  projection: MatterStateProjection,
  meta?: { jurisdictions?: string[]; law_as_of?: string | null },
): string {
  const payload: Record<string, unknown> = {};
  if (meta?.jurisdictions?.length) payload.jurisdictions = meta.jurisdictions;
  if (meta?.law_as_of) payload.law_as_of = meta.law_as_of;
  payload.active = projection.active;
  payload.superseded = projection.superseded.map(supersededMarker);
  return [
    "AUTHORITATIVE MATTER STATE (versioned, provenance-bearing; controls over conflicting earlier conversation):",
    "```json",
    JSON.stringify(payload),
    "```",
  ].join("\n");
}

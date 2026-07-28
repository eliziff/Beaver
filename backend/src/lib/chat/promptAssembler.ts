// Bounded prompt assembly (Issue 9, docs/beaver-evaluation-context-plan.md
// §11). The full transcript is durable audit history, not automatically the
// model's working memory: each strategy decides which components reach the
// provider, and the AssemblyReport records what was included or excluded so
// traces stay inspectable.

import { buildMessages } from "./contextBuilders";
import { contextStrategy, type ContextStrategy } from "./contextStrategy";
import {
  projectMatterState,
  renderMatterStateBlock,
  type MatterStateProjection,
} from "./matterState";
import { loadMatterState } from "../matterStateStore";
import type { ChatMessage, DocIndex } from "./types";

/** Application-controlled working-context budget, not the provider maximum. */
export const ASSEMBLY_BUDGET_TOKENS = 32_000;
/** Matter-state slice of the budget (§11 suggests 2,000–4,000). */
export const MATTER_STATE_BUDGET_TOKENS = 4_000;

/** UTF-8 bytes / 4 — the experiments/context_compaction_track_a convention. */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

export type AssemblyComponentReport = {
  component: string;
  included: boolean;
  token_estimate: number;
  count: number;
};

export type AssemblyReport = {
  strategy: ContextStrategy;
  budget_tokens: number;
  components: AssemblyComponentReport[];
  over_budget: boolean;
  notes: string[];
};

export type AssembleArgs = {
  messages: ChatMessage[];
  docAvailability: { doc_id: string; filename: string; folder_path?: string }[];
  systemPromptExtra?: string;
  docIndex?: DocIndex;
  includeResearchTools?: boolean;
  chatId: string;
  userId: string;
};

type FormattedMessage = { role: string; content: unknown };

function estimateMessage(message: FormattedMessage): number {
  return typeof message.content === "string"
    ? estimateTokens(message.content)
    : 0;
}

export function assembleApiMessages(args: AssembleArgs): {
  messages: unknown[];
  report: AssemblyReport;
} {
  const strategy = contextStrategy();
  switch (strategy) {
    case "full_history":
      return assembleFullHistory(args, strategy, []);
    case "provider_native":
      // Stub: provider-native transport is Issue 12 territory. Full history
      // keeps behavior correct; the note keeps the trace honest.
      return assembleFullHistory(args, strategy, [
        "provider_native transport not implemented; assembled as full_history",
      ]);
    case "legal_state":
      return assembleBoundedTail(args, strategy, true, []);
    case "generic_summary":
      // Stub: no summarizer yet. Bounded tail without the state block keeps
      // the strategy runnable for ablation plumbing.
      return assembleBoundedTail(args, strategy, false, [
        "generic_summary summarizer not implemented; assembled as bounded tail without summary",
      ]);
  }
}

function assembleFullHistory(
  args: AssembleArgs,
  strategy: ContextStrategy,
  notes: string[],
): { messages: unknown[]; report: AssemblyReport } {
  // Literal delegation: full_history must stay byte-identical to the
  // pre-assembler pipeline (golden test enforces deep equality).
  const formatted = buildMessages(
    args.messages,
    args.docAvailability,
    args.systemPromptExtra,
    args.docIndex,
    args.includeResearchTools ?? true,
  ) as FormattedMessage[];

  const systemEstimate = estimateMessage(formatted[0]);
  const historyEstimate = formatted
    .slice(1)
    .reduce((sum, message) => sum + estimateMessage(message), 0);
  return {
    messages: formatted,
    report: {
      strategy,
      budget_tokens: ASSEMBLY_BUDGET_TOKENS,
      components: [
        {
          component: "system",
          included: true,
          token_estimate: systemEstimate,
          count: 1,
        },
        {
          component: "conversation",
          included: true,
          token_estimate: historyEstimate,
          count: formatted.length - 1,
        },
      ],
      over_budget: systemEstimate + historyEstimate > ASSEMBLY_BUDGET_TOKENS,
      notes,
    },
  };
}

function boundedStateBlock(
  projection: MatterStateProjection,
  meta: { jurisdictions?: string[]; law_as_of?: string | null },
  notes: string[],
): { block: string; overBudget: boolean } {
  const full = renderMatterStateBlock(projection, meta);
  if (estimateTokens(full) <= MATTER_STATE_BUDGET_TOKENS) {
    return { block: full, overBudget: false };
  }
  // Superseded markers are the compressible part; active legal state is
  // never silently dropped, even when it alone exceeds its budget slice.
  const activeOnly = renderMatterStateBlock(
    { active: projection.active, superseded: [] },
    meta,
  );
  notes.push("matter-state superseded markers dropped to fit state budget");
  if (estimateTokens(activeOnly) <= MATTER_STATE_BUDGET_TOKENS) {
    return { block: activeOnly, overBudget: false };
  }
  notes.push("active matter state exceeds state budget; included in full");
  return { block: activeOnly, overBudget: true };
}

function assembleBoundedTail(
  args: AssembleArgs,
  strategy: ContextStrategy,
  withMatterState: boolean,
  notes: string[],
): { messages: unknown[]; report: AssemblyReport } {
  let stateBlock: string | null = null;
  let stateOverBudget = false;
  let activeCount = 0;
  if (withMatterState) {
    const log = loadMatterState(args.chatId);
    const projection = log ? projectMatterState(log) : null;
    if (
      log &&
      projection &&
      (projection.active.length > 0 || projection.superseded.length > 0)
    ) {
      const bounded = boundedStateBlock(
        projection,
        { jurisdictions: log.jurisdictions, law_as_of: log.law_as_of },
        notes,
      );
      stateBlock = bounded.block;
      stateOverBudget = bounded.overBudget;
      activeCount = projection.active.length;
    }
  }

  const systemPromptExtra = [args.systemPromptExtra, stateBlock]
    .filter((part): part is string => !!part)
    .join("\n\n");
  const formatted = buildMessages(
    args.messages,
    args.docAvailability,
    systemPromptExtra || undefined,
    args.docIndex,
    args.includeResearchTools ?? true,
  ) as FormattedMessage[];
  const system = formatted[0];
  const tail = formatted.slice(1); // Aligned 1:1 with args.messages.

  // Group into whole turns: a turn starts at each user message; any leading
  // non-user messages join the first turn.
  const turns: number[][] = [];
  tail.forEach((message, index) => {
    if (message.role === "user" || turns.length === 0) turns.push([index]);
    else turns[turns.length - 1].push(index);
  });

  // The current user message and the last assistant message always survive.
  const required = new Set<number>();
  for (const roleNeeded of ["user", "assistant"]) {
    for (let i = tail.length - 1; i >= 0; i -= 1) {
      if (tail[i].role === roleNeeded) {
        required.add(turns.findIndex((turn) => turn.includes(i)));
        break;
      }
    }
  }

  const systemEstimate = estimateMessage(system);
  const turnEstimates = turns.map((turn) =>
    turn.reduce((sum, index) => sum + estimateMessage(tail[index]), 0),
  );
  const kept = new Set(turns.keys());
  let total = systemEstimate + turnEstimates.reduce((a, b) => a + b, 0);
  for (let i = 0; i < turns.length && total > ASSEMBLY_BUDGET_TOKENS; i += 1) {
    if (required.has(i)) continue;
    kept.delete(i);
    total -= turnEstimates[i];
  }

  const keptIndices = turns
    .filter((_, turnIndex) => kept.has(turnIndex))
    .flat();
  const droppedCount = tail.length - keptIndices.length;
  const droppedEstimate = turnEstimates.reduce(
    (sum, estimate, turnIndex) => (kept.has(turnIndex) ? sum : sum + estimate),
    0,
  );
  const tailEstimate = total - systemEstimate;
  const stateEstimate = stateBlock ? estimateTokens(stateBlock) : 0;

  const components: AssemblyComponentReport[] = [
    {
      component: "system",
      included: true,
      token_estimate: systemEstimate - stateEstimate,
      count: 1,
    },
    {
      component: "matter_state",
      included: stateBlock !== null,
      token_estimate: stateEstimate,
      count: activeCount,
    },
    {
      component: "conversation_tail",
      included: keptIndices.length > 0,
      token_estimate: tailEstimate,
      count: keptIndices.length,
    },
    {
      component: "dropped_turns",
      included: false,
      token_estimate: droppedEstimate,
      count: droppedCount,
    },
  ];

  return {
    messages: [system, ...keptIndices.map((index) => tail[index])],
    report: {
      strategy,
      budget_tokens: ASSEMBLY_BUDGET_TOKENS,
      components,
      over_budget: stateOverBudget || total > ASSEMBLY_BUDGET_TOKENS,
      notes,
    },
  };
}

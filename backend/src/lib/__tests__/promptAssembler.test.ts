import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyProposedUpdates,
  createMatterStateLog,
  type MatterStateLog,
} from "../chat/matterState";
import type { ChatMessage } from "../chat/types";

let dataHome: string;

beforeEach(async () => {
  dataHome = await mkdtemp(path.join(os.tmpdir(), "beaver-prompt-assembler-"));
  process.env.OPEN_LEGAL_DATA_HOME = dataHome;
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.OPEN_LEGAL_DATA_HOME;
  delete process.env.CONTEXT_STRATEGY;
  vi.restoreAllMocks();
  vi.resetModules();
  await rm(dataHome, { recursive: true, force: true });
});

async function loadAssembler() {
  return import("../chat/promptAssembler");
}

function proposals(count: number, textLength = 40): unknown[] {
  return Array.from({ length: count }, (_, index) => ({
    op: "add",
    item: {
      kind: "fact",
      text: `Fact ${index}: ${"x".repeat(textLength)}`,
    },
  }));
}

function stateLog(chatId: string, itemCount: number, textLength = 40) {
  const log: MatterStateLog = {
    ...createMatterStateLog(chatId),
    jurisdictions: ["CA-AB"],
    law_as_of: "2026-07-27",
  };
  const result = applyProposedUpdates(
    log,
    "TURN-1",
    proposals(itemCount, textLength),
  );
  expect(result.rejected).toEqual([]);
  return result.log;
}

function systemContent(messages: unknown[]): string {
  const first = messages[0] as { role: string; content: string };
  expect(first.role).toBe("system");
  return first.content;
}

const baseArgs = {
  docAvailability: [
    { doc_id: "doc-0", filename: "lease.pdf", folder_path: "Leases" },
  ],
  systemPromptExtra: "Answer in French.",
  docIndex: {
    "doc-0": { document_id: randomUUID(), filename: "lease.pdf" },
  },
  userId: randomUUID(),
};

const shortConversation: ChatMessage[] = [
  {
    role: "user",
    content: "Summarize the lease.",
    files: [{ filename: "lease.pdf" }],
  },
  { role: "assistant", content: "It is a five-year commercial lease." },
  { role: "user", content: "Who pays utilities?" },
];

describe("full_history strategy", () => {
  it("is byte-identical to buildMessages (golden delegation)", async () => {
    const { assembleApiMessages } = await loadAssembler();
    const { buildMessages } = await import("../chat/contextBuilders");
    const expected = buildMessages(
      shortConversation,
      baseArgs.docAvailability,
      baseArgs.systemPromptExtra,
      baseArgs.docIndex,
      true,
    );

    const { messages, report } = assembleApiMessages({
      ...baseArgs,
      messages: shortConversation,
      chatId: randomUUID(),
    });

    expect(messages).toEqual(expected);
    expect(JSON.stringify(messages)).toBe(JSON.stringify(expected));
    expect(report.strategy).toBe("full_history");
    expect(report.budget_tokens).toBe(32_000);
    expect(report.over_budget).toBe(false);
    expect(report.components).toMatchObject([
      { component: "system", included: true, count: 1 },
      { component: "conversation", included: true, count: 3 },
    ]);
  });

  it("falls back to full_history on an unknown flag, warning once", async () => {
    process.env.CONTEXT_STRATEGY = "clever_new_mode";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { assembleApiMessages } = await loadAssembler();

    for (let i = 0; i < 2; i += 1) {
      const { report } = assembleApiMessages({
        ...baseArgs,
        messages: shortConversation,
        chatId: randomUUID(),
      });
      expect(report.strategy).toBe("full_history");
    }
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("legal_state strategy", () => {
  it("bounds the tail to whole turns, keeping the current user and last assistant messages", async () => {
    process.env.CONTEXT_STRATEGY = "legal_state";
    const { assembleApiMessages } = await loadAssembler();
    const big = (label: string) => `${label} ${"x".repeat(60_000)}`;
    const messages: ChatMessage[] = [
      { role: "user", content: big("u1") },
      { role: "assistant", content: big("a1") },
      { role: "user", content: big("u2") },
      { role: "assistant", content: big("a2") },
      { role: "user", content: big("u3") },
      { role: "assistant", content: big("a3") },
      { role: "user", content: big("u4") },
      { role: "assistant", content: "a4 short answer" },
      { role: "user", content: "u5 current question" },
    ];

    const { messages: assembled, report } = assembleApiMessages({
      ...baseArgs,
      messages,
      chatId: randomUUID(),
    });

    const tail = assembled.slice(1) as { role: string; content: string }[];
    // Whole turns only: the kept tail starts at a user message.
    expect(tail[0].role).toBe("user");
    // Current user message and last assistant message survive.
    expect(tail.map((m) => m.content.slice(0, 2))).toEqual(["u4", "a4", "u5"]);
    expect(report.strategy).toBe("legal_state");
    expect(
      report.components.find((c) => c.component === "dropped_turns"),
    ).toMatchObject({ included: false, count: 6 });
    expect(
      report.components.find((c) => c.component === "conversation_tail"),
    ).toMatchObject({ included: true, count: 3 });
    // u4 alone is ~15k estimated tokens; the kept set fits the 32k budget.
    expect(report.over_budget).toBe(false);
  });

  it("keeps the required turns even when they alone exceed the budget", async () => {
    process.env.CONTEXT_STRATEGY = "legal_state";
    const { assembleApiMessages } = await loadAssembler();
    const big = (label: string) => `${label} ${"x".repeat(80_000)}`;
    const messages: ChatMessage[] = [
      { role: "user", content: big("u1") },
      { role: "assistant", content: big("a1") },
      { role: "user", content: big("u2") },
    ];

    const { messages: assembled, report } = assembleApiMessages({
      ...baseArgs,
      messages,
      chatId: randomUUID(),
    });
    const tail = assembled.slice(1) as { role: string; content: string }[];
    expect(tail.map((m) => m.content.slice(0, 2))).toEqual(["u1", "a1", "u2"]);
    expect(report.over_budget).toBe(true);
  });

  it("injects the durable matter state block into the system message", async () => {
    process.env.CONTEXT_STRATEGY = "legal_state";
    const chatId = randomUUID();
    const store = await import("../matterStateStore");
    const log = applyProposedUpdates(
      {
        ...createMatterStateLog(chatId),
        jurisdictions: ["CA-AB"],
        law_as_of: "2026-07-27",
      },
      "TURN-1",
      [
        {
          op: "add",
          item: {
            kind: "authority",
            text: "Smith v Jones, 2020 ABCA 1 at para 42.",
          },
        },
      ],
    ).log;
    store.saveMatterState(log);

    const { assembleApiMessages } = await loadAssembler();
    const { messages, report } = assembleApiMessages({
      ...baseArgs,
      messages: shortConversation,
      chatId,
    });

    const system = systemContent(messages);
    expect(system).toContain("AUTHORITATIVE MATTER STATE");
    expect(system).toContain("Smith v Jones, 2020 ABCA 1 at para 42.");
    expect(system).toContain("CA-AB");
    expect(system).toContain("Answer in French.");
    expect(
      report.components.find((c) => c.component === "matter_state"),
    ).toMatchObject({ included: true, count: 1 });
    expect(report.over_budget).toBe(false);
  });

  it("never silently drops active state: over-cap state is included and flagged", async () => {
    process.env.CONTEXT_STRATEGY = "legal_state";
    const chatId = randomUUID();
    const store = await import("../matterStateStore");
    store.saveMatterState(stateLog(chatId, 15, 1_990));

    const { assembleApiMessages } = await loadAssembler();
    const { messages, report } = assembleApiMessages({
      ...baseArgs,
      messages: shortConversation,
      chatId,
    });

    const system = systemContent(messages);
    expect(system).toContain("AUTHORITATIVE MATTER STATE");
    expect(system).toContain("Fact 14:");
    expect(report.over_budget).toBe(true);
    expect(
      report.notes.some((note) => note.includes("exceeds state budget")),
    ).toBe(true);
  });
});

describe("stubbed strategies", () => {
  it("generic_summary assembles a bounded tail without a state block and says so", async () => {
    process.env.CONTEXT_STRATEGY = "generic_summary";
    const chatId = randomUUID();
    const store = await import("../matterStateStore");
    store.saveMatterState(stateLog(chatId, 1));

    const { assembleApiMessages } = await loadAssembler();
    const { messages, report } = assembleApiMessages({
      ...baseArgs,
      messages: shortConversation,
      chatId,
    });

    expect(systemContent(messages)).not.toContain("AUTHORITATIVE MATTER STATE");
    expect(report.strategy).toBe("generic_summary");
    expect(report.notes.some((note) => note.includes("summarizer"))).toBe(true);
  });

  it("provider_native assembles as full_history with a note", async () => {
    process.env.CONTEXT_STRATEGY = "provider_native";
    const { assembleApiMessages } = await loadAssembler();
    const { buildMessages } = await import("../chat/contextBuilders");
    const { messages, report } = assembleApiMessages({
      ...baseArgs,
      messages: shortConversation,
      chatId: randomUUID(),
    });

    expect(messages).toEqual(
      buildMessages(
        shortConversation,
        baseArgs.docAvailability,
        baseArgs.systemPromptExtra,
        baseArgs.docIndex,
        true,
      ),
    );
    expect(report.strategy).toBe("provider_native");
    expect(report.notes.some((note) => note.includes("provider_native"))).toBe(
      true,
    );
  });
});

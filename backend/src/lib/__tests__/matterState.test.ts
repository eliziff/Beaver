import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  applyProposedUpdates,
  createMatterStateLog,
  matterStateLogSchema,
  projectMatterState,
  renderMatterStateBlock,
  type MatterStateLog,
} from "../chat/matterState";

const chatId = "00000000-0000-0000-0000-0000000000aa";

function logWith(proposals: unknown[], turn = "TURN-1") {
  const result = applyProposedUpdates(
    createMatterStateLog(chatId),
    turn,
    proposals,
  );
  expect(result.rejected).toEqual([]);
  return result;
}

describe("matter state projection", () => {
  it("supersession keeps the old item retrievable and back-linked", () => {
    const first = logWith([
      {
        op: "add",
        item: {
          kind: "fact",
          text: "The agreement was signed on 2024-03-01.",
          provenance: { source_id: "DOC-004", locator: "page 7" },
        },
      },
    ]);
    const factId =
      first.accepted[0].op === "add" ? first.accepted[0].item.id : "";
    const second = applyProposedUpdates(first.log, "TURN-2", [
      {
        op: "supersede",
        target_id: factId,
        replacement: {
          kind: "fact",
          text: "The agreement was signed on 2024-03-05.",
        },
      },
    ]);
    expect(second.rejected).toEqual([]);

    const projection = projectMatterState(second.log);
    expect(projection.active).toHaveLength(1);
    expect(projection.active[0].text).toBe(
      "The agreement was signed on 2024-03-05.",
    );
    expect(projection.superseded).toHaveLength(1);
    const old = projection.superseded[0];
    expect(old.id).toBe(factId);
    expect(old.status).toBe("superseded");
    expect(old.superseded_by).toBe(projection.active[0].id);
    // The displaced item keeps its exact literal text and provenance.
    expect(old.text).toBe("The agreement was signed on 2024-03-01.");
    expect(old.provenance).toMatchObject({
      source_id: "DOC-004",
      locator: "page 7",
      originating_turn: "TURN-1",
    });
  });

  it("distinguishes retraction from supersession", () => {
    const added = logWith([
      { op: "add", item: { kind: "instruction", text: "Use UK spelling." } },
    ]);
    const id = added.accepted[0].op === "add" ? added.accepted[0].item.id : "";
    const retracted = applyProposedUpdates(added.log, "TURN-2", [
      { op: "retract", target_id: id, reason: "Client withdrew instruction." },
    ]);
    expect(retracted.rejected).toEqual([]);

    const projection = projectMatterState(retracted.log);
    expect(projection.active).toEqual([]);
    expect(projection.superseded[0]).toMatchObject({
      id,
      status: "retracted",
      superseded_by: null,
      data: { retract_reason: "Client withdrew instruction." },
    });
  });

  it("revert restores the prior projection while the reverted event stays logged", () => {
    const added = logWith([
      { op: "add", item: { kind: "deadline", text: "File reply by 2026-08-14." } },
    ]);
    const before = projectMatterState(added.log);
    const id = added.accepted[0].op === "add" ? added.accepted[0].item.id : "";

    const retracted = applyProposedUpdates(added.log, "TURN-2", [
      { op: "retract", target_id: id, reason: "Thought moot." },
    ]);
    const retractEventId = retracted.accepted[0].event_id;
    expect(projectMatterState(retracted.log).active).toEqual([]);

    const reverted = applyProposedUpdates(retracted.log, "TURN-3", [
      { op: "revert", target_event_id: retractEventId },
    ]);
    expect(reverted.rejected).toEqual([]);
    expect(projectMatterState(reverted.log)).toEqual(before);
    // Append-only: the undone retract remains durable history.
    expect(reverted.log.events).toHaveLength(3);
    expect(reverted.log.events[1].op).toBe("retract");
  });

  it("replays deterministically, including across a JSON round-trip", () => {
    const built = logWith([
      { op: "add", item: { kind: "authority", text: "Smith v Jones, 2020 ABCA 1 at para 42." } },
      { op: "add", item: { kind: "open_question", text: "Does the limitation period run from discovery?" } },
    ]);
    const roundTripped = matterStateLogSchema.parse(
      JSON.parse(JSON.stringify(built.log)),
    ) as MatterStateLog;
    expect(projectMatterState(built.log)).toEqual(
      projectMatterState(built.log),
    );
    expect(projectMatterState(roundTripped)).toEqual(
      projectMatterState(built.log),
    );
  });
});

describe("applyProposedUpdates", () => {
  it("rejects each malformed entry with a reason, never throws, and keeps the good ones", () => {
    const log = createMatterStateLog(chatId);
    const proposals = [
      { op: "add", item: { kind: "fact", text: "Valid fact." } },
      { op: "add", item: { kind: "vibe", text: "Unknown kind." } },
      { op: "add", item: { kind: "fact", text: "x".repeat(2001) } },
      { op: "add", item: { kind: "fact", text: "ok", bogus: true } },
      {
        op: "supersede",
        target_id: randomUUID(),
        replacement: { kind: "fact", text: "Orphan replacement." },
      },
      { op: "revert", target_event_id: randomUUID() },
      "not an object",
    ];
    const result = applyProposedUpdates(log, "TURN-1", proposals);

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(6);
    for (const rejection of result.rejected) {
      expect(rejection.reason.length).toBeGreaterThan(0);
      expect(rejection).toHaveProperty("raw");
    }
    expect(result.log.events).toHaveLength(1);
    // Input log is not mutated.
    expect(log.events).toHaveLength(0);
    // Server stamps attribution regardless of what the model claims.
    expect(result.log.events[0]).toMatchObject({ turn: "TURN-1" });
  });

  it("rejects a non-array proposal wholesale with an actionable reason", () => {
    const log = createMatterStateLog(chatId);
    const result = applyProposedUpdates(log, "TURN-1", { op: "add" });
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain("array");
    expect(result.log.events).toEqual([]);
  });
});

describe("renderMatterStateBlock", () => {
  it("emits active items in full and superseded items as one-line markers", () => {
    const first = logWith([
      { op: "add", item: { kind: "authority", text: "Old authority, 2001 SCC 1." } },
    ]);
    const oldId =
      first.accepted[0].op === "add" ? first.accepted[0].item.id : "";
    const second = applyProposedUpdates(first.log, "TURN-2", [
      {
        op: "supersede",
        target_id: oldId,
        replacement: { kind: "authority", text: "New authority, 2024 SCC 9 at para 12." },
      },
    ]);
    const block = renderMatterStateBlock(projectMatterState(second.log), {
      jurisdictions: ["CA-AB"],
      law_as_of: "2026-07-27",
    });

    const fenced = /```json\n(.*)\n```/su.exec(block);
    expect(fenced).not.toBeNull();
    const payload = JSON.parse(fenced![1]) as {
      jurisdictions: string[];
      law_as_of: string;
      active: { text: string; provenance: unknown }[];
      superseded: string[];
    };
    expect(payload.jurisdictions).toEqual(["CA-AB"]);
    expect(payload.law_as_of).toBe("2026-07-27");
    expect(payload.active).toHaveLength(1);
    expect(payload.active[0].text).toBe("New authority, 2024 SCC 9 at para 12.");
    expect(payload.active[0].provenance).toBeTruthy();
    expect(payload.superseded).toHaveLength(1);
    expect(payload.superseded[0]).toContain(oldId);
    expect(payload.superseded[0]).toContain("superseded by");
    // Active items come before superseded markers in the rendered block.
    expect(block.indexOf("2024 SCC 9")).toBeLessThan(
      block.indexOf("2001 SCC 1"),
    );
  });
});

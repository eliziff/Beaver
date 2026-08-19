import { describe, expect, it } from "vitest";
import {
  READ_SUBAGENT_TOOL_NAME,
  RESUME_SUBAGENT_TOOL_NAME,
  allowedReadSubagentRegions,
  createReadSubagentAdmission,
  getReadSubagentCapability,
  readSubagentAssignment,
  resumableReadSubagents,
  runReadSubagentRound,
  type ReadSubagentCheckpoint,
} from "./readSubagents";
import type { NormalizedToolCall, NormalizedToolResult } from "../llm";

const assignment = (
  id: string,
  scope: string,
  jurisdiction: "CA" | "US" | "UK" = "CA",
): NormalizedToolCall => ({
  id,
  name: READ_SUBAGENT_TOOL_NAME,
  input: { task: `Read ${scope}`, scope, jurisdiction },
});
const result = (call: NormalizedToolCall): NormalizedToolResult => ({
  tool_use_id: call.id,
  status: "ok",
  content: JSON.stringify({ scope: call.input.scope }),
});

describe("reader boundary", () => {
  it("advertises only a configured catalog model and reasoning level", async () => {
    const catalog = {
      models: [{
        slug: "reader",
        displayName: "Reader",
        supportedReasoningLevels: [{ effort: "high", description: "" }],
      }],
    };
    await expect(getReadSubagentCapability(catalog, {
      model: "reader", effort: "high",
    })).resolves.toMatchObject({ available: true, displayName: "Reader" });
    await expect(getReadSubagentCapability(catalog, {
      model: "reader", effort: "low",
    })).resolves.toMatchObject({ available: false });
  });

  it("defaults to Canada and admits only distinct assignments in selected regions", () => {
    expect([...allowedReadSubagentRegions(null, "ordinary request")]).toEqual(["CA"]);
    expect([...allowedReadSubagentRegions(null, "Compare Canada and United States law")])
      .toEqual(["CA", "US"]);
    const admit = createReadSubagentAdmission(4, new Set(["CA"]));
    expect(admit([assignment("a", "SCC"), assignment("b", "Ontario")]))
      .toMatchObject({ accepted: [{ id: "a" }, { id: "b" }], rejected: [] });
    expect(admit([assignment("duplicate", "SCC")]).rejected).toHaveLength(1);
    expect(admit([assignment("foreign", "Ninth Circuit", "US")]).rejected)
      .toHaveLength(1);
  });

  it("normalizes assignment bounds without accepting a named foreign mismatch", () => {
    expect(readSubagentAssignment(assignment("a", "Ontario"))).toEqual({
      task: "Read Ontario", scope: "Ontario", jurisdiction: "CA",
    });
    const admit = createReadSubagentAdmission(4, new Set(["CA", "US"]));
    expect(admit([{
      ...assignment("bad", "United States cases"),
      input: { task: "Read US law", scope: "United States cases", jurisdiction: "CA" },
    }]).rejected).toHaveLength(1);
  });

  it("runs a two-to-four reader round concurrently and returns one parent result", async () => {
    const parent: NormalizedToolCall = {
      id: "round", name: READ_SUBAGENT_TOOL_NAME,
      input: { assignments: [assignment("x", "SCC").input, assignment("y", "Ontario").input] },
    };
    const seen: string[] = [];
    const combined = await runReadSubagentRound({
      call: parent,
      admit: createReadSubagentAdmission(),
      async runReader(call) {
        seen.push(String(call.input.scope));
        return result(call);
      },
    });
    expect(seen.sort()).toEqual(["Ontario", "SCC"]);
    expect(combined).toMatchObject({ tool_use_id: "round", status: "ok" });
    expect(JSON.parse(combined.content).readers).toHaveLength(2);
  });

  it("resumes only the exact interrupted IDs and their stored assignments", async () => {
    const saved: ReadSubagentCheckpoint = {
      id: "reader-1",
      continuation_id: "session-1",
      model: "reader",
      effort: "high",
      assignment: {
        task: "Read SCC authorities", scope: "SCC", jurisdiction: "CA",
      },
      evidence: [],
    };
    const events = [{
      type: "subagent_run", id: saved.id, status: "interrupted", resume: saved,
    }];
    expect(resumableReadSubagents(events).get(saved.id)).toEqual(saved);
    const resumed: string[] = [];
    const output = await runReadSubagentRound({
      call: { id: "resume", name: RESUME_SUBAGENT_TOOL_NAME, input: { ids: [saved.id] } },
      admit: createReadSubagentAdmission(),
      resumable: resumableReadSubagents(events),
      async runReader(call, checkpoint) {
        resumed.push(checkpoint!.continuation_id);
        return result(call);
      },
    });
    expect(resumed).toEqual(["session-1"]);
    expect(output.status).toBe("ok");
    const rejected = await runReadSubagentRound({
      call: { id: "resume", name: RESUME_SUBAGENT_TOOL_NAME, input: { ids: ["unknown"] } },
      admit: createReadSubagentAdmission(),
      resumable: resumableReadSubagents(events),
      runReader: async (call) => result(call),
    });
    expect(rejected.status).toBe("error");
  });
});

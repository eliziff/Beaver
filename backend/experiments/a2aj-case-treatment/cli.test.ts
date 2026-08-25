import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { applyJsonPatch, embedSchemaInPrompt, parseJson, runCheckpointedStage } from "./cli";

describe("case-treatment model output parsing", () => {
  it("parses plain JSON directly", () => {
    expect(parseJson("{\"answer\":42}")).toEqual({ answer: 42 });
  });

  it("salvages fenced or prose-wrapped JSON without altering the raw ledger", () => {
    const fenced = "```json\n{\"answer\":42}\n```";
    expect(parseJson(fenced)).toEqual({ answer: 42 });
    const wrapped = "Here is the result:\n{\"answer\":42,\"note\":\"braces } inside text\"}\nThanks!";
    expect(parseJson(wrapped)).toEqual({ answer: 42, note: "braces } inside text" });
    expect(parseJson("[{\"op\":\"replace\",\"path\":\"/answer\",\"value\":42}]")).toBeInstanceOf(Array);
  });

  it("returns null for unparseable output instead of guessing", () => {
    expect(parseJson("")).toBeNull();
    expect(parseJson("no json here")).toBeNull();
    expect(parseJson("{\"answer\":")).toBeNull();
  });
});

describe("stateless schema delivery", () => {
  it("embeds the schema in the prompt for schema-blind gateways", () => {
    const embedded = embedSchemaInPrompt("Do the task. Return only JSON matching the supplied schema.", {
      type: "object",
      properties: { answer: { type: "number" } },
    });
    expect(embedded).toContain("[OUTPUT JSON SCHEMA]");
    expect(embedded).toContain("\"answer\"");
    expect(embedded.indexOf("Do the task.")).toBe(0);
  });
});

describe("JSON Patch corrections", () => {
  it("accepts an RFC 6902 root-pointer replacement", () => {
    const patched = applyJsonPatch({ answer: 41 }, [{ op: "replace", path: "", value: { answer: 42 } }]);
    expect(patched.errors).toEqual([]);
    expect(patched.value).toEqual({ answer: 42 });
    const removed = applyJsonPatch({ answer: 41 }, [{ op: "remove", path: "" }]);
    expect(removed.errors).toEqual(["correction: operation 1 cannot remove the root document"]);
  });

  it("resends the complete original prompt when a stateless response is unparseable", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "a2aj-treatment-stateless-"));
    const prompts: string[] = [];
    try {
      const result = await runCheckpointedStage({
        prompt: "Analyze the complete decision and return JSON.",
        schema: { type: "object" },
        compile: (value) => ({ ok: true, errors: [], value: value as { answer: number }, grounding: [] }),
        max_corrections: 1,
        stateless_corrections: true,
        model_call: async (prompt) => {
          prompts.push(prompt);
          return prompts.length === 1
            ? { call_id: "empty", raw: "", parsed: null, error: null, continuation_id: null, elapsed_seconds: 1, usage: null, output_sha256: "empty" }
            : { call_id: "good", raw: "{\"answer\":42}", parsed: { answer: 42 }, error: null, continuation_id: null, elapsed_seconds: 1, usage: null, output_sha256: "hash" };
        },
        checkpoint_file: path.join(directory, "stage.json"),
      });
      expect(result.value).toEqual({ answer: 42 });
      expect(prompts[1]).toBe("Analyze the complete decision and return JSON.");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("case-treatment stage checkpoints", () => {
  it("reuses an accepted stage without another model call", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "a2aj-treatment-checkpoint-"));
    let calls = 0;
    const args = {
      prompt: "prompt",
      schema: { type: "object" },
      compile: (value: unknown) => ({ ok: true, errors: [], value: value as { answer: number }, grounding: [] }),
      max_corrections: 0,
      stateless_corrections: false,
      model_call: async () => {
        calls += 1;
        return {
          call_id: "call-1", raw: "{\"answer\":42}", parsed: { answer: 42 }, error: null,
          continuation_id: null, elapsed_seconds: 1, usage: null, output_sha256: "hash",
        };
      },
      checkpoint_file: path.join(directory, "stage.json"),
    };
    try {
      expect((await runCheckpointedStage(args)).value).toEqual({ answer: 42 });
      const resumed = await runCheckpointedStage({ ...args, model_call: async () => { throw new Error("should not run"); } });
      expect(resumed.value).toEqual({ answer: 42 });
      expect(resumed.attempts).toMatchObject([{ checkpoint_reused: true }]);
      expect(calls).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retries the same stage after a provider startup failure", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "a2aj-treatment-retry-"));
    let calls = 0;
    try {
      const result = await runCheckpointedStage({
        prompt: "unchanged prompt",
        schema: { type: "object" },
        compile: (value: unknown) => ({ ok: true, errors: [], value: value as { answer: number }, grounding: [] }),
        max_corrections: 1,
        stateless_corrections: false,
        model_call: async (prompt) => {
          calls += 1;
          expect(prompt).toBe("unchanged prompt");
          return calls === 1
            ? { call_id: "failed", raw: "", parsed: null, error: "startup failed", continuation_id: null, elapsed_seconds: 1, usage: null, output_sha256: "empty" }
            : { call_id: "landed", raw: "{\"answer\":42}", parsed: { answer: 42 }, error: null, continuation_id: null, elapsed_seconds: 1, usage: null, output_sha256: "hash" };
        },
        checkpoint_file: path.join(directory, "stage.json"),
      });
      expect(result.value).toEqual({ answer: 42 });
      expect(calls).toBe(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("applies a targeted correction without requesting the complete object again", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "a2aj-treatment-patch-"));
    const calls: Array<{ prompt: string; schema: unknown }> = [];
    try {
      const result = await runCheckpointedStage({
        prompt: "Return the answer.",
        schema: { type: "object" },
        compile: (value: unknown) => {
          const answer = (value as { answer?: unknown })?.answer;
          return { ok: answer === 42, errors: answer === 42 ? [] : ["answer: must be 42"], value: value as { answer: number }, grounding: [] };
        },
        max_corrections: 1,
        stateless_corrections: false,
        model_call: async (prompt, _continuation, _attempt, schema) => {
          calls.push({ prompt, schema });
          return calls.length === 1
            ? { call_id: "draft", raw: "{\"answer\":41}", parsed: { answer: 41 }, error: null, continuation_id: "thread", elapsed_seconds: 1, usage: null, output_sha256: "draft" }
            : { call_id: "patch", raw: "[{\"op\":\"replace\",\"path\":\"/answer\",\"value\":42}]", parsed: [{ op: "replace", path: "/answer", value: 42 }], error: null, continuation_id: "thread", elapsed_seconds: 1, usage: null, output_sha256: "patch" };
        },
        checkpoint_file: path.join(directory, "stage.json"),
      });
      expect(result.value).toEqual({ answer: 42 });
      expect(calls[1].schema).toBeUndefined();
      expect(calls[1].prompt).toContain("RFC 6902 JSON Patch");
      expect(calls[1].prompt).not.toContain('{"answer":41}');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

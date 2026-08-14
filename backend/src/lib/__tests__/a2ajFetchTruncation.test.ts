import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearA2AJCache } from "../a2aj";
import { A2AJ_TOOL_NAMES } from "../chat/tools/a2ajTools";
import { runToolCalls } from "../chat/tools/toolDispatcher";
import type { DocStore } from "../chat/types";

beforeEach(() => {
  // This suite probes provider truncation, not the machine's local corpus.
  vi.stubEnv(
    "MIKE_A2AJ_BULK_DB",
    path.join(os.tmpdir(), `beaver-a2aj-fetch-test-${crypto.randomUUID()}.sqlite`),
  );
});

afterEach(() => {
  clearA2AJCache();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function stubA2AJText(text: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          {
            dataset: "LEGISLATION-FED",
            citation_en: "RSC 1985, c C-46",
            name_en: "Criminal Code",
            source_url_en: "https://laws-lois.justice.gc.ca/eng/XML/C-46.xml",
            unofficial_text_en: text,
          },
        ],
      }),
    }),
  );
}

async function fetchToolResult(text: string) {
  stubA2AJText(text);
  const toolCall = {
    id: "call-1",
    name: A2AJ_TOOL_NAMES.fetch,
    input: {
      citation: "RSC 1985, c C-46",
      doc_type: "laws",
    },
  };
  const { toolResults } = await runToolCalls(
    [toolCall],
    {
      docStore: new Map() as DocStore,
      userId: "user-1",
      db: null as never,
      emit: () => undefined,
    },
  );
  return JSON.parse(toolResults[0].content) as Record<string, unknown>;
}

describe("a2aj_fetch truncation signalling", () => {
  it("tells the model when the document was cut and how long it really is", async () => {
    const payload = await fetchToolResult("c".repeat(60_000));

    expect(payload.ok).toBe(true);
    expect(payload.truncated).toBe(true);
    expect(payload.total_chars).toBe(60_000);
    expect(String(payload.text)).toHaveLength(50_000);
    expect(String(payload.next_required_action)).toContain(
      "Truncated: 50000 of 60000 characters shown.",
    );
  });

  it("stays silent when the whole document fits", async () => {
    const payload = await fetchToolResult("c".repeat(1_200));

    expect(payload.truncated).toBe(false);
    expect(payload.total_chars).toBe(1_200);
    expect(payload.next_required_action).toBeUndefined();
  });
});

import { expect, it, vi } from "vitest";
import { toolText, type BeaverTool } from "../../src/lib/chat/toolRegistry";
import { traceChatTools } from "./index";

it("keeps opt-in tool tracing executable outside production", async () => {
  vi.stubEnv("MIKE_BENCHMARK_TRACE_TOOLS", "1");
  const emit = vi.fn();
  const tools = traceChatTools<undefined>([{
    name: "probe",
    inputSchema: { type: "object", additionalProperties: false },
    async execute() {
      return { result: toolText({ ok: true }) };
    },
  } satisfies BeaverTool<undefined>], emit);

  await tools[0].execute(
    {},
    undefined,
    new AbortController().signal,
    { id: "call-1", name: "probe", input: {} },
  );

  expect(emit).toHaveBeenCalledWith(expect.objectContaining({
    type: "tool_call_result",
    id: "call-1",
    name: "probe",
    ok: true,
  }));
  vi.unstubAllEnvs();
});

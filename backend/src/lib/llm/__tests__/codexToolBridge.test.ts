import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startCodexToolBridge, type CodexToolBridge } from "../codexToolBridge";

const bridges: CodexToolBridge[] = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
});

describe("Codex tool bridge scheduling", () => {
  it("runs reading agents together while keeping ordinary tools serialized", async () => {
    const gates: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    const bridge = await startCodexToolBridge({
      tools: ["delegate_read", "inspect"].map((name) => ({
        type: "function" as const,
        function: {
          name,
          parameters: { type: "object", properties: {} },
        },
      })),
      runTools: async (calls) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => gates.push(resolve));
        active -= 1;
        return calls.map((call) => ({
          tool_use_id: call.id,
          status: "ok" as const,
          content: "done",
        }));
      },
    });
    bridges.push(bridge);
    const transport = new StreamableHTTPClientTransport(new URL(bridge.url), {
      requestInit: {
        headers: { Authorization: `Bearer ${bridge.token}` },
      },
    });
    const client = new Client({ name: "beaver-test", version: "1.0.0" });
    await client.connect(transport);

    const readers = [
      client.callTool({ name: "delegate_read", arguments: {} }),
      client.callTool({ name: "delegate_read", arguments: {} }),
    ];
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    expect(maxActive).toBe(2);
    gates.splice(0).forEach((release) => release());
    await Promise.all(readers);

    maxActive = 0;
    const ordinary = [
      client.callTool({ name: "inspect", arguments: {} }),
      client.callTool({ name: "inspect", arguments: {} }),
    ];
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    gates.shift()?.();
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    expect(maxActive).toBe(1);
    gates.shift()?.();
    await Promise.all(ordinary);
    await transport.close();
  });
});

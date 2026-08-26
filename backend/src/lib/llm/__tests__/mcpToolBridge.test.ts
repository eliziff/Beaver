import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startMcpToolBridge, type McpToolBridge } from "../mcpToolBridge";

const bridges: McpToolBridge[] = [];
const tool = (name: string): Tool => ({
  name,
  inputSchema: { type: "object", properties: {} },
});

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
});

async function clientFor(bridge: McpToolBridge) {
  const transport = new StreamableHTTPClientTransport(new URL(bridge.url), {
    requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } },
  });
  const client = new Client({ name: "beaver-test", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

describe("MCP tool bridge", () => {
  it("refreshes its catalog after exact loading", async () => {
    let tools = [tool("load_tools")];
    const bridge = await startMcpToolBridge({
      tools,
      resolveTools: () => tools,
      runTools: async (calls) => {
        tools = [tool("load_tools"), tool("transform_docx")];
        return calls.map((call) => ({
          tool_use_id: call.id,
          status: "ok" as const,
          content: "done",
        }));
      },
    });
    bridges.push(bridge);
    const { client, transport } = await clientFor(bridge);

    expect((await client.listTools()).tools.map(({ name }) => name)).toEqual([
      "load_tools",
    ]);
    await client.callTool({
      name: "load_tools",
      arguments: { names: ["transform_docx"] },
    });
    expect((await client.listTools()).tools.map(({ name }) => name)).toEqual([
      "load_tools",
      "transform_docx",
    ]);
    expect(bridge.stats()).toMatchObject({
      toolCallCount: 1,
      toolResultBytes: 4,
    });
    await transport.close();
  });

  it("serializes concurrent provider calls", async () => {
    const gates: Array<() => void> = [];
    const batches: string[][] = [];
    let active = 0;
    let maxActive = 0;
    const bridge = await startMcpToolBridge({
      tools: [tool("delegate_read"), tool("inspect")],
      runTools: async (calls) => {
        batches.push(calls.map(({ name }) => name));
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
    const { client, transport } = await clientFor(bridge);

    const calls = [
      client.callTool({ name: "delegate_read", arguments: {} }),
      client.callTool({ name: "inspect", arguments: {} }),
    ];
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    expect(batches).toEqual([["delegate_read"]]);
    gates.shift()?.();
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    expect(maxActive).toBe(1);
    gates.shift()?.();
    await Promise.all(calls);
    expect(bridge.stats().toolCallCount).toBe(2);
    await transport.close();
  });

  it("lets a long-running tool refresh the provider inactivity watchdog", async () => {
    const activity = vi.fn();
    const bridge = await startMcpToolBridge({
      tools: [tool("delegate_read")],
      onActivity: activity,
      runTools: async (calls, onActivity) => {
        onActivity?.();
        return calls.map((call) => ({
          tool_use_id: call.id,
          status: "ok" as const,
          content: "done",
        }));
      },
    });
    bridges.push(bridge);
    const { client, transport } = await clientFor(bridge);

    await client.callTool({ name: "delegate_read", arguments: {} });
    expect(activity).toHaveBeenCalledOnce();
    await transport.close();
  });

  it("redacts provider credentials from tool failures", async () => {
    const bridge = await startMcpToolBridge({
      tools: [tool("inspect")],
      runTools: async () => { throw new Error("token: secret-token-value"); },
    });
    bridges.push(bridge);
    const { client, transport } = await clientFor(bridge);

    const result = await client.callTool({ name: "inspect", arguments: {} });
    expect(JSON.stringify(result)).not.toContain("secret-token-value");
    expect(JSON.stringify(result)).toContain("[redacted]");
    await transport.close();
  });
});

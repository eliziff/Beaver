import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnToolRegistry, toolOutcome } from "../../chat/toolRegistry";
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
  it("executes loaded specialists without refreshing the client's catalog", async () => {
    const names = ["edit_docx_advanced", "document_operation", "lint_document"];
    const executed: string[] = [];
    const registry = new TurnToolRegistry<null>(names.map((name) => ({
      ...tool(name), specialist: true,
      async execute() { executed.push(name); return toolOutcome(name); },
    })));
    const bridge = await startMcpToolBridge({
      tools: registry.all(),
      runTools: (calls) => registry.run(calls, null),
    });
    bridges.push(bridge);
    const { client, transport } = await clientFor(bridge);
    const cachedTools = (await client.listTools()).tools;
    expect(cachedTools.map(({ name }) => name)).toEqual(["load_tools", ...names]);

    const blocked = await client.callTool({ name: names[0], arguments: {} });
    expect(blocked.isError).toBe(true);
    expect(JSON.stringify(blocked.content)).toContain("tool_not_loaded");
    expect(executed).toEqual([]);
    expect((await client.callTool({ name: "load_tools", arguments: { names } })).content)
      .toEqual([{ type: "text", text: JSON.stringify({ ok: true, loaded: names }) }]);

    // No second tools/list request or list-changed notification before these calls.
    for (const name of names) {
      const result = await client.callTool({ name, arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual([{ type: "text", text: name }]);
    }
    expect(executed).toEqual(names);
    expect((await client.callTool({ name: "missing_tool", arguments: {} })).isError).toBe(true);
    expect(executed).toEqual(names);
    expect((await client.callTool({ name: "load_tools", arguments: { names } })).content)
      .toEqual([{ type: "text", text: JSON.stringify({ ok: true, loaded: [] }) }]);
    expect((await client.listTools()).tools).toEqual(cachedTools);
    expect(bridge.stats().toolCallCount).toBe(6);
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

  it("passes a tool result page through as MCP image content", async () => {
    const bridge = await startMcpToolBridge({
      tools: [tool("view_page")],
      runTools: async (calls) => calls.map((call) => ({
        tool_use_id: call.id, status: "ok" as const, content: "{\"page\":2}",
        images: [{ filename: "page 2.jpg", mimeType: "image/jpeg" as const, data: "AAAB" }],
      })),
    });
    bridges.push(bridge);
    const { client, transport } = await clientFor(bridge);

    expect((await client.callTool({ name: "view_page", arguments: {} })).content).toEqual([
      { type: "text", text: "{\"page\":2}" },
      { type: "image", data: "AAAB", mimeType: "image/jpeg" },
    ]);
    expect(bridge.stats().toolResultBytes).toBe(14);
    await transport.close();
  });

  it("preserves tool annotations rather than labelling writes as read-only", async () => {
    const tools = [tool("unspecified"), { ...tool("write"), annotations: { readOnlyHint: false, destructiveHint: true } },
      { ...tool("inspect"), annotations: { readOnlyHint: true } }];
    const bridge = await startMcpToolBridge({ tools, runTools: async () => [] });
    bridges.push(bridge);
    const { client } = await clientFor(bridge);
    try { expect((await client.listTools()).tools).toEqual(tools); } finally { await client.close(); }
  });

  it("rejects missing, duplicate and foreign dispatcher results without publishing their content", async () => {
    let defect = "missing";
    const bridge = await startMcpToolBridge({ tools: [tool("inspect")], runTools: async ([call]) => {
      const correct = { tool_use_id: call.id, content: "not a verified result", terminal: true };
      const foreign = { ...correct, tool_use_id: "foreign" };
      return defect === "missing" ? [] : defect === "duplicate" ? [correct, correct]
        : defect === "foreign" ? [foreign] : [correct, foreign];
    } });
    bridges.push(bridge);
    const { client } = await clientFor(bridge);
    try {
      for (defect of ["missing", "duplicate", "foreign", "extra"]) {
        const result = await client.callTool({ name: "inspect", arguments: {} });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).not.toContain("not a verified result");
        expect(bridge.hasTerminalResult()).toBe(false);
      }
    } finally { await client.close(); }
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


it("advertises the normalized result contract without changing effect annotations", async () => {
  const annotations = { readOnlyHint: false, destructiveHint: true };
  const registry = new TurnToolRegistry([{ ...tool("edit"), annotations,
    outputSchema: { type: "object", properties: { count: { type: "integer" } }, required: ["count"] },
    execute: async () => ({ result: { content: [{ type: "text" as const, text: "Edited one paragraph" }],
      structuredContent: { count: 1 } } }),
  }]);
  const bridge = await startMcpToolBridge({ tools: registry.all(), runTools: calls => registry.run(calls, {}) });
  bridges.push(bridge);
  const { client } = await clientFor(bridge);
  try {
    const [exposed] = (await client.listTools()).tools;
    expect(exposed.annotations).toEqual(annotations);
    expect(exposed.outputSchema).toBeUndefined();
    expect(await client.callTool({ name: "edit", arguments: {} })).toMatchObject({
      content: [{ type: "text", text: "Edited one paragraph" }],
    });
  } finally { await client.close(); }
});

it("rejects ambiguous dispatcher results rather than selecting the first match", async () => {
  const bridge = await startMcpToolBridge({ tools: [tool("inspect")], runTools: async ([call]) => [
    { tool_use_id: call.id, content: "first", terminal: true },
    { tool_use_id: call.id, content: "duplicate" },
  ] });
  bridges.push(bridge);
  const { client } = await clientFor(bridge);
  try {
    expect((await client.callTool({ name: "inspect", arguments: {} })).isError).toBe(true);
    expect(bridge.hasTerminalResult()).toBe(false);
  } finally { await client.close(); }
});

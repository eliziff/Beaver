import { describe, expect, it } from "vitest";
import { boundMcpResponse } from "../mcp/client";
import {
  MAX_MCP_RESPONSE_BYTES,
  MAX_MCP_SSE_EVENT_BYTES,
  MAX_MCP_SSE_RESPONSE_BYTES,
} from "../mcp/types";

describe("MCP response limits", () => {
  it("rejects and cancels a declared oversized JSON response", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(body, {
      headers: {
        "content-length": String(MAX_MCP_RESPONSE_BYTES + 1),
        "content-type": "application/json",
      },
    });

    await expect(boundMcpResponse(response)).rejects.toThrow("size limit");
    expect(cancelled).toBe(true);
  });

  it("caps an undeclared JSON body while it streams", async () => {
    const chunk = new Uint8Array(Math.ceil(MAX_MCP_RESPONSE_BYTES / 2));
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
        if (pulls === 3) controller.close();
      },
    });
    const bounded = await boundMcpResponse(
      new Response(body, {
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(bounded.arrayBuffer()).rejects.toThrow("size limit");
  });

  it("allows a long SSE stream whose individually bounded events exceed the JSON total", async () => {
    const event = `data:${"a".repeat(200 * 1024)}\n\n`;
    const response = new Response(event.repeat(6), {
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    });
    const bounded = await boundMcpResponse(response);

    await expect(bounded.text()).resolves.toHaveLength(event.length * 6);
  });

  it("rejects one oversized SSE event split across chunks", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data:"));
        controller.enqueue(new Uint8Array(MAX_MCP_SSE_EVENT_BYTES));
        controller.enqueue(encoder.encode("\n\n"));
        controller.close();
      },
    });
    const bounded = await boundMcpResponse(
      new Response(body, {
        headers: { "content-type": "text/event-stream" },
      }),
    );

    await expect(bounded.text()).rejects.toThrow("SSE event");
  });

  it("caps the total size of an endless sequence of valid SSE events", async () => {
    const chunk = new TextEncoder().encode(`data:${"a".repeat(64 * 1024)}\n\n`);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
        sent += chunk.byteLength;
        if (sent > MAX_MCP_SSE_RESPONSE_BYTES) controller.close();
      },
    });
    const bounded = await boundMcpResponse(new Response(body, {
      headers: { "content-type": "text/event-stream" },
    }));
    await expect(bounded.arrayBuffer()).rejects.toThrow("SSE response");
  });
});

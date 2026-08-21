import type { Response } from "express";
import { expect, it, vi } from "vitest";
import { writeSse } from "./httpStreaming";

it("flushes each SSE event immediately", () => {
  const response = {
    destroyed: false,
    writableEnded: false,
    write: vi.fn(),
    flush: vi.fn(),
  } as unknown as Response;

  writeSse(response, { type: "tool_activity", label: "Reading page 8" });

  expect(response.write).toHaveBeenCalledWith(
    'data: {"type":"tool_activity","label":"Reading page 8"}\n\n',
  );
  expect((response as Response & { flush: () => void }).flush).toHaveBeenCalledOnce();
});

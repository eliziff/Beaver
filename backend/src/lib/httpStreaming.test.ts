import type { Response } from "express";
import { afterEach, expect, it, vi } from "vitest";
import { startSse, writeSse } from "./httpStreaming";

afterEach(() => vi.useRealTimers());

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

it("keeps an idle SSE observer alive without owning its work", () => {
  vi.useFakeTimers();
  let close = () => undefined;
  const response = {
    destroyed: false, writableEnded: false,
    setTimeout: vi.fn(), set: vi.fn(), flushHeaders: vi.fn(), write: vi.fn(),
    socket: { setTimeout: vi.fn(), setNoDelay: vi.fn() },
    once: vi.fn((_event, callback) => { close = callback; }),
  } as unknown as Response;

  startSse(response);
  vi.advanceTimersByTime(15_000);
  expect(response.write).toHaveBeenCalledWith(": keepalive\n\n");
  close();
  vi.advanceTimersByTime(15_000);
  expect(response.write).toHaveBeenCalledOnce();
});

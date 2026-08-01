import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  borrowCodexKey: vi.fn(async () => ({
    accessToken: "test-token",
    accountId: "account-1",
  })),
  getCodexModelCatalog: vi.fn(),
}));

vi.mock("../codexAuth", () => ({ borrowCodexKey: mocks.borrowCodexKey }));
vi.mock("../../codexCatalog", () => ({
  getCodexModelCatalog: mocks.getCodexModelCatalog,
}));

import { streamCodexApi } from "../codexApi";

const response = (...events: unknown[]) =>
  new Response(
    `${events
      .concat({ type: "response.output_text.delta", delta: "ok" })
      .map((event) => `data: ${JSON.stringify(event)}`)
      .join("\n\n")}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );

const params = (serviceTier?: string) => ({
  model: "codex:gpt-5.6-sol",
  systemPrompt: "system",
  messages: [{ role: "user" as const, content: "test" }],
  ...(serviceTier ? { serviceTier } : {}),
});

afterEach(() => {
  mocks.borrowCodexKey.mockClear();
  mocks.getCodexModelCatalog.mockReset();
  vi.unstubAllGlobals();
});

describe("Codex service tier", () => {
  it("leaves default requests unchanged without loading the catalog", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    vi.stubGlobal("fetch", fetchMock);

    await streamCodexApi(params());

    const body = JSON.parse(
      String((fetchMock.mock.calls[0][1] as RequestInit).body),
    );
    expect(body).not.toHaveProperty("service_tier");
    expect(mocks.getCodexModelCatalog).not.toHaveBeenCalled();
  });

  it("maps advertised fast mode to the priority request value", async () => {
    mocks.getCodexModelCatalog.mockResolvedValue({
      source: "bundled",
      models: [{ slug: "gpt-5.6-sol", serviceTiers: [{ id: "priority" }] }],
    });
    const fetchMock = vi.fn().mockResolvedValue(response());
    vi.stubGlobal("fetch", fetchMock);

    const result = await streamCodexApi(params("fast"));

    expect(
      JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)),
    ).toMatchObject({
      model: "gpt-5.6-sol",
      service_tier: "priority",
      store: false,
    });
    expect(result.serviceTier).toBeUndefined();
  });

  it("accepts the transport-facing priority name directly", async () => {
    mocks.getCodexModelCatalog.mockResolvedValue({
      source: "live",
      models: [{ slug: "gpt-5.6-sol", serviceTiers: [{ id: "priority" }] }],
    });
    const fetchMock = vi.fn().mockResolvedValue(response());
    vi.stubGlobal("fetch", fetchMock);

    await streamCodexApi(params("priority"));

    expect(
      JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)),
    ).toMatchObject({ service_tier: "priority" });
  });

  it("returns the service tier reported by the response stream", async () => {
    mocks.getCodexModelCatalog.mockResolvedValue({
      source: "bundled",
      models: [{ slug: "gpt-5.6-sol", serviceTiers: [{ id: "priority" }] }],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({
          type: "response.completed",
          response: { service_tier: "priority" },
        }),
      ),
    );

    const result = await streamCodexApi(params("fast"));

    expect(result).toMatchObject({ fullText: "ok", serviceTier: "priority" });
  });

  it("refuses a tier the selected model does not advertise", async () => {
    mocks.getCodexModelCatalog.mockResolvedValue({
      source: "bundled",
      models: [
        {
          slug: "gpt-5.6-sol",
          serviceTiers: [],
          additionalSpeedTiers: ["fast"],
        },
      ],
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(streamCodexApi(params("fast"))).rejects.toThrow(
      "does not advertise service tier priority",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.borrowCodexKey).not.toHaveBeenCalled();
  });
});

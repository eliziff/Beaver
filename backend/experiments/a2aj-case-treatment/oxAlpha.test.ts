import { afterEach, describe, expect, it, vi } from "vitest";

import { modelContextWindow } from "../../src/lib/llm/contextWindow";
import { providerForModel } from "../../src/lib/llm/models";
import {
  OX_ALPHA_ROUTES,
  assignedOxAlphaRoute,
  inspectOxAlphaCatalog,
  oxAlphaCredentials,
  oxAlphaRoute,
  oxAlphaRoutes,
  preflightOxAlpha,
} from "./oxAlpha";

const priorKiloKey = process.env.KILO_API_KEY;

afterEach(() => {
  if (priorKiloKey === undefined) delete process.env.KILO_API_KEY;
  else process.env.KILO_API_KEY = priorKiloKey;
});

describe("Ox Alpha route contract", () => {
  it("pins the exact route-specific model IDs", () => {
    expect(OX_ALPHA_ROUTES.openrouter.model).toBe("stealth/ox-alpha");
    expect(OX_ALPHA_ROUTES["opencode-zen"].model).toBe("x-preview-f-free");
    expect(OX_ALPHA_ROUTES["opencode-go"].model).toBe("ox-alpha-free");
    expect(OX_ALPHA_ROUTES.nous.model).toBe("stealth/ox-alpha");
    expect(OX_ALPHA_ROUTES.nous.base_url).toBe("http://127.0.0.1:8645/v1");
    expect(OX_ALPHA_ROUTES.kilo.model).toBe("stealth/ox-alpha");
    expect(OX_ALPHA_ROUTES.kilo.catalog_url).toBe("https://api.kilo.ai/api/gateway/models");
    expect(OX_ALPHA_ROUTES.kilo.maximum_requests_per_minute! * 60).toBe(200);
  });

  it("resolves every route model through the shared runtime router", () => {
    for (const config of Object.values(OX_ALPHA_ROUTES)) {
      expect(providerForModel(config.model)).toBe("ox-gateway");
      expect(modelContextWindow(config.model)).toBe(1_000_000);
    }
  });

  it("accepts the advertised zero-priced OpenRouter model", () => {
    expect(inspectOxAlphaCatalog("openrouter", {
      data: [{
        id: "stealth/ox-alpha",
        pricing: { prompt: "0", completion: "0" },
        reasoning: { supported_efforts: ["low", "high", "max"], mandatory: true },
      }],
    })).toMatchObject({
      route: "openrouter",
      model: "stealth/ox-alpha",
      price_verified_zero: true,
    });
  });

  it("accepts Nous and Kilo only while their catalogs still advertise free inference", () => {
    expect(inspectOxAlphaCatalog("nous", {
      data: [{ id: "stealth/ox-alpha", pricing: { prompt: "0.0000000000", completion: "0" } }],
    })).toMatchObject({ route: "nous", price_verified_zero: true });
    expect(inspectOxAlphaCatalog("kilo", {
      data: [{
        id: "stealth/ox-alpha",
        isFree: true,
        mayTrainOnYourPrompts: true,
        pricing: { prompt: "0", completion: "0" },
      }],
    })).toMatchObject({
      route: "kilo",
      advertised_free: true,
      may_train_on_prompts: true,
      price_verified_zero: true,
    });
    expect(() => inspectOxAlphaCatalog("kilo", {
      data: [{ id: "stealth/ox-alpha", isFree: false, pricing: { prompt: "0", completion: "0" } }],
    })).toThrow("no longer advertises zero");
  });

  it("stops if a fail-closed catalog removes the model or starts charging", () => {
    expect(() => inspectOxAlphaCatalog("openrouter", { data: [] })).toThrow("not advertised");
    expect(() => inspectOxAlphaCatalog("openrouter", {
      data: [{ id: "stealth/ox-alpha", pricing: { prompt: "0.1", completion: "0" } }],
    })).toThrow("no longer advertises zero");
  });

  it("parses unique routes and assigns cases in stable round-robin order", () => {
    const routes = oxAlphaRoutes("openrouter,nous kilo");
    expect(routes).toEqual(["openrouter", "nous", "kilo"]);
    expect([0, 1, 2, 3, 4].map((index) => assignedOxAlphaRoute(routes, index))).toEqual([
      "openrouter", "nous", "kilo", "openrouter", "nous",
    ]);
    expect(() => oxAlphaRoutes("nous,nous")).toThrow("must not repeat");
    expect(() => oxAlphaRoute("rotate")).toThrow("--ox-route/--ox-routes");
  });

  it("keeps anonymous, proxy, and optional credentials route-local", () => {
    delete process.env.KILO_API_KEY;
    expect(oxAlphaCredentials("opencode-zen")).toEqual({
      apiKey: "sk-unused",
      omitAuthorization: true,
    });
    expect(oxAlphaCredentials("nous")).toEqual({ apiKey: "sk-unused" });
    expect(oxAlphaCredentials("kilo")).toEqual({
      apiKey: "sk-unused",
      omitAuthorization: true,
    });
    process.env.KILO_API_KEY = "kilo-test-key";
    expect(oxAlphaCredentials("kilo")).toEqual({ apiKey: "kilo-test-key" });
  });

  it("omits authorization for anonymous catalog preflights", async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "x-preview-f-free" }] }),
    })) as unknown as typeof fetch;
    await preflightOxAlpha("opencode-zen", oxAlphaCredentials("opencode-zen"), fetcher);
    expect(fetcher).toHaveBeenCalledWith(
      OX_ALPHA_ROUTES["opencode-zen"].catalog_url,
      expect.objectContaining({ headers: { accept: "application/json" } }),
    );
  });
});

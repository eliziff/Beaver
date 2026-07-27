import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearA2AJCache } from "../lib/a2aj";
import { legalLibraryRouter } from "./legalLibrary";

const app = express();
app.use(express.json());
app.use("/library/legal", legalLibraryRouter);

const originalAuthMode = process.env.AUTH_MODE;

afterEach(() => {
  clearA2AJCache();
  vi.unstubAllGlobals();
  process.env.AUTH_MODE = originalAuthMode;
});

describe("legal Library viewer responses", () => {
  it("revalidates with a stable ETag without refetching the source", async () => {
    process.env.AUTH_MODE = "anonymous";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          {
            dataset: "SCC",
            citation_en: "2099 SCC 3",
            name_en: "ETag v. Repeat Open",
            unofficial_text_en:
              "[1] First paragraph with enough legal text.\n[2] Second paragraph with enough legal text.",
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await request(app)
      .get("/library/legal/document")
      .query({ citation: "2099 SCC 3", doc_type: "cases" });
    const second = await request(app)
      .get("/library/legal/document")
      .query({ citation: "2099 SCC 3", doc_type: "cases" })
      .set("If-None-Match", first.headers.etag);

    expect(first.status).toBe(200);
    expect(first.headers.etag).toMatch(/^"[A-Za-z0-9_-]+"$/u);
    expect(first.headers["cache-control"]).toBe(
      "private, max-age=0, must-revalidate",
    );
    expect(second.status).toBe(304);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

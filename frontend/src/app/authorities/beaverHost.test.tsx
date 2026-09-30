import { beforeEach, expect, it, vi } from "vitest";
import type { AuthoritiesProduct } from "./types";

const mocks = vi.hoisted(() => ({ build: vi.fn(), resolve: vi.fn(), prepare: vi.fn() }));
vi.mock("@/app/lib/api/authorities", async (load) => ({
  ...await load<typeof import("@/app/lib/api/authorities")>(), buildAuthorities: mocks.build,
}));
vi.mock("@/app/lib/api/workProducts", async (load) => ({
  ...await load<typeof import("@/app/lib/api/workProducts")>(), getWorkProductResolution: mocks.resolve,
}));
vi.mock("@/app/lib/pdfPreparation", async (load) => ({
  ...await load<typeof import("@/app/lib/pdfPreparation")>(), waitForPdfPreparation: mocks.prepare,
}));
import { beaverAuthoritiesHost } from "./beaverHost";

const draft = (allowIncomplete: boolean) => ({ id: "draft", revision: 3,
  state: { outputMode: "book", settings: { allowIncomplete }, authorityOrder: ["case"],
    authorities: { case: { excluded: false, source: { kind: "attached", sources: [
      { bindingRole: "authority:en", filename: "English.pdf" },
      { bindingRole: "authority:fr", filename: "French.pdf" },
    ] } } }, bindings: {
      "authority:en": { kind: "document", documentId: "english", version: "latest" },
      "authority:fr": { kind: "document", documentId: "french", version: "latest" },
    } },
}) as unknown as AuthoritiesProduct;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.build.mockResolvedValue({ receipt: { outputs: { book: {} } } });
  mocks.prepare.mockResolvedValue(undefined);
  mocks.resolve.mockResolvedValue({ inputs: {
    "authority:en": { status: "ready" }, "authority:fr": { status: "missing", reason: "deleted" },
  } });
});

it("builds with the available language when an unavailable authority PDF was accepted", async () => {
  const result = await beaverAuthoritiesHost.build(draft(true));
  expect(mocks.prepare.mock.calls.map(([id]) => id)).toEqual(["english"]);
  expect(result.receipt.outputs.book).toBeDefined();
});

it("keeps preparation failures actionable instead of treating them as missing PDFs", async () => {
  mocks.prepare.mockRejectedValue(new Error("PDF is password-protected"));
  await expect(beaverAuthoritiesHost.build(draft(true))).rejects.toThrow("password-protected");
  expect(mocks.build).not.toHaveBeenCalled();
});

it("requires the attached PDFs when incomplete building was not accepted", async () => {
  mocks.prepare.mockImplementation(async (id) => {
    if (id === "french") throw new Error("PDF is unavailable");
  });
  await expect(beaverAuthoritiesHost.build(draft(false))).rejects.toThrow("unavailable");
  expect(mocks.build).not.toHaveBeenCalled();
});

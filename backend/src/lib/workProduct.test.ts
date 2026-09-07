import { expect, it } from "vitest";
import type { WorkProductBuildReceipt, WorkProductInput } from "../../../frontend/src/app/lib/workProducts";
import { decodeWorkProductBindings, decodeWorkProductBuildReceipt, decodeWorkProductState } from "./workProduct";

const sha256 = "a".repeat(64);
const receipt: WorkProductBuildReceipt = {
  schemaVersion: "beaver.work-product-build.v2", builtAt: "2026-09-07T12:00:00Z",
  workProduct: { id: "draft", kind: "court-record", revision: 1 }, inputs: [],
  settings: { profileId: null, outputMode: "single", stateSha256: sha256,
    settingsSha256: sha256, sourceReceiptIds: [],
    audit: { effective: null, valuesJson: "{}" } },
  steps: [], output: { role: "record", filename: "Record.pdf", mimeType: "application/pdf",
    pageCount: null, sha256 },
};

it.each<WorkProductInput>([
  { kind: "local-file", handleId: "file", lastSeen: { name: "Record.pdf", size: 0, modified: 0 } },
  { kind: "document", documentId: "file", version: "latest" },
  { kind: "document", documentId: "file", version: { versionId: "v1", sha256 } },
  { kind: "work-product-output", workProductId: "child", role: "book" },
])("accepts client bindings without copying the draft: $kind", (input) => {
  const bindings = { source: input }, state = { bindings, cover: { title: "Record" } };
  expect(decodeWorkProductBindings(bindings)).toBe(bindings);
  expect(decodeWorkProductState(state)).toBe(state);
});

it("reads client receipts as objects or stored JSON without changing their fields", () => {
  expect(decodeWorkProductBuildReceipt(receipt)).toBe(receipt);
  expect(decodeWorkProductBuildReceipt(JSON.stringify(receipt))).toEqual(receipt);
});

it.each([null, { from: "2026-09-07", to: null }, { from: "2026-09-07", to: "2027-01-01" }])(
  "accepts an explicit null or complete effective interval: %j", (effective) => {
    const value = structuredClone(receipt); value.settings.audit.effective = effective;
    expect(decodeWorkProductBuildReceipt(value)).toBe(value);
  },
);

it.each([undefined, {}, [], "today", 1, { from: "2026-09-07" }, { to: null },
  { from: "2026-09-07", to: null, extra: true }])(
  "does not mistake malformed effective metadata for an explicit null: %j", (effective) => {
    const value = { ...receipt, settings: { ...receipt.settings,
      audit: { ...receipt.settings.audit, effective } } };
    expect(decodeWorkProductBuildReceipt(value)).toBeNull();
  },
);

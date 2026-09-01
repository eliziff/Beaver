import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  auditRedirectUrl,
  auditSource,
  isCanlii,
  needsAudit,
  validateAuditCoverage,
  validateManifest,
} from "./audit-court-output-sources.mjs";

test("CanLII receipts never invoke the request function", async () => {
  let requests = 0;
  const request = async () => {
    requests += 1;
    throw new Error("request must not run");
  };
  for (const url of [
    "https://www.canlii.org/en/ca/scc/doc/2016/2016scc27/2016scc27.pdf",
    "https://www.canlii.org./example",
    "https://download.canlii.ca/example",
  ]) {
    const result = await auditSource({ id: "canlii-manual", url,
      expected_markers: [] }, undefined, false, request);
    assert.equal(result.status, "manual_only");
    assert.equal(isCanlii(url), true);
  }
  assert.equal(requests, 0);
  assert.equal(isCanlii("https://canlii.org.evil.example/"), false);
});

test("redirects cannot cross the request boundary into CanLII", () => {
  assert.equal(auditRedirectUrl("/rules", "https://albertacourts.ca/start").href,
    "https://albertacourts.ca/rules");
  assert.throws(() => auditRedirectUrl("https://www.canlii.ca./case",
    "https://albertacourts.ca/start"), /CanLII/u);
  assert.throws(() => auditRedirectUrl("http://example.test/rules",
    "https://albertacourts.ca/start"), /HTTPS/u);
});

test("fresh receipts skip conditional network checks unless selected", () => {
  const source = { id: "official" };
  const previous = { checked_at: "2026-08-30T00:00:00.000Z" };
  const options = { ids: new Set(), maxAgeDays: 30, refreshAll: false };
  const now = Date.parse("2026-08-31T00:00:00.000Z");
  assert.equal(needsAudit(source, previous, options, now), false);
  assert.equal(needsAudit(source, previous, { ...options,
    ids: new Set([source.id]) }, now), true);
});

test("manifest receipts name exact profiles and mark CanLII manual-only", () => {
  const source = {
    id: "source",
    profiles: ["fc-motion-record-moving"],
    kind: "rule",
    url: "https://laws-lois.justice.gc.ca/example",
    locator: "Rule 1",
    expected_markers: [],
  };
  assert.doesNotThrow(() => validateManifest({ schema_version: 2, sources: [source] }));
  assert.throws(() => validateManifest({ schema_version: 2,
    sources: [{ ...source, profiles: ["fc"] }] }), /exact supported profiles/u);
  assert.throws(() => validateManifest({ schema_version: 2,
    sources: [{ ...source, url: "https://www.canlii.org/example" }] }), /manual_only/u);
});

test("offline checks require one receipt for every manifest source", () => {
  const manifest = { sources: [{ id: "a" }, { id: "b" }] };
  assert.doesNotThrow(() => validateAuditCoverage(manifest, {
    results: [{ id: "b" }, { id: "a" }],
  }));
  assert.throws(() => validateAuditCoverage(manifest, {
    results: [{ id: "a" }],
  }), /cover/u);
  assert.throws(() => validateAuditCoverage(manifest, {
    results: [{ id: "a" }, { id: "a" }],
  }), /match/u);
});

test("current Alberta authority profiles do not consume the superseded Book checklist", () => {
  const manifest = JSON.parse(readFileSync(new URL(
    "../docs/decisions/court-output-preset-receipts.json", import.meta.url), "utf8"));
  const guide = manifest.sources.find(({ id }) => id === "ab-ca-authorities-guide");
  assert(guide.profiles.includes("ab-court-of-appeal"));
  assert.equal(guide.locator.includes("Rule 14.25(1)(h)"), true);
  assert.equal(manifest.sources.some(({ url }) => url === guide.supersedes.url), false);
});

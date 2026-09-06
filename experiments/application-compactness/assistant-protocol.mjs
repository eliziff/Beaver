import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(new URL("../../backend/package.json", import.meta.url));
const { buildSync } = require("esbuild");
const label = process.argv[2] ?? "candidate";
const source = label === "baseline" ? "assistantSession" : "assistantProtocol";
buildSync({ absWorkingDir: root, entryPoints: [`frontend/src/app/lib/${source}.ts`],
bundle: true, platform: "node", format: "esm", tsconfig: "frontend/tsconfig.json",
outfile: `experiments/application-compactness/results/assistant-${label}.mjs` });
if (label === "baseline") {
  console.log("Captured the pre-change parser. Run again with a candidate label after the refactor.");
  process.exit(0);
}
const baseline = await import(new URL("./results/assistant-baseline.mjs", import.meta.url).href);
const candidate = await import(new URL(`./results/assistant-${label}.mjs`, import.meta.url).href);
const test = readFileSync(new URL("../../frontend/src/app/lib/assistantSession.test.ts", import.meta.url), "utf8");
const literal = test.match(/const supportedEvents:[\s\S]*?= (\[[\s\S]*?\n\]);/u)?.[1];
assert.ok(literal, "Use the existing protocol fixtures");
const events = Function(`return ${literal}`)().map(([, event]) => event);
const quotes = [{ quote: "The governing rule applies." }];
const display = { display_form: "full", source_class: "case", external_url: "https://example.test/case",
  authority: "Example", short_authority: "Example", locator_separator: " at " };
const locator = { ...display, locator_kind: "page", locator: "3", pinpoint: "3" };
const citations = [
  { kind: "a2aj", ref: 1, citation: "2020 SCC 1", name: "Example", dataset: "scc",
    url: "https://example.test/case", quotes, ...locator },
  { kind: "public_legal", ref: 2, provider: "tna", identifier: "test", title: "Example",
    citation: "[2020] UKSC 1", url: "https://example.test/case", quotes, ...locator },
  { kind: "tabular", ref: 3, review_id: "review", col_index: 0, row_index: 1,
    col_name: "Rule", doc_name: "Lease", quotes, ...display },
  { kind: "document", ref: 4, document_id: "document", filename: "Lease.pdf",
    version_id: "version", version_number: 1, url: "/api/documents/document/file",
    quotes: [{ quote: "Rule", page: 2, sheet: "Sheet1", cell: "A1" }], ...locator },
];
const activity = { id: "activity", tool: "Read", label: "Reading", status: "completed", citations };
events.push(
  { type: "content_final", text: "Answer [1]", citations },
  { type: "ask_inputs", items: [{ id: "files", kind: "documents", document_types: ["brief"] }] },
  { type: "ask_inputs_response", responses: [{ id: "files", kind: "documents",
    documents: [{ document_id: "document", filename: "Brief.docx" }] }] },
  { type: "tool_activity", ...activity },
  { type: "subagent_run", id: "reader", task: "Read the brief", status: "completed",
    activity, activities: [activity], output: "Read complete.", error: "", citations },
  { type: "workflow_run", tool: "update_work_product", id: "", status: "completed", stage: "Build",
    progress: 100, message: "Built", counts: [{ label: "Sources", value: 1 }],
    outputs: [{ name: "Book.pdf", url: "/book.pdf" }], app_url: "/authorities", job_id: "job",
    version_number: 1, error: "private details", work_product: { kind: "authorities", id: "draft", revision: 1 },
    requested_action: "open" },
  { type: "document_artifact", action: "edited", filename: "Brief.docx", document_id: "document",
    version_id: "version", version_number: 1, download_url: "/document.docx", edit_mode: "auto",
    annotations: [{ edit_id: "edit", document_id: "document", version_id: "version", version_number: 1,
      del_w_id: "delete", ins_w_id: "insert", deleted_text: "old", inserted_text: "new",
      context_before: "before", context_after: "after", reason: "Corrected",
      diff: [{ kind: "insert", text: "new" }], status: "pending" }] },
);

function* paths(value, prefix = []) {
  if (!value || typeof value !== "object") return;
  for (const key of Object.keys(value)) {
    const path = [...prefix, key];
    yield path;
    yield* paths(value[key], path);
  }
}
const omit = Symbol("omit");
const variants = [omit, undefined, null, false, true, -1, 0, 1, 0.5, Number.MAX_SAFE_INTEGER + 1,
  Infinity, NaN, "", " ", "unknown", "javascript:alert(1)", "//example.test/file", "x".repeat(513), {}, []];
let checked = 0;
for (const event of events) {
  assert.ok(baseline.parseAssistantProtocolEvent(event).ok, `Invalid baseline fixture: ${event.type}`);
  const compare = (value) => {
    const before = baseline.parseAssistantProtocolEvent(value), after = candidate.parseAssistantProtocolEvent(value);
    if (!isDeepStrictEqual(before, after)) {
      writeFileSync(new URL("./results/assistant-mismatch.json", import.meta.url), JSON.stringify({ value, before, after }, null, 2));
      assert.fail(`Protocol drift at ${event.type}, case ${checked}; see results/assistant-mismatch.json`);
    }
    checked++;
  };
  compare(event);
  compare({ ...event, unknown_field: true });
  compare({ ...event, ["__proto__"]: {} });
  for (const path of paths(event)) for (const value of variants) {
    const changed = structuredClone(event);
    const parent = path.slice(0, -1).reduce((row, key) => row[key], changed);
    if (value === omit) delete parent[path.at(-1)]; else parent[path.at(-1)] = value;
    compare(changed);
  }
  console.log(`${event.type}: ${checked} equivalent cases`);
}
const samples = { baseline: [], candidate: [] };
for (let round = 0; round < 65; round++) {
  // Alternate order to reduce warm-up/order bias. Each sample replays 2,800 events.
  for (const name of round % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"]) {
    const parser = name === "baseline" ? baseline : candidate;
    const start = performance.now();
    for (let pass = 0; pass < 100; pass++) for (const event of events) parser.parseAssistantProtocolEvent(event);
    if (round >= 5) samples[name].push(performance.now() - start);
  }
}
const result = { checked, eventsPerSample: events.length * 100,
  samples: Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, {
    p50: values.toSorted((a, b) => a - b)[Math.floor(values.length * 0.5)],
    p95: values.toSorted((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1], values,
  }])) };
writeFileSync(new URL(`./results/assistant-${label}.json`, import.meta.url), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ checked, ...Object.fromEntries(Object.entries(result.samples).map(([key, value]) => [key, value.p95])) }));

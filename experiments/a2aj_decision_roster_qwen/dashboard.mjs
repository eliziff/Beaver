#!/usr/bin/env node

/**
 * Small, dependency-free dashboard for the decision-roster receipts.
 *
 * The runner writes append-only progress and receipt streams.  This server
 * reads those streams without mutating them, so it is safe to leave running
 * beside an active eight-worker dispatch.
 */

import { createServer } from "node:http";
import assert from "node:assert/strict";
import { open, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_DIR = path.join(HERE, "runs");
const DASHBOARD_FILE = path.join(HERE, "dashboard.html");
const RUN_ID = /^[A-Za-z0-9._-]+$/u;
const DEFAULT_PAGE_SIZE = 60;
const MAX_PAGE_SIZE = 200;

const jsonlCache = new Map();
const jsonCache = new Map();
const runCache = new Map();

function parseArgs(argv) {
  const options = {
    host: "127.0.0.1",
    port: 8796,
    frontendUrl: process.env.BEAVER_FRONTEND_URL || "http://127.0.0.1:3000",
    selfTest: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--host" && value) {
      options.host = value;
      index += 1;
    } else if (arg === "--port" && value) {
      options.port = Number.parseInt(value, 10);
      index += 1;
    } else if (arg === "--frontend-url" && value) {
      options.frontendUrl = value;
      index += 1;
    } else if (arg === "--self-test") {
      options.selfTest = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "usage: node dashboard.mjs [--port 8796] [--host 127.0.0.1] [--frontend-url http://127.0.0.1:3000] [--self-test]",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown dashboard option: ${arg}`);
    }
  }
  if (!Number.isFinite(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error("--port must be between 1 and 65535");
  }
  return options;
}

function jsonResponse(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function errorResponse(response, status, message) {
  jsonResponse(response, status, { error: message });
}

function asNumber(value, fallback = null) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function finiteInteger(value, fallback = null) {
  const number = asNumber(value, fallback);
  return number !== null && Number.isInteger(number) ? number : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function normalizeSpan(value) {
  if (Array.isArray(value) && value.length >= 2) {
    const from = finiteInteger(value[0]);
    const to = finiteInteger(value[1]);
    return from !== null && to !== null ? { from, to } : null;
  }
  if (!value || typeof value !== "object") return null;
  const from = finiteInteger(value.from ?? value.start);
  const to = finiteInteger(value.to ?? value.end);
  return from !== null && to !== null ? { from, to } : null;
}

function normalizeSpans(value) {
  const source = value && typeof value === "object" ? value : {};
  return Object.fromEntries(
    ["majority", "minority", "concurring", "unknown"].map((role) => [
      role,
      (Array.isArray(source[role]) ? source[role] : [])
        .map(normalizeSpan)
        .filter(Boolean),
    ]),
  );
}

function normalizeJudges(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((judge) => judge && typeof judge === "object")
    .map((judge) => ({
      name: String(judge.name ?? "").trim(),
      role: String(judge.role ?? judge.result_side ?? "unknown").trim() || "unknown",
      result_side: String(judge.result_side ?? judge.role ?? "unknown").trim() || "unknown",
      relationship: String(judge.relationship ?? "unknown").trim() || "unknown",
      opinion_ids: Array.isArray(judge.opinion_ids) ? judge.opinion_ids.map(String) : [],
    }))
    .filter((judge) => judge.name);
}

function isSeparateOpinionRole(role) {
  return /minority|dissent|concurr/iu.test(String(role ?? ""));
}

function hasSeparateOpinion(item) {
  return item.spans.minority.length > 0
    || item.spans.concurring.length > 0
    || item.opinions.some((opinion) => ["same_result_separate_reasons", "different_result", "mixed"].includes(opinion.alignment));
}

function opinionRole(alignment) {
  return alignment === "lead"
    ? "majority"
    : alignment === "different_result"
      ? "minority"
      : alignment === "same_result_separate_reasons"
        ? "concurring"
        : "unknown";
}

function normalizeOpinions(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((opinion) => opinion && typeof opinion === "object")
    .map((opinion) => ({
      id: String(opinion.id ?? ""),
      authors: Array.isArray(opinion.authors) ? opinion.authors.map(String) : [],
      alignment: String(opinion.alignment ?? "unknown"),
      start: finiteInteger(opinion.start),
      end_exclusive: finiteInteger(opinion.end_exclusive ?? opinion.end),
      start_quote: String(opinion.start_quote ?? opinion.startQuote ?? ""),
      end_quote: String(opinion.end_quote ?? opinion.endQuote ?? ""),
      paragraphs: (Array.isArray(opinion.paragraphs) ? opinion.paragraphs : [])
        .map(normalizeSpan)
        .filter(Boolean),
    }));
}

function statusOutcome(receipt) {
  const status = String(receipt?.status ?? "").toLowerCase();
  if (["accepted", "rejected", "structure_unavailable", "case_failed"].includes(status)) {
    return status;
  }
  if (["failed", "error"].includes(status)) return "case_failed";
  if (receipt?.validation?.ok === false || receipt?.model_receipt?.error) {
    return "case_failed";
  }
  if (receipt?.structure?.status === "unavailable" || receipt?.prediction == null) {
    return "structure_unavailable";
  }
  return status || "unknown";
}

function outcomeLabel(outcome) {
  return {
    accepted: "Accepted",
    rejected: "Rejected",
    structure_unavailable: "No structure",
    case_failed: "Case failed",
    unknown: "Unknown",
  }[outcome] ?? outcome;
}

function outcomeRank(outcome) {
  return {
    accepted: 0,
    rejected: 1,
    structure_unavailable: 2,
    case_failed: 3,
    unknown: 4,
  }[outcome] ?? 4;
}

function runStatusLabel(status) {
  return {
    finished: "Finished",
    running: "In progress",
    failed: "Failed",
    incomplete: "Incomplete",
  }[status] ?? status;
}

function normalizeCase(raw, fallbackIndex = 0) {
  const envelope = raw?.receipt && typeof raw.receipt === "object" ? raw : null;
  const receipt = envelope ? raw.receipt : raw && typeof raw === "object" ? raw : {};
  const source = receipt.source && typeof receipt.source === "object" ? receipt.source : {};
  const prediction = receipt.prediction && typeof receipt.prediction === "object"
    ? receipt.prediction
    : {};
  const opinions = normalizeOpinions(prediction.opinions);
  const rawSpans = prediction.spans ?? receipt.spans;
  const spans = normalizeSpans(rawSpans);
  for (const opinion of opinions) {
    spans[opinionRole(opinion.alignment)].push(...opinion.paragraphs);
  }
  const outcome = statusOutcome(receipt);
  const judges = normalizeJudges(prediction.judges);
  const rawSeparateRange = rawSpans && typeof rawSpans === "object"
    && Object.entries(rawSpans).some(([role, ranges]) => isSeparateOpinionRole(role) && Array.isArray(ranges) && ranges.length > 0);
  const separateOpinion = hasSeparateOpinion({ opinions, spans }) || rawSeparateRange;
  return {
    index: finiteInteger(envelope?.index, fallbackIndex),
    document_id: finiteInteger(source.document_id ?? envelope?.document),
    dataset: source.dataset ? String(source.dataset) : null,
    citation: source.citation ? String(source.citation) : null,
    name: source.name ? String(source.name) : null,
    date: source.date ? String(source.date) : null,
    outcome,
    outcome_label: outcomeLabel(outcome),
    status: receipt.status ? String(receipt.status) : outcome,
    structure_status: receipt.structure?.status ? String(receipt.structure.status) : null,
    paragraph_count: finiteInteger(receipt.structure?.paragraph_count),
    judges,
    opinions,
    spans,
    separate_opinion: separateOpinion,
    validation_ok: receipt.validation?.ok !== false,
    evidence: Array.isArray(receipt.evidence)
      ? receipt.evidence.map((item) => ({
          role: String(item?.role ?? "unknown"),
          from: item?.from ? String(item.from) : null,
          to: item?.to ? String(item.to) : null,
          evidence_id: item?.evidence_id ? String(item.evidence_id) : null,
        }))
      : [],
    error: receipt.model_receipt?.error
      ? String(receipt.model_receipt.error)
      : receipt.validation?.error
        ? String(receipt.validation.error)
        : null,
  };
}

function sourceUrl(frontendUrl, item, range = null) {
  if (!item?.citation) return null;
  try {
    const base = String(frontendUrl).replace(/\/+$/u, "");
    const query = new URLSearchParams({
      provider: "a2aj",
      citation: item.citation,
      doc_type: "cases",
      language: "en",
    });
    if (item.dataset) query.set("dataset", item.dataset);
    const url = `${base}/sources/view?${query.toString()}`;
    return range?.from ? `${url}#legal-par${range.from}` : url;
  } catch {
    return null;
  }
}

function withLinks(item, frontendUrl) {
  const legacyRanges = Object.entries(item.spans).flatMap(([role, values]) =>
    values.map((range) => ({
      role,
      from: range.from,
      to: range.to,
      label: `par${range.from}–par${range.to}`,
      url: sourceUrl(frontendUrl, item, range),
    })),
  );
  const ranges = item.opinions.length
    ? item.opinions.map((opinion) => {
        const paragraph = opinion.paragraphs[0] ?? null;
        return {
          role: opinionRole(opinion.alignment),
          from: paragraph?.from ?? null,
          to: paragraph?.to ?? null,
          start: opinion.start,
          end_exclusive: opinion.end_exclusive,
          start_quote: opinion.start_quote,
          end_quote: opinion.end_quote,
          label: opinion.start !== null && opinion.end_exclusive !== null
            ? `chars ${opinion.start}-${opinion.end_exclusive}`
            : paragraph
              ? `par${paragraph.from}-par${paragraph.to}`
              : opinion.id,
          url: sourceUrl(frontendUrl, item, paragraph),
        };
      })
    : legacyRanges;
  return {
    ...item,
    text_url: sourceUrl(frontendUrl, item),
    ranges,
  };
}

async function readJsonCached(file) {
  try {
    const info = await stat(file);
    const previous = jsonCache.get(file);
    if (previous && previous.size === info.size && previous.mtimeMs === info.mtimeMs) {
      return previous.value;
    }
    const value = JSON.parse(await readFile(file, "utf8"));
    jsonCache.set(file, { size: info.size, mtimeMs: info.mtimeMs, value });
    return value;
  } catch {
    return null;
  }
}

async function readJsonlEvents(file, keepKinds) {
  let info;
  try {
    info = await stat(file);
  } catch {
    return [];
  }
  let cache = jsonlCache.get(file);
  if (!cache || info.size < cache.bytes || (info.size === cache.bytes && info.mtimeMs !== cache.mtimeMs)) {
    cache = { bytes: 0, mtimeMs: 0, remainder: "", events: [] };
    jsonlCache.set(file, cache);
  }
  if (info.size > cache.bytes) {
    const length = info.size - cache.bytes;
    const handle = await open(file, "r");
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, cache.bytes);
      const lines = `${cache.remainder}${buffer.toString("utf8")}`.split(/\r?\n/u);
      cache.remainder = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (!keepKinds || keepKinds.has(event?.kind)) cache.events.push(event);
        } catch {
          // A writer may leave a malformed line only while a file is being
          // appended. The next size change will give us another chance.
        }
      }
      cache.bytes = info.size;
      cache.mtimeMs = info.mtimeMs;
    } finally {
      await handle.close();
    }
  }
  return cache.events;
}

function eventTime(event) {
  const time = Date.parse(String(event?.utc ?? ""));
  return Number.isFinite(time) ? time : 0;
}

function runIdFromName(name, suffix) {
  return name.endsWith(suffix) ? name.slice(0, -suffix.length) : null;
}

async function discoverRunIds() {
  let names = [];
  try {
    names = await readdir(RUN_DIR);
  } catch {
    return [];
  }
  const ids = new Set();
  for (const name of names) {
    const root = name.endsWith(".json") && !name.endsWith(".manifest.json")
      ? name.slice(0, -5)
      : null;
    const progress = runIdFromName(name, ".progress.jsonl");
    const receipts = runIdFromName(name, ".receipts.jsonl");
    if (root && RUN_ID.test(root)) ids.add(root);
    if (progress && RUN_ID.test(progress)) ids.add(progress);
    if (receipts && RUN_ID.test(receipts)) ids.add(receipts);
  }
  return [...ids];
}

function rawReceipts(root, receiptEvents) {
  if (Array.isArray(root?.receipts) && root.receipts.length) return root.receipts;
  return receiptEvents
    .filter((event) => event?.kind === "case_receipt" && event.receipt)
    .map((event) => event);
}

function outcomeCounts(cases) {
  const counts = {
    accepted: 0,
    rejected: 0,
    structure_unavailable: 0,
    case_failed: 0,
    unknown: 0,
    separate_opinion: 0,
  };
  for (const item of cases) {
    counts[item.outcome] = (counts[item.outcome] ?? 0) + 1;
    if (item.separate_opinion) counts.separate_opinion += 1;
  }
  return counts;
}

function latestEvent(...groups) {
  return groups.flat().sort((left, right) => eventTime(right) - eventTime(left))[0] ?? null;
}

async function readRun(id) {
  const root = await readJsonCached(path.join(RUN_DIR, `${id}.json`));
  const progress = await readJsonlEvents(
    path.join(RUN_DIR, `${id}.progress.jsonl`),
    new Set(["run_started", "run_finished", "case_finished"]),
  );
  const receiptEvents = await readJsonlEvents(
    path.join(RUN_DIR, `${id}.receipts.jsonl`),
    new Set(["run_started", "run_finished", "case_receipt"]),
  );
  const sourceCases = rawReceipts(root, receiptEvents);
  const previous = runCache.get(id);
  const normalizeRunCase = (item, index) => ({
    ...normalizeCase(item, index),
    run_id: id,
  });
  let cases;
  if (
    previous &&
    previous.root === root &&
    previous.progress === progress &&
    previous.receiptEvents === receiptEvents &&
    previous.sourceLength === sourceCases.length
  ) {
    cases = previous.cases;
  } else if (
    previous &&
    previous.root === root &&
    previous.progress === progress &&
    previous.receiptEvents === receiptEvents &&
    previous.sourceLength < sourceCases.length &&
    !(Array.isArray(root?.receipts) && root.receipts.length)
  ) {
    cases = previous.cases.concat(
      sourceCases
        .slice(previous.sourceLength)
        .map((item, index) => normalizeRunCase(item, previous.sourceLength + index)),
    );
  } else {
    cases = sourceCases.map(normalizeRunCase);
  }
  const started = progress.filter((event) => event.kind === "run_started").at(-1)
    ?? receiptEvents.filter((event) => event.kind === "run_started").at(-1)
    ?? null;
  const finished = progress.filter((event) => event.kind === "run_finished").at(-1)
    ?? receiptEvents.filter((event) => event.kind === "run_finished").at(-1)
    ?? null;
  const total = finiteInteger(
    root?.sample_size
      ?? root?.selection?.requested_sample_size
      ?? started?.sample_size
      ?? started?.pending_sample_size,
    cases.length,
  ) ?? cases.length;
  const progressFinished = progress.filter((event) => event.kind === "case_finished");
  const processed = finiteInteger(
    root?.processed_cases
      ?? (root?.status === "finished" ? root?.sample_size : null)
      ?? Math.max(cases.length, progressFinished.length),
    cases.length,
  ) ?? cases.length;
  const hasFailure = root?.status === "failed" || root?.status === "error" || finished?.ok === false;
  const status = root?.status === "finished"
    ? "finished"
    : hasFailure
      ? "failed"
      : total > 0 && processed >= total && finished
        ? "finished"
        : "running";
  const counts = outcomeCounts(cases);
  if (!cases.length && progressFinished.length) {
    for (const event of progressFinished) {
      const outcome = statusOutcome({ status: event.status });
      counts[outcome] = (counts[outcome] ?? 0) + 1;
    }
  }
  const updated = latestEvent(progress, receiptEvents);
  const startedAt = started?.utc ?? root?.created_utc ?? null;
  const updatedAt = updated?.utc ?? root?.created_utc ?? null;
  const acceptedRate = processed ? counts.accepted / processed : 0;
  const run = {
    id,
    status,
    status_label: runStatusLabel(status),
    run_success: status === "finished",
    provider: root?.provider ?? started?.provider ?? null,
    model: root?.model ?? started?.model ?? null,
    effort: root?.effort ?? started?.effort ?? null,
    workers: finiteInteger(root?.workers ?? started?.workers),
    dispatch: root?.dispatch ?? started?.dispatch ?? null,
    sample_size: total,
    processed_cases: processed,
    percent: total ? clamp((processed / total) * 100, 0, 100) : 0,
    counts,
    accepted_rate: acceptedRate,
    started_utc: startedAt,
    updated_utc: updatedAt,
    error: root?.error ?? finished?.error ?? null,
    receipt_file: `${id}.receipts.jsonl`,
    output_file: root ? `${id}.json` : null,
    receipt_count: cases.length,
    _root: root,
    _cases: cases,
  };
  runCache.set(id, {
    root,
    progress,
    receiptEvents,
    sourceLength: sourceCases.length,
    cases,
  });
  return run;
}

function sortRuns(left, right) {
  const group = (run) => run.run_success ? 0 : run.status === "running" ? 1 : 2;
  const groupDifference = group(left) - group(right);
  if (groupDifference) return groupDifference;
  if (group(left) === 0) {
    const rateDifference = right.accepted_rate - left.accepted_rate;
    if (Math.abs(rateDifference) > 1e-9) return rateDifference;
    const acceptedDifference = right.counts.accepted - left.counts.accepted;
    if (acceptedDifference) return acceptedDifference;
  }
  return (Date.parse(right.updated_utc ?? "") || 0) - (Date.parse(left.updated_utc ?? "") || 0)
    || left.id.localeCompare(right.id);
}

function publicRun(run) {
  const { _root, _cases, ...publicValue } = run;
  return publicValue;
}

async function allRuns() {
  const ids = await discoverRunIds();
  const runs = await Promise.all(ids.map((id) => readRun(id)));
  return runs.sort(sortRuns);
}

function aggregateRuns(runs) {
  const cases = runs.flatMap((run) => run._cases);
  const counts = {
    accepted: 0,
    rejected: 0,
    structure_unavailable: 0,
    case_failed: 0,
    unknown: 0,
    separate_opinion: 0,
  };
  for (const run of runs) {
    for (const key of Object.keys(counts)) counts[key] += run.counts[key] ?? 0;
  }
  const total = runs.reduce((sum, run) => sum + run.sample_size, 0);
  const processed = runs.reduce((sum, run) => sum + run.processed_cases, 0);
  const dates = runs
    .flatMap((run) => [run.started_utc, run.updated_utc])
    .filter(Boolean)
    .map((value) => ({ value, time: Date.parse(value) }))
    .filter((item) => Number.isFinite(item.time));
  return {
    id: "all",
    display_name: "All seeds / runs",
    status: "aggregate",
    status_label: "All seeds / runs",
    run_success: runs.length > 0 && runs.every((run) => run.run_success),
    provider: "mixed",
    model: "mixed",
    effort: null,
    workers: null,
    dispatch: null,
    sample_size: total,
    processed_cases: processed,
    percent: total ? clamp((processed / total) * 100, 0, 100) : 0,
    counts,
    accepted_rate: processed ? counts.accepted / processed : 0,
    started_utc: dates.length ? new Date(Math.min(...dates.map((item) => item.time))).toISOString() : null,
    updated_utc: dates.length ? new Date(Math.max(...dates.map((item) => item.time))).toISOString() : null,
    error: null,
    receipt_file: null,
    output_file: null,
    receipt_count: cases.length,
    _root: null,
    _cases: cases,
  };
}

function progressFor(run) {
  if (!run) return null;
  return {
    run_id: run.id,
    status: run.status,
    processed: run.processed_cases,
    total: run.sample_size,
    percent: run.percent,
    accepted: run.counts.accepted,
    rejected: run.counts.rejected,
    structure_unavailable: run.counts.structure_unavailable,
    failed: run.counts.case_failed,
    separate_opinion: run.counts.separate_opinion,
    updated_utc: run.updated_utc,
  };
}

function caseSort(left, right, sortMode = "outcome") {
  if (sortMode === "separate_first") {
    const separateDifference = Number(Boolean(right.separate_opinion)) - Number(Boolean(left.separate_opinion));
    if (separateDifference) return separateDifference;
  }
  return outcomeRank(left.outcome) - outcomeRank(right.outcome)
    || String(left.citation ?? "").localeCompare(String(right.citation ?? ""), undefined, { numeric: true })
    || (left.document_id ?? 0) - (right.document_id ?? 0);
}

function caseMatches(item, query, outcome, panel) {
  if (outcome && outcome !== "all" && item.outcome !== outcome) return false;
  if (panel === "separate" && !item.separate_opinion) return false;
  if (panel === "single" && item.separate_opinion) return false;
  if (!query) return true;
  const haystack = [
    item.citation,
    item.name,
    item.dataset,
    item.document_id,
    ...item.judges.map((judge) => `${judge.name} ${judge.role}`),
    ...item.opinions.flatMap((opinion) => [opinion.alignment, ...opinion.authors]),
  ].filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(query.toLowerCase());
}

async function serveCases(url, response, frontendUrl) {
  const id = url.searchParams.get("run")?.trim() || "all";
  if (id !== "all" && !RUN_ID.test(id)) return errorResponse(response, 400, "invalid run id");
  const runs = await allRuns();
  const run = id === "all" ? aggregateRuns(runs) : runs.find((candidate) => candidate.id === id);
  if (!run) return errorResponse(response, 404, "run not found");
  const page = clamp(finiteInteger(url.searchParams.get("page"), 1) ?? 1, 1, 1000000);
  const pageSize = clamp(
    finiteInteger(url.searchParams.get("page_size"), DEFAULT_PAGE_SIZE) ?? DEFAULT_PAGE_SIZE,
    1,
    MAX_PAGE_SIZE,
  );
  const query = url.searchParams.get("q")?.trim() ?? "";
  const outcome = url.searchParams.get("outcome")?.trim() ?? "all";
  const requestedPanel = url.searchParams.get("panel")?.trim() ?? "all";
  const panel = ["all", "separate", "single"].includes(requestedPanel) ? requestedPanel : "all";
  const requestedSort = url.searchParams.get("sort")?.trim() ?? "outcome";
  const sortMode = ["outcome", "separate_first"].includes(requestedSort) ? requestedSort : "outcome";
  const filtered = run._cases
    .filter((item) => caseMatches(item, query, outcome, panel))
    .sort((left, right) => caseSort(left, right, sortMode));
  const start = (page - 1) * pageSize;
  return jsonResponse(response, 200, {
    run: publicRun(run),
    page,
    page_size: pageSize,
    panel,
    sort: sortMode,
    total: filtered.length,
    cases: filtered.slice(start, start + pageSize).map((item) => withLinks(item, frontendUrl)),
  });
}

async function serveRawReceipts(url, response) {
  const id = url.searchParams.get("run") ?? "";
  if (!RUN_ID.test(id)) return errorResponse(response, 400, "invalid run id");
  const streamFile = path.join(RUN_DIR, `${id}.receipts.jsonl`);
  try {
    const body = await readFile(streamFile);
    response.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-disposition": `attachment; filename="${id}.receipts.jsonl"`,
      "cache-control": "no-store",
      "content-length": body.length,
    });
    response.end(body);
    return;
  } catch {
    const root = await readJsonCached(path.join(RUN_DIR, `${id}.json`));
    if (!root) return errorResponse(response, 404, "receipt stream not found");
    const body = JSON.stringify(root, null, 2);
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${id}.json"`,
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(body),
    });
    response.end(body);
  }
}

async function start() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) {
    const item = normalizeCase({
      source: { document_id: 7, dataset: "BCCA", citation: "2020 BCCA 7" },
      status: "accepted",
      prediction: {
        judges: [
          { name: "Justice Example", role: "majority" },
          { name: "Justice Labelled Concurring", role: "concurring" },
        ],
        spans: { majority: [[1, 4]], minority: [], concurring: [], unknown: [] },
      },
      structure: { status: "usable", paragraph_count: 4 },
    });
    assert.equal(item.outcome, "accepted");
    assert.equal(item.separate_opinion, false);
    assert.deepEqual(item.spans.majority, [{ from: 1, to: 4 }]);
    assert.equal(sourceUrl("http://127.0.0.1:3000", item, { from: 1, to: 4 }), "http://127.0.0.1:3000/sources/view?provider=a2aj&citation=2020+BCCA+7&doc_type=cases&language=en&dataset=BCCA#legal-par1");
    assert.equal(caseSort({ outcome: "accepted", citation: "z" }, { outcome: "rejected", citation: "a" }) < 0, true);
    const separate = normalizeCase({
      source: { document_id: 8, citation: "2020 BCCA 8" },
      status: "accepted",
      prediction: {
        judges: [
          { name: "Justice Example", role: "majority" },
          { name: "Justice Separate", role: "concurring" },
        ],
        spans: { majority: [[1, 3]], minority: [], concurring: [[4, 4]], unknown: [] },
      },
      structure: { status: "usable", paragraph_count: 4 },
    });
    assert.equal(separate.separate_opinion, true);
    assert.equal(caseSort(separate, item, "separate_first") < 0, true);
    const richer = normalizeCase({
      source: { document_id: 9, citation: "2020 BCCA 9" },
      status: "accepted",
      prediction: {
        opinions: [
          { id: "o1", authors: ["Alpha"], alignment: "lead", start: 100, end_exclusive: 800, paragraphs: [{ from: 1, to: 4 }] },
          { id: "o2", authors: ["Beta"], alignment: "different_result", start: 801, end_exclusive: 1100, paragraphs: [{ from: 5, to: 6 }] },
        ],
        judges: [
          { name: "Alpha", result_side: "majority", relationship: "authors", opinion_ids: ["o1"] },
          { name: "Beta", result_side: "minority", relationship: "authors", opinion_ids: ["o2"] },
        ],
      },
    });
    assert.equal(richer.separate_opinion, true);
    assert.deepEqual(richer.spans.minority, [{ from: 5, to: 6 }]);
    assert.equal(withLinks(richer, "http://127.0.0.1:3000").ranges[1].label, "chars 801-1100");
    console.log("PASS decision-roster dashboard self-test");
    return;
  }
  const dashboard = await readFile(DASHBOARD_FILE, "utf8");
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (url.pathname === "/" || url.pathname === "/index.html") {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-length": Buffer.byteLength(dashboard),
        });
        response.end(dashboard);
        return;
      }
      if (url.pathname === "/api/state") {
        const runs = await allRuns();
        const active = runs.find((run) => run.status === "running") ?? null;
        return jsonResponse(response, 200, {
          generated_utc: new Date().toISOString(),
          active_run_id: active?.id ?? null,
          active_progress: progressFor(active),
          runs: [aggregateRuns(runs), ...runs].map(publicRun),
        });
      }
      if (url.pathname === "/api/cases") return await serveCases(url, response, options.frontendUrl);
      if (url.pathname === "/api/receipts") return await serveRawReceipts(url, response);
      if (url.pathname === "/api/health") return jsonResponse(response, 200, { ok: true });
      return errorResponse(response, 404, "not found");
    } catch (error) {
      return errorResponse(response, 500, error instanceof Error ? error.message : "dashboard error");
    }
  });
  server.listen(options.port, options.host, () => {
    console.log(`decision-roster dashboard http://${options.host}:${options.port}/`);
    console.log(`source links use ${options.frontendUrl}`);
  });
}

start().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

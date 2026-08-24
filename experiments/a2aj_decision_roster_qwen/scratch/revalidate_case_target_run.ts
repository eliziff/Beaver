import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import {
  candidatesFromPairFile,
  CASE_TARGET_MVP_COMPILER_VERSION,
  CASE_TARGET_MVP_VALIDATOR_VERSION,
  loadCase,
  validateCaseTargetSubmission,
} from "../runner";

type FrozenAnswer = {
  parsed: unknown;
  raw: string;
  rawSha256: string;
  sourceFile: string;
  sourceLine: number;
  claimedSha256: string | null;
  occurrenceContract: FrozenOccurrenceContract | null;
  deterministicContract: FrozenDeterministicContract | null;
};

type FrozenTargetOccurrence = {
  id: string;
  kind: "citation" | "case_name";
  quote: string;
  start: number;
  end: number;
  citationKey: string;
  linkedContext: { kind: "footnote_reference"; quote: string; start: number; end: number } | null;
};

type FrozenOccurrenceContract = {
  version: string;
  sourceSha256: string;
  occurrences: FrozenTargetOccurrence[];
  judgeCandidates: string[];
  paragraphCount: number;
  contractSha256: string;
  sourceFile: string;
  sourceLine: number;
};

type FrozenDeterministicContract = {
  sourceSha256: string;
  deterministic: Record<string, unknown>;
  contractSha256: string;
  sourceFile: string;
  sourceLine: number;
};

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function flag(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? "" : "";
}

function frozenAnswer(
  event: Record<string, unknown>,
  sourceFile: string,
  sourceLine: number,
  occurrenceContract: FrozenOccurrenceContract | null,
  deterministicContract: FrozenDeterministicContract | null,
): FrozenAnswer | null {
  if (event.kind !== "model_output" || typeof event.raw_model_output !== "string") return null;
  let parsed: unknown = null;
  try { parsed = JSON.parse(event.raw_model_output); } catch { /* fail closed without changing the retained bytes */ }
  return {
    parsed,
    raw: event.raw_model_output,
    rawSha256: sha256(event.raw_model_output),
    sourceFile,
    sourceLine,
    claimedSha256: typeof event.output_sha256 === "string" ? event.output_sha256 : null,
    occurrenceContract,
    deterministicContract,
  };
}

function frozenOccurrenceContract(
  event: Record<string, unknown>,
  sourceFile: string,
  sourceLine: number,
): FrozenOccurrenceContract | null {
  if (event.kind !== "case_loaded") return null;
  const version = event.target_occurrence_version;
  const sourceSha256 = event.source_sha256;
  const judgeCandidates = event.judge_candidates;
  const paragraphCount = event.paragraph_count;
  if (typeof version !== "string" || !version || typeof sourceSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(sourceSha256)) {
    throw new Error(`${sourceFile}:${sourceLine}: case_loaded is missing its frozen occurrence version or source hash`);
  }
  if (!Array.isArray(judgeCandidates) || judgeCandidates.some((name) => typeof name !== "string") ||
      !Number.isSafeInteger(paragraphCount) || Number(paragraphCount) < 0) {
    throw new Error(`${sourceFile}:${sourceLine}: case_loaded is missing its frozen validation hints`);
  }
  if (!Array.isArray(event.target_occurrences) || event.target_occurrences.length === 0) {
    throw new Error(`${sourceFile}:${sourceLine}: case_loaded is missing frozen target occurrences`);
  }
  const occurrences = event.target_occurrences.map((value, index): FrozenTargetOccurrence => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${sourceFile}:${sourceLine}: target_occurrences[${index}] is invalid`);
    const row = value as Record<string, unknown>;
    const linked = row.linkedContext;
    const linkedContext = linked === null
      ? null
      : linked && typeof linked === "object" && !Array.isArray(linked)
        ? {
            kind: (linked as Record<string, unknown>).kind,
            quote: (linked as Record<string, unknown>).quote,
            start: (linked as Record<string, unknown>).start,
            end: (linked as Record<string, unknown>).end,
          }
        : undefined;
    if (
      typeof row.id !== "string" || !row.id ||
      (row.kind !== "citation" && row.kind !== "case_name") ||
      typeof row.quote !== "string" || !row.quote ||
      typeof row.start !== "number" || typeof row.end !== "number" ||
      !Number.isSafeInteger(row.start) || !Number.isSafeInteger(row.end) || row.start < 0 || row.end <= row.start ||
      typeof row.citationKey !== "string" || !row.citationKey ||
      linkedContext === undefined ||
      (linkedContext !== null && (
        linkedContext.kind !== "footnote_reference" || typeof linkedContext.quote !== "string" || !linkedContext.quote ||
        typeof linkedContext.start !== "number" || typeof linkedContext.end !== "number" ||
        !Number.isSafeInteger(linkedContext.start) || !Number.isSafeInteger(linkedContext.end) ||
        linkedContext.start < 0 || linkedContext.end <= linkedContext.start
      ))
    ) throw new Error(`${sourceFile}:${sourceLine}: target_occurrences[${index}] is invalid`);
    return {
      id: row.id,
      kind: row.kind,
      quote: row.quote,
      start: Number(row.start),
      end: Number(row.end),
      citationKey: row.citationKey,
      linkedContext: linkedContext === null ? null : {
        kind: "footnote_reference",
        quote: linkedContext.quote as string,
        start: Number(linkedContext.start),
        end: Number(linkedContext.end),
      },
    };
  });
  if (new Set(occurrences.map(({ id }) => id)).size !== occurrences.length) {
    throw new Error(`${sourceFile}:${sourceLine}: frozen target occurrence IDs are not unique`);
  }
  const contractSha256 = sha256(JSON.stringify({ version, source_sha256: sourceSha256, occurrences }));
  return {
    version,
    sourceSha256,
    occurrences,
    judgeCandidates: judgeCandidates as string[],
    paragraphCount: Number(paragraphCount),
    contractSha256,
    sourceFile,
    sourceLine,
  };
}

function frozenDeterministicContract(
  event: Record<string, unknown>,
  sourceFile: string,
  sourceLine: number,
): FrozenDeterministicContract | null {
  if (event.kind !== "case_receipt") return null;
  const receipt = event.receipt;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new Error(`${sourceFile}:${sourceLine}: case_receipt is missing its receipt`);
  }
  const row = receipt as Record<string, unknown>;
  const source = row.source;
  const deterministic = row.deterministic;
  const sourceSha256 = source && typeof source === "object" && !Array.isArray(source)
    ? (source as Record<string, unknown>).source_sha256
    : null;
  if (typeof sourceSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(sourceSha256) ||
      !deterministic || typeof deterministic !== "object" || Array.isArray(deterministic)) {
    throw new Error(`${sourceFile}:${sourceLine}: case_receipt is missing its source hash or deterministic receipt`);
  }
  const value = deterministic as Record<string, unknown>;
  if (!Array.isArray(value.panel) || value.panel.some((name) => typeof name !== "string") ||
      !Array.isArray(value.judges) || value.judges.some((judge) =>
        !judge || typeof judge !== "object" || Array.isArray(judge) ||
        typeof (judge as Record<string, unknown>).name !== "string")) {
    throw new Error(`${sourceFile}:${sourceLine}: deterministic receipt has an invalid panel or judge list`);
  }
  return {
    sourceSha256,
    deterministic: value,
    contractSha256: sha256(JSON.stringify(value)),
    sourceFile,
    sourceLine,
  };
}

async function occurrenceContracts(file: string) {
  const byDocument = new Map<number, FrozenOccurrenceContract>();
  let sourceLine = 0;
  const lines = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
  for await (const line of lines) {
    sourceLine += 1;
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const contract = frozenOccurrenceContract(event, file, sourceLine);
    const documentId = Number(event.document ?? event.document_id);
    if (!contract || !Number.isSafeInteger(documentId)) continue;
    const existing = byDocument.get(documentId);
    if (existing && existing.contractSha256 !== contract.contractSha256) {
      throw new Error(`${file}:${sourceLine}: conflicting frozen occurrence contracts for ${documentId}`);
    }
    if (!existing) byDocument.set(documentId, contract);
  }
  return byDocument;
}

async function deterministicContracts(file: string) {
  const byDocument = new Map<number, FrozenDeterministicContract>();
  let sourceLine = 0;
  const lines = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
  for await (const line of lines) {
    sourceLine += 1;
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const contract = frozenDeterministicContract(event, file, sourceLine);
    const documentId = Number(event.document ?? event.document_id);
    if (!contract || !Number.isSafeInteger(documentId)) continue;
    const existing = byDocument.get(documentId);
    if (existing && existing.contractSha256 !== contract.contractSha256) {
      throw new Error(`${file}:${sourceLine}: conflicting deterministic receipts for ${documentId}`);
    }
    if (!existing) byDocument.set(documentId, contract);
  }
  return byDocument;
}

function validateFrozenOccurrences(source: string, sourceSha256: string, contract: FrozenOccurrenceContract) {
  if (contract.sourceSha256 !== sourceSha256) throw new Error(`frozen occurrence source hash ${contract.sourceSha256} does not match ${sourceSha256}`);
  for (const [index, occurrence] of contract.occurrences.entries()) {
    if (occurrence.end > source.length || source.slice(occurrence.start, occurrence.end) !== occurrence.quote) {
      throw new Error(`frozen target occurrence ${index} (${occurrence.id}) does not match its exact source span`);
    }
    const linked = occurrence.linkedContext;
    if (linked && (linked.end > source.length || source.slice(linked.start, linked.end) !== linked.quote)) {
      throw new Error(`frozen linked context for ${occurrence.id} does not match its exact source span`);
    }
  }
  return contract.occurrences;
}

async function outputs(files: string[], progressFiles: string[], receiptFiles: string[]) {
  const byDocument = new Map<number, FrozenAnswer>();
  for (const [fileIndex, file] of files.entries()) {
    const contracts = await occurrenceContracts(progressFiles[fileIndex]);
    const deterministic = await deterministicContracts(receiptFiles[fileIndex]);
    let sourceLine = 0;
    const lines = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
    for await (const line of lines) {
      sourceLine += 1;
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        const documentId = Number(event.document ?? event.document_id);
        const answer = frozenAnswer(
          event,
          file,
          sourceLine,
          contracts.get(documentId) ?? null,
          deterministic.get(documentId) ?? null,
        );
        if (answer && Number.isSafeInteger(documentId)) byDocument.set(documentId, answer);
      } catch {
        // Interrupted JSONL may end with one truncated event. Earlier complete
        // raw answers remain independently recompilable.
      }
    }
  }
  return byDocument;
}

function canonicalEvent(
  candidate: { documentId: number; citation: string },
  sourceSha256: string,
  answer: FrozenAnswer,
  validated: ReturnType<typeof validateCaseTargetSubmission>,
) {
  const occurrenceContract = answer.occurrenceContract;
  const deterministicContract = answer.deterministicContract;
  if (!occurrenceContract) throw new Error(`missing frozen occurrence contract for ${candidate.documentId}`);
  if (!deterministicContract) throw new Error(`missing frozen deterministic contract for ${candidate.documentId}`);
  const canonical = {
    compiler_version: CASE_TARGET_MVP_COMPILER_VERSION,
    validator_version: CASE_TARGET_MVP_VALIDATOR_VERSION,
    source_sha256: sourceSha256,
    raw_output_sha256: answer.rawSha256,
    target_occurrence_version: occurrenceContract.version,
    target_occurrence_set_sha256: occurrenceContract.contractSha256,
    target_occurrences: occurrenceContract.occurrences,
    prediction: validated.prediction,
    case_target_mvp: validated.case_target_mvp,
    compiler_errors: validated.compiler_errors,
    opinion_validation: validated.validation,
  };
  return {
    kind: "canonical_model_output",
    origin: "offline_recompile",
    document: candidate.documentId,
    citation: candidate.citation,
    ...canonical,
    canonical_output_sha256: sha256(JSON.stringify(canonical)),
    recompile_receipt: {
      model_call_made: false,
      source_output_file: answer.sourceFile,
      source_event_line: answer.sourceLine,
      raw_output_bytes: Buffer.byteLength(answer.raw, "utf8"),
      raw_output_sha256: answer.rawSha256,
      claimed_raw_output_sha256: answer.claimedSha256,
      claimed_hash_matches: answer.claimedSha256 === null ? null : answer.claimedSha256 === answer.rawSha256,
      source_progress_file: occurrenceContract.sourceFile,
      source_progress_event_line: occurrenceContract.sourceLine,
      target_occurrence_version: occurrenceContract.version,
      target_occurrence_count: occurrenceContract.occurrences.length,
      target_occurrence_set_sha256: occurrenceContract.contractSha256,
      deterministic_receipt_file: deterministicContract.sourceFile,
      deterministic_receipt_line: deterministicContract.sourceLine,
      deterministic_receipt_sha256: deterministicContract.contractSha256,
      paragraph_projection: "deferred_from_exact_character_offsets",
    },
  };
}

async function main() {
  if (process.argv.includes("--self-test")) {
    const source = "The court applied 2020 Test 1.";
    const sourceSha256 = sha256(source);
    const contract = frozenOccurrenceContract({
      kind: "case_loaded",
      document: 1,
      source_sha256: sourceSha256,
      target_occurrence_version: "frozen-test-v1",
      judge_candidates: ["Example J."],
      paragraph_count: 1,
      target_occurrences: [{
        id: "tm1", kind: "citation", quote: "2020 Test 1", start: 18, end: 29,
        citationKey: "2020test1", linkedContext: null,
      }],
    }, "progress.jsonl", 3);
    if (!contract || validateFrozenOccurrences(source, sourceSha256, contract).length !== 1) {
      throw new Error("frozen occurrence contract self-test failed");
    }
    const deterministic = frozenDeterministicContract({
      kind: "case_receipt",
      document: 1,
      receipt: {
        source: { source_sha256: sourceSha256 },
        deterministic: { status: "unavailable", panel: [], judges: [], nonparticipants: [], opinions: [], refusals: [] },
      },
    }, "receipts.jsonl", 2);
    if (!deterministic) throw new Error("frozen deterministic receipt self-test failed");
    const raw = "{\n  \"opinions\": []\n}\n";
    const answer = frozenAnswer(
      { kind: "model_output", raw_model_output: raw, output_sha256: sha256(raw) },
      "raw.jsonl",
      7,
      contract,
      deterministic,
    );
    if (!answer || answer.raw !== raw || answer.sourceLine !== 7 || answer.rawSha256 !== sha256(raw) || answer.claimedSha256 !== answer.rawSha256) {
      throw new Error("offline recompilation receipt self-test failed");
    }
    const event = canonicalEvent({ documentId: 1, citation: "2020 Test 1" }, sourceSha256, answer, {
      prediction: null,
      validation: { ok: false, error: "test rejection" },
      case_target_mvp: null,
      compiler_errors: ["test rejection"],
    } as ReturnType<typeof validateCaseTargetSubmission>);
    const { kind: _kind, origin: _origin, document: _document, citation: _citation, canonical_output_sha256: canonicalHash, recompile_receipt: receipt, ...canonical } = event;
    if (
      canonicalHash !== sha256(JSON.stringify(canonical)) || receipt.model_call_made !== false || "raw_model_output" in event ||
      receipt.target_occurrence_version !== "frozen-test-v1" || receipt.target_occurrence_count !== 1 ||
      receipt.target_occurrence_set_sha256 !== contract.contractSha256
    ) {
      throw new Error("canonical recompilation event self-test failed");
    }
    console.log("PASS offline recompilation receipt self-test");
    return;
  }
  const pairFile = process.argv[2];
  const outputFile = process.argv[3];
  const progressFile = flag("--progress");
  const receiptFile = flag("--receipts");
  if (!pairFile || !outputFile || !progressFile || !receiptFile) {
    throw new Error("usage: revalidate_case_target_run.ts <pairs.json> <outputs.jsonl[,outputs.jsonl]> --progress <progress.jsonl[,progress.jsonl]> --receipts <receipts.jsonl[,receipts.jsonl]> [--canonical-out immutable.jsonl] [--out report.json] [--summary]");
  }
  const startedAt = performance.now();
  const outputFiles = outputFile.split(",").map((file) => path.resolve(file));
  const progressFiles = progressFile.split(",").map((file) => path.resolve(file));
  const receiptFiles = receiptFile.split(",").map((file) => path.resolve(file));
  if (outputFiles.length !== progressFiles.length || outputFiles.length !== receiptFiles.length) {
    throw new Error("each historical output file requires matching --progress and --receipts files in the same list position");
  }
  const rawByDocument = await outputs(outputFiles, progressFiles, receiptFiles);
  const candidates = await candidatesFromPairFile(path.resolve(pairFile));
  const canonicalDestination = flag("--canonical-out");
  const canonicalPath = canonicalDestination ? path.resolve(canonicalDestination) : null;
  if (canonicalPath) await mkdir(path.dirname(canonicalPath), { recursive: true });
  const canonicalHandle = canonicalPath ? await open(canonicalPath, "wx") : null;
  const retained = candidates.filter((candidate) => rawByDocument.has(candidate.documentId));
  const missingRaw = candidates.filter((candidate) => !rawByDocument.has(candidate.documentId));
  let writes = Promise.resolve();
  try {
    let completed = 0;
    const settled = await Promise.allSettled(retained.map(async (candidate) => {
      const answer = rawByDocument.get(candidate.documentId);
      const liveRecord = await loadCase(candidate);
      if (!liveRecord || !answer) throw new Error(`missing case or frozen input for ${candidate.documentId}`);
      const document = liveRecord.document;
      if (!answer.occurrenceContract) throw new Error(`missing frozen occurrence contract for ${candidate.documentId}`);
      if (!answer.deterministicContract) throw new Error(`missing frozen deterministic contract for ${candidate.documentId}`);
      const sourceSha256 = sha256(document.text);
      if (answer.deterministicContract.sourceSha256 !== sourceSha256) {
        throw new Error(`frozen deterministic source hash ${answer.deterministicContract.sourceSha256} does not match ${sourceSha256}`);
      }
      const targetOccurrences = validateFrozenOccurrences(document.text, sourceSha256, answer.occurrenceContract);
      const historicalRecord = {
        ...liveRecord,
        candidate,
        // Paragraph projection is deliberately deferred. The semantic graph is
        // grounded to exact character offsets; rebuilding corpus structure is
        // not part of recompiling a retained model answer.
        paragraphs: [],
        deterministic: answer.deterministicContract.deterministic,
        hints: {
          judgeCandidates: answer.occurrenceContract.judgeCandidates,
          opinions: [],
          header: "",
          status: "unavailable",
        },
        targetOccurrences,
      } as unknown as Parameters<typeof validateCaseTargetSubmission>[0];
      const validated = validateCaseTargetSubmission(historicalRecord, answer.parsed);
      const event = canonicalEvent(candidate, sourceSha256, answer, validated);
      if (canonicalHandle) {
        writes = writes.then(() => canonicalHandle.appendFile(`${JSON.stringify(event)}\n`, "utf8"));
        await writes;
      }
      completed += 1;
      process.stderr.write(`[recompile ${completed}/${retained.length}] ${candidate.citation}\n`);
      const roster = { prediction: validated.prediction, validation: validated.validation };
      const target = validated.case_target_mvp;
      return {
        document_id: candidate.documentId,
        citation: candidate.citation,
        raw_output_sha256: answer.rawSha256,
        canonical_output_sha256: event.canonical_output_sha256,
        target_occurrence_version: answer.occurrenceContract.version,
        target_occurrence_count: answer.occurrenceContract.occurrences.length,
        target_occurrence_set_sha256: answer.occurrenceContract.contractSha256,
        opinion_ok: roster.validation.ok,
        target_ok: target?.ok ?? false,
        errors: target?.errors ?? roster.validation.errors ?? [roster.validation.error ?? "unknown rejection"],
        counts: target?.counts ?? null,
        flat_treatment: target?.flat_treatment ?? null,
        rejections: target?.rejections ?? null,
      };
    }));
    await writes;
    const failures = settled.flatMap((item, index) => item.status === "rejected"
      ? [{ document_id: retained[index].documentId, citation: retained[index].citation, error: item.reason instanceof Error ? item.reason.message : String(item.reason) }]
      : []);
    const results = settled.flatMap((item) => item.status === "fulfilled" ? [item.value] : []);
    const report = {
      compiler_version: CASE_TARGET_MVP_COMPILER_VERSION,
      validator_version: CASE_TARGET_MVP_VALIDATOR_VERSION,
      canonical_event_file: canonicalPath,
      model_calls_made: 0,
      requested_cases: candidates.length,
      cases: results.length,
      missing_raw_cases: missingRaw.map(({ documentId, citation }) => ({ document_id: documentId, citation })),
      recompile_failures: failures,
      opinion_ok: results.filter(({ opinion_ok }) => opinion_ok).length,
      target_ok: results.filter(({ target_ok }) => target_ok).length,
      elapsed_ms: Math.round((performance.now() - startedAt) * 10) / 10,
      results,
    };
    const reportDestination = flag("--out");
    if (reportDestination) {
      await writeFile(path.resolve(reportDestination), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }
    console.log(JSON.stringify(process.argv.includes("--summary") ? {
      validator_version: report.validator_version,
      compiler_version: report.compiler_version,
      canonical_event_file: report.canonical_event_file,
      model_calls_made: report.model_calls_made,
      requested_cases: report.requested_cases,
      cases: report.cases,
      missing_raw_cases: report.missing_raw_cases,
      recompile_failures: report.recompile_failures,
      opinion_ok: report.opinion_ok,
      target_ok: report.target_ok,
      elapsed_ms: report.elapsed_ms,
      results: results.map(({ document_id, citation, target_occurrence_version, target_occurrence_count, target_occurrence_set_sha256, opinion_ok, target_ok, errors, counts, flat_treatment }) => ({
        document_id,
        citation,
        target_occurrence_version,
        target_occurrence_count,
        target_occurrence_set_sha256,
        opinion_ok,
        target_ok,
        errors,
        accepted_positions: counts?.accepted_opinion_positions ?? 0,
        accepted_mentions: counts?.accepted_target_mentions ?? 0,
        accepted_treatments: counts?.accepted_target_treatments ?? 0,
        accepted_direct_history: counts?.accepted_target_direct_history ?? 0,
        controlling_labels: flat_treatment?.controlling_labels ?? [],
        other_judicial_labels: flat_treatment?.other_judicial_labels ?? [],
        attributed_labels: flat_treatment?.attributed_labels ?? [],
      })),
    } : report, null, 2));
  } finally {
    await canonicalHandle?.close();
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });

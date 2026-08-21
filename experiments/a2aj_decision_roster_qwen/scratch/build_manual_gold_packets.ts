import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  CASE_TARGET_OCCURRENCE_VERSION,
  detectCaseTargetOccurrences,
} from "../../../backend/experiments/a2aj-decision-roster/caseTargetMvp.ts";
import { fetchLocalA2AJDocumentsByIds } from "../../../backend/src/lib/a2ajLocalBulk.ts";
import { createTextSourceDoc } from "../../../backend/src/lib/sourceDoc.ts";
import { validateGold } from "./gold_validation.ts";

type Json = Record<string, any>;
type Role = "author" | "reviewer";

const PACKET_FORMAT = "a2aj-case-target-blind-review-packet-v1";
const INDEX_FORMAT = "a2aj-case-target-blind-review-index-v1";
const ANNOTATION_FORMAT = "a2aj-case-target-frozen-annotation-v1";
const RECEIPT_FORMAT = "a2aj-case-target-adjudication-receipt-v1";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function flag(name: string, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function encoded(value: unknown) {
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function valueSha256(value: unknown) {
  return sha256(encoded(value));
}

function isoDate(value: string, label: string) {
  assert(/^\d{4}-\d{2}-\d{2}$/u.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), `${label}: expected YYYY-MM-DD`);
  return value;
}

async function jsonFile(filename: string) {
  return JSON.parse(await readFile(filename, "utf8")) as Json;
}

async function writeNew(filename: string, value: unknown) {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, encoded(value), { encoding: "utf8", flag: "wx" });
}

function safePath(root: string, relative: string) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  assert(resolved.startsWith(`${resolvedRoot}${path.sep}`), `path escapes audit root: ${relative}`);
  return resolved;
}

function occurrenceContract(sourceText: string, target: Json) {
  const occurrences = detectCaseTargetOccurrences(createTextSourceDoc(sourceText), {
    citation: String(target.citation),
    citationAliases: Array.isArray(target.citation_aliases) ? target.citation_aliases : [],
    name: typeof target.name === "string" ? target.name : null,
  }).map(({ id, kind, quote, start, end, citationKey, linkedContext }) => ({
    id, kind, quote, start, end, citation_key: citationKey,
    linked_context: linkedContext && {
      kind: linkedContext.kind,
      quote: linkedContext.quote,
      start: linkedContext.start,
      end: linkedContext.end,
    },
  }));
  assert(occurrences.length, `target ${String(target.citation)} has no deterministic occurrences`);
  return { version: CASE_TARGET_OCCURRENCE_VERSION, occurrences };
}

function occurrenceContracts(cases: Array<{ sourceText: string; target: Json }>) {
  return cases.map(({ sourceText, target }) => occurrenceContract(sourceText, target));
}

function makePacket(pair: Json, document: Json, contract = occurrenceContract(String(document.text ?? ""), pair.target ?? {})) {
  assert(document.dataset === pair.source?.dataset, `${pair.document_id}: dataset changed`);
  assert(document.citation === pair.source?.citation, `${pair.document_id}: citation changed`);
  assert((document.name ?? null) === (pair.source?.name ?? null), `${pair.document_id}: name changed`);
  assert((document.date?.slice(0, 10) ?? null) === (pair.source?.date ?? null), `${pair.document_id}: date changed`);
  const sourceText = String(document.text ?? "");
  const sourceTextSha256 = sha256(sourceText);
  if (pair.selection_receipt?.source_text_sha256) {
    assert(sourceTextSha256 === pair.selection_receipt.source_text_sha256, `${pair.document_id}: source bytes changed`);
  }
  return {
    format: PACKET_FORMAT,
    document_id: Number(pair.document_id),
    source: {
      dataset: document.dataset,
      citation: document.citation,
      name: document.name ?? null,
      date: document.date?.slice(0, 10) ?? null,
      language: document.language,
    },
    target: {
      document_id: Number.isSafeInteger(pair.target?.document_id) ? pair.target.document_id : null,
      citation: pair.target?.citation,
      citation_aliases: Array.isArray(pair.target?.citation_aliases) ? pair.target.citation_aliases : [],
      name: pair.target?.name ?? null,
      same_litigation_eligible: pair.target?.same_litigation_eligible === true,
    },
    source_text_sha256: sourceTextSha256,
    occurrence_contract_sha256: valueSha256(contract),
    occurrence_contract: contract,
    source_text: sourceText,
  };
}

function validatePacket(packet: Json) {
  assert(packet.format === PACKET_FORMAT, "wrong packet format");
  assert(Number.isSafeInteger(packet.document_id), "packet document_id is invalid");
  assert(typeof packet.source_text === "string" && packet.source_text.length > 0, "packet source is empty");
  assert(sha256(packet.source_text) === packet.source_text_sha256, "packet source hash mismatch");
  assert(packet.occurrence_contract?.version === CASE_TARGET_OCCURRENCE_VERSION, "packet occurrence version mismatch");
  assert(valueSha256(packet.occurrence_contract) === packet.occurrence_contract_sha256, "packet occurrence hash mismatch");
  const ids = new Set<string>();
  for (const occurrence of packet.occurrence_contract.occurrences ?? []) {
    assert(typeof occurrence.id === "string" && !ids.has(occurrence.id), "packet occurrence IDs must be unique");
    ids.add(occurrence.id);
    assert(packet.source_text.slice(occurrence.start, occurrence.end) === occurrence.quote, `${occurrence.id}: occurrence moved`);
    if (occurrence.linked_context) {
      assert(packet.source_text.slice(occurrence.linked_context.start, occurrence.linked_context.end) === occurrence.linked_context.quote, `${occurrence.id}: linked context moved`);
    }
  }
  assert(ids.size > 0, "packet has no target occurrences");
  return packet;
}

function assertFrozenOccurrences(pair: Json, contract: Json) {
  const frozen = pair.selection_receipt?.target_occurrences;
  assert(Array.isArray(frozen), `${pair.document_id}: frozen manifest occurrence contract is missing`);
  const identity = (occurrence: Json) => ({
    id: occurrence.id,
    kind: occurrence.kind,
    quote: occurrence.quote,
    start: occurrence.start,
    end: occurrence.end ?? occurrence.end_exclusive,
    citation_key: occurrence.citation_key ?? occurrence.citationKey,
  });
  const expected = frozen.map(identity);
  const actual = contract.occurrences.map(identity);
  assert(encoded(expected) === encoded(actual), `${pair.document_id}: frozen manifest occurrences (${expected.length}) differ from production ${CASE_TARGET_OCCURRENCE_VERSION} (${actual.length})`);
}

function validateAnnotation(packet: Json, annotation: Json) {
  const occurrenceIds = packet.occurrence_contract.occurrences.map(({ id }: Json) => id);
  const errors = validateGold(packet.source_text, annotation, occurrenceIds);
  assert(!errors.length, errors.join("; "));
}

function annotationArtifact(packetBytes: string, packet: Json, role: Role, identity: string, version: string, annotatedOn: string, annotation: Json) {
  assert(identity.trim(), "annotation identity is required");
  assert(version.trim(), "annotation version is required");
  validateAnnotation(packet, annotation);
  return {
    format: ANNOTATION_FORMAT,
    role,
    document_id: packet.document_id,
    packet_sha256: sha256(packetBytes),
    source_text_sha256: packet.source_text_sha256,
    occurrence_contract_sha256: packet.occurrence_contract_sha256,
    identity: identity.trim(),
    version: version.trim(),
    annotated_on: isoDate(annotatedOn, "annotated_on"),
    annotation_sha256: valueSha256(annotation),
    annotation,
  };
}

function validateArtifact(packetBytes: string, packet: Json, artifact: Json, role: Role) {
  assert(artifact.format === ANNOTATION_FORMAT && artifact.role === role, `wrong ${role} artifact`);
  assert(artifact.document_id === packet.document_id, `${role}: document mismatch`);
  assert(artifact.packet_sha256 === sha256(packetBytes), `${role}: packet hash mismatch`);
  assert(artifact.source_text_sha256 === packet.source_text_sha256, `${role}: source hash mismatch`);
  assert(artifact.occurrence_contract_sha256 === packet.occurrence_contract_sha256, `${role}: occurrence hash mismatch`);
  assert(typeof artifact.identity === "string" && artifact.identity.trim(), `${role}: identity missing`);
  assert(typeof artifact.version === "string" && artifact.version.trim(), `${role}: version missing`);
  isoDate(artifact.annotated_on, `${role}.annotated_on`);
  assert(artifact.annotation_sha256 === valueSha256(artifact.annotation), `${role}: annotation hash mismatch`);
  validateAnnotation(packet, artifact.annotation);
}

function pointerPart(value: string) {
  return value.replace(/~/gu, "~0").replace(/\//gu, "~1");
}

function fieldDiff(author: any, reviewer: any, pointer = ""): Json[] {
  if (JSON.stringify(canonical(author)) === JSON.stringify(canonical(reviewer))) return [];
  const authorObject = author && typeof author === "object";
  const reviewerObject = reviewer && typeof reviewer === "object";
  if (authorObject && reviewerObject && Array.isArray(author) === Array.isArray(reviewer)) {
    const keys = Array.isArray(author)
      ? Array.from({ length: Math.max(author.length, reviewer.length) }, (_, index) => String(index))
      : [...new Set([...Object.keys(author), ...Object.keys(reviewer)])].sort();
    return keys.flatMap((key) => {
      const authorPresent = Object.hasOwn(author, key);
      const reviewerPresent = Object.hasOwn(reviewer, key);
      const next = `${pointer}/${pointerPart(key)}`;
      return authorPresent && reviewerPresent
        ? fieldDiff(author[key], reviewer[key], next)
        : [{ path: next, author_present: authorPresent, reviewer_present: reviewerPresent, ...(authorPresent ? { author: author[key] } : {}), ...(reviewerPresent ? { reviewer: reviewer[key] } : {}) }];
    });
  }
  return [{ path: pointer || "/", author_present: true, reviewer_present: true, author, reviewer }];
}

function resolution(author: Json, reviewer: Json, final: Json) {
  const finalValue = JSON.stringify(canonical(final));
  const authorSame = finalValue === JSON.stringify(canonical(author));
  const reviewerSame = finalValue === JSON.stringify(canonical(reviewer));
  return authorSame && reviewerSame ? "agreed" : authorSame ? "author" : reviewerSame ? "reviewer" : "merged";
}

function adjudicationReceipt(args: {
  packetBytes: string; packet: Json; authorBytes: string; author: Json; reviewerBytes: string; reviewer: Json;
  identity: string; version: string; adjudicatedOn: string; summary: string; annotation: Json;
}) {
  validateArtifact(args.packetBytes, args.packet, args.author, "author");
  validateArtifact(args.packetBytes, args.packet, args.reviewer, "reviewer");
  assert(args.author.identity.trim().toLocaleLowerCase() !== args.reviewer.identity.trim().toLocaleLowerCase(), "author and reviewer must be different identities");
  assert(args.identity.trim() && args.version.trim() && args.summary.trim(), "adjudicator identity, version, and summary are required");
  validateAnnotation(args.packet, args.annotation);
  const diff = fieldDiff(args.author.annotation, args.reviewer.annotation);
  return {
    format: RECEIPT_FORMAT,
    document_id: args.packet.document_id,
    packet_sha256: sha256(args.packetBytes),
    source_text_sha256: args.packet.source_text_sha256,
    occurrence_contract_sha256: args.packet.occurrence_contract_sha256,
    author: { identity: args.author.identity, artifact_sha256: sha256(args.authorBytes), annotation_sha256: args.author.annotation_sha256 },
    reviewer: { identity: args.reviewer.identity, artifact_sha256: sha256(args.reviewerBytes), annotation_sha256: args.reviewer.annotation_sha256 },
    field_diff_sha256: valueSha256(diff),
    field_diff: diff,
    adjudicator_identity: args.identity.trim(),
    adjudicator_version: args.version.trim(),
    adjudicated_on: isoDate(args.adjudicatedOn, "adjudicated_on"),
    adjudication_summary: args.summary.trim(),
    resolution: resolution(args.author.annotation, args.reviewer.annotation, args.annotation),
    adjudicated_annotation_sha256: valueSha256(args.annotation),
    adjudicated_annotation: args.annotation,
  };
}

function validateReceipt(packetBytes: string, packet: Json, authorBytes: string, author: Json, reviewerBytes: string, reviewer: Json, receipt: Json) {
  validateArtifact(packetBytes, packet, author, "author");
  validateArtifact(packetBytes, packet, reviewer, "reviewer");
  assert(author.identity.trim().toLocaleLowerCase() !== reviewer.identity.trim().toLocaleLowerCase(), "author and reviewer identities are not independent");
  assert(receipt.format === RECEIPT_FORMAT && receipt.document_id === packet.document_id, "wrong adjudication receipt");
  assert(receipt.packet_sha256 === sha256(packetBytes), "receipt packet hash mismatch");
  assert(receipt.source_text_sha256 === packet.source_text_sha256, "receipt source hash mismatch");
  assert(receipt.occurrence_contract_sha256 === packet.occurrence_contract_sha256, "receipt occurrence hash mismatch");
  assert(receipt.author?.identity === author.identity && receipt.author?.artifact_sha256 === sha256(authorBytes) && receipt.author?.annotation_sha256 === author.annotation_sha256, "receipt author artifact mismatch");
  assert(receipt.reviewer?.identity === reviewer.identity && receipt.reviewer?.artifact_sha256 === sha256(reviewerBytes) && receipt.reviewer?.annotation_sha256 === reviewer.annotation_sha256, "receipt reviewer artifact mismatch");
  const diff = fieldDiff(author.annotation, reviewer.annotation);
  assert(receipt.field_diff_sha256 === valueSha256(diff) && encoded(receipt.field_diff) === encoded(diff), "receipt field diff mismatch");
  assert(typeof receipt.adjudicator_identity === "string" && receipt.adjudicator_identity.trim(), "receipt adjudicator identity missing");
  assert(typeof receipt.adjudicator_version === "string" && receipt.adjudicator_version.trim(), "receipt adjudicator version missing");
  assert(typeof receipt.adjudication_summary === "string" && receipt.adjudication_summary.trim(), "receipt summary missing");
  isoDate(receipt.adjudicated_on, "receipt.adjudicated_on");
  validateAnnotation(packet, receipt.adjudicated_annotation);
  assert(receipt.adjudicated_annotation_sha256 === valueSha256(receipt.adjudicated_annotation), "receipt adjudicated annotation hash mismatch");
  assert(receipt.resolution === resolution(author.annotation, reviewer.annotation, receipt.adjudicated_annotation), "receipt resolution mismatch");
}

async function prepare() {
  const started = performance.now();
  const rootArg = flag("--root");
  const root = path.resolve(rootArg);
  const manifests = flag("--manifests").split(",").filter(Boolean).map((file) => path.resolve(file));
  assert(rootArg && manifests.length, "prepare requires --manifests <a.json,b.json> --root <new-directory>");
  await mkdir(root, { recursive: true });
  assert((await readdir(root)).length === 0, `audit root must be new or empty: ${root}`);
  const pairs = (await Promise.all(manifests.map(async (file) => (await jsonFile(file)).pairs as Json[]))).flat();
  assert(pairs.length > 0, "manifests contain no pairs");
  assert(new Set(pairs.map(({ document_id }) => document_id)).size === pairs.length, "duplicate document_id across manifests");
  const documents = new Map<number, Json>();
  for (const language of ["en", "fr"] as const) {
    const ids = pairs.filter(({ source }) => (source?.language === "fr" ? "fr" : "en") === language).map(({ document_id }) => Number(document_id));
    for (const [id, document] of fetchLocalA2AJDocumentsByIds({ ids, language, maxChars: Number.MAX_SAFE_INTEGER })) documents.set(id, document);
  }
  const sourced = pairs.map((pair) => {
    const document = documents.get(Number(pair.document_id));
    assert(document, `${pair.document_id}: local A2AJ source missing`);
    return { pair, document, sourceText: String(document.text ?? "") };
  });
  const occurrenceStarted = performance.now();
  const contracts = occurrenceContracts(sourced.map(({ pair, sourceText }) => ({ sourceText, target: pair.target ?? {} })));
  const occurrenceMs = +(performance.now() - occurrenceStarted).toFixed(1);
  sourced.forEach(({ pair }, index) => assertFrozenOccurrences(pair, contracts[index]));
  const rows = sourced.map(({ pair, document }, caseIndex) => {
    const packet = validatePacket(makePacket(pair, document, contracts[caseIndex]));
    const bytes = encoded(packet);
    return { packet, bytes, index: {
      document_id: packet.document_id,
      citation: packet.source.citation,
      packet_file: `packets/${packet.document_id}.json`,
      packet_sha256: sha256(bytes),
      source_text_sha256: packet.source_text_sha256,
      occurrence_contract_sha256: packet.occurrence_contract_sha256,
    } };
  });
  await mkdir(path.join(root, "packets"));
  await Promise.all(rows.map(({ bytes, index }) => writeFile(safePath(root, index.packet_file), bytes, { encoding: "utf8", flag: "wx" })));
  const cases = rows.map(({ index }) => index);
  const index = { format: INDEX_FORMAT, occurrence_contract_version: CASE_TARGET_OCCURRENCE_VERSION, cases, cohort_sha256: valueSha256(cases) };
  await writeNew(path.join(root, "index.json"), index);
  console.log(JSON.stringify({ command: "prepare", root, cases: cases.length, source_chars: rows.reduce((sum, { packet }) => sum + packet.source_text.length, 0), cohort_sha256: index.cohort_sha256, occurrence_ms: occurrenceMs, elapsed_ms: +(performance.now() - started).toFixed(1) }, null, 2));
}

async function loadIndexedPacket(root: string, documentId: number) {
  const index = await jsonFile(path.join(root, "index.json"));
  assert(index.format === INDEX_FORMAT && index.cohort_sha256 === valueSha256(index.cases), "audit index is invalid");
  const row = index.cases.find((item: Json) => item.document_id === documentId);
  assert(row, `document ${documentId} is not in the audit index`);
  const bytes = await readFile(safePath(root, row.packet_file), "utf8");
  assert(sha256(bytes) === row.packet_sha256, `${documentId}: packet hash mismatch`);
  const packet = validatePacket(JSON.parse(bytes));
  assert(packet.document_id === documentId && packet.source_text_sha256 === row.source_text_sha256 && packet.occurrence_contract_sha256 === row.occurrence_contract_sha256, `${documentId}: packet index mismatch`);
  return { index, row, bytes, packet };
}

async function freeze() {
  const started = performance.now();
  const root = path.resolve(flag("--root"));
  const documentId = Number(flag("--document"));
  const role = flag("--role") as Role;
  const annotationArg = flag("--annotation");
  assert(flag("--root") && Number.isSafeInteger(documentId) && ["author", "reviewer"].includes(role) && annotationArg, "freeze requires --root, --document, --role author|reviewer, --identity, --version, --date, and --annotation");
  const { bytes, packet } = await loadIndexedPacket(root, documentId);
  const annotation = await jsonFile(path.resolve(annotationArg));
  const artifact = annotationArtifact(bytes, packet, role, flag("--identity"), flag("--version"), flag("--date"), annotation);
  const output = path.join(root, role, `${documentId}.json`);
  await writeNew(output, artifact);
  console.log(JSON.stringify({ command: "freeze", role, document_id: documentId, output, packet_sha256: artifact.packet_sha256, annotation_sha256: artifact.annotation_sha256, artifact_sha256: sha256(encoded(artifact)), elapsed_ms: +(performance.now() - started).toFixed(1) }, null, 2));
}

async function adjudicate() {
  const started = performance.now();
  const root = path.resolve(flag("--root"));
  const documentId = Number(flag("--document"));
  const annotationArg = flag("--annotation");
  assert(flag("--root") && Number.isSafeInteger(documentId) && annotationArg, "adjudicate requires --root, --document, --identity, --version, --date, --summary, and --annotation");
  const { bytes: packetBytes, packet } = await loadIndexedPacket(root, documentId);
  const [authorBytes, reviewerBytes, annotation] = await Promise.all([
    readFile(path.join(root, "author", `${documentId}.json`), "utf8"),
    readFile(path.join(root, "reviewer", `${documentId}.json`), "utf8"),
    jsonFile(path.resolve(annotationArg)),
  ]);
  const author = JSON.parse(authorBytes) as Json;
  const reviewer = JSON.parse(reviewerBytes) as Json;
  const receipt = adjudicationReceipt({ packetBytes, packet, authorBytes, author, reviewerBytes, reviewer, identity: flag("--identity"), version: flag("--version"), adjudicatedOn: flag("--date"), summary: flag("--summary"), annotation });
  const output = path.join(root, "adjudication", `${documentId}.json`);
  await writeNew(output, receipt);
  console.log(JSON.stringify({ command: "adjudicate", document_id: documentId, output, differences: receipt.field_diff.length, resolution: receipt.resolution, receipt_sha256: sha256(encoded(receipt)), elapsed_ms: +(performance.now() - started).toFixed(1) }, null, 2));
}

async function optionalFile(filename: string) {
  try { return await readFile(filename, "utf8"); } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function auditStatus(packetBytes: string, packet: Json, authorBytes: string | null, reviewerBytes: string | null, receiptBytes: string | null) {
  if (!authorBytes || !reviewerBytes || !receiptBytes) {
    if (receiptBytes) throw new Error("receipt exists without both frozen annotations");
    return authorBytes && reviewerBytes ? "awaiting_adjudication" : authorBytes || reviewerBytes ? "awaiting_independent_annotation" : "not_started";
  }
  const author = JSON.parse(authorBytes) as Json;
  const reviewer = JSON.parse(reviewerBytes) as Json;
  validateReceipt(packetBytes, packet, authorBytes, author, reviewerBytes, reviewer, JSON.parse(receiptBytes));
  return "audited";
}

async function verify() {
  const started = performance.now();
  const rootArg = flag("--root");
  const root = path.resolve(rootArg);
  assert(rootArg, "verify requires --root");
  const index = await jsonFile(path.join(root, "index.json"));
  assert(index.format === INDEX_FORMAT && index.cohort_sha256 === valueSha256(index.cases), "audit index is invalid");
  const cases = await Promise.all(index.cases.map(async (row: Json) => {
    const documentId = Number(row.document_id);
    try {
      const { bytes: packetBytes, packet } = await loadIndexedPacket(root, documentId);
      const [authorBytes, reviewerBytes, receiptBytes] = await Promise.all([
        optionalFile(path.join(root, "author", `${documentId}.json`)),
        optionalFile(path.join(root, "reviewer", `${documentId}.json`)),
        optionalFile(path.join(root, "adjudication", `${documentId}.json`)),
      ]);
      return { document_id: documentId, status: auditStatus(packetBytes, packet, authorBytes, reviewerBytes, receiptBytes) };
    } catch (error) {
      return { document_id: documentId, status: "invalid", error: error instanceof Error ? error.message : String(error) };
    }
  }));
  const counts = Object.fromEntries(["audited", "awaiting_adjudication", "awaiting_independent_annotation", "not_started", "invalid"].map((status) => [status, cases.filter((item: Json) => item.status === status).length]));
  console.log(JSON.stringify({ command: "verify", root, total: cases.length, ...counts, cases, elapsed_ms: +(performance.now() - started).toFixed(1) }, null, 2));
  if (counts.invalid) process.exitCode = 1;
}

function exampleAnnotation(answer: string) {
  return {
    disposition_quote: "The appeal is allowed.",
    opinions: [{ opinion_key: "o1", writer_names: ["Alpha J."], collective_writer: null, writer_evidence_quote: "Alpha J.: These are my reasons.", result_position: "supports_disposition", position_evidence_quote: "The appeal is allowed.", start_quote: "Alpha J.: These are my reasons.", end_quote: "End of reasons." }],
    participants: [{ name: "Alpha J.", panel_evidence_quote: "Before: Alpha J.", result_position: "supports_disposition", result_evidence_quote: "The appeal is allowed.", result_only: false, opinion_links: [{ opinion_key: "o1", relation: "authors", issue_keys: [], evidence_quote: "Alpha J.: These are my reasons." }] }],
    issues: [{ issue_key: "s1", question: "Should relief be granted?", answer_groups: [{ answer_group_key: "a1", answer, positions: [{ opinion_key: "o1", relation_to_disposition: "dispositive", answer_evidence_quotes: ["The question is whether relief should be granted."] }] }] }],
    target_mentions: [{ mention_key: "m1", occurrence_id: "tm1", evidence_quote: "I apply 2020 SCC 1 and conclude relief is granted.", voice: "current_court", issue_keys: ["s1"] }],
    target_treatments: [{ mention_keys: ["m1"], issue_keys: ["s1"], attribution: "current_court", label: "applied", scope: "legal_test", evidence_quote: "I apply 2020 SCC 1 and conclude relief is granted.", target_proposition_as_characterized: "The cited rule supports granting relief." }],
    target_direct_history: [],
  };
}

function selfTest() {
  const started = performance.now();
  const source = ["Example Court", "Before: Alpha J.", "Alpha J.: These are my reasons.", "The question is whether relief should be granted.", "I apply 2020 SCC 1 and conclude relief is granted.", "The appeal is allowed.", "End of reasons."].join("\n");
  const pair = { document_id: 1, challenge_category: "LEAK_CATEGORY", source: { dataset: "TEST", citation: "2026 TEST 1", name: "Example", date: "2026-08-20" }, target: { document_id: 2, citation: "2020 SCC 1", citation_aliases: [], name: null, same_litigation_eligible: false }, selection_receipt: { notes: "LEAK_NOTES", source_text_sha256: sha256(source) } };
  const packet = validatePacket(makePacket(pair, { ...pair.source, language: "en", text: source }));
  const packetBytes = encoded(packet);
  assert(!packetBytes.includes("LEAK_CATEGORY") && !packetBytes.includes("LEAK_NOTES") && !packetBytes.includes("challenge_category") && !packetBytes.includes("selection_receipt"), "blind packet leaked selection data");
  const author = annotationArtifact(packetBytes, packet, "author", "author-a", "manual-v1", "2026-08-20", exampleAnnotation("Relief is granted."));
  const reviewer = annotationArtifact(packetBytes, packet, "reviewer", "reviewer-b", "manual-v1", "2026-08-20", exampleAnnotation("The cited rule warrants relief."));
  const authorBytes = encoded(author);
  const reviewerBytes = encoded(reviewer);
  const receipt = adjudicationReceipt({ packetBytes, packet, authorBytes, author, reviewerBytes, reviewer, identity: "adjudicator-c", version: "manual-v1", adjudicatedOn: "2026-08-20", summary: "Accepted the reviewer's narrower answer.", annotation: reviewer.annotation });
  assert(receipt.field_diff.some(({ path }) => path === "/issues/0/answer_groups/0/answer"), "field diff missed changed answer");
  assert(auditStatus(packetBytes, packet, authorBytes, reviewerBytes, null) === "awaiting_adjudication", "annotations were counted without an adjudication receipt");
  assert(auditStatus(packetBytes, packet, authorBytes, reviewerBytes, encoded(receipt)) === "audited", "valid adjudication receipt was not counted");
  let rejectedSameIdentity = false;
  try { adjudicationReceipt({ packetBytes, packet, authorBytes, author, reviewerBytes: encoded({ ...reviewer, identity: "AUTHOR-A" }), reviewer: { ...reviewer, identity: "AUTHOR-A" }, identity: "adjudicator-c", version: "manual-v1", adjudicatedOn: "2026-08-20", summary: "test", annotation: reviewer.annotation }); } catch { rejectedSameIdentity = true; }
  assert(rejectedSameIdentity, "same-person author/reviewer was accepted");
  console.log(JSON.stringify({ ok: true, packet_sha256: sha256(packetBytes), occurrence_contract_sha256: packet.occurrence_contract_sha256, differences: receipt.field_diff.length, adjudication_required: true, elapsed_ms: +(performance.now() - started).toFixed(1) }, null, 2));
}

async function main() {
  const command = process.argv[2];
  if (command === "--self-test") return selfTest();
  if (command === "prepare") return prepare();
  if (command === "freeze") return freeze();
  if (command === "adjudicate") return adjudicate();
  if (command === "verify") return verify();
  throw new Error("usage: build_manual_gold_packets.ts prepare|freeze|adjudicate|verify|--self-test");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

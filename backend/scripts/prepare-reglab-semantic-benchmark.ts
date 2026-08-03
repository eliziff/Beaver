/** Prepare source-resolved RegLab claims for the strict semantic checker. */
import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

type Claim = {
  row_key: string;
  question_id: string;
  model: string | null;
  label: "grounded" | "misgrounded" | "ungrounded";
  question: string;
  claim: string;
  sentence_index: number;
  citations: string[];
  citation_inherited: boolean;
};
type CitationRow = {
  citation: string;
  cases?: Array<{ cap_id: number }>;
};
type OpinionFile = {
  cap_id: number;
  opinions?: Array<{ text?: string | null }>;
};

function flag(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (value === undefined) throw new Error(`missing --${name}`);
  return value;
}

function hash(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function readJsonl<T>(file: string): T[] {
  return readFileSync(file, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function terms(value: string) {
  return new Set(
    value
      .normalize("NFKC")
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]{3,}/gu) ?? [],
  );
}

function lexicalOverlap(query: string, passage: string) {
  const wanted = terms(query);
  const available = terms(passage);
  return wanted.size
    ? [...wanted].filter((term) => available.has(term)).length / wanted.size
    : 0;
}

function chunks(text: string): string[] {
  const paragraphs = text
    .replace(/\r\n?/gu, "\n")
    .split(/\n+/u)
    .map((value) => value.replace(/\s+/gu, " ").trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= 1_800) {
      if (paragraph.length >= 80) out.push(paragraph);
      continue;
    }
    const sentences = paragraph.split(/(?<=[.!?])\s+(?=[A-Z"'(])/u);
    let current = "";
    for (const sentence of sentences) {
      if (current && current.length + sentence.length > 1_600) {
        out.push(current);
        current = "";
      }
      current = `${current} ${sentence}`.trim();
    }
    if (current.length >= 80) out.push(current);
  }
  return out;
}

function selectPassages(claim: string, sources: Array<{ capId: number; text: string }>) {
  return sources
    .flatMap((source) =>
      chunks(source.text).map((text, index) => ({
        cap_id: source.capId,
        chunk_index: index,
        text,
        lexical_overlap: lexicalOverlap(claim, text),
      })),
    )
    .sort(
      (left, right) =>
        right.lexical_overlap - left.lexical_overlap ||
        left.cap_id - right.cap_id ||
        left.chunk_index - right.chunk_index,
    )
    .slice(0, 3);
}

function splitOf(questionId: string): "dev" | "test" {
  return Number.parseInt(hash(questionId).slice(0, 8), 16) % 5 === 0
    ? "test"
    : "dev";
}

function tally(values: string[]) {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

function main() {
  const local =
    process.env.LOCALAPPDATA ??
    path.join(process.env.USERPROFILE ?? "", "AppData", "Local");
  const base = flag(
    "base",
    path.join(local, "OpenLegalData", "misgrounding-corpus"),
  );
  const claimsFile = flag("claims", path.join(base, "reglab_claims.jsonl"));
  const citationsFile = flag(
    "citations",
    path.join(base, "us_sources", "citations.jsonl"),
  );
  const opinionsDir = flag(
    "opinions",
    path.join(base, "us_sources", "opinions"),
  );
  const output = flag("out");
  for (const target of [claimsFile, citationsFile, opinionsDir])
    if (!existsSync(target)) throw new Error(`RegLab source not found: ${target}`);

  const claims = readJsonl<Claim>(claimsFile);
  const clusters = new Map(
    readJsonl<CitationRow>(citationsFile).map((row) => [
      row.citation,
      (row.cases ?? []).map((item) => item.cap_id),
    ]),
  );
  const opinionText = new Map<number, string>();
  for (const file of readdirSync(opinionsDir)) {
    const parsed = JSON.parse(
      readFileSync(path.join(opinionsDir, file), "utf8"),
    ) as OpinionFile;
    const text = (parsed.opinions ?? [])
      .map((opinion) => opinion.text ?? "")
      .join("\n")
      .trim();
    if (text) opinionText.set(parsed.cap_id, text);
  }

  const rows: Record<string, unknown>[] = [];
  let noCitation = 0;
  let unresolved = 0;
  for (const claim of claims) {
    if (!claim.citations.length) {
      noCitation += 1;
      continue;
    }
    const sourceIds = [
      ...new Set(
        claim.citations.flatMap((citation) => clusters.get(citation) ?? []),
      ),
    ];
    const sources = sourceIds.flatMap((capId) => {
      const text = opinionText.get(capId);
      return text ? [{ capId, text }] : [];
    });
    if (!sources.length) {
      unresolved += 1;
      continue;
    }
    const selected = selectPassages(claim.claim, sources);
    if (!selected.length) {
      unresolved += 1;
      continue;
    }
    rows.push({
      id: `reglab:${hash(`${claim.row_key}:${claim.sentence_index}`).slice(0, 20)}`,
      source: "reglab-source-resolved",
      source_class: "case",
      split: splitOf(claim.question_id),
      doc_id: claim.row_key,
      response_id: claim.row_key,
      case_id: claim.question_id,
      claim: claim.claim,
      citation: claim.citations.join("; "),
      evidence_texts: selected.map((item) => item.text),
      label: claim.label === "grounded" ? "supported" : "unsupported",
      label_provenance: "expert_response_label_applied_to_claim",
      original_label: claim.label,
      request_context: claim.question,
      citation_inherited: claim.citation_inherited,
      source_sha256: hash(selected.map((item) => item.text).join("\n")),
      retrieval_receipt: {
        algorithm: "claim_lexical_paragraph_top3_v1",
        source_case_count: sources.length,
        candidate_chunk_count: sources.reduce(
          (sum, source) => sum + chunks(source.text).length,
          0,
        ),
        selected: selected.map((item) => ({
          cap_id: item.cap_id,
          chunk_index: item.chunk_index,
          lexical_overlap: item.lexical_overlap,
          span_sha256: hash(item.text),
        })),
      },
    });
  }
  writeFileSync(
    output,
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8",
  );
  const responseLabels = new Map(
    claims.map((claim) => [claim.row_key, claim.label]),
  );
  const coveredResponses = new Set(rows.map((row) => row.response_id as string));
  const summary = {
    benchmark: "reglab-source-resolved-semantic-v1",
    output,
    sha256: hash(readFileSync(output)),
    input_claims: claims.length,
    output_claims: rows.length,
    no_citation_claims: noCitation,
    unresolved_cited_claims: unresolved,
    input_responses: new Set(claims.map((claim) => claim.row_key)).size,
    covered_responses: coveredResponses.size,
    covered_response_labels: tally(
      [...coveredResponses].map((key) => responseLabels.get(key) ?? "unknown"),
    ),
    weak_claim_labels: tally(rows.map((row) => String(row.original_label))),
    retrieval: "claim_lexical_paragraph_top3_v1",
    input_hashes: {
      claims: hash(readFileSync(claimsFile)),
      citations: hash(readFileSync(citationsFile)),
    },
  };
  const manifest = flag("manifest", "");
  if (manifest)
    writeFileSync(manifest, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

function selfTest() {
  const selected = selectPassages("court permits recovery of fees", [
    {
      capId: 1,
      text: "Unrelated procedural history concerning filing dates.\nThe court permits recovery of reasonable fees after judgment when the statutory conditions and notice requirements have been satisfied.",
    },
  ]);
  if (!selected[0]?.text.includes("permits recovery"))
    throw new Error("RegLab passage selection self-test failed");
  console.log("ok");
}

if (process.argv.includes("--self-test")) selfTest();
else main();

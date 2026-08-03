/**
 * Extracts mechanically labelled journal-author characterization pairs from
 * the existing paired-footnote database. The positive is a high-quality
 * law-review provenance label, not a claim that the cited case entails the
 * proposition in every context.
 *
 *   tsx scripts/journal-author-benchmark.ts --limit 5000 --out journal.jsonl
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

type Note = {
  note_id: number;
  article_id: number;
  dataset: string | null;
  journal_name: string | null;
  authors: string | null;
  citation: string;
  proposition: string;
  body: string;
};

type BenchmarkRow = {
  id: string;
  doc_id: string;
  split: "dev" | "test";
  label: "author_attested" | "constructed_unsupported";
  mutation_type?: string;
  parent_id?: string;
  author_alienness_loo: number | null;
  journal_alienness_loo: number | null;
};

function arg(name: string, fallback?: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] ?? fallback ?? "" : fallback ?? "";
}

function tokens(text: string): string[] {
  return text.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function normalizeAuthorGroup(value: string | null, articleId: number): string {
  if (!value?.trim()) return `article:${articleId}`;
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\./gu, "")
    .replace(/[^\p{L}\p{N},;&' -]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function overlap(left: string, right: string): number {
  const wanted = new Set(tokens(left).filter((value) => value.length > 2));
  const available = new Set(tokens(right).filter((value) => value.length > 2));
  return wanted.size
    ? [...wanted].filter((value) => available.has(value)).length / wanted.size
    : 0;
}

function trigrams(text: string): string[] {
  const words = tokens(text);
  return words.slice(0, Math.max(0, words.length - 2)).map((_, index) => words.slice(index, index + 3).join(" "));
}

function alienness(
  text: string,
  counts: Map<string, number>,
  excluded?: Map<string, number>,
): number | null {
  const values = trigrams(text);
  if (!values.length) return null;
  return (
    values.filter(
      (value) => (counts.get(value) ?? 0) - (excluded?.get(value) ?? 0) <= 0,
    ).length / values.length
  );
}

function addCounts(target: Map<string, number>, text: string, delta: number) {
  for (const value of trigrams(text)) {
    const next = (target.get(value) ?? 0) + delta;
    if (next > 0) target.set(value, next);
    else target.delete(value);
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function splitOf(articleId: number): "dev" | "test" {
  return Number.parseInt(hash(String(articleId)).slice(0, 8), 16) % 5 === 0
    ? "test"
    : "dev";
}

function citationSwapDonor(note: Note, pool: Note[]): Note | undefined {
  if (!pool.length) return undefined;
  const cap = Math.min(128, pool.length);
  const start = Number.parseInt(hash(String(note.note_id)).slice(0, 8), 16) % pool.length;
  let best: { note: Note; overlap: number } | undefined;
  for (let offset = 0; offset < cap; offset += 1) {
    const candidate = pool[(start + offset) % pool.length];
    if (
      candidate.article_id === note.article_id ||
      candidate.citation.normalize("NFKC") === note.citation.normalize("NFKC")
    )
      continue;
    const value = overlap(note.proposition, candidate.proposition);
    if (value >= 0.2) continue;
    if (!best || value < best.overlap) best = { note: candidate, overlap: value };
  }
  return best?.note;
}

function auc(rows: Array<{ label: boolean; score: number }>): number | null {
  const positives = rows.filter((row) => row.label).length;
  const negatives = rows.length - positives;
  if (!positives || !negatives) return null;
  const sorted = [...rows].sort((left, right) => left.score - right.score);
  let rank = 1;
  let positiveRankSum = 0;
  for (let index = 0; index < sorted.length; ) {
    let end = index + 1;
    while (end < sorted.length && sorted[end].score === sorted[index].score)
      end += 1;
    const meanRank = (rank + rank + end - index - 1) / 2;
    for (let at = index; at < end; at += 1)
      if (sorted[at].label) positiveRankSum += meanRank;
    rank += end - index;
    index = end;
  }
  return (
    (positiveRankSum - (positives * (positives + 1)) / 2) /
    (positives * negatives)
  );
}

function scoreBenchmark(file: string) {
  const rows = readFileSync(file, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as BenchmarkRow);
  const maxFpr = Number(arg("max-fpr", "0.20"));
  const signalNames = [
    "author_alienness_loo",
    "journal_alienness_loo",
  ] as const;
  const scoreSignal = (signal: (typeof signalNames)[number]) => {
    const usable = rows.filter(
      (row): row is BenchmarkRow & Record<typeof signal, number> =>
        typeof row[signal] === "number",
    );
    const dev = usable.filter((row) => row.split === "dev");
    const test = usable.filter((row) => row.split === "test");
    const attestedDev = dev
      .filter((row) => row.label === "author_attested")
      .map((row) => row[signal])
      .sort((left, right) => left - right);
    const thresholds = attestedDev.length
      ? [...new Set([...attestedDev, attestedDev.at(-1)! + 1e-9])].sort(
          (left, right) => left - right,
        )
      : [];
    const threshold =
      thresholds.find(
        (candidate) =>
          attestedDev.filter((value) => value >= candidate).length /
            attestedDev.length <=
          maxFpr,
      ) ?? null;
    const operating = (items: typeof usable) => {
      const positives = items.filter(
        (row) => row.label === "constructed_unsupported",
      );
      const attested = items.filter((row) => row.label === "author_attested");
      const flagged = (row: (typeof items)[number]) =>
        threshold !== null && row[signal] >= threshold;
      return {
        n: items.length,
        constructed: positives.length,
        attested: attested.length,
        recall_constructed: positives.length
          ? positives.filter(flagged).length / positives.length
          : null,
        false_negative_rate: positives.length
          ? positives.filter((row) => !flagged(row)).length / positives.length
          : null,
        false_positive_rate: attested.length
          ? attested.filter(flagged).length / attested.length
          : null,
        review_rate: items.length
          ? items.filter(flagged).length / items.length
          : null,
      };
    };
    return {
      coverage: usable.length / Math.max(1, rows.length),
      threshold,
      target_max_false_positive_rate: maxFpr,
      dev_auc: auc(
        dev.map((row) => ({
          label: row.label === "constructed_unsupported",
          score: row[signal],
        })),
      ),
      test_auc: auc(
        test.map((row) => ({
          label: row.label === "constructed_unsupported",
          score: row[signal],
        })),
      ),
      dev: operating(dev),
      test: operating(test),
      test_by_condition: Object.fromEntries(
        ["author_attested", "same_journal_citation_swap", "unsupported_qualifier"].map(
          (condition) => [
            condition,
            operating(
              test.filter((row) =>
                condition === "author_attested"
                  ? row.label === "author_attested"
                  : row.mutation_type === condition,
              ),
            ),
          ],
        ),
      ),
    };
  };
  const output = {
    benchmark: "journal-author-characterization-v3-score",
    input: file,
    rows: rows.length,
    distinct_articles: new Set(rows.map((row) => row.doc_id)).size,
    labels: {
      author_attested: rows.filter((row) => row.label === "author_attested").length,
      constructed_unsupported: rows.filter(
        (row) => row.label === "constructed_unsupported",
      ).length,
    },
    signals: Object.fromEntries(
      signalNames.map((signal) => [signal, scoreSignal(signal)]),
    ),
    limitations: [
      "Editorial publication strongly supports attribution quality but is not human adjudication of every entailment.",
      "Constructed citation swaps and qualifier extensions are regression tests, not natural hallucinations.",
      "Citation swaps deliberately leave language-only scores unchanged; success on them requires citation-specific evidence or semantic checking.",
    ],
  };
  const report = arg("report");
  if (report) writeFileSync(report, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(output, null, 2));
}

function main() {
  const dbPath = path.resolve(arg(
    "db",
    path.join(process.env.LOCALAPPDATA ?? "", "ALR Quote Verifier", "citator", "journal_commentary.sqlite"),
  ));
  const output = arg("out");
  if (!output) throw new Error("missing --out");
  if (!existsSync(dbPath)) throw new Error(`journal commentary database not found: ${dbPath}`);
  const limit = Math.max(1, Number(arg("limit", "5000")));
  const database = new DatabaseSync(dbPath, { readOnly: true });
  const notes = database.prepare(
    `SELECT note.id AS note_id, note.article_id, article.dataset,
            article.journal_name,
            article.authors, note_citation.citation, note.proposition, note.body
       FROM note
       JOIN article ON article.article_id = note.article_id
       JOIN note_citation ON note_citation.note_id = note.id
      WHERE note.pair_status = 'paired'
        AND note.proposition IS NOT NULL
        AND note_citation.rank = 1
      ORDER BY ((note.article_id * 1103515245) % 2147483647), note.id
      LIMIT ?`,
  ).all(limit) as Note[];
  database.close();
  if (!notes.length) throw new Error("journal database returned no paired propositions");

  const groupOf = (note: Note) =>
    normalizeAuthorGroup(note.authors, note.article_id);
  const authorCounts = new Map<string, Map<string, number>>();
  const journalCounts = new Map<string, Map<string, number>>();
  const authorArticleCounts = new Map<string, Map<number, Map<string, number>>>();
  const journalArticleCounts = new Map<string, Map<number, Map<string, number>>>();
  const authorArticles = new Map<string, Set<number>>();
  const byJournal = new Map<string, Note[]>();
  // Language indexes are fit on development articles only. A development
  // row additionally removes its own article; a test row never contributes
  // to the index at all.
  for (const note of notes.filter((item) => splitOf(item.article_id) === "dev")) {
    const author = groupOf(note);
    const journal = note.journal_name?.trim() || "unknown-journal";
    if (!authorCounts.has(author)) authorCounts.set(author, new Map());
    if (!journalCounts.has(journal)) journalCounts.set(journal, new Map());
    if (!authorArticleCounts.has(author)) authorArticleCounts.set(author, new Map());
    if (!journalArticleCounts.has(journal)) journalArticleCounts.set(journal, new Map());
    if (!authorArticleCounts.get(author)!.has(note.article_id)) authorArticleCounts.get(author)!.set(note.article_id, new Map());
    if (!journalArticleCounts.get(journal)!.has(note.article_id)) journalArticleCounts.get(journal)!.set(note.article_id, new Map());
    addCounts(authorCounts.get(author)!, note.proposition, 1);
    addCounts(journalCounts.get(journal)!, note.proposition, 1);
    addCounts(authorArticleCounts.get(author)!.get(note.article_id)!, note.proposition, 1);
    addCounts(journalArticleCounts.get(journal)!.get(note.article_id)!, note.proposition, 1);
    if (!authorArticles.has(author)) authorArticles.set(author, new Set());
    authorArticles.get(author)!.add(note.article_id);
    if (!byJournal.has(journal)) byJournal.set(journal, []);
    byJournal.get(journal)!.push(note);
  }

  const rows: unknown[] = [];
  for (const pool of byJournal.values())
    pool.sort((left, right) => left.note_id - right.note_id);
  for (const note of notes) {
    const author = groupOf(note);
    const journal = note.journal_name?.trim() || "unknown-journal";
    const split = splitOf(note.article_id);
    const authorIndex = authorCounts.get(author) ?? new Map<string, number>();
    const journalIndex = journalCounts.get(journal) ?? new Map<string, number>();
    const authorExcluded =
      split === "dev"
        ? authorArticleCounts.get(author)?.get(note.article_id)
        : undefined;
    const journalExcluded =
      split === "dev"
        ? journalArticleCounts.get(journal)?.get(note.article_id)
        : undefined;
    const rowBase = (proposition: string) => ({
      source: "journal-commentary",
      source_kind: "journal_commentary",
      publication_dataset: note.dataset,
      provenance_tier: "editorially_published_legal_journal",
      citation_pair_status: "paired",
      split,
      doc_id: `journal:${note.article_id}`,
      article_id: note.article_id,
      note_id: note.note_id,
      journal_name: note.journal_name,
      author_group: author,
      author_group_raw: note.authors,
      author_identity_status: note.authors
        ? "normalized_metadata"
        : "article_fallback",
      case_citation: note.citation,
      proposition,
      note_body: note.body,
      source_sha256: hash(`${note.article_id}:${note.note_id}:${proposition}`),
      author_alienness_loo: alienness(
        proposition,
        authorIndex,
        authorExcluded,
      ),
      journal_alienness_loo: alienness(
        proposition,
        journalIndex,
        journalExcluded,
      ),
      author_train_article_count: authorArticles.get(author)?.size ?? 0,
    });
    const base = rowBase(note.proposition);
    rows.push({
      ...base,
      id: `journal:${note.article_id}:${note.note_id}:author_attested`,
      label: "author_attested",
      condition: "author_attested",
      label_provenance: "paired_footnote",
      label_strength: "editorially_published_attribution",
      vetted_positive: true,
    });
    const donor = citationSwapDonor(note, byJournal.get(journal) ?? []);
    if (donor) {
      rows.push({
        ...base,
        id: `journal:${note.article_id}:${note.note_id}:citation_swap`,
        case_citation: donor.citation,
        original_case_citation: note.citation,
        label: "constructed_unsupported",
        condition: "negative",
        label_provenance: "constructed",
        label_strength: "synthetic_wrong_citation",
        vetted_positive: false,
        parent_id: `journal:${note.article_id}:${note.note_id}:author_attested`,
        mutation_type: "same_journal_citation_swap",
      });
    }
    const qualifier =
      split === "dev"
        ? "This rule applies in every circumstance, regardless of the facts."
        : "No factual qualification can limit this rule.";
    rows.push({
      ...rowBase(`${note.proposition} ${qualifier}`),
      id: `journal:${note.article_id}:${note.note_id}:unsupported_qualifier`,
      label: "constructed_unsupported",
      condition: "negative",
      label_provenance: "constructed",
      label_strength: "synthetic_unsupported_extension",
      vetted_positive: false,
      parent_id: `journal:${note.article_id}:${note.note_id}:author_attested`,
      mutation_type: "unsupported_qualifier",
      mutation_template_id:
        split === "dev" ? "qualifier_dev_v1" : "qualifier_test_v1",
    });
  }
  writeFileSync(output, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  console.log(JSON.stringify({ benchmark: "journal-author-characterization-v3", db: dbPath, output, source_rows: notes.length, output_rows: rows.length, author_attested: rows.filter((row: any) => row.label === "author_attested").length, constructed_negatives: rows.filter((row: any) => row.label === "constructed_unsupported").length, split_policy: "sha256_article_80_20", index_policy: "dev_only_and_dev_leave_one_article_out" }, null, 2));
}

if (process.argv.includes("--self-test")) {
  const counts = new Map<string, number>();
  addCounts(counts, "The court considered the application.", 1);
  if ((alienness("The court considered the application.", counts) ?? 1) !== 0) throw new Error("journal benchmark self-test failed");
  if (normalizeAuthorGroup("A. B. Smith", 1) !== normalizeAuthorGroup("A B Smith", 2)) throw new Error("author normalization self-test failed");
  if (auc([{ label: false, score: 0 }, { label: true, score: 1 }]) !== 1) throw new Error("journal AUC self-test failed");
  console.log("ok");
} else if (arg("score")) {
  scoreBenchmark(path.resolve(arg("score")));
} else {
  main();
}

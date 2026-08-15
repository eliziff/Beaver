import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";

import { executeCitatorTool } from "../tools/citatorTools";

let temporaryDirectory: string | null = null;

afterEach(async () => {
  delete process.env.MIKE_CITATOR_DB;
  delete process.env.MIKE_JOURNAL_COMMENTARY_DB;
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = null;
});

it("validates note-up calls before opening the graph", () => {
  expect(executeCitatorTool("library_read", {})).toBeNull();
  expect(executeCitatorTool("note_up", { citation: "  " })?.payload)
    .toMatchObject({ ok: false, error: "citation is required" });
  expect(executeCitatorTool("note_up", {
    citation: "2019 SCC 65",
    court_scope: "appellate",
    court_code: "ONCA",
  })?.payload).toMatchObject({
    ok: false,
    error: "court_code cannot be combined with a non-all court_scope",
  });
});

it("returns judicial and journal analysis as separate attributed lanes", { timeout: 60_000 }, async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-note-up-"));
  const input = path.join(temporaryDirectory, "cases.jsonl");
  const database = path.join(temporaryDirectory, "noteup.sqlite");
  await writeFile(input, [
    {
      dataset: "SCC",
      citation_en: "2016 SCC 27",
      name_en: "R. v. Jordan",
      document_date_en: "2016-07-08",
      unofficial_text_en:
        "R. v. Jordan\nNeutral citation\n2016 SCC 27\n[1] The presumptive ceiling applies.",
    },
    {
      dataset: "ONCA",
      citation_en: "2022 ONCA 400",
      name_en: "R. v. Second",
      document_date_en: "2022-06-20",
      cases_cited_en: ["2016 SCC 27"],
      unofficial_text_en:
        "R. v. Second\nNeutral citation\n2022 ONCA 400\n[1] Jordan, 2016 SCC 27 at para 1, establishes a presumptive ceiling beyond which delay is presumed unreasonable.",
    },
  ].map(JSON.stringify).join("\n"));
  const built = spawnSync("python", [
    path.resolve("scripts/build_citator_graph.py"),
    "--jsonl",
    input,
    "--output",
    database,
  ], { encoding: "utf8" });
  expect(built.status, built.stderr).toBe(0);
  process.env.MIKE_CITATOR_DB = database;

  const commentaryDb = path.join(temporaryDirectory, "journal.sqlite");
  const commentary = new DatabaseSync(commentaryDb);
  commentary.exec(`
    CREATE TABLE article (
      article_id INTEGER PRIMARY KEY, dataset TEXT, citation TEXT,
      name TEXT, date TEXT, journal_name TEXT, authors TEXT, url TEXT,
      pages INTEGER, labels_candidates INTEGER, labels_selected INTEGER,
      refs_assigned INTEGER, ambiguous_sites INTEGER, footnote_mode INTEGER,
      crossrefs INTEGER, crossrefs_unresolved INTEGER);
    CREATE TABLE note (
      id INTEGER PRIMARY KEY, article_id INTEGER, label TEXT,
      restart_sequence INTEGER, pair_status TEXT, note_page_label TEXT,
      ref_page_label TEXT, body TEXT, body_sha256 TEXT,
      truncated_at_page_end INTEGER, proposition TEXT,
      proposition_sha256 TEXT, passage TEXT);
    CREATE TABLE note_citation (
      note_id INTEGER, rank INTEGER, kind TEXT, citation TEXT,
      cited_key TEXT, case_short TEXT, pinpoints TEXT);
    INSERT INTO article VALUES (1, 'MCGILL-LJ', '(2020) 65:1 McGill LJ 1',
      'Jordan at Five', '2020', 'McGill Law Journal', 'A Scholar', NULL,
      10, 5, 5, 5, 0, 1, 0, 0);
    INSERT INTO note VALUES
      (1, 1, '1', 1, 'paired', '8', '7', 'Jordan, supra note 1.', 'x', 0,
       'The Court recognized that the presumptive ceiling governs delay.',
       'y', NULL);
    INSERT INTO note_citation VALUES
      (1, 1, 'neutral', '2016 SCC 27', '2016scc27', NULL, 'par1');
  `);
  commentary.close();
  process.env.MIKE_JOURNAL_COMMENTARY_DB = commentaryDb;

  const reply = executeCitatorTool("note_up", {
    citation: "2016 SCC 27",
    cited_paragraph: 1,
  })!;
  const payload = reply.payload as {
    ok: boolean;
    citing_decisions: Array<Record<string, unknown>>;
    judicial_discussion: Array<Record<string, unknown>>;
    journal_analysis: Array<Record<string, unknown>>;
  };
  expect(payload.ok).toBe(true);
  expect(payload.citing_decisions).toMatchObject([{
    citation: "2022 ONCA 400",
    pinpoints: "par1",
  }]);
  expect(payload.judicial_discussion).toMatchObject([{
    source_citation: "2022 ONCA 400",
    evidence_id: expect.stringMatching(/^e_/u),
  }]);
  expect(payload.journal_analysis).toMatchObject([{
    source_citation: "(2020) 65:1 McGill LJ 1",
    journal_name: "McGill Law Journal",
    page: "7",
    evidence_id: expect.stringMatching(/^e_/u),
  }]);
  expect(reply.evidences).toHaveLength(3);
  expect(reply.evidences?.[1]).toMatchObject({
    provider: "citator",
    source_class: "case",
    citation: "2022 ONCA 400",
    target_citation: "2016 SCC 27",
    resolver_version: "citator-analysis-v1",
  });
  expect(reply.evidences?.[2]).toMatchObject({
    provider: "journal",
    source_class: "commentary",
    citation: "(2020) 65:1 McGill LJ 1",
    target_citation: "2016 SCC 27",
    locator: { kind: "page", label: "7" },
  });
});

it("reports a missing note-up graph", () => {
  process.env.MIKE_CITATOR_DB = path.join(__dirname, "missing", "noteup.sqlite");
  expect(executeCitatorTool("note_up", { citation: "2019 SCC 65" })?.payload)
    .toMatchObject({ ok: false, error: "citator_not_installed" });
});

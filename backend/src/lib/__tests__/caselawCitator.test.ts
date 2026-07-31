import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Drives the REAL build script (scripts/build_citator_graph.py) over a tiny
 * fixture via its --jsonl input mode, then reads the product surface
 * (src/lib/caselawCitator.ts) plus a few edge-level rows straight from the
 * built SQLite. Nothing touches the network or the real corpus (resolution
 * is skipped by design in jsonl mode, so the French-twin/parallel-citation
 * union stays off and the literal-key behavior is what gets asserted).
 *
 * The rows are synthetic, but their column names and value shapes mirror the
 * real A2AJ cases parquet files (dataset, citation_en/_fr, citation2_en/_fr,
 * name_en/_fr, document_date_en/_fr, url_en/_fr, unofficial_text_en/_fr,
 * cases_cited_en, cases_citing_en), probed with duckdb over the local
 * SCC/FC/ONCA families on
 * 2026-07-28 - including the corpus habit of opening every text with a
 * header that repeats the decision's own citation. Carter v. Canada is real
 * ("2015 SCC 5", parallel report "[2015] 1 SCR 331"), which keeps the
 * non-conflation assertions honest: the S.C.R. form and French twin of the
 * SAME decision sit beside the neutral citation and must still be distinct
 * keys, because only corpus resolution evidence (absent here) may union
 * them.
 */
const fixtureRows: Array<Record<string, unknown>> = [
  {
    // The cited case itself: its only occurrences are its own header
    // citations, which self-citation exclusion must drop (0 edges).
    dataset: "SCC",
    citation_en: "2015 SCC 5",
    citation_fr: "2015 CSC 5",
    citation2_en: "[2015] 1 SCR 331",
    citation2_fr: "[2015] 1 RCS 331",
    name_en: "Carter v. Canada (Attorney General)",
    document_date_en: "2015-02-06",
    url_en: "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/14637/index.do",
    // Curated provider graph: cases the corpus records as citing Carter,
    // including one outside every fixture family (2023 ABKB 999).
    cases_citing_en: ["2020 FC 100", "2018 ONCA 50", "2023 ABKB 999"],
    unofficial_text_en:
      "Carter v. Canada (Attorney General)\nCollection\nSupreme Court " +
      "Judgments\nDate\n2015-02-06\nNeutral citation\n2015 SCC 5\nReport\n" +
      "[2015] 1 SCR 331\nCase number\n35591\n[1] It is a crime in Canada to " +
      "assist another person in ending her own life.",
  },
  {
    dataset: "FC",
    citation_en: "2020 FC 100",
    citation_fr: "2020 CF 100",
    name_en: "Doe v. Canada (Citizenship and Immigration)",
    document_date_en: "2020-06-01",
    url_en: "https://decisions.fct-cf.gc.ca/fc-cf/decisions/en/item/900001/index.do",
    cases_cited_en: ["2015 SCC 5", "2019 SCC 5"],
    unofficial_text_en:
      "Doe v. Canada (Citizenship and Immigration)\nDate\n2020-06-01\n" +
      "Neutral citation\n2020 FC 100\n" +
      "[1] The applicants seek judicial review of a decision refusing " +
      "their claim, and the parties agree on the governing authorities.\n" +
      "[2] The framework in Carter v. Canada (Attorney General), " +
      "2015 SCC 5, [2015] 1 S.C.R. 331, requires a demonstrated " +
      "deprivation of the right to life, liberty or security of the " +
      "person.\n" +
      "[3] Carter, 2015 SCC 5, instructs at para 86 that the claimant " +
      "bears that burden throughout the proceeding.\n" +
      "[4] The applicants also invoke Miranda v. Arizona, 384 U.S. 436 " +
      "(1966), but that American authority does not assist them here.\n" +
      "[5] Finally, R. v. Chanmany, 2019 SCC 5, addresses and disposes " +
      "of the remaining ground raised in argument.\n" +
      "[6] The application is dismissed, and no question of general " +
      "importance is certified for appeal.",
  },
  {
    // French-only row: text/citation/date/url all fall back to the _fr
    // columns, and the French neutral citation "2015 CSC 5" is its own
    // distinct key - never silently folded into "2015 SCC 5".
    dataset: "FC",
    citation_fr: "2021 CF 200",
    name_fr: "Tremblay c. Canada (Procureur général)",
    document_date_fr: "2021-03-15",
    url_fr: "https://decisions.fct-cf.gc.ca/fc-cf/decisions/fr/item/900002/index.do",
    unofficial_text_fr:
      "Tremblay c. Canada (Procureur général)\nDate\n2021-03-15\n" +
      "Référence neutre\n2021 CF 200\n[8] Selon l'arrêt Carter c. Canada " +
      "(Procureur général), 2015 CSC 5, la norme constitutionnelle exige " +
      "une atteinte démontrée.",
  },
  {
    dataset: "ONCA",
    citation_en: "2018 ONCA 50",
    name_en: "R. v. Example",
    document_date_en: "2018-09-10",
    url_en: "https://www.ontariocourts.ca/decisions/2018/2018ONCA0050.htm",
    unofficial_text_en:
      "R. v. Example\nDate\n2018-09-10\nNeutral citation\n2018 ONCA 50\n" +
      "[3] The governing framework remains the Supreme Court's decision " +
      "in 2015  SCC 5, which this court must apply.",
  },
  {
    // Same url_en as the previous row: the builder must skip it as a
    // duplicate, so its citation of 2015 SCC 5 adds no edge.
    dataset: "ONCA",
    citation_en: "2018 ONCA 51",
    name_en: "R. v. Example (duplicate row)",
    document_date_en: "2018-09-10",
    url_en: "https://www.ontariocourts.ca/decisions/2018/2018ONCA0050.htm",
    unofficial_text_en:
      "R. v. Example (duplicate row)\n[1] Citing 2015 SCC 5 again.",
  },
];

let temporaryDirectory: string | null = null;

afterEach(async () => {
  delete process.env.MIKE_CITATOR_DB;
  delete process.env.MIKE_JOURNAL_COMMENTARY_DB;
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  }
});

describe("caselaw citator note-up graph", () => {
  it(
    "builds the graph via the real script and notes up citations",
    { timeout: 60_000 },
    async () => {
      temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-citator-"));
      const input = path.join(temporaryDirectory, "cases.jsonl");
      const database = path.join(temporaryDirectory, "noteup.sqlite");
      await writeFile(
        input,
        fixtureRows.map((row) => JSON.stringify(row)).join("\n"),
      );
      const built = spawnSync(
        "python",
        [
          path.resolve("scripts/build_citator_graph.py"),
          "--jsonl",
          input,
          "--output",
          database,
        ],
        { encoding: "utf8" },
      );
      expect(built.status, built.stderr).toBe(0);
      expect(built.stdout).toMatch(/cases indexed:\s+4/u);
      expect(built.stdout).toMatch(/edges written:\s+7/u);
      expect(built.stdout).toMatch(/self-citations skipped:\s+5/u);
      // Provider graph stored verbatim (2 cited on the FC row, 3 citing on
      // Carter's row) and measured against the miner: both curated cited
      // keys were also mined; the miner additionally found the S.C.R.
      // parallel form and the American authority the list omits.
      expect(built.stdout).toMatch(/provider cited edges:\s+2 \(1 docs\)/u);
      expect(built.stdout).toMatch(/provider citing edges:\s+3/u);
      expect(built.stdout).toMatch(
        /miner vs provider:\s+2 confirmed, 0 provider-only, 2 mined-only/u,
      );
      process.env.MIKE_CITATOR_DB = database;
      const citator = await import("../caselawCitator");

      // 7 edges: Carter contributes none (both header occurrences are
      // self-citations) and the duplicate-url row is skipped entirely.
      // 5 distinct keys: 2015scc5, 20151scr331, 384us436, 2019scc5,
      // 2015csc5 - the S.C.R. parallel form and the French twin stay
      // separate nodes.
      expect(citator.graphStats()).toEqual({
        cases_indexed: 4,
        edges: 7,
        distinct_cited: 5,
        provider_edges: 5,
      });

      const noteUp = citator.noteUpCitations({ citation: "2015 SCC 5" });
      expect(noteUp).toMatchObject({ total: 2 });
      expect(noteUp!.entries).toMatchObject([
        {
          citation: "2020 FC 100",
          name: "Doe v. Canada (Citizenship and Immigration)",
          court: "FC",
          date: "2020-06-01",
          paragraph: 2,
          occurrences: 2,
          citedAs: "2015 SCC 5",
          pinpoints: null,
          // First occurrence's bounded context, not the para [3] one.
          excerpt: expect.stringContaining("framework in Carter"),
        },
        {
          citation: "2018 ONCA 50",
          court: "ONCA",
          date: "2018-09-10",
          // One [3] marker is no paragraph spine, so no paragraph claim.
          paragraph: null,
          occurrences: 1,
          // Raw spacing preserved; the key equates it anyway.
          citedAs: "2015  SCC 5",
        },
      ]);
      for (const entry of noteUp!.entries) {
        expect(entry.excerpt.length).toBeLessThanOrEqual(600);
        // The cited case itself never appears in its own note-up list.
        expect(entry.citation).not.toBe("2015 SCC 5");
      }
      // Curated provider graph beside the text evidence: one in-corpus case
      // lists Carter in its cited column, and Carter's own citing column
      // reports three citations - one outside every fixture family.
      expect(noteUp!.provider).toEqual({
        citingInCorpus: 1,
        citingReported: ["2018 ONCA 50", "2020 FC 100", "2023 ABKB 999"],
      });
      // The citing list hangs off the decision, so every one of the
      // decision's own citation keys reaches it - the French twin included -
      // while citingInCorpus stays keyed to the literal queried form.
      expect(
        citator.noteUpCitations({ citation: "2015 CSC 5" })!.provider,
      ).toEqual({
        citingInCorpus: 0,
        citingReported: ["2018 ONCA 50", "2020 FC 100", "2023 ABKB 999"],
      });
      expect(
        citator.noteUpCitations({ citation: "384 US 436" })!.provider,
      ).toEqual({ citingInCorpus: 0, citingReported: [] });

      // Punctuation/whitespace variants of one form share a key...
      expect(citator.noteUpCitations({ citation: "2015 S.C.C. 5" })!.entries).toHaveLength(2);
      expect(citator.noteUpCitations({ citation: "2015   SCC  5" })!.entries).toHaveLength(2);
      // A capped page still reports the true total — the bug that made a
      // full-corpus Vavilov note-up look like 10 citing cases.
      const capped = citator.noteUpCitations({ citation: "2015 SCC 5", size: 1 });
      expect(capped!.entries).toMatchObject([{ citation: "2020 FC 100" }]);
      expect(capped!.total).toBe(2);
      // ...but distinct forms are distinct nodes. Without resolution
      // evidence the French twin finds only French-keyed edges, and the
      // S.C.R. parallel citation only its own occurrences.
      expect(citator.noteUpCitations({ citation: "2015 CSC 5" })!.entries).toMatchObject([
        {
          citation: "2021 CF 200",
          name: "Tremblay c. Canada (Procureur général)",
          court: "FC",
          date: "2021-03-15",
          paragraph: null,
          citedAs: "2015 CSC 5",
          excerpt: expect.stringContaining("norme constitutionnelle"),
        },
      ]);
      expect(
        citator.noteUpCitations({ citation: "[2015] 1 S.C.R. 331" })!.entries,
      ).toMatchObject([{ citation: "2020 FC 100", citedAs: "[2015] 1 S.C.R. 331" }]);
      expect(
        citator.noteUpCitations({ citation: "[2015] 1 SCR 331" })!.entries,
      ).toHaveLength(1);
      expect(citator.noteUpCitations({ citation: "384 US 436" })!.entries).toMatchObject([
        { citation: "2020 FC 100", citedAs: "384 U.S. 436", paragraph: 4 },
      ]);
      expect(citator.noteUpCitations({ citation: "2019 SCC 5" })!.entries).toMatchObject([
        { citation: "2020 FC 100", occurrences: 1, paragraph: 5 },
      ]);

      // The batch alias surface is the single-citation one, on one handle:
      // element i must equal citationAliasKeys(citations[i]) exactly,
      // including the "" input that normalizes to no key at all. Callers
      // scanning a query's fragments use it to avoid reopening the graph
      // per fragment; it may never answer differently.
      const batchInputs = [
        "2015 SCC 5",
        "2015 S.C.C. 5",
        "2015 CSC 5",
        "[2015] 1 SCR 331",
        "384 US 436",
        "no citation here",
        "",
      ];
      expect(citator.citationAliasKeysBatch(batchInputs)).toEqual(
        batchInputs.map((citation) => citator.citationAliasKeys(citation)),
      );
      expect(citator.citationAliasKeysBatch([])).toEqual([]);

      // Stands-for profile: attested characterizations ranked by citing
      // court level (ONCA level 4 outranks FC level 3), prose windows
      // extracted by the excerpt classifier, sha receipts over the text.
      const profile = citator.standsForProfile({ citation: "2015 SCC 5" })!;
      expect(profile.totalCiters).toBe(2);
      expect(profile.tier).toBe("thin");
      expect(profile.candidates).toHaveLength(2);
      expect(profile.candidates[0]).toMatchObject({
        citingCitation: "2018 ONCA 50",
        citingCourt: "ONCA",
        citingLevel: 4,
      });
      expect(profile.candidates[0].text).toContain("governing framework");
      expect(profile.candidates[0].text).not.toMatch(/\d{4} (?:SCC|ONCA) \d+/u);
      const { createHash } = await import("node:crypto");
      expect(profile.candidates[0].spanSha256).toBe(
        createHash("sha256")
          .update(profile.candidates[0].text, "utf8")
          .digest("hex"),
      );
      expect(profile.candidates[1]).toMatchObject({
        citingCitation: "2020 FC 100",
        citingLevel: 3,
      });
      // 2020 FC 100 cites Carter twice ([2] and [3]); the profile must
      // characterize the FIRST occurrence. The paragraph and excerpt ride
      // the MIN(text_offset) row of the grouped query, so this pins the
      // bare-column contract that replaced a per-group re-fetch: pick the
      // wrong row and the paragraph reads 3 and the window becomes the
      // "bears that burden" sentence.
      expect(profile.candidates[1].paragraph).toBe(2);
      expect(profile.candidates[1].text).toContain("governing authorities");
      expect(profile.candidates[1].text).not.toContain("bears that burden");
      // No journal commentary DB installed -> the source reports null,
      // never an empty count that would read as "looked and found nothing".
      expect(profile.commentary).toBeNull();
      // The French twin profiles only French-keyed citing prose.
      const frenchProfile = citator.standsForProfile({ citation: "2015 CSC 5" })!;
      expect(frenchProfile.totalCiters).toBe(1);
      expect(frenchProfile.tier).toBe("thin");
      expect(frenchProfile.candidates[0].text).toContain(
        "norme constitutionnelle",
      );

      // Journal commentary source (pair_journal_footnotes.py schema): a
      // paired note's proposition sentence joins the profile as an
      // attested characterization; junk propositions are classifier-
      // rejected; rank>1 string-cite members never attribute.
      const commentaryDb = path.join(
        temporaryDirectory,
        "journal_commentary.sqlite",
      );
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
          'Carter at Five', '2020', 'McGill Law Journal', 'A Scholar', NULL,
          10, 5, 5, 5, 0, 1, 0, 0);
        INSERT INTO note VALUES
          (1, 1, '1', 1, 'paired', '2', '2', 'Carter, supra note 1.', 'x', 0,
           'The Court recognized that the prohibition deprived competent adults of security of the person.',
           'y', NULL),
          (2, 1, '2', 1, 'paired', '3', '3', 'See Carter.', 'x', 0,
           'Implications for Medical Practice 245 Conclusion 249', 'y', NULL);
        INSERT INTO note_citation VALUES
          (1, 1, 'neutral', '2015 SCC 5', '2015scc5', NULL, NULL),
          (2, 1, 'neutral', '2015 SCC 5', '2015scc5', NULL, NULL),
          (1, 2, 'neutral', '2019 SCC 5', '2019scc5', NULL, NULL);
      `);
      commentary.close();
      process.env.MIKE_JOURNAL_COMMENTARY_DB = commentaryDb;
      const withCommentary = citator.standsForProfile({
        citation: "2015 SCC 5",
      })!;
      expect(withCommentary.commentary).toEqual({ considered: 2, rejected: 1 });
      expect(withCommentary.tier).toBe("rich");
      expect(withCommentary.candidates).toHaveLength(3);
      const commentaryCandidate = withCommentary.candidates[2];
      expect(commentaryCandidate).toMatchObject({
        sourceKind: "commentary",
        journalName: "McGill Law Journal",
        citingCitation: "(2020) 65:1 McGill LJ 1",
        citingName: "Carter at Five",
        citingCourt: null,
        citingLevel: null,
        citingDate: "2020",
      });
      expect(commentaryCandidate.text).toContain("security of the person");
      // Court prose still outranks commentary under the default policy.
      expect(withCommentary.candidates[0].sourceKind).toBe("case");
      expect(withCommentary.rankPolicy).toBe("authority");

      // H19 rank policies (Stage 9): the SAME candidate set, reordered.
      // banded_recency: commentary joins the highest band present
      // (ONCA's level 4) and its 2020 date beats ONCA's 2018 within the
      // band; FC stays below in band 3 despite being newest overall.
      const banded = citator.standsForProfile({
        citation: "2015 SCC 5",
        rankPolicy: "banded_recency",
      })!;
      expect(banded.rankPolicy).toBe("banded_recency");
      expect(
        banded.candidates.map(
          (candidate) => candidate.citingCitation ?? candidate.sourceKind,
        ),
      ).toEqual(["(2020) 65:1 McGill LJ 1", "2018 ONCA 50", "2020 FC 100"]);
      // flat_recency: newest first regardless of source kind or level.
      const flat = citator.standsForProfile({
        citation: "2015 SCC 5",
        rankPolicy: "flat_recency",
      })!;
      expect(
        flat.candidates.map(
          (candidate) => candidate.citingCitation ?? candidate.sourceKind,
        ),
      ).toEqual(["2020 FC 100", "(2020) 65:1 McGill LJ 1", "2018 ONCA 50"]);
      // Policies reorder, never change membership or the tier.
      expect(new Set(flat.candidates.map((c) => c.spanSha256))).toEqual(
        new Set(withCommentary.candidates.map((c) => c.spanSha256)),
      );
      expect(flat.tier).toBe("rich");
      // The rank-2 string-cite member does not attribute to 2019 SCC 5.
      const rank2Profile = citator.standsForProfile({ citation: "2019 SCC 5" })!;
      expect(
        rank2Profile.candidates.filter(
          (candidate) => candidate.sourceKind === "commentary",
        ),
      ).toHaveLength(0);

      // Typed refusals when nothing survives normalization.
      expect(() => citator.noteUpCitations({ citation: "" })).toThrow(
        /citation is required/u,
      );
      expect(() => citator.noteUpCitations({ citation: "??? ---" })).toThrow(
        /citation is required/u,
      );

      // Edge-level facts straight from the built database: paragraph
      // anchors and cited-side pinpoints ("at para 86" belongs to the
      // second Carter occurrence), and jsonl builds skip resolution.
      const graph = new DatabaseSync(database, { readOnly: true });
      try {
        const carterEdges = graph
          .prepare(
            `SELECT case_doc.citation AS citing, edge.paragraph, edge.pinpoints,
                    edge.cited_short
             FROM edge JOIN case_doc ON case_doc.id = edge.case_id
             WHERE edge.cited_key = '2015scc5'
             ORDER BY case_doc.id, edge.text_offset`,
          )
          .all();
        expect(carterEdges).toMatchObject([
          {
            citing: "2020 FC 100",
            paragraph: 2,
            pinpoints: null,
            cited_short: "Carter v. Canada (Attorney General)",
          },
          { citing: "2020 FC 100", paragraph: 3, pinpoints: "par86" },
          { citing: "2018 ONCA 50", paragraph: null, pinpoints: null },
        ]);
        expect(
          graph.prepare("SELECT COUNT(*) AS n FROM resolution").get(),
        ).toMatchObject({ n: 0 });
        // Curated lists land verbatim, keyed into the shared key space, in
        // row order (Carter's citing column, then the FC row's cited column).
        expect(
          graph
            .prepare(
              "SELECT case_id, direction, citation, citation_key FROM provider_edge ORDER BY id",
            )
            .all(),
        ).toMatchObject([
          { case_id: 1, direction: "citing", citation: "2020 FC 100", citation_key: "2020fc100" },
          { case_id: 1, direction: "citing", citation: "2018 ONCA 50", citation_key: "2018onca50" },
          { case_id: 1, direction: "citing", citation: "2023 ABKB 999", citation_key: "2023abkb999" },
          { case_id: 2, direction: "cited", citation: "2015 SCC 5", citation_key: "2015scc5" },
          { case_id: 2, direction: "cited", citation: "2019 SCC 5", citation_key: "2019scc5" },
        ]);
        // Every case's own citation keys are recorded - Carter carries all
        // four forms (neutral, French twin, S.C.R., R.C.S.).
        expect(
          graph
            .prepare(
              "SELECT citation_key FROM case_key WHERE case_id = 1 ORDER BY citation_key",
            )
            .all(),
        ).toMatchObject([
          { citation_key: "20151rcs331" },
          { citation_key: "20151scr331" },
          { citation_key: "2015csc5" },
          { citation_key: "2015scc5" },
        ]);
        expect(
          graph.prepare("SELECT value FROM meta WHERE key = 'source'").get(),
        ).toMatchObject({ value: "jsonl" });
        expect(
          graph
            .prepare("SELECT language FROM case_doc WHERE citation = '2021 CF 200'")
            .get(),
        ).toMatchObject({ language: "fr" });
      } finally {
        graph.close();
      }
    },
  );

  it("returns null when no note-up graph has been built", async () => {
    process.env.MIKE_CITATOR_DB = path.join(
      os.tmpdir(),
      "beaver-citator-missing",
      "absent.sqlite",
    );
    const citator = await import("../caselawCitator");
    expect(citator.noteUpCitations({ citation: "2015 SCC 5" })).toBeNull();
    expect(citator.graphStats()).toBeNull();
    // Absent graph: both alias surfaces degrade to the literal key, and
    // text that normalizes to nothing to no key. Same contract, batched
    // or not.
    const inputs = ["2015 SCC 5", "prose that keys anyway", "  -- "];
    expect(citator.citationAliasKeysBatch(inputs)).toEqual([
      ["2015scc5"],
      ["prosethatkeysanyway"],
      [],
    ]);
    expect(citator.citationAliasKeysBatch(inputs)).toEqual(
      inputs.map((citation) => citator.citationAliasKeys(citation)),
    );
  });
});

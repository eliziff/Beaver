import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { executeCitatorTool } from "../tools/citatorTools";

let temporaryDirectory: string | null = null;

afterEach(async () => {
  delete process.env.MIKE_CITATOR_DB;
  delete process.env.MIKE_JOURNAL_COMMENTARY_DB;
  delete process.env.MIKE_CONSULT_ATTESTATIONS;
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  }
});

describe("executeCitatorTool", () => {
  it("ignores foreign tool names", () => {
    expect(executeCitatorTool("library_read", {})).toBeNull();
  });

  it("refuses an empty citation", () => {
    const reply = executeCitatorTool("caselaw_note_up", { citation: "  " });
    expect(reply?.payload).toMatchObject({ ok: false, error: "citation is required" });
  });

  it("reports citator_not_installed when no graph exists", () => {
    process.env.MIKE_CITATOR_DB = path.join(
      __dirname,
      "does-not-exist",
      "noteup.sqlite",
    );
    const reply = executeCitatorTool("caselaw_note_up", {
      citation: "2019 SCC 65",
    });
    expect(reply?.payload).toMatchObject({ ok: false, error: "citator_not_installed" });
  });

  it("rejects conflicting court scopes before opening the graph", () => {
    const reply = executeCitatorTool("caselaw_note_up", {
      citation: "2019 SCC 65",
      court_scope: "appellate",
      court_code: "ONCA",
    });
    expect(reply?.payload).toMatchObject({
      ok: false,
      error: "court_code cannot be combined with a non-all court_scope",
    });
  });

  describe("consult_attested_characterization", () => {
    it("refuses an empty citation", () => {
      const reply = executeCitatorTool("consult_attested_characterization", {
        citation: "  ",
      });
      expect(reply?.payload).toMatchObject({
        ok: false,
        error: "citation is required",
      });
    });

    it("refuses execution while the flag is off", () => {
      delete process.env.MIKE_CONSULT_ATTESTATIONS;
      const reply = executeCitatorTool("consult_attested_characterization", {
        citation: "2016 SCC 27",
      });
      expect(reply?.payload).toMatchObject({
        ok: false,
        error: "tool_not_enabled",
      });
    });

    it("reports citator_not_installed when the flag is on but no graph exists", () => {
      process.env.MIKE_CONSULT_ATTESTATIONS = "1";
      process.env.MIKE_CITATOR_DB = path.join(
        __dirname,
        "does-not-exist",
        "noteup.sqlite",
      );
      const reply = executeCitatorTool("consult_attested_characterization", {
        citation: "2016 SCC 27",
      });
      expect(reply?.payload).toMatchObject({
        ok: false,
        error: "citator_not_installed",
      });
    });

    it(
      "returns up to three attestations with actionable follow_ups",
      { timeout: 60_000 },
      async () => {
        temporaryDirectory = await mkdtemp(
          path.join(os.tmpdir(), "beaver-consult-"),
        );
        const input = path.join(temporaryDirectory, "cases.jsonl");
        const database = path.join(temporaryDirectory, "noteup.sqlite");
        const rows = [
          {
            dataset: "SCC",
            citation_en: "2016 SCC 27",
            name_en: "R. v. Jordan",
            document_date_en: "2016-07-08",
            url_en: "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/16202/index.do",
            cases_citing_en: ["2022 ONCA 400"],
            unofficial_text_en:
              "R. v. Jordan\nDate\n2016-07-08\nNeutral citation\n2016 SCC 27\n[1] The presumptive ceiling on delay applies.",
          },
          {
            dataset: "ONCA",
            citation_en: "2022 ONCA 400",
            name_en: "R. v. Second",
            document_date_en: "2022-06-20",
            url_en: "https://www.ontariocourts.ca/decisions/2022/2022ONCA0400.htm",
            cases_cited_en: ["2016 SCC 27"],
            unofficial_text_en:
              "R. v. Second\nDate\n2022-06-20\nNeutral citation\n2022 ONCA 400\n[1] The Supreme Court's decision in R. v. Jordan, 2016 SCC 27 establishes a presumptive ceiling beyond which delay is presumed unreasonable, and this court must apply that framework to the present appeal.",
          },
        ];
        await writeFile(
          input,
          rows.map((row) => JSON.stringify(row)).join("\n"),
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
        process.env.MIKE_CITATOR_DB = database;

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
            'Jordan at Five', '2020', 'McGill Law Journal', 'A Scholar', NULL,
            10, 5, 5, 5, 0, 1, 0, 0);
          INSERT INTO note VALUES
            (1, 1, '1', 1, 'paired', '2', '2', 'Jordan, supra note 1.', 'x', 0,
             'The Court recognized that the presumptive ceiling governs delay.',
             'y', NULL);
          INSERT INTO note_citation VALUES
            (1, 1, 'neutral', '2016 SCC 27', '2016scc27', NULL, NULL);
        `);
        commentary.close();
        process.env.MIKE_JOURNAL_COMMENTARY_DB = commentaryDb;
        process.env.MIKE_CONSULT_ATTESTATIONS = "1";

        const reply = executeCitatorTool("consult_attested_characterization", {
          citation: "2016 SCC 27",
        });
        const payload = reply?.payload as {
          ok: boolean;
          tier: string;
          rank_policy: string;
          returned: number;
          attestations: Array<Record<string, unknown>>;
          statement?: string;
        };
        expect(payload.ok).toBe(true);
        expect(payload.rank_policy).toBe("scc_journal_first");
        expect(payload.returned).toBe(2);
        // The case-law slot ranks before the journal slot.
        expect(payload.attestations.map((entry) => entry.source_kind)).toEqual([
          "case",
          "commentary",
        ]);
        // Every attestation carries an evidence_id and an actionable
        // follow_up naming the existing fetch tool + identifier.
        const [citingCase, journal] = payload.attestations;
        expect(citingCase).toMatchObject({
          citing_citation: "2022 ONCA 400",
          citing_url:
            "https://www.ontariocourts.ca/decisions/2022/2022ONCA0400.htm",
          evidence_id: expect.stringMatching(/^e_/u),
          follow_up: { tool: "a2aj_fetch", citation: "2022 ONCA 400" },
        });
        expect(journal).toMatchObject({
          source_article_id: "1",
          evidence_id: expect.stringMatching(/^e_/u),
          follow_up: {
            tool: "public_legal_source_fetch",
            provider: "journal",
            identifier: "1",
          },
        });
        // Receipts flow out for the dispatcher to register into turn state.
        expect(reply?.evidences).toHaveLength(2);
        expect(reply?.evidences?.[0]).toMatchObject({
          provider: "citator",
          resolver_version: "citator-standsfor-v1",
          citation: "2016 SCC 27",
        });
      },
    );

    it("returns the exact typed statement when a case is not characterized", async () => {
      temporaryDirectory = await mkdtemp(
        path.join(os.tmpdir(), "beaver-consult-none-"),
      );
      const input = path.join(temporaryDirectory, "cases.jsonl");
      const database = path.join(temporaryDirectory, "noteup.sqlite");
      const rows = [
        {
          dataset: "SCC",
          citation_en: "2016 SCC 27",
          name_en: "R. v. Jordan",
          document_date_en: "2016-07-08",
          url_en: "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/16202/index.do",
          unofficial_text_en:
            "R. v. Jordan\nDate\n2016-07-08\nNeutral citation\n2016 SCC 27\n[1] The presumptive ceiling on delay applies.",
        },
      ];
      await writeFile(
        input,
        rows.map((row) => JSON.stringify(row)).join("\n"),
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
      process.env.MIKE_CITATOR_DB = database;
      process.env.MIKE_CONSULT_ATTESTATIONS = "1";

      const reply = executeCitatorTool("consult_attested_characterization", {
        citation: "2016 SCC 27",
      });
      expect(reply?.payload).toMatchObject({
        ok: true,
        tier: "none",
        returned: 0,
        attestations: [],
        statement: "No attested characterization of 2016 SCC 27 is available.",
      });
    });
  });
});

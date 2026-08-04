// Citator note-up chat tool — read path for the Stage 1 exact note-up
// graph (lib/caselawCitator.ts; built by scripts/build_citator_graph.py).
// Research-gated alongside the other legal-source tools: sealed benchmark
// runs must not see information sources beyond the matter documents.
import {
  noteUpCitations,
  standsForProfile,
  type NoteUpCourtScope,
  type NoteUpSort,
} from "../../caselawCitator";
import type { OpenAIToolSchema } from "../../llm";
import {
  attestedCharacterizationReceipt,
  citatorNoteUpReceipt,
  type LegalEvidenceReceipt,
} from "../legalEvidenceExperiment";

/**
 * MIKE_CONSULT_ATTESTATIONS=1 exposes the consult_attested_characterization
 * tool in production (off by default — an experiment switch, per Eli
 * 2026-08-04). The tool is a pure local-sqlite read: it surfaces attested
 * characterizations of a cited case drawn from other cases' citing prose
 * and law-journal footnotes, never a model call. The tool also inherits
 * the research-tools gate (MIKE_DISABLE_RESEARCH_TOOLS=1 empties the whole
 * legal block in localAssistantTools.ts).
 */
export const CONSULT_ATTESTATIONS_ENABLED =
  process.env.MIKE_CONSULT_ATTESTATIONS === "1";

export const CONSULT_ATTESTED_CHARACTERIZATION_TOOL_NAME =
  "consult_attested_characterization";

const tool = (
  name: string,
  description: string,
  parameters: Record<string, unknown>,
): OpenAIToolSchema => ({
  type: "function",
  function: { name, description, parameters },
});

export const CITATOR_TOOLS: OpenAIToolSchema[] = [
  tool(
    "caselaw_note_up",
    "Find Canadian decisions that cite one case. Filter by court level or exact court code; sort by date or by how often each decision discusses the cited case. Returns bounded citing passages and occurrence counts, not editorial treatment labels.",
    {
      type: "object",
      properties: {
        citation: {
          type: "string",
          description:
            "The cited decision's citation on its own ('2019 SCC 65'), not prose around it.",
        },
        size: {
          type: "number",
          description:
            "Citing cases to return, 1-50 (default 10). Paging only — citing_cases_total is the real count; never read the returned count as how often the case was cited.",
        },
        court_scope: {
          type: "string",
          enum: ["all", "scc", "appellate", "trial", "tribunal"],
          description:
            "Court level to include. appellate excludes SCC; trial includes superior and inferior trial courts. Defaults to all.",
        },
        court_code: {
          type: "string",
          description:
            "Optional exact corpus court code, such as ONCA or BCSC. Use only with court_scope all.",
        },
        sort: {
          type: "string",
          enum: ["newest", "most_discussed"],
          description:
            "newest sorts by decision date. most_discussed ranks exact citation occurrences, then distinct citing paragraphs, court level, and recency. Defaults to newest.",
        },
      },
      required: ["citation"],
    },
  ),
  ...(CONSULT_ATTESTATIONS_ENABLED
    ? [
        tool(
          CONSULT_ATTESTED_CHARACTERIZATION_TOOL_NAME,
          "Consult attested characterizations of ONE cited Canadian case — other decisions' citing prose about it and law-journal footnotes' editor-verified propositions about it. Returns up to 3: the two top case-law characterizations first (court level, then how often the citing decision discusses the cited case within that level), then a journal characterization if available. These are other courts'/authors' words: quote them verbatim with attribution (the tool's evidence_ids), never paraphrase them as your own synthesis. A case nobody characterizes in the corpus returns the exact statement: No attested characterization of [citation] is available. Each result carries a follow_up telling you which fetch tool pulls the citing case or journal article if you need the surrounding source; journal articles also support page-level lookup via public_legal_source_lookup with provider journal, locator_type page, and the printed page number.",
          {
            type: "object",
            properties: {
              citation: {
                type: "string",
                description:
                  "The cited decision's citation on its own ('2019 SCC 65'), not prose around it.",
              },
            },
            required: ["citation"],
          },
        ),
      ]
    : []),
];

/** Handles caselaw_note_up; returns null for any other tool name. */
export type CitatorToolExecution = {
  payload: Record<string, unknown>;
  evidences?: LegalEvidenceReceipt[];
};

export function executeCitatorTool(
  name: string,
  args: Record<string, unknown>,
): CitatorToolExecution | null {
  if (
    name !== "caselaw_note_up" &&
    name !== CONSULT_ATTESTED_CHARACTERIZATION_TOOL_NAME
  )
    return null;
  const citation = typeof args.citation === "string" ? args.citation.trim() : "";
  if (!citation) return { payload: { ok: false, error: "citation is required" } };
  if (name === CONSULT_ATTESTED_CHARACTERIZATION_TOOL_NAME)
    return consultAttestedCharacterization(citation);
  const courtScope = (["all", "scc", "appellate", "trial", "tribunal"] as const).includes(
    args.court_scope as NoteUpCourtScope,
  )
    ? (args.court_scope as NoteUpCourtScope)
    : "all";
  const courtCode =
    typeof args.court_code === "string" ? args.court_code.trim().toUpperCase() : "";
  if (courtCode && courtScope !== "all") {
    return {
      payload: {
        ok: false,
        error: "court_code cannot be combined with a non-all court_scope",
      },
    };
  }
  const sort: NoteUpSort =
    args.sort === "most_discussed" ? "most_discussed" : "newest";
  try {
    const result = noteUpCitations({
      citation,
      size: typeof args.size === "number" ? args.size : undefined,
      courtScope,
      courtCode: courtCode || undefined,
      sort,
    });
    if (result === null) {
      return {
        payload: {
          ok: false,
          error: "citator_not_installed",
          detail:
            "No local note-up graph has been built (scripts/build_citator_graph.py).",
        },
      };
    }
    const evidences = result.entries.map((entry) =>
      citatorNoteUpReceipt({ citedCitation: citation, entry }),
    );
    return {
      evidences,
      payload: {
        ok: true,
        citation,
        court_scope: courtScope,
        court_code: courtCode || null,
        sort,
        citing_cases_total: result.total,
        returned: result.entries.length,
        truncated: result.total > result.entries.length,
        entries: result.entries.map((entry, index) => ({
          citation: entry.citation,
          name: entry.name,
          court: entry.court,
          court_level: entry.courtLevel,
          date: entry.date,
          url: entry.url,
          paragraph: entry.paragraph,
          occurrences: entry.occurrences,
          distinct_paragraphs: entry.distinctParagraphs,
          cited_as: entry.citedAs,
          pinpoints: entry.pinpoints,
          passage: entry.excerpt,
          evidence_id: evidences[index].evidence_id,
        })),
      },
    };
  } catch (error) {
    return { payload: { ok: false, error: (error as Error).message } };
  }
}

/**
 * consult_attested_characterization: ranked attested characterizations of a
 * cited case (H12 stands-for profile) under the production ordering
 * (scc_journal_first). Each attestation records WHOSE words they are and an
 * actionable follow_up so the model can pull the citing case (a2aj_fetch,
 * in-corpus) or the journal article (public_legal_source_fetch, provider
 * "journal") in its next round. A case nobody characterizes in prose returns
 * the exact typed statement — the model echoes it verbatim rather than
 * inventing a characterization. Pure local-sqlite read; no model calls.
 */
function consultAttestedCharacterization(
  citation: string,
): CitatorToolExecution {
  // Lazy env read (not the module-load const): the const gates whether the
  // tool is PRESENTED in CITATOR_TOOLS; this gate refuses execution even if
  // a name-guessed call slips through, and lets tests flip the switch.
  if (process.env.MIKE_CONSULT_ATTESTATIONS !== "1") {
    return {
      payload: {
        ok: false,
        error: "tool_not_enabled",
        detail:
          "consult_attested_characterization is gated behind MIKE_CONSULT_ATTESTATIONS=1.",
      },
    };
  }
  try {
    const profile = standsForProfile({
      citation,
      size: 3,
      rankPolicy: "scc_journal_first",
    });
    if (profile === null) {
      return {
        payload: {
          ok: false,
          error: "citator_not_installed",
          detail:
            "No local note-up graph has been built (scripts/build_citator_graph.py).",
        },
      };
    }
    if (profile.tier === "none") {
      return {
        payload: {
          ok: true,
          citation,
          rank_policy: profile.rankPolicy,
          tier: profile.tier,
          total_citers: profile.totalCiters,
          returned: 0,
          truncated: false,
          attestations: [],
          statement: `No attested characterization of ${citation} is available.`,
        },
      };
    }
    const evidences = profile.candidates.map((candidate) =>
      attestedCharacterizationReceipt({
        citedCitation: citation,
        characterization: candidate,
      }),
    );
    return {
      evidences,
      payload: {
        ok: true,
        citation,
        rank_policy: profile.rankPolicy,
        tier: profile.tier,
        total_citers: profile.totalCiters,
        returned: profile.candidates.length,
        truncated: false,
        attestations: profile.candidates.map((candidate, index) => ({
          text: candidate.text,
          source_kind: candidate.sourceKind,
          journal_name: candidate.journalName,
          citing_citation: candidate.citingCitation,
          citing_name: candidate.citingName,
          citing_court: candidate.citingCourt,
          date: candidate.citingDate,
          level: candidate.citingLevel,
          source_article_id: candidate.sourceArticleId,
          citing_url: candidate.citingUrl,
          evidence_id: evidences[index].evidence_id,
          follow_up:
            candidate.sourceKind === "commentary"
              ? {
                  tool: "public_legal_source_fetch",
                  provider: "journal",
                  identifier:
                    candidate.sourceArticleId ?? candidate.citingCitation,
                  page_lookup:
                    "public_legal_source_lookup with provider journal, locator_type page, and the printed page number",
                }
              : {
                  tool: "a2aj_fetch",
                  citation: candidate.citingCitation,
                },
        })),
      },
    };
  } catch (error) {
    return { payload: { ok: false, error: (error as Error).message } };
  }
}

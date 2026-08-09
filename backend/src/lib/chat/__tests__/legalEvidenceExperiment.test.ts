import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

const llm = vi.hoisted(() => ({ streamChatWithTools: vi.fn() }));

vi.mock("../../llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../llm")>()),
  streamChatWithTools: llm.streamChatWithTools,
}));

import type { A2AJDocument, A2AJLocatorLookup } from "../../a2aj";
import { fnv1a64 } from "../../legalClaimLint";
import {
  attestedCharacterizationReceipt,
  createA2AJLookupEvidence,
  createBenchmarkEvidence,
  createLegalEvidenceTurnState,
  deterministicClaimSupport,
  finalizeLegalEvidenceExperiment,
  legalEvidenceExperimentTools,
  legalEvidenceReceiptEvent,
  planLegalEvidence,
  registerLegalEvidence,
  renderLegalEvidenceAnswer,
  submitLegalEvidenceAnswer,
  submitLegalEvidenceVerification,
  submitHolisticLegalEvidenceVerification,
  temporalOrderInversion,
} from "../legalEvidenceExperiment";

const lookup: A2AJLocatorLookup = {
  status: "found",
  citation: "2024 SCC 6",
  alternateCitation: null,
  name: "R. v. Example",
  dataset: "SCC",
  url: "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/99999/index.do",
  language: "en",
  requested: { kind: "paragraph", locator: "12", label: "par12" },
  matches: ["par12"],
  block: {
    kind: "paragraph",
    label: "par12",
    start: 0,
    end: 45,
    origin: "native",
    text: "The governing test has three required elements.",
  },
  before: [],
  after: [],
  structure: {
    status: "usable",
    source: "flat_text",
    counts: { paragraph: 1, page: 0, section: 0 },
  },
  sourceMethod: "structure_index",
};

describe("provisional legal evidence contract", () => {
  it("uses stable IDs while distinguishing exact passage bytes", () => {
    const make = (spanText: string) =>
      createBenchmarkEvidence({
        jurisdiction: "CA",
        sourceClass: "case",
        stableSourceId: "case:1",
        sourceText: "alpha  beta",
        spanText,
        citation: "2024 SCC 1",
        dataset: "fixture",
        locatorLabel: "para 1",
      });
    const first = make("alpha  beta");
    const repeated = make("alpha  beta");
    const normalizedTwin = make("alpha beta");

    expect(repeated.evidence_id).toBe(first.evidence_id);
    expect(repeated.exact_span_sha256).toBe(first.exact_span_sha256);
    expect(normalizedTwin.span_sha256).toBe(first.span_sha256);
    expect(normalizedTwin.exact_span_sha256).not.toBe(first.exact_span_sha256);
    expect(normalizedTwin.evidence_id).not.toBe(first.evidence_id);
  });

  it("does not opt ordinary retrieval into a structured answer rewrite", () => {
    const state = createLegalEvidenceTurnState(null);
    registerLegalEvidence(state, createA2AJLookupEvidence(lookup)!);
    expect(state.mode).toBeNull();
  });

  it.each([
    "See 2020 BCSC 1122.",
    "[Royal Bank of Canada v. Mysak](https://www.bccourts.ca/jdb-txt/sc/20/11/2020BCSC1122.htm)",
  ])("rejects authority text that bypasses grounded citation rendering: %s", async (draft) => {
    llm.streamChatWithTools.mockResolvedValueOnce({ fullText: "" });
    const state = createLegalEvidenceTurnState(null);

    await expect(
      finalizeLegalEvidenceExperiment({ state, model: "test", draft }),
    ).resolves.toMatchObject({ passed: false, modelCalls: 1 });

    expect(state.mode).toBe("citation_structure");
    expect(renderLegalEvidenceAnswer(state)).toBe(
      "The model did not submit a grounded answer.",
    );
  });

  it("renders only claims separately verified against turn-local passages", () => {
    const state = createLegalEvidenceTurnState("compose_check");
    const evidence = createA2AJLookupEvidence(lookup)!;
    registerLegalEvidence(state, evidence, { lookup });

    expect(
      submitLegalEvidenceAnswer(
        {
          claims: [
            {
              text: "The governing test has three elements.",
              evidence_ids: [evidence.evidence_id],
            },
          ],
        },
        state,
      ),
    ).toEqual({ ok: true, terminal: true });
    expect(renderLegalEvidenceAnswer(state)).toBeNull();

    expect(
      submitLegalEvidenceVerification(
        {
          coverage: "complete",
          claims: [
            {
              index: 0,
              context_status: "preserved",
              evidence_status: "supported",
            },
          ],
        },
        state,
      ),
    ).toEqual({ ok: true, terminal: true });
    expect(renderLegalEvidenceAnswer(state)).toBe(
      "The governing test has three elements [2024 SCC 6 at para. 12](https://www.canlii.org/en/ca/scc/doc/2024/2024scc6/2024scc6.html#par12).",
    );
    expect(legalEvidenceReceiptEvent(state)).toMatchObject({
      schema_version: 6,
      mode: "compose_check",
      status: "passed",
      verification: {
        reference: "verified",
        semantic: "model_checked",
        coverage: "complete",
        authority: "not_run",
      },
      evidence: [
        {
          evidence_id: evidence.evidence_id,
          scope: "passage",
          span_text: lookup.block!.text,
        },
      ],
    });

    const nextTurn = createLegalEvidenceTurnState("compose_check");
    expect(
      submitLegalEvidenceAnswer(
        {
          claims: [
            {
              text: "The same claim.",
              evidence_ids: [evidence.evidence_id],
            },
          ],
        },
        nextTurn,
      ),
    ).toMatchObject({ ok: false });
  });

  it("requires evidence-first claims to stay inside the accepted plan", () => {
    const state = createLegalEvidenceTurnState("evidence_first");
    const first = createA2AJLookupEvidence(lookup)!;
    const second = { ...first, evidence_id: "e_second" };
    registerLegalEvidence(state, first, { lookup });
    registerLegalEvidence(state, second, { lookup });

    expect(
      planLegalEvidence(
        {
          answerability: "sufficient",
          evidence_ids: [first.evidence_id],
        },
        state,
      ),
    ).toEqual({ ok: true });
    expect(
      submitLegalEvidenceAnswer(
        {
          claims: [
            {
              text: "A proposition.",
              evidence_ids: [second.evidence_id],
            },
          ],
        },
        state,
      ),
    ).toEqual({
      ok: false,
      errors: ["claims[0] uses evidence outside the accepted plan"],
    });
  });

  it("places a verified paragraph-range citation without parsing claim prose", async () => {
    const text = [
      "[8] The earlier paragraph supplies unrelated procedural background.",
      "[9] This paragraph supplies additional history before the disputed issue.",
      "[10] The range begins with a distinctive finding about the payor's disclosure default.",
      "[11] The court explains why the resulting financial disarray cannot establish hardship.",
      "[12] The range ends by explaining why the cost cannot be shifted to the child.",
      "[13] The next paragraph addresses costs on the appeal.",
    ].join("\n");
    const rangeLookup: A2AJLocatorLookup = {
      ...lookup,
      citation: "2010 BCCA 170",
      name: "Tschudi v. Tschudi",
      dataset: "BCCA",
      url: "https://www.canlii.org/en/bc/bcca/doc/2010/2010bcca170/2010bcca170.html",
      requested: {
        kind: "paragraph",
        locator: "10-12",
        label: "par10-par12",
      },
      matches: ["par10", "par11", "par12"],
      block: {
        kind: "paragraph",
        label: "par10-par12",
        start: text.indexOf("[10]"),
        end: text.indexOf("\n[13]"),
        origin: "native",
        text: text.slice(text.indexOf("[10]"), text.indexOf("\n[13]")),
      },
    };
    const document: A2AJDocument = {
      dataset: rangeLookup.dataset,
      citation: rangeLookup.citation,
      alternateCitation: null,
      name: rangeLookup.name,
      date: "2010-04-13",
      url: rangeLookup.url,
      text,
      language: "en",
      upstreamLicense: null,
      structure: {
        status: "unavailable",
        source: "flat_text",
        counts: { paragraph: 0, page: 0, section: 0 },
      },
    };
    const state = createLegalEvidenceTurnState("citation_structure");
    const evidence = createA2AJLookupEvidence(rangeLookup)!;
    registerLegalEvidence(state, evidence, { lookup: rangeLookup, document });

    expect(state.mode).toBe("citation_structure");
    for (const text of [
      "The court rejected the hardship argument: paras. 10-12.",
      "2010 BCCA 170 rejected the hardship argument.",
    ]) {
      expect(
        submitLegalEvidenceAnswer(
          {
            claims: [{ text, evidence_ids: [evidence.evidence_id] }],
          },
          state,
        ),
      ).toEqual({ ok: true, terminal: true });
      const rendered = renderLegalEvidenceAnswer(state)!;
      expect(
        rendered.match(/\[2010 BCCA 170 at paras\. 10\u201312\]/gu),
      ).toHaveLength(1);
      expect(rendered).toContain("#par10:~:text=");
    }
    expect(
      submitLegalEvidenceAnswer(
        {
          claims: [
            {
              text: "The court rejected the payor's hardship argument.",
              evidence_ids: [evidence.evidence_id],
            },
          ],
        },
        state,
      ),
    ).toEqual({ ok: true, terminal: true });
    await expect(
      finalizeLegalEvidenceExperiment({
        state,
        model: "unused",
        draft: "",
      }),
    ).resolves.toMatchObject({ passed: true, modelCalls: 0 });

    const rendered = renderLegalEvidenceAnswer(state)!;
    expect(rendered).toContain(
      "[2010 BCCA 170 at paras. 10\u201312](https://www.canlii.org/en/bc/bcca/doc/2010/2010bcca170/2010bcca170.html#par10:~:text=",
    );
    expect(rendered).toMatch(/#par10:~:text=[^)]+,[^)]+\)\.$/u);
    expect(legalEvidenceReceiptEvent(state)).toMatchObject({
      schema_version: 6,
      mode: "citation_structure",
      status: "passed",
      verification: {
        reference: "verified",
        semantic: "not_run",
        coverage: "not_run",
      },
    });
  });

  it("keeps cross-block multi-spans behind the experiment flag", () => {
    const text = [
      "[1] Ancient forests hold clean water beneath a changing sky.",
      "[2] Ancient forests hold clean water beneath a changing sky.",
      "[3] Migratory birds cross open air above the northern wetlands.",
      "[4] Old roots remember rain after the summer fires.",
    ].join("\n");
    const document: A2AJDocument = {
      dataset: "SCC",
      citation: "2023 SCC 23",
      alternateCitation: null,
      name: "Reference re Impact Assessment Act",
      date: "2023-10-13",
      url: "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/20102/index.do",
      text,
      language: "en",
      upstreamLicense: null,
      structure: {
        status: "unavailable",
        source: "flat_text",
        counts: { paragraph: 4, page: 0, section: 0 },
      },
    };
    const paragraph = (number: 1 | 3 | 4): A2AJLocatorLookup => {
      const start = text.indexOf(`[${number}]`);
      const end = text.indexOf("\n", start);
      return {
        ...lookup,
        citation: document.citation,
        name: document.name,
        url: document.url,
        requested: {
          kind: "paragraph",
          locator: String(number),
          label: `par${number}`,
        },
        matches: [`par${number}`],
        block: {
          kind: "paragraph",
          label: `par${number}`,
          start,
          end: end < 0 ? text.length : end,
          origin: "native",
          text: text.slice(start, end < 0 ? text.length : end),
        },
      };
    };
    const render = (
      mode: "citation_structure" | "arbitrary_source_spans",
    ) => {
      const state = createLegalEvidenceTurnState(mode);
      const lookups = [paragraph(1), paragraph(3), paragraph(4)];
      const evidence = lookups.map((item) => createA2AJLookupEvidence(item)!);
      evidence.forEach((item, index) =>
        registerLegalEvidence(state, item, {
          lookup: lookups[index],
          document,
        }),
      );
      expect(
        submitLegalEvidenceAnswer(
          {
            claims: [{
              text:
                "\u201cforests hold clean water\u201d \u2014 " +
                "\u201cbirds cross open air\u201d \u2014 " +
                "\u201croots remember rain\u201d",
              evidence_ids: evidence.map(({ evidence_id }) => evidence_id),
            }],
          },
          state,
        ),
      ).toEqual({ ok: true, terminal: true });
      return renderLegalEvidenceAnswer(state)!;
    };

    const safe = render("citation_structure");
    expect(safe.match(/\[2023 SCC 23 at para\./gu)).toHaveLength(3);
    expect(safe).not.toContain("text=");

    const experimental = render("arbitrary_source_spans");
    expect(experimental.match(/\[2023 SCC 23\]/gu)).toHaveLength(1);
    expect(experimental.match(/text=/gu)).toHaveLength(2);
    expect(experimental).toContain("?iframe=true&site_preference=mobile#:~:");
    expect(experimental).not.toContain("forests%20hold%20clean%20water");
    expect(experimental).not.toContain("1%5D");
  });

  it("terminates an evidence-first turn when the passages are insufficient", () => {
    const state = createLegalEvidenceTurnState("evidence_first");
    const evidence = createA2AJLookupEvidence(lookup)!;
    registerLegalEvidence(state, evidence, { lookup });

    expect(
      planLegalEvidence(
        { answerability: "insufficient", evidence_ids: [] },
        state,
      ),
    ).toEqual({ ok: true, terminal: true });
    expect(state.answerability).toBe("insufficient");
    expect(renderLegalEvidenceAnswer(state)).toBe(
      "The retrieved passages do not contain enough information to answer this question.",
    );
    expect(
      submitLegalEvidenceAnswer(
        {
          claims: [
            {
              text: "A proposition.",
              evidence_ids: [evidence.evidence_id],
            },
          ],
        },
        state,
      ),
    ).toEqual({
      ok: false,
      errors: ["a sufficient evidence plan is required before composing"],
    });
    expect(
      planLegalEvidence(
        {
          answerability: "insufficient",
          evidence_ids: [evidence.evidence_id],
        },
        createLegalEvidenceTurnState("evidence_first"),
      ),
    ).toEqual({
      ok: false,
      errors: ["an insufficient plan cannot include evidence_ids"],
    });
  });

  it("rejects a document-only handle even when another handle has a passage", () => {
    const state = createLegalEvidenceTurnState("compose_check");
    const passage = createA2AJLookupEvidence(lookup)!;
    const documentOnly = {
      ...passage,
      evidence_id: "e_document",
      scope: "document" as const,
      span_text: null,
    };
    registerLegalEvidence(state, passage, { lookup });
    registerLegalEvidence(state, documentOnly, { lookup });

    expect(
      submitLegalEvidenceAnswer(
        {
          claims: [
            {
              text: "A proposition.",
              evidence_ids: [
                passage.evidence_id,
                documentOnly.evidence_id,
              ],
            },
          ],
        },
        state,
      ),
    ).toEqual({
      ok: false,
      errors: [
        "claims[0] requires an exact passage for every evidence_id",
      ],
    });
  });

  it("rejects duplicate evidence handles locally", () => {
    const state = createLegalEvidenceTurnState("compose_check");
    const evidence = createA2AJLookupEvidence(lookup)!;
    registerLegalEvidence(state, evidence, { lookup });

    expect(
      submitLegalEvidenceAnswer(
        {
          claims: [
            {
              text: "A proposition.",
              evidence_ids: [evidence.evidence_id, evidence.evidence_id],
            },
          ],
        },
        state,
      ),
    ).toEqual({
      ok: false,
      errors: ["claims[0].evidence_ids must contain 1 to 16 handles"],
    });
  });

  it("exposes distinct tool orderings without the removed claim taxonomy", () => {
    expect(
      legalEvidenceExperimentTools("compose_check").map(
        (tool) => tool.function.name,
      ),
    ).toEqual(["submit_grounded_answer"]);
    expect(
      legalEvidenceExperimentTools("evidence_first").map(
        (tool) => tool.function.name,
      ),
    ).toEqual(["plan_grounded_evidence", "submit_grounded_answer"]);
    expect(
      legalEvidenceExperimentTools("holistic_check").map(
        (tool) => tool.function.name,
      ),
    ).toEqual(["submit_grounded_answer"]);
    expect(
      legalEvidenceExperimentTools(null).map(
        (tool) => tool.function.name,
      ),
    ).toEqual(["submit_grounded_answer"]);
    expect(
      JSON.stringify(legalEvidenceExperimentTools("compose_check")),
    ).not.toContain("claim_type");
    expect(
      JSON.stringify(legalEvidenceExperimentTools("compose_check")),
    ).not.toContain("atomic");
  });

  it("fails closed when context changes or coverage is incomplete", () => {
    const state = createLegalEvidenceTurnState("compose_check");
    const evidence = createA2AJLookupEvidence(lookup)!;
    registerLegalEvidence(state, evidence, { lookup });
    submitLegalEvidenceAnswer(
      {
        claims: [
          {
            text: "The governing test has three elements.",
            evidence_ids: [evidence.evidence_id],
          },
        ],
      },
      state,
    );

    expect(
      submitLegalEvidenceVerification(
        {
          coverage: "incomplete",
          claims: [
            {
              index: 0,
              context_status: "changed",
              evidence_status: "supported",
            },
          ],
        },
        state,
      ),
    ).toEqual({ ok: true, terminal: true });
    expect(renderLegalEvidenceAnswer(state)).toBeNull();
    expect(legalEvidenceReceiptEvent(state)).toMatchObject({
      status: "failed",
      verification: { coverage: "incomplete", semantic: "failed" },
      claims: [
        {
          context_status: "changed",
          evidence_status: "supported",
        },
      ],
    });
  });

  it("renders a holistic answer only after a whole-answer support verdict", () => {
    const state = createLegalEvidenceTurnState("holistic_check");
    const evidence = createA2AJLookupEvidence(lookup)!;
    registerLegalEvidence(state, evidence, { lookup });
    submitLegalEvidenceAnswer(
      {
        claims: [
          {
            text: "The governing test has three elements.",
            evidence_ids: [evidence.evidence_id],
          },
        ],
      },
      state,
    );

    expect(renderLegalEvidenceAnswer(state)).toBeNull();
    expect(
      submitHolisticLegalEvidenceVerification(
        { verdict: "supported" },
        state,
      ),
    ).toEqual({ ok: true, terminal: true });
    expect(renderLegalEvidenceAnswer(state)).toContain(
      "https://www.canlii.org/en/ca/scc/doc/2024/2024scc6/2024scc6.html#par12",
    );
    expect(legalEvidenceReceiptEvent(state)).toMatchObject({
      schema_version: 6,
      status: "passed",
      verification: {
        answerability: "not_run",
        holistic: "supported",
        semantic: "model_checked",
        coverage: "complete",
      },
    });
  });
});

describe("quote_first deterministic contract enforcement", () => {
  const passage =
    "If rent is unpaid when due, the landlord may deliver a written notice " +
    "to terminate the lease not less than seven business days after receipt.";

  function quoteFirstState() {
    const state = createLegalEvidenceTurnState("quote_first");
    const receipt = createBenchmarkEvidence({
      stableSourceId: "test:qf",
      sourceText: passage,
      spanText: passage,
      citation: "ALA. CODE § 35-9A-421(b)",
      dataset: "test",
      locatorKind: "section",
      locatorLabel: "ALA. CODE § 35-9A-421(b)",
      jurisdiction: "US",
      sourceClass: "legislation",
    });
    registerLegalEvidence(state, receipt);
    return { state, id: receipt.evidence_id };
  }

  it("rejects answers with more than one non-verbatim claim", () => {
    const { state, id } = quoteFirstState();
    const result = submitLegalEvidenceAnswer(
      {
        claims: [
          { text: "Alabama broadly regulates evictions.", evidence_ids: [id] },
          { text: "Notice is always required in every case.", evidence_ids: [id] },
        ],
      },
      state,
    );
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toContain("verbatim quotations");
    expect(state.answer).toBeNull();
  });

  it("accepts verbatim quotes plus one conclusion claim", () => {
    const { state, id } = quoteFirstState();
    expect(
      submitLegalEvidenceAnswer(
        {
          claims: [
            {
              text:
                "If rent is unpaid when due, the landlord may deliver a " +
                "written notice to terminate the lease not less than seven " +
                "business days after receipt.",
              evidence_ids: [id],
            },
            {
              text: "Yes — written notice must precede termination.",
              evidence_ids: [id],
            },
          ],
        },
        state,
      ),
    ).toEqual({ ok: true, terminal: true });
  });
});

describe("deterministic verbatim-quote tier (tiered_check)", () => {
  const passage =
    "If rent is unpaid when due, the landlord may deliver a written notice to " +
    "terminate the lease — a date not less than seven business days after " +
    "receipt of the notice.";

  function tieredState() {
    const state = createLegalEvidenceTurnState("tiered_check");
    const receipt = createBenchmarkEvidence({
      stableSourceId: "test:ala",
      sourceText: passage,
      spanText: passage,
      citation: "ALA. CODE § 35-9A-421(b)",
      dataset: "test",
      locatorKind: "section",
      locatorLabel: "ALA. CODE § 35-9A-421(b)",
      jurisdiction: "US",
      sourceClass: "legislation",
    });
    registerLegalEvidence(state, receipt);
    return { state, id: receipt.evidence_id };
  }

  const claim = (text: string, id: string) => ({
    text,
    evidence_ids: [id],
  });

  it("clears an exact quotation with a trailing citation tail", () => {
    const { state, id } = tieredState();
    expect(
      deterministicClaimSupport(
        claim(
          "“If rent is unpaid when due, the landlord may deliver a written " +
            "notice to terminate the lease — a date not less than seven " +
            "business days after receipt of the notice.” " +
            "(ALA. CODE § 35-9A-421(b))",
          id,
        ),
        state,
      ),
    ).toBe(true);
  });

  it("normalizes curly quotes, dash widths, and whitespace, never words", () => {
    const { state, id } = tieredState();
    expect(
      deterministicClaimSupport(
        claim(
          "If rent is unpaid when due,  the landlord may deliver a written " +
            "notice to terminate the lease - a date not less than seven " +
            "business days after receipt of the notice. " +
            "(ALA. CODE § 35-9A-421(b))",
          id,
        ),
        state,
      ),
    ).toBe(true);
    expect(
      deterministicClaimSupport(
        claim(
          "If rent is unpaid when due, the landlord may deliver a written " +
            "notice to terminate the lease — a date not less than seven " +
            "calendar days after receipt of the notice. " +
            "(ALA. CODE § 35-9A-421(b))",
          id,
        ),
        state,
      ),
    ).toBe(false);
  });

  it("refuses paraphrase, prose framing, and short fragments", () => {
    const { state, id } = tieredState();
    expect(
      deterministicClaimSupport(
        claim(
          "Alabama requires seven business days' notice before termination. " +
            "(ALA. CODE § 35-9A-421(b))",
          id,
        ),
        state,
      ),
    ).toBe(false);
    expect(
      deterministicClaimSupport(
        claim(
          "Because the statute says “seven business days”, notice is required. " +
            "(ALA. CODE § 35-9A-421(b))",
          id,
        ),
        state,
      ),
    ).toBe(false);
    expect(
      deterministicClaimSupport(
        claim("“seven business days” (ALA. CODE § 35-9A-421(b))", id),
        state,
      ),
    ).toBe(false);
  });

  it("records the deterministic path honestly in the receipt", () => {
    const { state, id } = tieredState();
    const text =
      "“If rent is unpaid when due, the landlord may deliver a written " +
      "notice to terminate the lease — a date not less than seven business " +
      "days after receipt of the notice.”";
    expect(
      submitLegalEvidenceAnswer({ claims: [claim(text, id)] }, state),
    ).toEqual({ ok: true, terminal: true });
    state.deterministicSupport = state.answer!.map((entry) =>
      deterministicClaimSupport(entry, state),
    );
    expect(state.deterministicSupport).toEqual([true]);
    expect(renderLegalEvidenceAnswer(state)).toContain("seven business days");
    expect(legalEvidenceReceiptEvent(state)).toMatchObject({
      status: "passed",
      verification: {
        holistic: "not_run",
        semantic: "not_run",
        coverage: "not_run",
      },
      claims: [{ deterministic_support: true }],
    });
  });
});

describe("attested characterizations (H12 widened tier)", () => {
  const characterization = {
    text:
      "the Supreme Court has set a presumptive ceiling beyond which delay " +
      "is presumed unreasonable unless exceptional circumstances justify it",
    citingCitation: "2023 SCC 30",
    citingName: "R. v. Citing Example",
    citingCourt: "SCC",
    citingDate: "2023-05-05",
    spanSha256: "ignored-by-receipt-builder",
  };

  function statePlusCharacterization() {
    const state = createLegalEvidenceTurnState("quote_first");
    const receipt = attestedCharacterizationReceipt({
      citedCitation: "2016 SCC 27",
      characterization,
    });
    registerLegalEvidence(state, receipt);
    return { state, receipt };
  }

  it("builds a citator receipt that names whose words these are", () => {
    const { receipt } = statePlusCharacterization();
    expect(receipt).toMatchObject({
      provider: "citator",
      source_class: "case",
      citation: "2016 SCC 27",
      name: "R. v. Citing Example",
      block_id: "standsfor:2023 SCC 30",
      resolver_version: "citator-standsfor-v1",
    });
    expect(receipt.locator.label).toBe(
      "as characterized by 2023 SCC 30 (SCC)",
    );
    expect(receipt.span_text).toBe(characterization.text);
  });

  it("renders the attested characterization with attribution and a source link", () => {
    const state = createLegalEvidenceTurnState("citation_structure");
    const receipt = attestedCharacterizationReceipt({
      citedCitation: "2016 SCC 27",
      characterization: {
        ...characterization,
        citingUrl:
          "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/99999/index.do",
      },
    });
    registerLegalEvidence(state, receipt);

    expect(
      submitLegalEvidenceAnswer(
        {
          claims: [
            {
              text:
                "the Supreme Court has set a presumptive ceiling beyond which " +
                "delay is presumed unreasonable unless exceptional circumstances " +
                "justify it",
              evidence_ids: [receipt.evidence_id],
            },
          ],
        },
        state,
      ),
    ).toEqual({ ok: true, terminal: true });

    const rendered = renderLegalEvidenceAnswer(state)!;
    // The attribution reads as its own locator after an em dash and links
    // to the EXACT prose within the citing case via a text-fragment
    // pinpoint — like any other citation (not presented as the assistant's
    // own synthesis).
    expect(rendered).toContain(
      "[2016 SCC 27 — as characterized by 2023 SCC 30 (SCC)](" +
        "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/99999/index.do" +
        "?iframe=true&site_preference=mobile#:~:text=",
    );
  });

  it("clears a claim quoting the attested characterization verbatim", () => {
    const { state, receipt } = statePlusCharacterization();
    expect(
      deterministicClaimSupport(
        {
          text:
            "“the Supreme Court has set a presumptive ceiling beyond which " +
            "delay is presumed unreasonable unless exceptional circumstances " +
            "justify it” (2016 SCC 27)",
          evidence_ids: [receipt.evidence_id],
        },
        state,
      ),
    ).toBe(true);
  });

  it("rejects a mutated citance — one substituted word fails the tier", () => {
    const { state, receipt } = statePlusCharacterization();
    expect(
      deterministicClaimSupport(
        {
          text:
            "“the Supreme Court has set a mandatory ceiling beyond which " +
            "delay is presumed unreasonable unless exceptional circumstances " +
            "justify it” (2016 SCC 27)",
          evidence_ids: [receipt.evidence_id],
        },
        state,
      ),
    ).toBe(false);
  });

  it("rejects a splice across characterization and passage evidence", () => {
    const { state, receipt } = statePlusCharacterization();
    const passage = createBenchmarkEvidence({
      stableSourceId: "test:jordan",
      sourceText: "The total delay was 49.5 months in provincial court.",
      spanText: "The total delay was 49.5 months in provincial court.",
      citation: "2016 SCC 27",
      dataset: "test",
      locatorKind: "section",
      locatorLabel: "para 5",
      jurisdiction: "CA",
      sourceClass: "case",
    });
    registerLegalEvidence(state, passage);
    expect(
      deterministicClaimSupport(
        {
          text:
            "“the Supreme Court has set a presumptive ceiling beyond which " +
            "delay is presumed unreasonable The total delay was 49.5 months " +
            "in provincial court.” (2016 SCC 27)",
          evidence_ids: [receipt.evidence_id, passage.evidence_id],
        },
        state,
      ),
    ).toBe(false);
  });

  it("labels commentary characterizations with the journal, not a court", () => {
    const receipt = attestedCharacterizationReceipt({
      citedCitation: "2016 SCC 27",
      characterization: {
        ...characterization,
        citingCitation: null,
        citingCourt: null,
        sourceKind: "commentary",
        journalName: "McGill Law Journal",
      },
    });
    expect(receipt).toMatchObject({
      dataset: "journal-commentary",
      stable_source_id: "citator:standsfor:McGill Law Journal",
    });
    expect(receipt.locator.label).toBe(
      "as characterized in McGill Law Journal",
    );
  });
});

describe("attested_framing stands-for gate (Stage 8)", () => {
  const characterization = {
    text:
      "the Supreme Court has set a presumptive ceiling beyond which delay " +
      "is presumed unreasonable unless exceptional circumstances justify it",
    citingCitation: "2023 SCC 30",
    citingName: "R. v. Citing Example",
    citingCourt: "SCC",
    citingDate: "2023-05-05",
    spanSha256: "ignored-by-receipt-builder",
  };

  function framingState() {
    const state = createLegalEvidenceTurnState("attested_framing");
    const passage = createBenchmarkEvidence({
      stableSourceId: "test:jordan",
      sourceText: "The total delay was 49.5 months in provincial court.",
      spanText: "The total delay was 49.5 months in provincial court.",
      citation: "2016 SCC 27",
      dataset: "test",
      locatorKind: "section",
      locatorLabel: "para 5",
      jurisdiction: "CA",
      sourceClass: "case",
    });
    registerLegalEvidence(state, passage);
    const attested = attestedCharacterizationReceipt({
      citedCitation: "2016 SCC 27",
      characterization,
    });
    registerLegalEvidence(state, attested);
    return { state, passage, attested };
  }

  it("rejects composed stands-for framing even as the one conclusion claim", () => {
    const { state, passage } = framingState();
    const result = submitLegalEvidenceAnswer(
      {
        claims: [
          {
            text: "“The total delay was 49.5 months in provincial court.”",
            evidence_ids: [passage.evidence_id],
          },
          {
            text: "The case establishes a comprehensive framework governing unreasonable delay.",
            evidence_ids: [passage.evidence_id],
          },
        ],
      },
      state,
    );
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toContain("stands-for language");
  });

  it("accepts stands-for framing quoted verbatim from the attested characterization", () => {
    const { state, passage, attested } = framingState();
    expect(
      submitLegalEvidenceAnswer(
        {
          claims: [
            {
              text: "“The total delay was 49.5 months in provincial court.”",
              evidence_ids: [passage.evidence_id],
            },
            {
              text:
                "“the Supreme Court has set a presumptive ceiling beyond " +
                "which delay is presumed unreasonable unless exceptional " +
                "circumstances justify it”",
              evidence_ids: [attested.evidence_id],
            },
          ],
        },
        state,
      ),
    ).toEqual({ ok: true, terminal: true });
  });

  it("leaves statute conclusions alone — the gate needs case evidence (HousingQA no-op)", () => {
    const state = createLegalEvidenceTurnState("attested_framing");
    const statute = createBenchmarkEvidence({
      stableSourceId: "test:statute",
      sourceText:
        "A landlord may terminate a tenancy only on a ground set out in this section.",
      spanText:
        "A landlord may terminate a tenancy only on a ground set out in this section.",
      citation: "RTA s 37",
      dataset: "test",
      locatorKind: "section",
      locatorLabel: "s 37",
      jurisdiction: "CA",
      sourceClass: "legislation",
    });
    registerLegalEvidence(state, statute);
    expect(
      submitLegalEvidenceAnswer(
        {
          claims: [
            {
              text: "“A landlord may terminate a tenancy only on a ground set out in this section.”",
              evidence_ids: [statute.evidence_id],
            },
            {
              text: "The section governs which grounds permit termination.",
              evidence_ids: [statute.evidence_id],
            },
          ],
        },
        state,
      ),
    ).toEqual({ ok: true, terminal: true });
  });
});

describe("lint_gated soft gate (Stage 7 / H7+H13+H14)", () => {
  const passage =
    "If rent is unpaid when due, the landlord may deliver a written notice " +
    "to terminate the lease not less than seven business days after receipt.";
  const question = "What notice must an Alabama landlord give before eviction?";
  const overreach =
    "Alabama maintains a comprehensive regulatory framework broadly " +
    "governing residential evictions, imposing systematic statewide " +
    "oversight obligations and licensing duties across municipalities.";

  function lintGatedState() {
    const state = createLegalEvidenceTurnState("lint_gated");
    // Nonexistent index path keeps H13 off (documented null contract),
    // so these vectors exercise only the index-free features.
    state.lintContext = {
      question,
      alienessIndexPath: "Z:/nonexistent/trigrams-en.sqlite",
    };
    const receipt = createBenchmarkEvidence({
      stableSourceId: "test:lint",
      sourceText: passage,
      spanText: passage,
      citation: "ALA. CODE § 35-9A-421(b)",
      dataset: "test",
      locatorKind: "section",
      locatorLabel: "ALA. CODE § 35-9A-421(b)",
      jurisdiction: "US",
      sourceClass: "legislation",
    });
    registerLegalEvidence(state, receipt);
    return { state, id: receipt.evidence_id };
  }

  it("bounces a flagged composed claim exactly once, naming the feature", () => {
    const { state, id } = lintGatedState();
    const first = submitLegalEvidenceAnswer(
      { claims: [{ text: overreach, evidence_ids: [id] }] },
      state,
    );
    expect(first.ok).toBe(false);
    expect(first.errors?.[0]).toContain("deterministic lint");
    expect(first.errors?.[0]).toContain("novel_content_fraction");
    expect(state.lintBounced).toBe(true);
    expect(state.answer).toBeNull();

    const second = submitLegalEvidenceAnswer(
      { claims: [{ text: overreach, evidence_ids: [id] }] },
      state,
    );
    expect(second).toEqual({ ok: true, terminal: true });
    expect(state.lintReceipts?.[0]?.some((r) => r.fired === true)).toBe(true);
  });

  it("keeps lint receipts in the receipt event for calibration", () => {
    const { state, id } = lintGatedState();
    submitLegalEvidenceAnswer(
      { claims: [{ text: overreach, evidence_ids: [id] }] },
      state,
    );
    submitLegalEvidenceAnswer(
      { claims: [{ text: overreach, evidence_ids: [id] }] },
      state,
    );
    const event = legalEvidenceReceiptEvent(state);
    expect(event?.claims[0]?.lint?.length).toBeGreaterThan(0);
  });

  it("never fires on claims under the minimum content-word gate", () => {
    const { state, id } = lintGatedState();
    const result = submitLegalEvidenceAnswer(
      {
        claims: [
          { text: "A comprehensive framework governs.", evidence_ids: [id] },
        ],
      },
      state,
    );
    expect(result).toEqual({ ok: true, terminal: true });
    expect(state.lintBounced).toBe(false);
  });

  it("skips lint entirely for claims the verbatim tier clears", () => {
    const { state, id } = lintGatedState();
    const result = submitLegalEvidenceAnswer(
      { claims: [{ text: passage, evidence_ids: [id] }] },
      state,
    );
    expect(result).toEqual({ ok: true, terminal: true });
    expect(state.lintBounced).toBe(false);
    expect(state.lintReceipts?.[0]).toEqual([]);
  });
});

describe("Stage 8b typed claim roles and required characterization slot", () => {
  const passage =
    "If rent is unpaid when due, the landlord may deliver a written notice " +
    "to terminate the lease not less than seven business days after receipt.";
  const question =
    "Given that Alabama requires thirty days of notice before any eviction, " +
    "can a landlord terminate a lease for unpaid rent?";

  function typedState(mode: "quote_first" | "required_slot" | "lint_gated") {
    const state = createLegalEvidenceTurnState(mode);
    state.premiseContext = { question, priorAnswer: null };
    const receipt = createBenchmarkEvidence({
      stableSourceId: "test:8b",
      sourceText: passage,
      spanText: passage,
      citation: "ALA. CODE § 35-9A-421(b)",
      dataset: "test",
      locatorKind: "section",
      locatorLabel: "ALA. CODE § 35-9A-421(b)",
      jurisdiction: "US",
      sourceClass: "legislation",
    });
    registerLegalEvidence(state, receipt);
    return { state, id: receipt.evidence_id };
  }

  it("accepts a verified premise correction beyond the conclusion allowance", () => {
    const { state, id } = typedState("quote_first");
    expect(
      submitLegalEvidenceAnswer(
        {
          claims: [
            { text: `“${passage}”`, evidence_ids: [id], kind: "quotation" },
            {
              text: "Yes — after seven business days' written notice.",
              evidence_ids: [id],
              kind: "conclusion",
            },
            {
              text:
                "The question assumes a thirty-day notice period; the cited " +
                "section instead sets seven business days.",
              evidence_ids: [id],
              kind: "premise_correction",
              premise_source: "question",
              premise_text: "thirty days of notice before any eviction",
            },
          ],
        },
        state,
      ),
    ).toEqual({ ok: true, terminal: true });
    expect(
      legalEvidenceReceiptEvent(state)?.claims[2],
    ).toMatchObject({ kind: "premise_correction", premise_support: true });
  });

  it("rejects an unanchored premise_text and archives the bounce", () => {
    const { state, id } = typedState("quote_first");
    const result = submitLegalEvidenceAnswer(
      {
        claims: [
          {
            text: "The question assumes sixty days of notice; it does not.",
            evidence_ids: [id],
            kind: "premise_correction",
            premise_source: "question",
            premise_text: "sixty days of notice",
          },
        ],
      },
      state,
    );
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toContain("not a verbatim substring");
    const event = legalEvidenceReceiptEvent(state);
    expect(event?.bounces).toHaveLength(1);
    expect(event?.bounces[0].claims[0]).toMatchObject({
      premise_text: "sixty days of notice",
    });
    expect(event?.bounces[0].errors[0]).toContain("premise_correction");
  });

  it("rejects prior_answer anchoring when no prior answer exists", () => {
    const { state, id } = typedState("quote_first");
    const result = submitLegalEvidenceAnswer(
      {
        claims: [
          {
            text: "My earlier answer overstated the notice period.",
            evidence_ids: [id],
            kind: "premise_correction",
            premise_source: "prior_answer",
            premise_text: "thirty days of notice",
          },
        ],
      },
      state,
    );
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toContain("no prior assistant answer");
  });

  it("rejects a typed quotation that is not verbatim", () => {
    const { state, id } = typedState("quote_first");
    const result = submitLegalEvidenceAnswer(
      {
        claims: [
          {
            text: "Landlords may deliver written notices to end the lease.",
            evidence_ids: [id],
            kind: "quotation",
          },
        ],
      },
      state,
    );
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toContain('kind "quotation"');
  });

  it("requires premise fields on premise corrections and nowhere else", () => {
    const { state, id } = typedState("quote_first");
    expect(
      submitLegalEvidenceAnswer(
        {
          claims: [
            {
              text: "The question rests on a mistaken premise.",
              evidence_ids: [id],
              kind: "premise_correction",
            },
          ],
        },
        state,
      ).errors?.[0],
    ).toContain("must carry premise_source and premise_text");
    expect(
      submitLegalEvidenceAnswer(
        {
          claims: [
            {
              text: "Yes, notice is required.",
              evidence_ids: [id],
              kind: "conclusion",
              premise_text: "thirty days of notice",
            },
          ],
        },
        state,
      ).errors?.[0],
    ).toContain("not kind premise_correction");
  });

  describe("required_slot (H15)", () => {
    const casePassage =
      "The total delay from the charge to the actual or anticipated end of " +
      "trial exceeded the presumptive ceiling and was not justified.";
    const characterization = {
      text:
        "the Supreme Court has set a presumptive ceiling beyond which delay " +
        "is presumed unreasonable unless exceptional circumstances justify it",
      citingCitation: "2023 SCC 30",
      citingName: "R. v. Citing Example",
      citingCourt: "SCC",
      citingDate: "2023-05-05",
      spanSha256: "ignored",
    };

    function slotState(withCandidate: boolean) {
      const state = createLegalEvidenceTurnState("required_slot");
      state.premiseContext = { question, priorAnswer: null };
      state.requiredCharacterizations = ["2016 SCC 27"];
      const caseReceipt = createBenchmarkEvidence({
        stableSourceId: "test:slot-case",
        sourceText: casePassage,
        spanText: casePassage,
        citation: "R. v. Jordan, 2016 SCC 27",
        dataset: "test",
        locatorKind: "paragraph",
        locatorLabel: "par1",
        jurisdiction: "CA",
        sourceClass: "case",
      });
      registerLegalEvidence(state, caseReceipt);
      let attested = null;
      if (withCandidate) {
        attested = attestedCharacterizationReceipt({
          citedCitation: "2016 SCC 27",
          characterization,
        });
        registerLegalEvidence(state, attested);
      }
      return { state, caseId: caseReceipt.evidence_id, attested };
    }

    it("rejects an answer whose slot is unfilled, restating both paths", () => {
      const { state, caseId } = slotState(true);
      const result = submitLegalEvidenceAnswer(
        {
          claims: [
            {
              text: `“${casePassage}”`,
              evidence_ids: [caseId],
              kind: "quotation",
            },
            {
              text: "The delay was unreasonable.",
              evidence_ids: [caseId],
              kind: "conclusion",
            },
          ],
        },
        state,
      );
      expect(result.ok).toBe(false);
      expect(result.errors?.[0]).toContain("characterization slot");
      expect(result.errors?.[0]).toContain(
        "No attested characterization of 2016 SCC 27 is available.",
      );
    });

    it("fills the slot with a verbatim attested quotation", () => {
      const { state, attested } = slotState(true);
      expect(
        submitLegalEvidenceAnswer(
          {
            claims: [
              {
                text: `“${characterization.text}”`,
                evidence_ids: [attested!.evidence_id],
                kind: "quotation",
              },
              {
                text: "The delay here therefore breached that ceiling.",
                evidence_ids: [attested!.evidence_id],
                kind: "conclusion",
              },
            ],
          },
          state,
        ),
      ).toEqual({ ok: true, terminal: true });
    });

    it("fills the slot with the exact typed refusal on thin profiles", () => {
      const { state, caseId } = slotState(false);
      expect(
        submitLegalEvidenceAnswer(
          {
            claims: [
              {
                text: `“${casePassage}”`,
                evidence_ids: [caseId],
                kind: "quotation",
              },
              {
                text:
                  "No attested characterization of 2016 SCC 27 is available.",
                evidence_ids: [caseId],
                kind: "conclusion",
              },
            ],
          },
          state,
        ),
      ).toEqual({ ok: true, terminal: true });
    });

    it("never lets premise typing launder a stands-for characterization", () => {
      const { state, caseId } = slotState(true);
      const result = submitLegalEvidenceAnswer(
        {
          claims: [
            {
              text:
                "The question assumes thirty days of notice; in fact Jordan " +
                "held that a comprehensive framework governs all delay.",
              evidence_ids: [caseId],
              kind: "premise_correction",
              premise_source: "question",
              premise_text: "thirty days of notice before any eviction",
            },
          ],
        },
        state,
      );
      expect(result.ok).toBe(false);
      expect(result.errors?.[0]).toContain("stands-for language");
    });
  });

  it("exempts only verified premise corrections from the lint bounce", () => {
    const { state, id } = typedState("lint_gated");
    state.lintContext = {
      question,
      alienessIndexPath: "Z:/nonexistent/trigrams-en.sqlite",
    };
    const overreach =
      "Alabama maintains a comprehensive regulatory framework broadly " +
      "governing residential evictions, imposing systematic statewide " +
      "oversight obligations and licensing duties across municipalities.";
    const corrective =
      "The premise of thirty days of notice misstates the position: the " +
      "section instead requires landlords to provide written termination " +
      "notice spanning seven business days following receipt of demand.";
    expect(
      submitLegalEvidenceAnswer(
        {
          claims: [
            {
              text: corrective,
              evidence_ids: [id],
              kind: "premise_correction",
              premise_source: "question",
              premise_text: "thirty days of notice",
            },
          ],
        },
        state,
      ).ok,
    ).toBe(true);
    expect(state.lintBounced).toBe(false);
    const bounced = typedState("lint_gated").state;
    bounced.lintContext = state.lintContext;
    const result = submitLegalEvidenceAnswer(
      {
        claims: [
          {
            text: overreach,
            evidence_ids: [[...bounced.evidence.keys()][0]],
          },
        ],
      },
      bounced,
    );
    expect(result.ok).toBe(false);
    expect(bounced.lintBounced).toBe(true);
  });
});

describe("Stage 9 — temporal-order flag and alienness advisory", () => {
  const passage =
    "If rent is unpaid when due, the landlord may deliver a written " +
    "notice to terminate the lease after seven business days.";

  function stageNineState() {
    const state = createLegalEvidenceTurnState("compose_check");
    const receipt = createBenchmarkEvidence({
      stableSourceId: "test:9",
      sourceText: passage,
      spanText: passage,
      citation: "2012 SCC 57",
      dataset: "test",
      locatorKind: "paragraph",
      locatorLabel: "1",
      jurisdiction: "CA",
      sourceClass: "case",
    });
    registerLegalEvidence(state, receipt);
    return { state, id: receipt.evidence_id };
  }

  it("temporalOrderInversion fires only on active-voice impossible orders", () => {
    expect(
      temporalOrderInversion(
        "R. v. A, 2005 BCCA 293, followed R. v. B, 2012 SCC 57, on this point.",
      ),
    ).toMatchObject({ earlier: "2005 BCCA 293", later: "2012 SCC 57" });
    // Correct order: a later decision may follow an earlier one.
    expect(
      temporalOrderInversion("2015 SCC 5 applied 2005 BCCA 293 to the facts."),
    ).toBeNull();
    // Passive voice inverts the relation and must not fire.
    expect(
      temporalOrderInversion("2005 BCCA 293 was followed in 2012 SCC 57."),
    ).toBeNull();
    expect(
      temporalOrderInversion("2005 BCCA 293, followed by 2012 SCC 57, held so."),
    ).toBeNull();
    // Sentence boundary between the citations breaks the clause.
    expect(
      temporalOrderInversion(
        "The court cited 2005 BCCA 293. It followed 2012 SCC 57.",
      ),
    ).toBeNull();
    expect(temporalOrderInversion("2005 BCCA 293 settled the point.")).toBeNull();
  });

  it("rejects an impossible temporal assertion with a typed error", () => {
    const { state, id } = stageNineState();
    const result = submitLegalEvidenceAnswer(
      {
        claims: [
          {
            text: "In 2005 BCCA 293 the court followed 2012 SCC 57 and dismissed.",
            evidence_ids: [id],
          },
        ],
      },
      state,
    );
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toMatch(/temporal order is impossible/u);
    expect(state.bounces).toHaveLength(1);
  });

  it("appends the alienness advisory to a rejection that already happened", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "advisory-test-"));
    const indexPath = path.join(directory, "trigrams-en.sqlite");
    const database = new DatabaseSync(indexPath);
    database.exec(
      "create table trigram (hash integer primary key, n integer not null) without rowid",
    );
    database.exec(
      "create table meta (key text primary key, value text not null)",
    );
    const insert = database.prepare(
      "insert into trigram (hash, n) values (?, ?)",
    );
    const tokens = passage.toLowerCase().match(/[a-z0-9']+/gu)!;
    for (let index = 0; index + 2 < tokens.length; index += 1)
      insert.run(fnv1a64(tokens.slice(index, index + 3).join(" ")), 2);
    database.close();
    try {
      const { state, id } = stageNineState();
      state.lintContext = { question: null, alienessIndexPath: indexPath };
      const result = submitLegalEvidenceAnswer(
        {
          claims: [
            {
              text: "In 2005 BCCA 293 the court followed 2012 SCC 57 and comprehensively regulated evictions.",
              evidence_ids: [id],
              kind: "conclusion",
            },
          ],
        },
        state,
      );
      expect(result.ok).toBe(false);
      const advisory = result.errors?.find((error) =>
        error.startsWith("advisory (style, not a rule)"),
      );
      expect(advisory).toContain("unattested in the legal corpus");
      // Without lintContext the same rejection carries no advisory.
      const bare = stageNineState();
      const bareResult = submitLegalEvidenceAnswer(
        {
          claims: [
            {
              text: "In 2005 BCCA 293 the court followed 2012 SCC 57 and comprehensively regulated evictions.",
              evidence_ids: [bare.id],
              kind: "conclusion",
            },
          ],
        },
        bare.state,
      );
      expect(
        bareResult.errors?.some((error) => error.startsWith("advisory")),
      ).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("premise-correction and abstention surfacing", () => {
  it("renders a verified premise correction visibly marked", () => {
    const state = createLegalEvidenceTurnState(null);
    state.premiseContext = {
      question: "Since the notice period is thirty days, can I appeal?",
      priorAnswer: null,
    };
    state.answer = [
      {
        text: "The statute sets a seven-day notice period.",
        evidence_ids: [],
        kind: "premise_correction",
        premise_source: "question",
        premise_text: "the notice period is thirty days",
      },
    ];
    expect(renderLegalEvidenceAnswer(state)).toBe(
      '**Premise correction** — the question states "the notice period is thirty days": The statute sets a seven-day notice period.',
    );
  });

  it("salvages verified corrections and typed unavailability on failure", () => {
    const state = createLegalEvidenceTurnState("required_slot");
    state.premiseContext = {
      question: "Since the notice period is thirty days, can I appeal?",
      priorAnswer: null,
    };
    state.bounces.push({
      claims: [
        {
          text: "The statute sets a seven-day notice period.",
          evidence_ids: [],
          kind: "premise_correction",
          premise_source: "question",
          premise_text: "the notice period is thirty days",
        },
        {
          text: "No attested characterization of 2007 BCCA 40 is available.",
          evidence_ids: [],
          kind: "quotation",
        },
        {
          text: "This overreaching claim was rejected.",
          evidence_ids: [],
          kind: "conclusion",
        },
      ],
      errors: ["claims[2] is not supported by its cited passages"],
    });
    state.failure = "The model did not submit a grounded answer.";
    const rendered = renderLegalEvidenceAnswer(state);
    expect(rendered).toContain("**Premise correction**");
    expect(rendered).toContain(
      "No attested characterization of 2007 BCCA 40 is available.",
    );
    expect(rendered).toContain("The model did not submit a grounded answer.");
    expect(rendered).not.toContain("overreaching");
  });

  it("keeps the bare failure line when nothing typed survives", () => {
    const state = createLegalEvidenceTurnState("required_slot");
    state.failure = "The model did not submit a grounded answer.";
    expect(renderLegalEvidenceAnswer(state)).toBe(
      "The model did not submit a grounded answer.",
    );
  });

  it("never salvages a correction whose anchor does not verify", () => {
    const state = createLegalEvidenceTurnState("required_slot");
    state.premiseContext = { question: "Can I appeal?", priorAnswer: null };
    state.bounces.push({
      claims: [
        {
          text: "The statute sets a seven-day notice period.",
          evidence_ids: [],
          kind: "premise_correction",
          premise_source: "question",
          premise_text: "the notice period is thirty days",
        },
      ],
      errors: [],
    });
    state.failure = "The model did not submit a grounded answer.";
    expect(renderLegalEvidenceAnswer(state)).toBe(
      "The model did not submit a grounded answer.",
    );
  });
});

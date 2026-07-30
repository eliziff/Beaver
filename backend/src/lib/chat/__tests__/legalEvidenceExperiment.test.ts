import { describe, expect, it } from "vitest";

import type { A2AJDocument, A2AJLocatorLookup } from "../../a2aj";
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
      schema_version: 5,
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
    const state = createLegalEvidenceTurnState(null);
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
      schema_version: 5,
      mode: "citation_structure",
      status: "passed",
      verification: {
        reference: "verified",
        semantic: "not_run",
        coverage: "not_run",
      },
    });
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
      schema_version: 5,
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

import assert from "node:assert/strict";
import { it } from "vitest";

import {
  citationTarget,
  deriveTreatmentIndicator,
  resolveTreatmentBatch,
  type ModelTreatmentItem,
  type OpinionPosition,
  type TreatmentInput,
} from "./caseTreatment";

const target = citationTarget("R. v. Jordan, 2016 SCC 27");
const EDGE_ID = "edge-jordan";

function resolve(
  position: OpinionPosition,
  output: ModelTreatmentItem,
  text = "We decline to follow Jordan on this point. Jordan set a presumptive ceiling.",
) {
  const input: TreatmentInput = {
    edge: { id: EDGE_ID, sourceCitationKey: "2024onca1", target, context: text },
    opinion: { id: "o1", position, text, start: 100 },
  };
  return resolveTreatmentBatch([input], { treatments: [output] }).edges[0];
}

function substantive(label: ModelTreatmentItem["substantive"][number]["label"]): ModelTreatmentItem {
  return {
    citation_edge_id: EDGE_ID,
    substantive: [{
      attribution: "current_court",
      label,
      scope: "specific_proposition",
      evidence_quote: "We decline to follow Jordan on this point.",
      proposition_quote: "Jordan set a presumptive ceiling.",
    }],
    direct_history: [],
  };
}

it("a majority negative treatment controls; the same dissent does not", () => {
  const majority = resolve("majority", substantive("not_followed")).substantive;
  const dissent = resolve("dissenting", substantive("not_followed")).substantive;
  assert.equal(deriveTreatmentIndicator(target, majority).indicator, "negative_treatment");
  assert.deepEqual(deriveTreatmentIndicator(target, dissent), {
    target,
    indicator: "none",
    controllingLabels: [],
    otherOpinionLabels: ["not_followed"],
  });
});

it("party argument and reported reasons do not become the current court's treatment", () => {
  for (const attribution of ["party_submission", "reported_decision"] as const) {
    const item = substantive("not_followed");
    item.substantive[0].attribution = attribution;
    const events = resolve("majority", item).substantive;
    assert.deepEqual(deriveTreatmentIndicator(target, events), {
      target,
      indicator: "none",
      controllingLabels: [],
      otherOpinionLabels: ["not_followed"],
    });
  }
});

it("citation-only unclassified treatment is a mention, not positive treatment", () => {
  const result = resolve("majority", {
    citation_edge_id: EDGE_ID,
    substantive: [{
      attribution: "current_court",
      label: "unclassified",
      scope: "unclear",
      evidence_quote: "Jordan set a presumptive ceiling.",
      proposition_quote: null,
    }],
    direct_history: [],
  });
  assert.equal(deriveTreatmentIndicator(target, result.substantive).indicator, "mentioned");
});

it("an out-of-corpus target keeps a stable citation key and display citation", () => {
  assert.deepEqual(target, {
    citationKey: "2016scc27",
    displayCitation: "2016 SCC 27",
    documentId: null,
  });
});

it("exact unique quotes become absolute offsets; missing anchors are rejected", () => {
  const result = resolve("majority", substantive("applied"));
  assert.deepEqual(result.substantive[0].evidence, {
    quote: "We decline to follow Jordan on this point.",
    start: 100,
    end: 142,
  });
  assert.deepEqual(result.substantive[0].proposition, {
    quote: "Jordan set a presumptive ceiling.",
    start: 143,
    end: 176,
  });

  const rejected = resolve("majority", substantive("applied"), "No matching anchor.");
  assert.equal(rejected.substantive.length, 0);
  assert.match(rejected.rejections[0].reason, /missing/u);

  const repeated = resolve(
    "majority",
    substantive("applied"),
    "We decline to follow Jordan on this point. We decline to follow Jordan on this point. Jordan set a presumptive ceiling.",
  );
  assert.equal(repeated.substantive.length, 0);
  assert.match(repeated.rejections[0].reason, /not unique/u);
});

it("direct procedural history remains separate from substantive treatment", () => {
  const text = "The Court of Appeal affirmed Jordan. We referred to Jordan only for context.";
  const result = resolve("majority", {
    citation_edge_id: EDGE_ID,
    substantive: [{
      attribution: "current_court",
      label: "referred_to",
      scope: "unclear",
      evidence_quote: "We referred to Jordan only for context.",
      proposition_quote: null,
    }],
    direct_history: [{
      label: "affirmed",
      evidence_quote: "The Court of Appeal affirmed Jordan.",
    }],
  }, text);
  assert.equal(result.substantive[0].kind, "substantive");
  assert.equal(result.directHistory[0].kind, "direct_history");
  assert.equal(result.directHistory[0].label, "affirmed");
  assert.equal(deriveTreatmentIndicator(target, result.substantive).indicator, "mentioned");
});

it("a case-level batch maps two targets by edge id and rejects unknown or duplicate ids", () => {
  const housen = citationTarget("Housen v. Nikolaisen, 2002 SCC 33", 42);
  const jordanText = "We applied Jordan's presumptive ceiling.";
  const housenText = "Housen governs the standard of review.";
  const inputs: TreatmentInput[] = [
    {
      edge: {
        id: EDGE_ID,
        sourceCitationKey: "2024onca1",
        target,
        context: jordanText,
      },
      opinion: { id: "o1", position: "majority", text: jordanText, start: 10 },
    },
    {
      edge: {
        id: "edge-housen",
        sourceCitationKey: "2024onca1",
        target: housen,
        context: housenText,
      },
      opinion: { id: "o1", position: "majority", text: housenText, start: 100 },
    },
  ];
  const housenItem: ModelTreatmentItem = {
    citation_edge_id: "edge-housen",
    substantive: [{
      attribution: "current_court",
      label: "followed",
      scope: "legal_test",
      evidence_quote: housenText,
      proposition_quote: null,
    }],
    direct_history: [],
  };
  const jordanItem: ModelTreatmentItem = {
    citation_edge_id: EDGE_ID,
    substantive: [{
      attribution: "current_court",
      label: "applied",
      scope: "legal_test",
      evidence_quote: jordanText,
      proposition_quote: null,
    }],
    direct_history: [],
  };
  const result = resolveTreatmentBatch(inputs, {
    treatments: [
      housenItem,
      jordanItem,
      jordanItem,
      { ...jordanItem, citation_edge_id: "edge-unknown" },
    ],
  });

  assert.deepEqual(
    result.edges.map((edge) => [edge.citationEdgeId, edge.substantive[0].label]),
    [[EDGE_ID, "applied"], ["edge-housen", "followed"]],
  );
  assert.deepEqual(
    result.rejections.map(({ citationEdgeId, reason }) => [citationEdgeId, reason]),
    [
      [EDGE_ID, "duplicate model citation edge id"],
      ["edge-unknown", "unknown citation edge id"],
    ],
  );
});

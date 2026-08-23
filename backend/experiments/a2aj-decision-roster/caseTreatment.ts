import {
  citationLookupKeyNative as citationLookupKey,
  citationsInTextNative as citationsInText,
} from "../../src/lib/structureNative";

export const ATTRIBUTIONS = [
  "current_court",
  "party_submission",
  "quoted_authority",
  "reported_decision",
  "procedural_recounting",
  "document_metadata",
  "unclear",
] as const;
export type TreatmentAttribution = (typeof ATTRIBUTIONS)[number];

export const SUBSTANTIVE_LABELS = [
  "followed",
  "applied",
  "approved",
  "explained",
  "distinguished",
  "limited",
  "criticized",
  "not_followed",
  "questioned",
  "overruled",
  "referred_to",
  "unclassified",
] as const;
export type SubstantiveTreatmentLabel = (typeof SUBSTANTIVE_LABELS)[number];

export const DIRECT_HISTORY_LABELS = [
  "affirmed",
  "reversed",
  "varied",
  "quashed",
  "remanded",
  "leave_granted",
  "leave_refused",
] as const;
export type DirectHistoryLabel = (typeof DIRECT_HISTORY_LABELS)[number];

export const TREATMENT_SCOPES = [
  "whole_decision",
  "holding",
  "legal_test",
  "specific_proposition",
  "facts",
  "remedy",
  "unclear",
] as const;
export type TreatmentScope = (typeof TREATMENT_SCOPES)[number];

export type OpinionPosition =
  | "unanimous"
  | "majority"
  | "plurality"
  | "concurring"
  | "dissenting"
  | "unknown";

export type ModelTreatmentItem = {
  citation_edge_id: string;
  substantive: Array<{
    attribution: TreatmentAttribution;
    label: SubstantiveTreatmentLabel;
    scope: TreatmentScope;
    evidence_quote: string;
    target_proposition_as_characterized: string | null;
  }>;
  direct_history: Array<{
    label: DirectHistoryLabel;
    evidence_quote: string;
  }>;
};

export type ModelTreatmentOutput = {
  treatments: ModelTreatmentItem[];
};

/** Embeddable item for a combined opinion+treatment response or standalone batch. */
export const CASE_TREATMENT_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["citation_edge_id", "substantive", "direct_history"],
  properties: {
    citation_edge_id: { type: "string" },
    substantive: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "attribution",
          "label",
          "scope",
          "evidence_quote",
          "target_proposition_as_characterized",
        ],
        properties: {
          attribution: { type: "string", enum: ATTRIBUTIONS },
          label: { type: "string", enum: SUBSTANTIVE_LABELS },
          scope: { type: "string", enum: TREATMENT_SCOPES },
          evidence_quote: { type: "string" },
          target_proposition_as_characterized: { type: ["string", "null"], minLength: 1 },
        },
      },
    },
    direct_history: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "evidence_quote"],
        properties: {
          label: { type: "string", enum: DIRECT_HISTORY_LABELS },
          evidence_quote: { type: "string" },
        },
      },
    },
  },
} as const;

export type CitationTarget = {
  citationKey: string;
  displayCitation: string;
  /** Null is valid: treatment does not require the cited decision in A2AJ. */
  documentId: number | null;
};

export function citationTarget(
  displayCitation: string,
  documentId: number | null = null,
): CitationTarget {
  const matches = citationsInText(displayCitation);
  if (matches.length !== 1) {
    throw new Error("display citation must contain exactly one citation");
  }
  return {
    citationKey: citationLookupKey(matches[0].text),
    displayCitation: matches[0].text,
    documentId,
  };
}

export type TreatmentInput = {
  edge: {
    id: string;
    sourceCitationKey: string;
    target: CitationTarget;
    context: string;
  };
  opinion: {
    id: string;
    position: OpinionPosition;
    text: string;
    /** Absolute start of `text` in the citing decision. */
    start: number;
  };
};

export type ExactQuote = {
  quote: string;
  start: number;
  end: number;
};

type AcceptedBase = {
  citationEdgeId: string;
  target: CitationTarget;
  sourceCitationKey: string;
  opinionId: string;
  opinionPosition: OpinionPosition;
  evidence: ExactQuote;
};

export type AcceptedSubstantiveTreatment = AcceptedBase & {
  kind: "substantive";
  attribution: TreatmentAttribution;
  label: SubstantiveTreatmentLabel;
  scope: TreatmentScope;
  proposition: string | null;
};

export type AcceptedDirectHistory = AcceptedBase & {
  kind: "direct_history";
  label: DirectHistoryLabel;
};

export type TreatmentRejection = {
  kind: "substantive" | "direct_history";
  index: number;
  reason: string;
};

export type TreatmentBatchRejection = {
  citationEdgeId: string;
  reason: string;
};

export type ResolvedTreatmentEdge = {
  citationEdgeId: string;
  target: CitationTarget;
  substantive: AcceptedSubstantiveTreatment[];
  directHistory: AcceptedDirectHistory[];
  rejections: TreatmentRejection[];
};

function exactQuote(
  opinion: TreatmentInput["opinion"],
  quote: string,
): ExactQuote | string {
  if (!quote) return "quote is empty";
  const relativeStart = opinion.text.indexOf(quote);
  if (relativeStart < 0) return "quote is missing from the opinion";
  if (opinion.text.indexOf(quote, relativeStart + 1) >= 0) {
    return "quote is not unique in the opinion";
  }
  const start = opinion.start + relativeStart;
  return { quote, start, end: start + quote.length };
}

function resolveTreatmentItem(
  input: TreatmentInput,
  output: ModelTreatmentItem,
): ResolvedTreatmentEdge {
  const substantive: AcceptedSubstantiveTreatment[] = [];
  const directHistory: AcceptedDirectHistory[] = [];
  const rejections: TreatmentRejection[] = [];
  const base = {
    citationEdgeId: input.edge.id,
    target: input.edge.target,
    sourceCitationKey: input.edge.sourceCitationKey,
    opinionId: input.opinion.id,
    opinionPosition: input.opinion.position,
  };

  output.substantive.forEach((event, index) => {
    const evidence = exactQuote(input.opinion, event.evidence_quote);
    const proposition = event.target_proposition_as_characterized?.trim() || null;
    const reason = typeof evidence === "string"
      ? `evidence ${evidence}`
      : event.target_proposition_as_characterized !== null && proposition === null
        ? "target proposition is empty"
        : null;
    if (reason) {
      rejections.push({ kind: "substantive", index, reason });
      return;
    }
    substantive.push({
      ...base,
      kind: "substantive",
      attribution: event.attribution,
      label: event.label,
      scope: event.scope,
      evidence: evidence as ExactQuote,
      proposition,
    });
  });

  output.direct_history.forEach((event, index) => {
    const evidence = exactQuote(input.opinion, event.evidence_quote);
    if (typeof evidence === "string") {
      rejections.push({ kind: "direct_history", index, reason: `evidence ${evidence}` });
      return;
    }
    directHistory.push({
      ...base,
      kind: "direct_history",
      label: event.label,
      evidence,
    });
  });

  return {
    citationEdgeId: input.edge.id,
    target: input.edge.target,
    substantive,
    directHistory,
    rejections,
  };
}

export function resolveTreatmentBatch(
  inputs: readonly TreatmentInput[],
  output: ModelTreatmentOutput,
): {
  edges: ResolvedTreatmentEdge[];
  rejections: TreatmentBatchRejection[];
} {
  const inputById = new Map<string, TreatmentInput>();
  for (const input of inputs) {
    if (!input.edge.id) throw new Error("citation edge id is required");
    if (inputById.has(input.edge.id)) {
      throw new Error(`duplicate input citation edge id: ${input.edge.id}`);
    }
    inputById.set(input.edge.id, input);
  }

  const outputById = new Map<string, ModelTreatmentItem>();
  const rejections: TreatmentBatchRejection[] = [];
  for (const item of output.treatments) {
    if (!inputById.has(item.citation_edge_id)) {
      rejections.push({
        citationEdgeId: item.citation_edge_id,
        reason: "unknown citation edge id",
      });
    } else if (outputById.has(item.citation_edge_id)) {
      rejections.push({
        citationEdgeId: item.citation_edge_id,
        reason: "duplicate model citation edge id",
      });
    } else {
      outputById.set(item.citation_edge_id, item);
    }
  }

  const edges = inputs.map((input): ResolvedTreatmentEdge => {
    const item = outputById.get(input.edge.id);
    if (item) return resolveTreatmentItem(input, item);
    rejections.push({
      citationEdgeId: input.edge.id,
      reason: "model output missing citation edge id",
    });
    return {
      citationEdgeId: input.edge.id,
      target: input.edge.target,
      substantive: [],
      directHistory: [],
      rejections: [],
    };
  });
  return { edges, rejections };
}

export type TreatmentIndicator =
  | "overruled"
  | "negative_treatment"
  | "cautionary_treatment"
  | "positive_treatment"
  | "mentioned"
  | "none";

const INDICATOR_RANK: Record<SubstantiveTreatmentLabel, [TreatmentIndicator, number]> = {
  overruled: ["overruled", 5],
  not_followed: ["negative_treatment", 4],
  criticized: ["negative_treatment", 4],
  limited: ["cautionary_treatment", 3],
  questioned: ["cautionary_treatment", 3],
  distinguished: ["cautionary_treatment", 3],
  followed: ["positive_treatment", 2],
  applied: ["positive_treatment", 2],
  approved: ["positive_treatment", 2],
  explained: ["mentioned", 1],
  referred_to: ["mentioned", 1],
  unclassified: ["mentioned", 1],
};

export function deriveTreatmentIndicator(
  target: CitationTarget,
  events: readonly AcceptedSubstantiveTreatment[],
): {
  target: CitationTarget;
  indicator: TreatmentIndicator;
  controllingLabels: SubstantiveTreatmentLabel[];
  otherOpinionLabels: SubstantiveTreatmentLabel[];
} {
  const relevant = events.filter(
    (event) => event.target.citationKey === target.citationKey,
  );
  const controlling = relevant.filter(
    (event) =>
      event.attribution === "current_court" &&
      (event.opinionPosition === "unanimous" ||
        event.opinionPosition === "majority"),
  );
  let indicator: TreatmentIndicator = "none";
  let rank = 0;
  for (const event of controlling) {
    const candidate = INDICATOR_RANK[event.label];
    if (candidate[1] > rank) [indicator, rank] = candidate;
  }
  return {
    target,
    indicator,
    controllingLabels: [...new Set(controlling.map(({ label }) => label))],
    otherOpinionLabels: [
      ...new Set(
        relevant
          .filter((event) => !controlling.includes(event))
          .map(({ label }) => label),
      ),
    ],
  };
}

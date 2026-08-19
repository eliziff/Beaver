export const ISSUE_EVIDENCE_VOICES = [
  "current_court",
  "party_submission",
  "quoted_authority",
  "reported_decision",
  "procedural_record",
  "unclear",
] as const;

export const ISSUE_RELATIONS_TO_DISPOSITION = [
  "dispositive",
  "independent_alternative",
  "non_dispositive",
  "unclear",
] as const;

export const ISSUE_BASIS_KINDS = [
  "rule",
  "application",
  "qualification",
  "exception",
  "independent_ground",
] as const;

export type ModelIssueCard = {
  id: string;
  opinion_id: string;
  question: string;
  answer: string;
  relation_to_disposition: (typeof ISSUE_RELATIONS_TO_DISPOSITION)[number];
  discussion_spans: Array<{ start_quote: string; end_quote: string }>;
  answer_evidence_ids: string[];
  basis_and_limits: Array<{
    id: string;
    kind: (typeof ISSUE_BASIS_KINDS)[number];
    text: string;
    evidence_ids: string[];
  }>;
  evidence: Array<{
    id: string;
    quote: string;
    voice: (typeof ISSUE_EVIDENCE_VOICES)[number];
  }>;
};

export const CASE_ISSUE_CARD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "opinion_id",
    "question",
    "answer",
    "relation_to_disposition",
    "discussion_spans",
    "answer_evidence_ids",
    "basis_and_limits",
    "evidence",
  ],
  properties: {
    id: { type: "string", pattern: "^i[1-9][0-9]*$" },
    opinion_id: { type: "string", pattern: "^o[1-9][0-9]*$" },
    question: { type: "string", minLength: 8 },
    answer: { type: "string", minLength: 1 },
    relation_to_disposition: {
      type: "string",
      enum: ISSUE_RELATIONS_TO_DISPOSITION,
    },
    discussion_spans: {
      type: "array",
      minItems: 1,
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["start_quote", "end_quote"],
        properties: {
          start_quote: { type: "string", minLength: 4 },
          end_quote: { type: "string", minLength: 4 },
        },
      },
    },
    answer_evidence_ids: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: { type: "string" },
    },
    basis_and_limits: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind", "text", "evidence_ids"],
        properties: {
          id: { type: "string" },
          kind: { type: "string", enum: ISSUE_BASIS_KINDS },
          text: { type: "string", minLength: 1 },
          evidence_ids: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: { type: "string" },
          },
        },
      },
    },
    evidence: {
      type: "array",
      minItems: 1,
      maxItems: 40,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "quote", "voice"],
        properties: {
          id: { type: "string" },
          quote: { type: "string", minLength: 4 },
          voice: { type: "string", enum: ISSUE_EVIDENCE_VOICES },
        },
      },
    },
  },
} as const;

type OpinionInput = {
  id: string;
  start: number;
  end: number;
  text: string;
};

type ExactQuote = { quote: string; start: number; end: number };

export type ResolvedIssueCard = Omit<
  ModelIssueCard,
  "discussion_spans" | "evidence"
> & {
  discussion_spans: Array<{
    start: number;
    end: number;
    start_quote: ExactQuote;
    end_quote: ExactQuote;
  }>;
  evidence: Array<Omit<ModelIssueCard["evidence"][number], "quote"> & {
    quote: ExactQuote;
  }>;
};

function exactQuote(opinion: OpinionInput, quote: string): ExactQuote | string {
  const relativeStart = opinion.text.indexOf(quote);
  if (relativeStart < 0) return "quote is missing from the opinion";
  if (opinion.text.indexOf(quote, relativeStart + 1) >= 0) {
    return "quote is not unique in the opinion";
  }
  const start = opinion.start + relativeStart;
  return { quote, start, end: start + quote.length };
}

export function resolveIssueCards(
  opinions: readonly OpinionInput[],
  cards: readonly ModelIssueCard[],
): {
  cards: ResolvedIssueCard[];
  rejections: Array<{ issueId: string; errors: string[] }>;
} {
  const opinionById = new Map(opinions.map((opinion) => [opinion.id, opinion]));
  const seenCards = new Set<string>();
  const accepted: ResolvedIssueCard[] = [];
  const rejections: Array<{ issueId: string; errors: string[] }> = [];

  for (const card of cards) {
    const errors: string[] = [];
    if (seenCards.has(card.id)) errors.push("duplicate issue id");
    seenCards.add(card.id);
    const opinion = opinionById.get(card.opinion_id);
    if (!opinion) errors.push("unknown opinion id");

    const evidenceIds = new Set<string>();
    const evidence = opinion ? card.evidence.flatMap((item) => {
      if (!item.id || evidenceIds.has(item.id)) {
        errors.push(`duplicate or empty evidence id: ${item.id || "(empty)"}`);
        return [];
      }
      evidenceIds.add(item.id);
      const quote = exactQuote(opinion, item.quote);
      if (typeof quote === "string") {
        errors.push(`${item.id} ${quote}`);
        return [];
      }
      return [{ ...item, quote }];
    }) : [];

    const discussionSpans = opinion ? card.discussion_spans.flatMap((span, index) => {
      const startQuote = exactQuote(opinion, span.start_quote);
      const endQuote = exactQuote(opinion, span.end_quote);
      if (typeof startQuote === "string") errors.push(`discussion ${index + 1} start ${startQuote}`);
      if (typeof endQuote === "string") errors.push(`discussion ${index + 1} end ${endQuote}`);
      if (typeof startQuote === "string" || typeof endQuote === "string") return [];
      if (endQuote.end <= startQuote.start) {
        errors.push(`discussion ${index + 1} ends before it starts`);
        return [];
      }
      return [{
        start: startQuote.start,
        end: endQuote.end,
        start_quote: startQuote,
        end_quote: endQuote,
      }];
    }) : [];

    const referencedEvidence = [
      ...card.answer_evidence_ids,
      ...card.basis_and_limits.flatMap((basis) => basis.evidence_ids),
    ];
    for (const id of referencedEvidence) {
      if (!evidenceIds.has(id)) errors.push(`unknown evidence id: ${id}`);
    }
    const basisIds = new Set<string>();
    for (const basis of card.basis_and_limits) {
      if (!basis.id || basisIds.has(basis.id)) {
        errors.push(`duplicate or empty basis id: ${basis.id || "(empty)"}`);
      }
      basisIds.add(basis.id);
    }
    const answerEvidence = evidence.filter((item) =>
      card.answer_evidence_ids.includes(item.id)
    );
    if (!answerEvidence.some((item) => item.voice === "current_court")) {
      errors.push("answer lacks current-court evidence");
    }
    for (const item of evidence) {
      if (!discussionSpans.some((span) =>
        item.quote.start >= span.start && item.quote.end <= span.end
      )) {
        errors.push(`${item.id} falls outside every discussion span`);
      }
    }

    if (errors.length || !opinion) {
      rejections.push({ issueId: card.id, errors: [...new Set(errors)] });
      continue;
    }
    accepted.push({
      ...card,
      discussion_spans: discussionSpans,
      evidence,
    });
  }

  return { cards: accepted, rejections };
}

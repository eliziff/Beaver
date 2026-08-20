import {
  CASE_ISSUE_CARD_SCHEMA,
  resolveUniqueGroundedQuote,
  resolveIssueCards,
  type ModelIssueCard,
} from "./caseSemanticMvp";
import {
  createTextSourceDoc,
  sourceDocPhraseSpans,
  sourceDocQuoteWords,
  type SourceDoc,
} from "../../src/lib/sourceDoc";
import { citationLookupKey, citationsInText } from "../../src/lib/citationKey";
import {
  ATTRIBUTIONS,
  DIRECT_HISTORY_LABELS,
  SUBSTANTIVE_LABELS,
  TREATMENT_SCOPES,
} from "./caseTreatment";

export type CaseTargetOccurrence = {
  id: string;
  kind: "citation" | "case_name";
  quote: string;
  start: number;
  end: number;
  citationKey: string;
  linkedContext: {
    kind: "footnote_reference";
    quote: string;
    start: number;
    end: number;
  } | null;
};

export type CaseTargetIdentity = {
  citation: string;
  citationAliases: readonly string[];
  name: string | null;
};

const GENERIC_CASE_PARTY_WORDS = new Set([
  "applicant", "association", "board", "canada", "commission", "company",
  "corporation", "defendant", "director", "estate", "minister", "ontario",
  "plaintiff", "quebec", "respondent", "tribunal", "union",
]);

function targetNamePhrases(name: string | null) {
  if (!name?.trim()) return [];
  const full = name.trim();
  const sides = full.split(/\s+v(?:\.|ersus)?\s+/iu);
  const crown = sides.length > 1 && /^(?:r\.?|the\s+(?:king|queen)|(?:his|her)\s+majesty)/iu.test(sides[0].trim());
  const preferredParty = (crown ? sides[1] : sides[0])
    .replace(/^the\s+/iu, "")
    .replace(/\s*\([^)]*\)\s*$/u, "")
    .replace(/(?:,?\s+(?:incorporated|inc\.?|limited|ltd\.?|corporation|corp\.?))\s*$/iu, "")
    .trim();
  const partyWords = sourceDocQuoteWords(preferredParty);
  const first = partyWords[0] ?? "";
  const shortWords = sides.length === 1
    ? partyWords.slice(0, Math.min(2, partyWords.length))
    : first.length >= 5 && !GENERIC_CASE_PARTY_WORDS.has(first)
      ? [first]
      : partyWords.slice(0, 2);
  const phrases = [full, preferredParty, shortWords.join(" ")]
    .map((value) => value.trim())
    .filter((value) => sourceDocQuoteWords(value).length > 0);
  const keyed = new Map<string, string>();
  for (const phrase of phrases) keyed.set(sourceDocQuoteWords(phrase).join("\0"), phrase);
  return [...keyed.values()];
}

function directlyDecoratesCitation(text: string, end: number, citations: readonly { start: number }[]) {
  return citations.some((citation) => {
    if (citation.start < end || citation.start - end > 180) return false;
    const between = text.slice(end, citation.start);
    return !between.includes("\n") && !/[!?]/u.test(between);
  });
}

/**
 * Find host-owned mentions of one target. Literal citations keep their stable
 * `tmN` IDs; conservative case-name/short-form matches use `tnN`. A name that
 * merely decorates an immediately following target citation is not duplicated.
 */
export function detectCaseTargetOccurrences(
  source: SourceDoc,
  target: CaseTargetIdentity,
): CaseTargetOccurrence[] {
  const bodyEnd = source.blocks.filter(({ kind }) => kind === "paragraph").at(-1)?.end ?? source.text.length;
  const targetCitations = [target.citation, ...target.citationAliases];
  const targetKeys = new Set(
    targetCitations.map(citationLookupKey)
      .filter(Boolean),
  );
  const citations = citationsInText(source.text)
    .filter((match) => targetKeys.has(citationLookupKey(match.text)));
  const citationOccurrences = citations.map((match, index): CaseTargetOccurrence => ({
    id: `tm${index + 1}`,
    kind: "citation",
    quote: match.text,
    start: match.start,
    end: match.end,
    citationKey: citationLookupKey(match.text),
    linkedContext: footnoteReferenceContext(source.text, match.start, bodyEnd),
  }));

  const candidateSpans = targetNamePhrases(target.name).flatMap((phrase) =>
    sourceDocPhraseSpans(source, sourceDocQuoteWords(phrase)).map(({ start, end }) => ({ start, end }))
  ).filter(({ start, end }) =>
    !citations.some((citation) => start < citation.end && end > citation.start) &&
    !directlyDecoratesCitation(source.text, end, citations)
  );
  const names = [...new Map(candidateSpans
    .sort((left, right) => left.start - right.start || right.end - left.end)
    .map((span) => [`${span.start}:${span.end}`, span])).values()]
    .filter((span, index, spans) => !spans.some((other, otherIndex) =>
      otherIndex !== index && other.start === span.start && other.end > span.end
    ))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const nameOccurrences = names.map((span, index): CaseTargetOccurrence => ({
    id: `tn${index + 1}`,
    kind: "case_name",
    quote: source.text.slice(span.start, span.end),
    start: span.start,
    end: span.end,
    citationKey: citationLookupKey(target.citation),
    linkedContext: footnoteReferenceContext(source.text, span.start, bodyEnd),
  }));
  return [...citationOccurrences, ...nameOccurrences];
}

export function footnoteReferenceContext(
  text: string,
  citationStart: number,
  bodyEnd: number,
): CaseTargetOccurrence["linkedContext"] {
  if (citationStart <= bodyEnd) return null;
  const lineStart = text.lastIndexOf("\n", citationStart - 1) + 1;
  const prefix = text.slice(lineStart, citationStart);
  const label = /^\s*\[(\d{1,4})\]\.?(?:\s|\u00a0)/u.exec(prefix)?.[1];
  if (!label) return null;
  const marker = new RegExp(`\\[\\s*${label}\\s*\\]`, "gu");
  const candidates: Array<{ quote: string; start: number; end: number }> = [];
  for (const match of text.slice(0, bodyEnd).matchAll(marker)) {
    const start = match.index;
    const sameLinePrefix = text.slice(text.lastIndexOf("\n", start - 1) + 1, start);
    if (!sameLinePrefix.trim()) continue;
    candidates.push({ quote: match[0], start, end: start + match[0].length });
  }
  return candidates.length === 1
    ? { kind: "footnote_reference", ...candidates[0] }
    : null;
}

export type ModelCaseIssue = {
  id: string;
  question: string;
  parent_issue_id: string | null;
};

export type ModelOpinionIssuePosition = Omit<ModelIssueCard, "id" | "question"> & {
  id: string;
  case_issue_id: string;
  answer_group_id: string;
};

export type ModelPartialIssueJoin = {
  participant_name: string;
  opinion_id: string;
  case_issue_ids: string[];
  evidence_quotes: string[];
};

export type ModelTargetMention = {
  id: string;
  occurrence_id: string;
  opinion_id: string | null;
  voice: (typeof ATTRIBUTIONS)[number];
  case_issue_ids: string[];
};

export type ModelTargetTreatment = {
  id: string;
  mention_ids: string[];
  opinion_id: string;
  case_issue_ids: string[];
  attribution: (typeof ATTRIBUTIONS)[number];
  label: (typeof SUBSTANTIVE_LABELS)[number];
  scope: (typeof TREATMENT_SCOPES)[number];
  evidence_quote: string;
  target_proposition_as_characterized: string | null;
};

export type ModelTargetDirectHistory = {
  id: string;
  mention_ids: string[];
  opinion_id: string | null;
  label: (typeof DIRECT_HISTORY_LABELS)[number];
  evidence_quote: string;
};

const ISSUE_POSITION_PROPERTIES = CASE_ISSUE_CARD_SCHEMA.properties;

export const CASE_TARGET_MVP_SCHEMA_EXTENSION = {
  case_issues: {
    type: "array",
    minItems: 0,
    maxItems: 40,
    items: {
      type: "object",
      additionalProperties: false,
      required: ["id", "question", "parent_issue_id"],
      properties: {
        id: { type: "string", pattern: "^i[1-9][0-9]*$" },
        question: { type: "string", minLength: 8 },
        parent_issue_id: { type: ["string", "null"] },
      },
    },
  },
  opinion_issue_positions: {
    type: "array",
    minItems: 0,
    maxItems: 100,
    items: {
      type: "object",
      additionalProperties: false,
      required: [
        "id", "case_issue_id", "opinion_id", "answer_group_id", "answer",
        "relation_to_disposition", "discussion_spans", "answer_evidence_ids",
        "basis_and_limits", "evidence",
      ],
      properties: {
        id: { type: "string", pattern: "^p[1-9][0-9]*$" },
        case_issue_id: { type: "string", pattern: "^i[1-9][0-9]*$" },
        opinion_id: ISSUE_POSITION_PROPERTIES.opinion_id,
        answer_group_id: { type: "string", pattern: "^a[1-9][0-9]*$" },
        answer: ISSUE_POSITION_PROPERTIES.answer,
        relation_to_disposition: ISSUE_POSITION_PROPERTIES.relation_to_disposition,
        discussion_spans: ISSUE_POSITION_PROPERTIES.discussion_spans,
        answer_evidence_ids: ISSUE_POSITION_PROPERTIES.answer_evidence_ids,
        basis_and_limits: ISSUE_POSITION_PROPERTIES.basis_and_limits,
        evidence: ISSUE_POSITION_PROPERTIES.evidence,
      },
    },
  },
  partial_issue_joins: {
    type: "array",
    maxItems: 60,
    items: {
      type: "object",
      additionalProperties: false,
      required: ["participant_name", "opinion_id", "case_issue_ids", "evidence_quotes"],
      properties: {
        participant_name: { type: "string", minLength: 2 },
        opinion_id: { type: "string", pattern: "^o[1-9][0-9]*$" },
        case_issue_ids: {
          type: "array",
          minItems: 1,
          items: { type: "string", pattern: "^i[1-9][0-9]*$" },
        },
        evidence_quotes: { type: "array", minItems: 1, items: { type: "string", minLength: 4 } },
      },
    },
  },
  target_mentions: {
    type: "array",
    minItems: 1,
    maxItems: 100,
    items: {
      type: "object",
      additionalProperties: false,
      required: ["id", "occurrence_id", "opinion_id", "voice", "case_issue_ids"],
      properties: {
        id: { type: "string", pattern: "^m[1-9][0-9]*$" },
        occurrence_id: { type: "string", minLength: 1 },
        opinion_id: { type: ["string", "null"] },
        voice: { type: "string", enum: ATTRIBUTIONS },
        case_issue_ids: {
          type: "array",
          items: { type: "string", pattern: "^i[1-9][0-9]*$" },
        },
      },
    },
  },
  target_treatments: {
    type: "array",
    maxItems: 100,
    items: {
      type: "object",
      additionalProperties: false,
      required: [
        "id", "mention_ids", "opinion_id", "case_issue_ids", "attribution",
        "label", "scope", "evidence_quote", "target_proposition_as_characterized",
      ],
      properties: {
        id: { type: "string", pattern: "^t[1-9][0-9]*$" },
        mention_ids: {
          type: "array",
          minItems: 1,
          items: { type: "string", pattern: "^m[1-9][0-9]*$" },
        },
        opinion_id: { type: "string", pattern: "^o[1-9][0-9]*$" },
        case_issue_ids: {
          type: "array",
          minItems: 1,
          items: { type: "string", pattern: "^i[1-9][0-9]*$" },
        },
        attribution: { type: "string", enum: ATTRIBUTIONS },
        label: { type: "string", enum: SUBSTANTIVE_LABELS },
        scope: { type: "string", enum: TREATMENT_SCOPES },
        evidence_quote: { type: "string", minLength: 4 },
        target_proposition_as_characterized: { type: ["string", "null"], minLength: 1 },
      },
    },
  },
  target_direct_history: {
    type: "array",
    maxItems: 20,
    items: {
      type: "object",
      additionalProperties: false,
      required: ["id", "mention_ids", "opinion_id", "label", "evidence_quote"],
      properties: {
        id: { type: "string", pattern: "^h[1-9][0-9]*$" },
        mention_ids: {
          type: "array",
          minItems: 1,
          items: { type: "string", pattern: "^m[1-9][0-9]*$" },
        },
        opinion_id: { type: ["string", "null"], pattern: "^o[1-9][0-9]*$" },
        label: { type: "string", enum: DIRECT_HISTORY_LABELS },
        evidence_quote: { type: "string", minLength: 4 },
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

type ParticipantInput = {
  name: string;
  opinion_links: Array<{ opinion_id: string; relation: "authors" | "joins" | "joins_in_part" }>;
  result_only: boolean;
};

type ExactQuote = { quote: string; start: number; end: number };

function exactQuote(text: string, base: number, quote: string, source?: SourceDoc): ExactQuote | string {
  return quote ? resolveUniqueGroundedQuote(text, base, quote, source) : "quote is empty";
}

function containingOpinion(opinions: readonly OpinionInput[], start: number, end: number) {
  return opinions.find((opinion) => start >= opinion.start && end <= opinion.end) ?? null;
}

function nameKey(name: string) {
  return name.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function duplicateKeys<T>(items: readonly T[], keyOf: (item: T) => string) {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyOf(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([key]) => key));
}

export function normalizeOpinionPositionEvidence(positions: readonly ModelOpinionIssuePosition[]) {
  const definitions = new Map<string, Map<string, ModelOpinionIssuePosition["evidence"][number]>>();
  for (const position of positions) {
    for (const evidence of position.evidence) {
      const byValue = definitions.get(evidence.id) ?? new Map();
      byValue.set(`${evidence.voice}\0${evidence.quote}`, evidence);
      definitions.set(evidence.id, byValue);
    }
  }
  let droppedUnreferenced = 0;
  let recoveredCrossPosition = 0;
  const normalized = positions.map((position) => {
    const referencedIds = [...new Set([
      ...position.answer_evidence_ids,
      ...position.basis_and_limits.flatMap((basis) => basis.evidence_ids),
    ])];
    const referenced = new Set(referencedIds);
    droppedUnreferenced += position.evidence.filter(({ id }) => !referenced.has(id)).length;
    const evidence = referencedIds.flatMap((id) => {
      const local = position.evidence.filter((item) => item.id === id);
      if (local.length) return local;
      const global = [...(definitions.get(id)?.values() ?? [])];
      if (global.length !== 1) return [];
      recoveredCrossPosition += 1;
      return global;
    });
    return { ...position, evidence };
  });
  return {
    positions: normalized,
    dropped_unreferenced_evidence: droppedUnreferenced,
    recovered_cross_position_evidence: recoveredCrossPosition,
  };
}

export function resolveCaseTargetMvp(args: {
  sourceText: string;
  opinions: readonly OpinionInput[];
  participants: readonly ParticipantInput[];
  panelComplete: boolean;
  occurrences: readonly CaseTargetOccurrence[];
  caseIssues: readonly ModelCaseIssue[];
  opinionPositions: readonly ModelOpinionIssuePosition[];
  partialIssueJoins: readonly ModelPartialIssueJoin[];
  targetMentions: readonly ModelTargetMention[];
  targetTreatments: readonly ModelTargetTreatment[];
  targetDirectHistory: readonly ModelTargetDirectHistory[];
}) {
  const errors: string[] = [];
  const normalizedEvidence = normalizeOpinionPositionEvidence(args.opinionPositions);
  const opinionPositions = normalizedEvidence.positions;
  const sourceDoc = createTextSourceDoc(args.sourceText);
  const opinionDocs = new Map(args.opinions.map((opinion) => [opinion.id, createTextSourceDoc(opinion.text)]));
  const duplicateIssueIds = duplicateKeys(args.caseIssues, ({ id }) => id);
  const issueById = new Map<string, ModelCaseIssue>();
  for (const issue of args.caseIssues) {
    if (!issueById.has(issue.id)) issueById.set(issue.id, issue);
  }
  for (const id of duplicateIssueIds) errors.push(`duplicate case issue id: ${id}`);
  const acceptedCaseIssues = args.caseIssues.filter(({ id }) => !duplicateIssueIds.has(id));
  for (const issue of args.caseIssues) {
    if (issue.parent_issue_id !== null && !issueById.has(issue.parent_issue_id)) {
      errors.push(`${issue.id} has unknown parent issue ${issue.parent_issue_id}`);
    }
    if (issue.parent_issue_id === issue.id) errors.push(`${issue.id} cannot parent itself`);
    const seen = new Set([issue.id]);
    let parent = issue.parent_issue_id;
    while (parent !== null && issueById.has(parent)) {
      if (seen.has(parent)) {
        errors.push(`${issue.id} belongs to a parent issue cycle`);
        break;
      }
      seen.add(parent);
      parent = issueById.get(parent)!.parent_issue_id;
    }
  }

  const duplicatePositionIds = duplicateKeys(opinionPositions, ({ id }) => id);
  const duplicatePositionPairs = duplicateKeys(
    opinionPositions,
    ({ opinion_id, case_issue_id }) => `${opinion_id}:${case_issue_id}`,
  );
  const issuePositionErrors: Array<{ positionId: string; reason: string }> = [];
  const cards = opinionPositions.flatMap((position) => {
    const local: string[] = [];
    if (duplicatePositionIds.has(position.id)) local.push("duplicate position id");
    const issue = issueById.get(position.case_issue_id);
    if (!issue) local.push("unknown case issue id");
    else if (duplicateIssueIds.has(position.case_issue_id)) local.push("ambiguous duplicate case issue id");
    const pair = `${position.opinion_id}:${position.case_issue_id}`;
    if (duplicatePositionPairs.has(pair)) local.push("opinion has more than one position for this issue");
    if (local.length || !issue) {
      issuePositionErrors.push({ positionId: position.id, reason: local.join("; ") });
      return [];
    }
    return [{
      ...position,
      question: issue.question,
    } satisfies ModelIssueCard & ModelOpinionIssuePosition];
  });
  const resolvedCards = resolveIssueCards(args.opinions, cards);
  for (const rejection of resolvedCards.rejections) {
    issuePositionErrors.push({ positionId: rejection.issueId, reason: rejection.errors.join("; ") });
  }
  const acceptedPositionIds = new Set(resolvedCards.cards.map(({ id }) => id));
  const acceptedPositions = opinionPositions.filter(({ id }) => acceptedPositionIds.has(id));
  for (const issue of acceptedCaseIssues) {
    if (!acceptedPositions.some((position) => position.case_issue_id === issue.id)) {
      errors.push(`${issue.id} has no accepted opinion position`);
    }
  }
  const acceptedPositionByOpinionIssue = new Map(
    acceptedPositions.map((position) => [`${position.opinion_id}:${position.case_issue_id}`, position]),
  );

  const participantByName = new Map(args.participants.map((participant) => [nameKey(participant.name), participant]));
  const partialJoinByLink = new Map<string, ModelPartialIssueJoin>();
  const partialJoinErrors: string[] = [];
  const partialJoinRejections: Array<{ participant_name: string; opinion_id: string; errors: string[] }> = [];
  const duplicatePartialJoinKeys = duplicateKeys(
    args.partialIssueJoins,
    ({ participant_name, opinion_id }) => `${nameKey(participant_name)}:${opinion_id}`,
  );
  for (const join of args.partialIssueJoins) {
    const local: string[] = [];
    const participant = participantByName.get(nameKey(join.participant_name));
    const key = `${nameKey(join.participant_name)}:${join.opinion_id}`;
    if (duplicatePartialJoinKeys.has(key)) local.push("duplicate partial join");
    if (!participant) local.push("unknown participant");
    if (!participant?.opinion_links.some((link) => link.opinion_id === join.opinion_id && link.relation === "joins_in_part")) {
      local.push(`no joins_in_part link to ${join.opinion_id}`);
    }
    if (new Set(join.case_issue_ids).size !== join.case_issue_ids.length) local.push("duplicate case issue id");
    for (const issueId of join.case_issue_ids) {
      if (!acceptedPositionByOpinionIssue.has(`${join.opinion_id}:${issueId}`)) {
        local.push(`unavailable position ${join.opinion_id}:${issueId}`);
      }
    }
    if (!join.evidence_quotes.length) local.push("missing evidence quote");
    for (const quote of join.evidence_quotes) {
      const evidence = exactQuote(args.sourceText, 0, quote, sourceDoc);
      if (typeof evidence === "string") local.push(`evidence ${evidence}`);
    }
    if (local.length === 0) {
      partialJoinByLink.set(key, join);
    } else {
      partialJoinRejections.push({ participant_name: join.participant_name, opinion_id: join.opinion_id, errors: local });
      partialJoinErrors.push(...local.map((reason) => `${join.participant_name} partial join to ${join.opinion_id}: ${reason}`));
    }
  }
  for (const participant of args.participants) {
    for (const link of participant.opinion_links.filter(({ relation }) => relation === "joins_in_part")) {
      if (!partialJoinByLink.has(`${nameKey(participant.name)}:${link.opinion_id}`)) {
        partialJoinErrors.push(`missing issue scope for ${participant.name} partial join to ${link.opinion_id}`);
      }
    }
  }

  const occurrenceById = new Map(args.occurrences.map((occurrence) => [occurrence.id, occurrence]));
  const seenOccurrenceIds = new Set<string>();
  const mentionById = new Map<string, ModelTargetMention & { span: ExactQuote }>();
  const mentionErrors: string[] = [];
  const mentionRejections: Array<{ mention_id: string; errors: string[] }> = [];
  let correctedMentionOpinionIds = 0;
  const duplicateMentionIds = duplicateKeys(args.targetMentions, ({ id }) => id);
  for (const mention of args.targetMentions) {
    const local: string[] = [];
    if (duplicateMentionIds.has(mention.id)) local.push("duplicate target mention id");
    const occurrence = occurrenceById.get(mention.occurrence_id);
    let span: ExactQuote | null = null;
    if (!occurrence) {
      local.push(`references unknown occurrence ${mention.occurrence_id}`);
    } else {
      if (seenOccurrenceIds.has(occurrence.id)) local.push(`duplicate accounting for occurrence ${occurrence.id}`);
      span = { quote: occurrence.quote, start: occurrence.start, end: occurrence.end };
    }
    const opinionAnchor = occurrence?.linkedContext ?? span;
    const derivedOpinionId = opinionAnchor === null
      ? mention.opinion_id
      : containingOpinion(args.opinions, opinionAnchor.start, opinionAnchor.end)?.id ?? null;
    if (span !== null && mention.opinion_id !== derivedOpinionId) correctedMentionOpinionIds += 1;
    const normalizedMention = { ...mention, opinion_id: derivedOpinionId };
    if (new Set(normalizedMention.case_issue_ids).size !== normalizedMention.case_issue_ids.length) {
      local.push("duplicate case issue id");
    }
    for (const issueId of normalizedMention.case_issue_ids) {
      if (!issueById.has(issueId) || duplicateIssueIds.has(issueId)) local.push(`references unavailable issue ${issueId}`);
      if (normalizedMention.opinion_id && !acceptedPositionByOpinionIssue.has(`${normalizedMention.opinion_id}:${issueId}`)) {
        local.push(`issue ${issueId} has no position in ${normalizedMention.opinion_id}`);
      }
    }
    if (local.length === 0 && span !== null) {
      mentionById.set(mention.id, { ...normalizedMention, span });
      if (occurrence) seenOccurrenceIds.add(occurrence.id);
    } else {
      mentionRejections.push({ mention_id: mention.id, errors: local });
      mentionErrors.push(...local.map((reason) => `${mention.id} ${reason}`));
    }
  }
  for (const occurrence of args.occurrences) {
    if (!seenOccurrenceIds.has(occurrence.id)) mentionErrors.push(`missing target occurrence ${occurrence.id}`);
  }

  const treatmentErrors: string[] = [];
  const treatmentRejections: Array<{ treatment_id: string; errors: string[] }> = [];
  let correctedTreatmentOpinionIds = 0;
  const duplicateTreatmentIds = duplicateKeys(args.targetTreatments, ({ id }) => id);
  const acceptedTreatments: Array<ModelTargetTreatment & {
    evidence: ExactQuote;
    proposition: string | null;
    evidence_contains_linked_mention: boolean;
  }> = [];
  for (const treatment of args.targetTreatments) {
    const local: string[] = [];
    if (duplicateTreatmentIds.has(treatment.id)) local.push("duplicate treatment id");
    if (new Set(treatment.mention_ids).size !== treatment.mention_ids.length) local.push("duplicate mention id");
    const mentions = treatment.mention_ids.flatMap((id) => {
      const mention = mentionById.get(id);
      if (!mention) local.push(`references unavailable mention ${id}`);
      return mention ? [mention] : [];
    });
    const linkedOpinionIds = new Set(mentions.map(({ opinion_id }) => opinion_id));
    const derivedOpinionId = linkedOpinionIds.size === 1 ? [...linkedOpinionIds][0] : null;
    if (derivedOpinionId === null) local.push("linked mentions do not belong to one substantive opinion");
    const normalizedTreatment = derivedOpinionId !== null ? { ...treatment, opinion_id: derivedOpinionId } : treatment;
    if (derivedOpinionId !== null && treatment.opinion_id !== derivedOpinionId) correctedTreatmentOpinionIds += 1;
    const opinion = args.opinions.find(({ id }) => id === normalizedTreatment.opinion_id);
    if (!opinion) local.push(`references unknown opinion ${normalizedTreatment.opinion_id}`);
    if (new Set(normalizedTreatment.case_issue_ids).size !== normalizedTreatment.case_issue_ids.length) local.push("duplicate case issue id");
    for (const issueId of normalizedTreatment.case_issue_ids) {
      if (!acceptedPositionByOpinionIssue.has(`${normalizedTreatment.opinion_id}:${issueId}`)) {
        local.push(`issue ${issueId} has no position in ${normalizedTreatment.opinion_id}`);
      }
      if (mentions.length > 0 && !mentions.some(({ case_issue_ids }) => case_issue_ids.includes(issueId))) {
        local.push(`issue ${issueId} is absent from every linked mention`);
      }
    }
    const opinionDoc = opinion ? opinionDocs.get(opinion.id)! : undefined;
    const evidence = opinion ? exactQuote(opinion.text, opinion.start, normalizedTreatment.evidence_quote, opinionDoc) : "opinion is unavailable";
    const proposition = normalizedTreatment.target_proposition_as_characterized?.trim() || null;
    if (typeof evidence === "string" && opinion) local.push(`evidence ${evidence} in ${opinion.id}`);
    if (normalizedTreatment.target_proposition_as_characterized !== null && proposition === null) {
      local.push("target proposition is empty");
    }
    if (local.length === 0 && typeof evidence !== "string") {
      const evidenceContainsLinkedMention = mentions.some(({ span }) =>
        span.start >= evidence.start && span.end <= evidence.end
      );
      acceptedTreatments.push({
        ...normalizedTreatment,
        evidence,
        proposition,
        evidence_contains_linked_mention: evidenceContainsLinkedMention,
      });
    } else {
      treatmentRejections.push({ treatment_id: treatment.id, errors: local });
      treatmentErrors.push(...local.map((reason) => `${treatment.id} ${reason}`));
    }
  }

  const historyErrors: string[] = [];
  const historyRejections: Array<{ history_id: string; errors: string[] }> = [];
  let correctedHistoryOpinionIds = 0;
  const duplicateHistoryIds = duplicateKeys(args.targetDirectHistory, ({ id }) => id);
  const acceptedHistory: Array<ModelTargetDirectHistory & { evidence: ExactQuote }> = [];
  for (const history of args.targetDirectHistory) {
    const local: string[] = [];
    if (duplicateHistoryIds.has(history.id)) local.push("duplicate direct-history id");
    const sourceEvidence = exactQuote(args.sourceText, 0, history.evidence_quote, sourceDoc);
    const opinionId = typeof sourceEvidence === "string"
      ? history.opinion_id
      : containingOpinion(args.opinions, sourceEvidence.start, sourceEvidence.end)?.id ?? null;
    if (typeof sourceEvidence !== "string" && history.opinion_id !== opinionId) correctedHistoryOpinionIds += 1;
    const opinion = opinionId === null ? null : args.opinions.find(({ id }) => id === opinionId) ?? null;
    if (opinionId !== null && !opinion) local.push(`references unknown opinion ${opinionId}`);
    if (new Set(history.mention_ids).size !== history.mention_ids.length) local.push("duplicate mention id");
    const mentions = history.mention_ids.flatMap((id) => {
      const mention = mentionById.get(id);
      if (!mention) local.push(`references unavailable mention ${id}`);
      return mention ? [mention] : [];
    });
    const evidence = typeof sourceEvidence !== "string"
      ? sourceEvidence
      : opinion
        ? exactQuote(opinion.text, opinion.start, history.evidence_quote, opinionDocs.get(opinion.id)!)
        : sourceEvidence;
    mentions.forEach((mention) => {
      if (opinionId !== null && mention.opinion_id !== null && mention.opinion_id !== opinionId) {
        local.push(`mention ${mention.id} belongs to another opinion`);
      }
    });
    if (
      opinionId === null &&
      !mentions.some(({ opinion_id }) => opinion_id === null)
    ) {
      local.push("case-level direct history requires an outside-opinion target mention");
    }
    if (typeof evidence === "string") {
      local.push(`evidence ${evidence}${opinion ? ` in ${opinion.id}` : " in source"}`);
    }
    if (local.length === 0 && typeof evidence !== "string") {
      acceptedHistory.push({ ...history, opinion_id: opinionId, evidence });
    } else {
      historyRejections.push({ history_id: history.id, errors: local });
      historyErrors.push(...local.map((reason) => `${history.id} ${reason}`));
    }
  }

  const judgeIssuePositions: Array<{
    participant_name: string;
    case_issue_id: string;
    opinion_position_id: string;
    answer_group_id: string;
    adoption: "authors" | "joins" | "joins_in_part";
  }> = [];
  for (const participant of args.participants) {
    for (const link of participant.opinion_links) {
      const allowedIssues = link.relation === "joins_in_part"
        ? new Set(partialJoinByLink.get(`${nameKey(participant.name)}:${link.opinion_id}`)?.case_issue_ids ?? [])
        : null;
      for (const position of acceptedPositions.filter(({ opinion_id }) => opinion_id === link.opinion_id)) {
        if (allowedIssues && !allowedIssues.has(position.case_issue_id)) continue;
        judgeIssuePositions.push({
          participant_name: participant.name,
          case_issue_id: position.case_issue_id,
          opinion_position_id: position.id,
          answer_group_id: position.answer_group_id,
          adoption: link.relation,
        });
      }
    }
  }

  const unresolvedParticipant = args.participants.some((participant) =>
    !participant.result_only && (
      participant.opinion_links.length === 0 ||
      participant.opinion_links.some((link) =>
        link.relation === "joins_in_part" &&
        !partialJoinByLink.has(`${nameKey(participant.name)}:${link.opinion_id}`)
      )
    )
  );
  const issueAuthority = acceptedCaseIssues.map((issue) => {
    const positions = acceptedPositions.filter(({ case_issue_id }) => case_issue_id === issue.id);
    const groups = [...new Set(positions.map(({ answer_group_id }) => answer_group_id))].map((answerGroupId) => {
      const supporters = [...new Set(judgeIssuePositions
        .filter((position) => position.case_issue_id === issue.id && position.answer_group_id === answerGroupId)
        .map((position) => position.participant_name))];
      return {
        answer_group_id: answerGroupId,
        opinion_position_ids: positions.filter(({ answer_group_id }) => answer_group_id === answerGroupId).map(({ id }) => id),
        supporters,
      };
    });
    const ranked = [...groups].sort((left, right) => right.supporters.length - left.supporters.length);
    const top = ranked[0];
    const tied = top && ranked.filter((group) => group.supporters.length === top.supporters.length).length > 1;
    const panelSize = args.participants.length;
    const status = !args.panelComplete
      ? "authority_ambiguous"
      : !top || top.supporters.length === 0
      ? "authority_ambiguous"
      : top.supporters.length === panelSize
        ? "unanimous"
        : top.supporters.length > panelSize / 2
          ? "majority_supported"
          : unresolvedParticipant
            ? "authority_ambiguous"
            : tied
              ? "no_majority_rationale"
              : "plurality_supported";
    return {
      case_issue_id: issue.id,
      panel_size: panelSize,
      status,
      controlling_answer_group_id: status === "unanimous" || status === "majority_supported" ? top.answer_group_id : null,
      answer_groups: groups,
    };
  });

  const allErrors = [
    ...errors,
    ...issuePositionErrors.map(({ positionId, reason }) => `${positionId}: ${reason}`),
    ...partialJoinErrors,
    ...mentionErrors,
    ...treatmentErrors,
    ...historyErrors,
  ];
  const positiveLabels = new Set(["followed", "applied", "approved"]);
  const adverseLabels = new Set(["distinguished", "limited", "criticized", "not_followed", "questioned", "overruled"]);
  const issueSlices = acceptedCaseIssues.map((issue) => {
    const authority = issueAuthority.find(({ case_issue_id }) => case_issue_id === issue.id)!;
    const controllingLabels = new Set<string>();
    const otherJudicialLabels = new Set<string>();
    const attributedLabels = new Set<string>();
    for (const treatment of acceptedTreatments.filter(({ case_issue_ids }) => case_issue_ids.includes(issue.id))) {
      if (treatment.attribution !== "current_court") {
        attributedLabels.add(treatment.label);
        continue;
      }
      const position = acceptedPositionByOpinionIssue.get(`${treatment.opinion_id}:${issue.id}`);
      const controlling = authority.controlling_answer_group_id !== null &&
        position?.answer_group_id === authority.controlling_answer_group_id;
      (controlling ? controllingLabels : otherJudicialLabels).add(treatment.label);
    }
    return {
      case_issue_id: issue.id,
      controlling_labels: [...controllingLabels],
      other_judicial_labels: [...otherJudicialLabels],
      attributed_labels: [...attributedLabels],
    };
  });
  const controllingLabels = new Set(issueSlices.flatMap(({ controlling_labels }) => controlling_labels));
  const otherJudicialLabels = new Set(issueSlices.flatMap(({ other_judicial_labels }) => other_judicial_labels));
  const attributedLabels = new Set(issueSlices.flatMap(({ attributed_labels }) => attributed_labels));
  const directHistoryLabels = [...new Set(acceptedHistory.map(({ label }) => label))];
  const occurrenceCoverageComplete = args.occurrences.every(({ id }) => seenOccurrenceIds.has(id));
  const canonicalOpinionPositions = resolvedCards.cards.map(({ discussion_spans: _internalEvidenceEnvelope, ...position }) => position);
  const flatTreatment = {
    status: allErrors.length === 0 ? "complete" : "partial",
    controlling_labels: [...controllingLabels],
    other_judicial_labels: [...otherJudicialLabels],
    attributed_labels: [...attributedLabels],
    direct_history_labels: directHistoryLabels,
    issue_slices: issueSlices,
    flags: {
      aggregation_safe: allErrors.length === 0 && args.panelComplete,
      target_occurrences_complete: occurrenceCoverageComplete,
      controlling_relied_on: [...controllingLabels].some((label) => positiveLabels.has(label)),
      controlling_adverse: [...controllingLabels].some((label) => adverseLabels.has(label)),
      controlling_explained: controllingLabels.has("explained"),
      noncontrolling_judicial_adverse: [...otherJudicialLabels].some((label) => adverseLabels.has(label)),
      attributed_adverse: [...attributedLabels].some((label) => adverseLabels.has(label)),
      court_treatment_detected: controllingLabels.size > 0 || otherJudicialLabels.size > 0,
      mention_only: occurrenceCoverageComplete && mentionById.size > 0 && acceptedTreatments.length === 0 && acceptedHistory.length === 0,
      direct_history: directHistoryLabels.length > 0,
    },
  };

  return {
    ok: allErrors.length === 0,
    errors: allErrors,
    case_issues: acceptedCaseIssues,
    opinion_issue_positions: canonicalOpinionPositions,
    partial_issue_joins: [...partialJoinByLink.values()],
    target_mentions: [...mentionById.values()],
    target_treatments: acceptedTreatments,
    target_direct_history: acceptedHistory,
    judge_issue_positions: judgeIssuePositions,
    issue_authority: issueAuthority,
    flat_treatment: flatTreatment,
    deterministic_normalization: {
      dropped_unreferenced: normalizedEvidence.dropped_unreferenced_evidence,
      recovered_cross_position: normalizedEvidence.recovered_cross_position_evidence,
      corrected_mention_opinion_ids: correctedMentionOpinionIds,
      corrected_treatment_opinion_ids: correctedTreatmentOpinionIds,
      corrected_history_opinion_ids: correctedHistoryOpinionIds,
    },
    rejections: {
      opinion_issue_positions: issuePositionErrors,
      partial_issue_joins: partialJoinRejections,
      target_mentions: mentionRejections,
      target_treatments: treatmentRejections,
      target_direct_history: historyRejections,
    },
    counts: {
      submitted_case_issues: args.caseIssues.length,
      case_issues: acceptedCaseIssues.length,
      submitted_opinion_positions: args.opinionPositions.length,
      accepted_opinion_positions: resolvedCards.cards.length,
      submitted_partial_issue_joins: args.partialIssueJoins.length,
      accepted_partial_issue_joins: partialJoinByLink.size,
      target_occurrences: args.occurrences.length,
      submitted_target_mentions: args.targetMentions.length,
      accepted_target_mentions: mentionById.size,
      submitted_target_treatments: args.targetTreatments.length,
      accepted_target_treatments: acceptedTreatments.length,
      submitted_target_direct_history: args.targetDirectHistory.length,
      accepted_target_direct_history: acceptedHistory.length,
    },
  };
}

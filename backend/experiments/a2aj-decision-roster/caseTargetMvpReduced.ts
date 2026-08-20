import {
  ISSUE_BASIS_KINDS,
  ISSUE_EVIDENCE_VOICES,
  ISSUE_RELATIONS_TO_DISPOSITION,
  resolveUniqueGroundedQuote,
} from "./caseSemanticMvp";
import {
  ATTRIBUTIONS,
  DIRECT_HISTORY_LABELS,
  SUBSTANTIVE_LABELS,
  TREATMENT_SCOPES,
} from "./caseTreatment";
import type {
  ModelCaseIssue,
  ModelOpinionIssuePosition,
  ModelPartialIssueJoin,
  ModelTargetDirectHistory,
  ModelTargetMention,
  ModelTargetTreatment,
} from "./caseTargetMvp";

type EvidenceVoice = (typeof ISSUE_EVIDENCE_VOICES)[number];
type RelationToDisposition = (typeof ISSUE_RELATIONS_TO_DISPOSITION)[number];
type BasisKind = (typeof ISSUE_BASIS_KINDS)[number];
type Attribution = (typeof ATTRIBUTIONS)[number];
type TreatmentLabel = (typeof SUBSTANTIVE_LABELS)[number];
type TreatmentScope = (typeof TREATMENT_SCOPES)[number];
type DirectHistoryLabel = (typeof DIRECT_HISTORY_LABELS)[number];
type ResultPosition = "supports_disposition" | "opposes_disposition" | "mixed" | "unclear";

export type ReducedMentionReference = {
  occurrence_id: string | null;
  mention_quote: string | null;
};

export type ReducedTreatment = {
  target_mentions: ReducedMentionReference[];
  attribution: Attribution;
  label: TreatmentLabel;
  scope: TreatmentScope;
  evidence_quote: string;
  target_proposition_as_characterized: string | null;
};

export type ReducedCaseTargetSubmission = {
  disposition_quote: string | null;
  opinions: Array<{
    named_authors: Array<{ name: string; evidence_quote: string }>;
    collective_author: string | null;
    collective_author_evidence_quote: string | null;
    result_position: ResultPosition;
    position_evidence_quote: string | null;
    start_quote: string;
    end_quote: string;
    whole_opinion_joiners: Array<{ name: string; evidence_quote: string }>;
  }>;
  participants: Array<{
    name: string;
    panel_evidence_quote: string;
    result_position: ResultPosition;
    result_only: boolean;
    result_only_evidence_quote: string | null;
  }>;
  nonparticipants: Array<{ name: string; evidence_quote: string }>;
  target_mentions: Array<ReducedMentionReference & { voice: Attribution }>;
  issues: Array<{
    question: string;
    answer_groups: Array<{
      answer: string;
      positions: Array<{
        relation_to_disposition: RelationToDisposition;
        answer_evidence: Array<{ quote: string; voice: EvidenceVoice }>;
        basis_and_limits: Array<{
          kind: BasisKind;
          text: string;
          evidence: Array<{ quote: string; voice: EvidenceVoice }>;
        }>;
        partial_joins: Array<{ participant_name: string; evidence_quote: string }>;
        target_mentions: ReducedMentionReference[];
        target_treatments: ReducedTreatment[];
      }>;
    }>;
  }>;
  unscoped_target_treatments: ReducedTreatment[];
  direct_history: Array<{
    target_mentions: ReducedMentionReference[];
    label: DirectHistoryLabel;
    evidence_quote: string;
  }>;
};

const mentionReferenceSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    occurrence_id: { type: ["string", "null"], minLength: 1 },
    mention_quote: { type: ["string", "null"], minLength: 4 },
  },
  required: ["occurrence_id", "mention_quote"],
} as const;

const exactEvidenceSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    quote: { type: "string", minLength: 4 },
    voice: { type: "string", enum: ISSUE_EVIDENCE_VOICES },
  },
  required: ["quote", "voice"],
} as const;

const treatmentSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    target_mentions: { type: "array", minItems: 1, maxItems: 100, items: mentionReferenceSchema },
    attribution: { type: "string", enum: ATTRIBUTIONS },
    label: { type: "string", enum: SUBSTANTIVE_LABELS },
    scope: { type: "string", enum: TREATMENT_SCOPES },
    evidence_quote: { type: "string", minLength: 4 },
    target_proposition_as_characterized: { type: ["string", "null"], minLength: 1 },
  },
  required: [
    "target_mentions",
    "attribution",
    "label",
    "scope",
    "evidence_quote",
    "target_proposition_as_characterized",
  ],
} as const;

const namedPersonEvidenceSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 2 },
    evidence_quote: { type: "string", minLength: 2 },
  },
  required: ["name", "evidence_quote"],
} as const;

const resultPositionSchema = {
  type: "string",
  enum: ["supports_disposition", "opposes_disposition", "mixed", "unclear"],
} as const;

/** Complete one-stage model-facing v13 roster and semantic contract. */
export const CASE_TARGET_MVP_REDUCED_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    disposition_quote: { type: ["string", "null"], minLength: 4 },
    opinions: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          named_authors: {
            type: "array",
            minItems: 0,
            maxItems: 30,
            items: namedPersonEvidenceSchema,
          },
          collective_author: { type: ["string", "null"], minLength: 2 },
          collective_author_evidence_quote: { type: ["string", "null"], minLength: 4 },
          result_position: resultPositionSchema,
          position_evidence_quote: { type: ["string", "null"], minLength: 4 },
          start_quote: { type: "string", minLength: 12 },
          end_quote: { type: "string", minLength: 12 },
          whole_opinion_joiners: {
            type: "array",
            minItems: 0,
            maxItems: 30,
            items: namedPersonEvidenceSchema,
          },
        },
        required: [
          "named_authors",
          "collective_author",
          "collective_author_evidence_quote",
          "result_position",
          "position_evidence_quote",
          "start_quote",
          "end_quote",
          "whole_opinion_joiners",
        ],
      },
    },
    participants: {
      type: "array",
      minItems: 0,
      maxItems: 30,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", minLength: 2 },
          panel_evidence_quote: { type: "string", minLength: 2 },
          result_position: resultPositionSchema,
          result_only: { type: "boolean" },
          result_only_evidence_quote: { type: ["string", "null"], minLength: 2 },
        },
        required: [
          "name",
          "panel_evidence_quote",
          "result_position",
          "result_only",
          "result_only_evidence_quote",
        ],
      },
    },
    nonparticipants: {
      type: "array",
      minItems: 0,
      maxItems: 30,
      items: namedPersonEvidenceSchema,
    },
    target_mentions: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          ...mentionReferenceSchema.properties,
          voice: { type: "string", enum: ATTRIBUTIONS },
        },
        required: ["occurrence_id", "mention_quote", "voice"],
      },
    },
    issues: {
      type: "array",
      minItems: 0,
      maxItems: 40,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          question: { type: "string", minLength: 8 },
          answer_groups: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                answer: { type: "string", minLength: 1 },
                positions: {
                  type: "array",
                  minItems: 1,
                  maxItems: 20,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      relation_to_disposition: { type: "string", enum: ISSUE_RELATIONS_TO_DISPOSITION },
                      answer_evidence: {
                        type: "array",
                        minItems: 1,
                        maxItems: 20,
                        items: exactEvidenceSchema,
                      },
                      basis_and_limits: {
                        type: "array",
                        minItems: 0,
                        maxItems: 20,
                        items: {
                          type: "object",
                          additionalProperties: false,
                          properties: {
                            kind: { type: "string", enum: ISSUE_BASIS_KINDS },
                            text: { type: "string", minLength: 1 },
                            evidence: {
                              type: "array",
                              minItems: 1,
                              maxItems: 20,
                              items: exactEvidenceSchema,
                            },
                          },
                          required: ["kind", "text", "evidence"],
                        },
                      },
                      partial_joins: {
                        type: "array",
                        minItems: 0,
                        maxItems: 30,
                        items: {
                          type: "object",
                          additionalProperties: false,
                          properties: {
                            participant_name: { type: "string", minLength: 2 },
                            evidence_quote: { type: "string", minLength: 4 },
                          },
                          required: ["participant_name", "evidence_quote"],
                        },
                      },
                      target_mentions: {
                        type: "array",
                        minItems: 0,
                        maxItems: 100,
                        items: mentionReferenceSchema,
                      },
                      target_treatments: {
                        type: "array",
                        minItems: 0,
                        maxItems: 100,
                        items: treatmentSchema,
                      },
                    },
                    required: [
                      "relation_to_disposition",
                      "answer_evidence",
                      "basis_and_limits",
                      "partial_joins",
                      "target_mentions",
                      "target_treatments",
                    ],
                  },
                },
              },
              required: ["answer", "positions"],
            },
          },
        },
        required: ["question", "answer_groups"],
      },
    },
    unscoped_target_treatments: {
      type: "array",
      minItems: 0,
      maxItems: 100,
      items: treatmentSchema,
    },
    direct_history: {
      type: "array",
      minItems: 0,
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          target_mentions: { type: "array", minItems: 1, maxItems: 100, items: mentionReferenceSchema },
          label: { type: "string", enum: DIRECT_HISTORY_LABELS },
          evidence_quote: { type: "string", minLength: 4 },
        },
        required: ["target_mentions", "label", "evidence_quote"],
      },
    },
  },
  required: [
    "disposition_quote",
    "opinions",
    "participants",
    "nonparticipants",
    "target_mentions",
    "issues",
    "unscoped_target_treatments",
    "direct_history",
  ],
} as const;

export type CompiledCaseTargetMvpInput = Parameters<
  typeof import("./caseTargetMvp").resolveCaseTargetMvp
>[0];

export type GroundedCaseTargetContext = Pick<
  CompiledCaseTargetMvpInput,
  "sourceText" | "opinions" | "participants" | "panelComplete" | "occurrences"
> & { directHistoryEligible: boolean };

type ExactQuote = { quote: string; start: number; end: number };
type GroundedMention = ModelTargetMention & { span: ExactQuote };

function containingOpinion(
  opinions: GroundedCaseTargetContext["opinions"],
  start: number,
  end: number,
) {
  return opinions.find((opinion) => start >= opinion.start && end <= opinion.end) ?? null;
}

function nameKey(name: string) {
  return name.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function referenceKind(reference: ReducedMentionReference) {
  const supplied = Number(reference.occurrence_id !== null) + Number(reference.mention_quote !== null);
  return supplied === 1 ? (reference.occurrence_id !== null ? "occurrence" : "quote") : null;
}

/** Assign graph IDs and containment deterministically. Invalid items are omitted and reported. */
export function compileReducedCaseTargetSubmission(
  submission: ReducedCaseTargetSubmission,
  context: GroundedCaseTargetContext,
): { ok: boolean; errors: string[]; input: CompiledCaseTargetMvpInput } {
  const errors: string[] = [];
  const occurrenceById = new Map(context.occurrences.map((occurrence) => [occurrence.id, occurrence]));
  const mentionByKey = new Map<string, GroundedMention>();
  const mentions: GroundedMention[] = [];
  const seenOccurrences = new Set<string>();
  const mentionIssues = new Map<string, Set<string>>();

  const sourceQuote = (quote: string, path: string) => {
    const resolved = resolveUniqueGroundedQuote(context.sourceText, 0, quote);
    if (typeof resolved === "string") errors.push(`${path}: ${resolved}`);
    return typeof resolved === "string" ? null : resolved;
  };

  submission.target_mentions.forEach((mention, index) => {
    const path = `target_mentions[${index}]`;
    const kind = referenceKind(mention);
    if (!kind) {
      errors.push(`${path}: use exactly one occurrence_id or mention_quote`);
      return;
    }
    let key: string;
    let span: ExactQuote;
    let occurrence: GroundedCaseTargetContext["occurrences"][number] | undefined;
    if (kind === "occurrence") {
      occurrence = occurrenceById.get(mention.occurrence_id!);
      if (!occurrence) {
        errors.push(`${path}: unknown occurrence ${mention.occurrence_id}`);
        return;
      }
      key = `occurrence:${occurrence.id}`;
      span = { quote: occurrence.quote, start: occurrence.start, end: occurrence.end };
      if (seenOccurrences.has(occurrence.id)) errors.push(`${path}: duplicate occurrence ${occurrence.id}`);
      seenOccurrences.add(occurrence.id);
    } else {
      const resolved = sourceQuote(mention.mention_quote!, path);
      if (!resolved) return;
      span = resolved;
      key = `quote:${span.start}:${span.end}`;
    }
    if (mentionByKey.has(key)) {
      errors.push(`${path}: duplicate root target mention`);
      return;
    }
    const anchor = occurrence?.linkedContext ?? span;
    const compiled: GroundedMention = {
      id: `m${index + 1}`,
      occurrence_id: occurrence?.id ?? null,
      mention_quote: occurrence ? null : span.quote,
      opinion_id: containingOpinion(context.opinions, anchor.start, anchor.end)?.id ?? null,
      voice: mention.voice,
      case_issue_ids: [],
      span,
    };
    mentions.push(compiled);
    mentionByKey.set(key, compiled);
    mentionIssues.set(compiled.id, new Set());
  });
  for (const occurrence of context.occurrences) {
    if (!seenOccurrences.has(occurrence.id)) errors.push(`missing target occurrence ${occurrence.id}`);
  }

  const resolveMention = (reference: ReducedMentionReference, path: string) => {
    const kind = referenceKind(reference);
    if (!kind) {
      errors.push(`${path}: use exactly one occurrence_id or mention_quote`);
      return null;
    }
    let key: string;
    if (kind === "occurrence") {
      key = `occurrence:${reference.occurrence_id}`;
    } else {
      const resolved = sourceQuote(reference.mention_quote!, path);
      if (!resolved) return null;
      key = `quote:${resolved.start}:${resolved.end}`;
    }
    const mention = mentionByKey.get(key) ?? null;
    if (!mention) errors.push(`${path}: target mention is not declared at the root`);
    return mention;
  };

  const caseIssues: ModelCaseIssue[] = submission.issues.map((issue, index) => ({
    id: `i${index + 1}`,
    question: issue.question,
    parent_issue_id: null,
  }));
  const positions: ModelOpinionIssuePosition[] = [];
  const treatments: ModelTargetTreatment[] = [];
  const treatmentByKey = new Map<string, ModelTargetTreatment>();
  let positionNumber = 0;
  let answerGroupNumber = 0;
  let treatmentNumber = 0;
  const partialJoinByKey = new Map<string, ModelPartialIssueJoin>();
  const participants = context.participants.map((participant) => ({
    ...participant,
    opinion_links: [...participant.opinion_links],
  }));
  const participantByName = new Map(participants.map((participant) => [nameKey(participant.name), participant]));

  const treatmentRefs = (value: ReducedTreatment, path: string) => {
    const linked = value.target_mentions.flatMap((reference, index) => {
      const mention = resolveMention(reference, `${path}.target_mentions[${index}]`);
      return mention ? [mention] : [];
    });
    if (new Set(linked.map(({ id }) => id)).size !== linked.length) {
      errors.push(`${path}: duplicate target mention reference`);
      return [];
    }
    return linked.length === value.target_mentions.length ? linked : [];
  };

  const addTreatment = (value: ReducedTreatment, path: string, opinionId: string, issueId: string | null) => {
    const linked = treatmentRefs(value, path);
    if (!linked.length) return;
    if (linked.some((mention) => mention.opinion_id !== opinionId)) {
      errors.push(`${path}: linked mentions do not belong to the treatment opinion`);
      return;
    }
    const opinion = context.opinions.find(({ id }) => id === opinionId)!;
    const evidence = resolveUniqueGroundedQuote(opinion.text, opinion.start, value.evidence_quote);
    if (typeof evidence === "string") {
      errors.push(`${path}.evidence_quote: ${evidence} in ${opinionId}`);
      return;
    }
    const mentionIds = linked.map(({ id }) => id);
    const key = JSON.stringify([
      opinionId,
      [...mentionIds].sort(),
      value.attribution,
      value.label,
      value.scope,
      evidence.quote,
      value.target_proposition_as_characterized,
    ]);
    const existing = treatmentByKey.get(key);
    if (existing) {
      if (issueId && !existing.case_issue_ids.includes(issueId)) existing.case_issue_ids.push(issueId);
      return;
    }
    treatmentNumber += 1;
    const compiled: ModelTargetTreatment = {
      id: `t${treatmentNumber}`,
      mention_ids: mentionIds,
      opinion_id: opinionId,
      case_issue_ids: issueId ? [issueId] : [],
      attribution: value.attribution,
      label: value.label,
      scope: value.scope,
      evidence_quote: evidence.quote,
      target_proposition_as_characterized: value.target_proposition_as_characterized,
    };
    treatments.push(compiled);
    treatmentByKey.set(key, compiled);
  };

  submission.issues.forEach((issue, issueIndex) => {
    const issueId = `i${issueIndex + 1}`;
    const opinionIds = new Set<string>();
    issue.answer_groups.forEach((group, groupIndex) => {
      answerGroupNumber += 1;
      const answerGroupId = `a${answerGroupNumber}`;
      group.positions.forEach((position, positionIndex) => {
        positionNumber += 1;
        const path = `issues[${issueIndex}].answer_groups[${groupIndex}].positions[${positionIndex}]`;
        if (!position.answer_evidence.some(({ voice }) => voice === "current_court")) {
          errors.push(`${path}: answer lacks current-court evidence`);
          return;
        }
        const evidenceInputs = [
          ...position.answer_evidence,
          ...position.basis_and_limits.flatMap((basis) => basis.evidence),
        ];
        const candidates = context.opinions.flatMap((opinion) => {
          const resolved = evidenceInputs.map((item) =>
            resolveUniqueGroundedQuote(opinion.text, opinion.start, item.quote)
          );
          return resolved.every((item) => typeof item !== "string")
            ? [{ opinion, resolved: resolved as ExactQuote[] }]
            : [];
        });
        if (candidates.length !== 1) {
          errors.push(`${path}: evidence resolves to ${candidates.length} opinions; expected exactly one`);
          return;
        }
        const { opinion, resolved } = candidates[0];
        if (opinionIds.has(opinion.id)) {
          errors.push(`${path}: opinion already has a position on this issue`);
          return;
        }
        opinionIds.add(opinion.id);

        const positionId = `p${positionNumber}`;
        const evidenceByValue = new Map<string, { id: string; quote: string; voice: EvidenceVoice }>();
        const addEvidence = (item: { quote: string; voice: EvidenceVoice }, quote: ExactQuote) => {
          const key = `${item.voice}\0${quote.quote}`;
          const existing = evidenceByValue.get(key);
          if (existing) return existing.id;
          const compiled = { id: `${positionId}e${evidenceByValue.size + 1}`, quote: quote.quote, voice: item.voice };
          evidenceByValue.set(key, compiled);
          return compiled.id;
        };
        let resolvedIndex = 0;
        const answerEvidenceIds = position.answer_evidence.map((item) => addEvidence(item, resolved[resolvedIndex++]));
        const basisAndLimits = position.basis_and_limits.map((basis, basisIndex) => ({
          id: `${positionId}b${basisIndex + 1}`,
          kind: basis.kind,
          text: basis.text,
          evidence_ids: basis.evidence.map((item) => addEvidence(item, resolved[resolvedIndex++])),
        }));
        const ordered = [...resolved].sort((left, right) => left.start - right.start || left.end - right.end);
        positions.push({
          id: positionId,
          case_issue_id: issueId,
          opinion_id: opinion.id,
          answer_group_id: answerGroupId,
          answer: group.answer,
          relation_to_disposition: position.relation_to_disposition,
          discussion_spans: [{ start_quote: ordered[0].quote, end_quote: ordered[ordered.length - 1].quote }],
          answer_evidence_ids: [...new Set(answerEvidenceIds)],
          basis_and_limits: basisAndLimits,
          evidence: [...evidenceByValue.values()],
        });

        position.target_mentions.forEach((reference, referenceIndex) => {
          const mention = resolveMention(reference, `${path}.target_mentions[${referenceIndex}]`);
          if (!mention) return;
          if (mention.opinion_id !== opinion.id) {
            errors.push(`${path}.target_mentions[${referenceIndex}]: mention belongs to another opinion`);
          } else {
            mentionIssues.get(mention.id)!.add(issueId);
          }
        });
        position.target_treatments.forEach((treatment, treatmentIndex) => {
          const treatmentPath = `${path}.target_treatments[${treatmentIndex}]`;
          for (const reference of treatment.target_mentions) {
            const mention = resolveMention(reference, treatmentPath);
            if (mention?.opinion_id === opinion.id) mentionIssues.get(mention.id)!.add(issueId);
          }
          addTreatment(treatment, treatmentPath, opinion.id, issueId);
        });

        position.partial_joins.forEach((join, joinIndex) => {
          const joinPath = `${path}.partial_joins[${joinIndex}]`;
          const participant = participantByName.get(nameKey(join.participant_name));
          if (!participant) {
            errors.push(`${joinPath}: unknown participant ${join.participant_name}`);
            return;
          }
          const evidence = sourceQuote(join.evidence_quote, `${joinPath}.evidence_quote`);
          if (!evidence) return;
          const key = `${nameKey(participant.name)}:${opinion.id}`;
          const existing = partialJoinByKey.get(key);
          if (!existing) {
            partialJoinByKey.set(key, {
              participant_name: participant.name,
              opinion_id: opinion.id,
              case_issue_ids: [issueId],
              evidence_quotes: [evidence.quote],
            });
          } else {
            if (!existing.case_issue_ids.includes(issueId)) existing.case_issue_ids.push(issueId);
            if (!existing.evidence_quotes.includes(evidence.quote)) existing.evidence_quotes.push(evidence.quote);
          }
        });
      });
    });
    if (!positions.some(({ case_issue_id }) => case_issue_id === issueId)) {
      errors.push(`issues[${issueIndex}]: no grounded opinion position`);
    }
  });

  submission.unscoped_target_treatments.forEach((treatment, index) => {
    const path = `unscoped_target_treatments[${index}]`;
    const linked = treatmentRefs(treatment, path);
    if (!linked.length) return;
    const opinionIds = new Set(linked.map(({ opinion_id }) => opinion_id));
    if (opinionIds.size !== 1 || opinionIds.has(null)) {
      errors.push(`${path}: linked mentions do not belong to one substantive opinion`);
      return;
    }
    addTreatment(treatment, path, [...opinionIds][0]!, null);
  });

  const directHistory: ModelTargetDirectHistory[] = [];
  submission.direct_history.forEach((history, index) => {
    const path = `direct_history[${index}]`;
    if (!context.directHistoryEligible) {
      errors.push(`${path}: source and target are not deterministically eligible as the same litigation`);
      return;
    }
    const linked = history.target_mentions.flatMap((reference, referenceIndex) => {
      const mention = resolveMention(reference, `${path}.target_mentions[${referenceIndex}]`);
      return mention ? [mention] : [];
    });
    if (linked.length !== history.target_mentions.length || !linked.length) return;
    if (new Set(linked.map(({ id }) => id)).size !== linked.length) {
      errors.push(`${path}: duplicate target mention reference`);
      return;
    }
    const evidence = sourceQuote(history.evidence_quote, `${path}.evidence_quote`);
    if (!evidence) return;
    const opinionId = containingOpinion(context.opinions, evidence.start, evidence.end)?.id ?? null;
    if (opinionId === null && !linked.some((mention) => mention.opinion_id === null)) {
      errors.push(`${path}: case-level history needs an outside-opinion mention`);
      return;
    }
    if (opinionId !== null && linked.some((mention) =>
      mention.opinion_id !== null && mention.opinion_id !== opinionId
    )) {
      errors.push(`${path}: linked mention belongs to another opinion`);
      return;
    }
    directHistory.push({
      id: `h${index + 1}`,
      mention_ids: linked.map(({ id }) => id),
      opinion_id: opinionId,
      label: history.label,
      evidence_quote: evidence.quote,
    });
  });

  const partialIssueJoins: ModelPartialIssueJoin[] = [];
  const acceptedPartialLinks = new Set<string>();
  for (const [key, state] of partialJoinByKey) {
    const participant = participantByName.get(nameKey(state.participant_name))!;
    const existing = participant.opinion_links.find(({ opinion_id }) => opinion_id === state.opinion_id);
    if (existing && existing.relation !== "joins_in_part") {
      errors.push(`${state.participant_name} already has a whole-opinion link to ${state.opinion_id}`);
      continue;
    }
    if (!existing) {
      participant.opinion_links.push({ opinion_id: state.opinion_id, relation: "joins_in_part" });
    }
    partialIssueJoins.push(state);
    acceptedPartialLinks.add(key);
  }
  for (const participant of participants) {
    for (const link of participant.opinion_links.filter(({ relation }) => relation === "joins_in_part")) {
      if (!acceptedPartialLinks.has(`${nameKey(participant.name)}:${link.opinion_id}`)) {
        errors.push(`missing grounded partial-join scope for ${participant.name} to ${link.opinion_id}`);
      }
    }
  }

  const targetMentions: ModelTargetMention[] = mentions.map(({ span: _, ...mention }) => ({
    ...mention,
    case_issue_ids: [...mentionIssues.get(mention.id)!],
  }));
  const uniqueErrors = [...new Set(errors)];
  return {
    ok: uniqueErrors.length === 0,
    errors: uniqueErrors,
    input: {
      ...context,
      participants,
      caseIssues,
      opinionPositions: positions,
      partialIssueJoins,
      targetMentions,
      targetTreatments: treatments,
      targetDirectHistory: directHistory,
    },
  };
}

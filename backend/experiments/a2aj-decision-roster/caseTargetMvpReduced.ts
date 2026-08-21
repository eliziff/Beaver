import {
  ISSUE_RELATIONS_TO_DISPOSITION,
} from "./caseSemanticMvp";
import {
  DIRECT_HISTORY_LABELS,
} from "./caseTreatment";
import {
  SOURCE_ORIGINS,
  TARGET_IDENTITIES,
} from "./caseTargetMvp";
import type {
  ModelCaseIssue,
  ModelOpinionIssuePosition,
  ModelPartialIssueJoin,
  ModelTargetDirectHistory,
  ModelTargetMention,
  ModelTargetTreatment,
} from "./caseTargetMvp";

type RelationToDisposition = (typeof ISSUE_RELATIONS_TO_DISPOSITION)[number];
type DirectHistoryLabel = (typeof DIRECT_HISTORY_LABELS)[number];
type ResultPosition = "supports_disposition" | "opposes_disposition" | "mixed" | "unclear";

export const EVIDENCE_ORIGINS = SOURCE_ORIGINS;
export const LEGAL_ACTORS = [
  "current_court",
  "party_or_counsel",
  "decision_under_review",
  "other_source",
  "metadata",
  "unclear",
] as const;
export const REDUCED_TREATMENT_LABELS = [
  "referred_to",
  "explained",
  "followed",
  "applied",
  "distinguished",
  "limited",
  "not_followed",
  "questioned",
  "overruled",
  "unclassified",
] as const;
export const REDUCED_TREATMENT_SCOPES = [
  "whole_decision",
  "rule_or_proposition",
  "facts",
  "remedy",
  "unclear",
] as const;

type EvidenceOrigin = (typeof EVIDENCE_ORIGINS)[number];
type LegalActor = (typeof LEGAL_ACTORS)[number];
type ReducedTreatmentLabel = (typeof REDUCED_TREATMENT_LABELS)[number];
type ReducedTreatmentScope = (typeof REDUCED_TREATMENT_SCOPES)[number];
type TargetIdentity = (typeof TARGET_IDENTITIES)[number];
export type SourceLineRef = { start_line: number; end_line: number };
export type ModelSourceLine = { line: number; start: number; end: number };

const MODEL_SOURCE_LINE_MAX_CHARS = 800;

/** Stable extractive units for model citations; offsets always address the untouched source text. */
export function modelSourceLines(text: string): ModelSourceLine[] {
  const lines: ModelSourceLine[] = [];
  let lineStart = 0;
  while (lineStart < text.length) {
    const newline = text.indexOf("\n", lineStart);
    let lineEnd = newline < 0 ? text.length : newline;
    if (lineEnd > lineStart && text.charCodeAt(lineEnd - 1) === 13) lineEnd -= 1;
    if (text.slice(lineStart, lineEnd).trim()) {
      let start = lineStart;
      while (lineEnd - start > MODEL_SOURCE_LINE_MAX_CHARS) {
        const hardEnd = start + MODEL_SOURCE_LINE_MAX_CHARS;
        const window = text.slice(start + 200, hardEnd);
        let split = -1;
        for (const match of window.matchAll(/[.!?;:](?=\s)/gu)) split = start + 200 + match.index! + 1;
        if (split < 0) {
          const space = text.lastIndexOf(" ", hardEnd);
          split = space > start + 200 ? space : hardEnd;
        }
        lines.push({ line: lines.length + 1, start, end: split });
        start = split;
        while (start < lineEnd && /\s/u.test(text[start])) start += 1;
      }
      if (start < lineEnd) lines.push({ line: lines.length + 1, start, end: lineEnd });
    }
    if (newline < 0) break;
    lineStart = newline + 1;
  }
  return lines;
}

type LineEvidence = SourceLineRef & { origin: EvidenceOrigin };
type NamedPersonEvidence = { name: string; evidence_lines: SourceLineRef };
type Authorship =
  | { kind: "named"; authors: NamedPersonEvidence[] }
  | { kind: "collective"; name: string; evidence_lines: SourceLineRef }
  | { kind: "unstated" };

const ORIGIN_TO_VOICE: Record<EvidenceOrigin, ModelTargetMention["voice"]> = {
  court_words: "current_court",
  quoted_material: "quoted_authority",
  metadata: "document_metadata",
  unclear: "unclear",
};
const ACTOR_TO_ATTRIBUTION: Record<LegalActor, ModelTargetMention["voice"]> = {
  current_court: "current_court",
  party_or_counsel: "party_submission",
  decision_under_review: "reported_decision",
  other_source: "quoted_authority",
  metadata: "document_metadata",
  unclear: "unclear",
};
const SCOPE_TO_CANONICAL: Record<ReducedTreatmentScope, ModelTargetTreatment["scope"]> = {
  whole_decision: "whole_decision",
  rule_or_proposition: "specific_proposition",
  facts: "facts",
  remedy: "remedy",
  unclear: "unclear",
};
export type ReducedMentionReference = {
  occurrence_id: string;
};

export type ReducedTreatment = {
  target_mentions: ReducedMentionReference[];
  treated_by: LegalActor;
  label: ReducedTreatmentLabel;
  scope: ReducedTreatmentScope;
  evidence_lines: SourceLineRef;
  target_proposition_as_characterized: string | null;
};

export type ReducedCaseTargetSubmission = {
  disposition_lines: SourceLineRef[];
  opinions: Array<{
    authorship: Authorship;
    result_position: ResultPosition;
    position_evidence_lines: SourceLineRef | null;
    start_line: number;
    end_line: number;
    full_joiners: NamedPersonEvidence[];
  }>;
  other_decision_makers: Array<{
    name: string;
    panel_evidence_lines: SourceLineRef;
    result_position: ResultPosition;
    result_only_evidence_lines: SourceLineRef | null;
  }>;
  nonparticipants: NamedPersonEvidence[];
  occurrence_assessments: Array<ReducedMentionReference & {
    target_identity: TargetIdentity;
    source_origin: EvidenceOrigin;
    legal_actor: LegalActor;
  }>;
  issues: Array<{
    question: string;
    answers: Array<{
      answer: string;
      positions: Array<{
        relation_to_disposition: RelationToDisposition;
        answer_evidence: LineEvidence[];
        issue_only_joiners: Array<{ participant_name: string; evidence_lines: SourceLineRef }>;
        target_treatments: ReducedTreatment[];
      }>;
    }>;
  }>;
  unscoped_target_treatments: ReducedTreatment[];
  case_history: Array<{
    target_mentions: ReducedMentionReference[];
    label: DirectHistoryLabel;
    evidence_lines: SourceLineRef;
  }>;
};

const mentionReferenceSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    occurrence_id: { type: "string", minLength: 1 },
  },
  required: ["occurrence_id"],
} as const;

const sourceLineRefSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    start_line: { type: "integer", minimum: 1 },
    end_line: { type: "integer", minimum: 1 },
  },
  required: ["start_line", "end_line"],
} as const;

const exactEvidenceSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...sourceLineRefSchema.properties,
    origin: { type: "string", enum: EVIDENCE_ORIGINS },
  },
  required: ["start_line", "end_line", "origin"],
} as const;

const treatmentSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    target_mentions: { type: "array", minItems: 1, maxItems: 100, items: mentionReferenceSchema },
    treated_by: { type: "string", enum: LEGAL_ACTORS },
    label: { type: "string", enum: REDUCED_TREATMENT_LABELS },
    scope: { type: "string", enum: REDUCED_TREATMENT_SCOPES },
    evidence_lines: sourceLineRefSchema,
    target_proposition_as_characterized: { type: ["string", "null"], minLength: 1 },
  },
  required: [
    "target_mentions",
    "treated_by",
    "label",
    "scope",
    "evidence_lines",
    "target_proposition_as_characterized",
  ],
} as const;

const namedPersonEvidenceSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 2 },
    evidence_lines: sourceLineRefSchema,
  },
  required: ["name", "evidence_lines"],
} as const;

const authorshipSchema = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string", const: "named" },
        authors: { type: "array", minItems: 1, maxItems: 30, items: namedPersonEvidenceSchema },
      },
      required: ["kind", "authors"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string", const: "collective" },
        name: { type: "string", minLength: 2 },
        evidence_lines: sourceLineRefSchema,
      },
      required: ["kind", "name", "evidence_lines"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: { kind: { type: "string", const: "unstated" } },
      required: ["kind"],
    },
  ],
} as const;

const resultPositionSchema = {
  type: "string",
  enum: ["supports_disposition", "opposes_disposition", "mixed", "unclear"],
} as const;

/** Complete one-stage model-facing v14 roster and semantic contract. */
export const CASE_TARGET_MVP_REDUCED_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    disposition_lines: {
      type: "array",
      minItems: 0,
      maxItems: 20,
      items: sourceLineRefSchema,
    },
    opinions: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          authorship: authorshipSchema,
          result_position: resultPositionSchema,
          position_evidence_lines: { anyOf: [sourceLineRefSchema, { type: "null" }] },
          start_line: { type: "integer", minimum: 1 },
          end_line: { type: "integer", minimum: 1 },
          full_joiners: {
            type: "array",
            minItems: 0,
            maxItems: 30,
            items: namedPersonEvidenceSchema,
          },
        },
        required: [
          "authorship",
          "result_position",
          "position_evidence_lines",
          "start_line",
          "end_line",
          "full_joiners",
        ],
      },
    },
    other_decision_makers: {
      type: "array",
      minItems: 0,
      maxItems: 30,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", minLength: 2 },
          panel_evidence_lines: sourceLineRefSchema,
          result_position: resultPositionSchema,
          result_only_evidence_lines: { anyOf: [sourceLineRefSchema, { type: "null" }] },
        },
        required: [
          "name",
          "panel_evidence_lines",
          "result_position",
          "result_only_evidence_lines",
        ],
      },
    },
    nonparticipants: {
      type: "array",
      minItems: 0,
      maxItems: 30,
      items: namedPersonEvidenceSchema,
    },
    occurrence_assessments: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          ...mentionReferenceSchema.properties,
          target_identity: { type: "string", enum: TARGET_IDENTITIES },
          source_origin: { type: "string", enum: EVIDENCE_ORIGINS },
          legal_actor: { type: "string", enum: LEGAL_ACTORS },
        },
        required: ["occurrence_id", "target_identity", "source_origin", "legal_actor"],
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
          answers: {
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
                      issue_only_joiners: {
                        type: "array",
                        minItems: 0,
                        maxItems: 30,
                        items: {
                          type: "object",
                          additionalProperties: false,
                          properties: {
                            participant_name: { type: "string", minLength: 2 },
                            evidence_lines: sourceLineRefSchema,
                          },
                          required: ["participant_name", "evidence_lines"],
                        },
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
                      "issue_only_joiners",
                      "target_treatments",
                    ],
                  },
                },
              },
              required: ["answer", "positions"],
            },
          },
        },
        required: ["question", "answers"],
      },
    },
    unscoped_target_treatments: {
      type: "array",
      minItems: 0,
      maxItems: 100,
      items: treatmentSchema,
    },
    case_history: {
      type: "array",
      minItems: 0,
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          target_mentions: { type: "array", minItems: 1, maxItems: 100, items: mentionReferenceSchema },
          label: { type: "string", enum: DIRECT_HISTORY_LABELS },
          evidence_lines: sourceLineRefSchema,
        },
        required: ["target_mentions", "label", "evidence_lines"],
      },
    },
  },
  required: [
    "disposition_lines",
    "opinions",
    "other_decision_makers",
    "nonparticipants",
    "occurrence_assessments",
    "issues",
    "unscoped_target_treatments",
    "case_history",
  ],
} as const;

export type CompiledCaseTargetMvpInput = Parameters<
  typeof import("./caseTargetMvp").resolveCaseTargetMvp
>[0];

export type GroundedCaseTargetContext = Pick<
  CompiledCaseTargetMvpInput,
  "sourceText" | "opinions" | "participants" | "panelComplete" | "occurrences"
> & {
  directHistoryEligible: boolean;
  sourceLines: ModelSourceLine[];
};

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
  return typeof reference.occurrence_id === "string" && reference.occurrence_id.length > 0
    ? "occurrence"
    : null;
}

/** Assign graph IDs and containment deterministically. Invalid items are omitted and reported. */
export function compileReducedCaseTargetSubmission(
  submission: ReducedCaseTargetSubmission,
  context: GroundedCaseTargetContext,
): { ok: boolean; errors: string[]; warnings: string[]; input: CompiledCaseTargetMvpInput } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const sourceLineIndex = new Map<number, number>();
  context.sourceLines.forEach((line, index) => {
    if (!Number.isInteger(line.line) || line.line < 1) errors.push(`sourceLines[${index}]: invalid line number`);
    if (sourceLineIndex.has(line.line)) errors.push(`sourceLines[${index}]: duplicate line ${line.line}`);
    sourceLineIndex.set(line.line, index);
    if (!Number.isInteger(line.start) || !Number.isInteger(line.end) || line.start < 0 || line.end < line.start || line.end > context.sourceText.length) {
      errors.push(`sourceLines[${index}]: invalid source offsets`);
    }
    if (index > 0 && (context.sourceLines[index - 1].line >= line.line || context.sourceLines[index - 1].end > line.start)) {
      errors.push(`sourceLines[${index}]: source lines are not ordered`);
    }
  });
  const occurrenceById = new Map(context.occurrences.map((occurrence) => [occurrence.id, occurrence]));
  const mentionByKey = new Map<string, GroundedMention>();
  const mentions: GroundedMention[] = [];
  const seenOccurrences = new Set<string>();
  const mentionIssues = new Map<string, Set<string>>();

  const sourceLines = (reference: SourceLineRef, path: string): ExactQuote | null => {
    if (!Number.isInteger(reference.start_line) || reference.start_line < 1
      || !Number.isInteger(reference.end_line) || reference.end_line < 1) {
      errors.push(`${path}: line numbers must be positive integers`);
      return null;
    }
    const startIndex = sourceLineIndex.get(reference.start_line);
    const endIndex = sourceLineIndex.get(reference.end_line);
    if (startIndex === undefined || endIndex === undefined) {
      errors.push(`${path}: unknown source line`);
      return null;
    }
    if (startIndex > endIndex) {
      errors.push(`${path}: source lines are out of order`);
      return null;
    }
    const start = context.sourceLines[startIndex].start;
    const end = context.sourceLines[endIndex].end;
    return { quote: context.sourceText.slice(start, end), start, end };
  };

  submission.disposition_lines.forEach((lines, index) => sourceLines(lines, `disposition_lines[${index}]`));
  submission.opinions.forEach((opinion, index) => {
    const boundary = sourceLines(opinion, `opinions[${index}]`);
    const canonical = context.opinions[index];
    if (!boundary || !canonical) return;
    if (boundary.start !== canonical.start || boundary.end !== canonical.end) {
      errors.push(`opinions[${index}]: source line range does not match the compiled opinion`);
    }
    const opinionEvidence = (reference: SourceLineRef, path: string) => {
      const evidence = sourceLines(reference, path);
      if (evidence && (evidence.start < boundary.start || evidence.end > boundary.end)) {
        errors.push(`${path}: evidence is outside the opinion line range`);
      }
    };
    if (opinion.authorship.kind === "named") {
      opinion.authorship.authors.forEach((author, authorIndex) =>
        sourceLines(author.evidence_lines, `opinions[${index}].authorship.authors[${authorIndex}].evidence_lines`));
    } else if (opinion.authorship.kind === "collective") {
      sourceLines(opinion.authorship.evidence_lines, `opinions[${index}].authorship.evidence_lines`);
    }
    if (opinion.position_evidence_lines) {
      opinionEvidence(opinion.position_evidence_lines, `opinions[${index}].position_evidence_lines`);
    }
    opinion.full_joiners.forEach((joiner, joinerIndex) =>
      sourceLines(joiner.evidence_lines, `opinions[${index}].full_joiners[${joinerIndex}].evidence_lines`));
  });
  if (submission.opinions.length !== context.opinions.length) {
    errors.push(`opinions: expected ${context.opinions.length}, received ${submission.opinions.length}`);
  }
  submission.other_decision_makers.forEach((participant, index) => {
    sourceLines(participant.panel_evidence_lines, `other_decision_makers[${index}].panel_evidence_lines`);
    if (participant.result_only_evidence_lines) {
      sourceLines(participant.result_only_evidence_lines, `other_decision_makers[${index}].result_only_evidence_lines`);
    }
  });
  submission.nonparticipants.forEach((participant, index) =>
    sourceLines(participant.evidence_lines, `nonparticipants[${index}].evidence_lines`));

  submission.occurrence_assessments.forEach((mention, index) => {
    const path = `occurrence_assessments[${index}]`;
    if (!referenceKind(mention)) {
      errors.push(`${path}: occurrence_id is required`);
      return;
    }
    const occurrence = occurrenceById.get(mention.occurrence_id);
    if (!occurrence) {
      errors.push(`${path}: unknown occurrence ${mention.occurrence_id}`);
      return;
    }
    const key = `occurrence:${occurrence.id}`;
    const span: ExactQuote = { quote: occurrence.quote, start: occurrence.start, end: occurrence.end };
    if (seenOccurrences.has(occurrence.id)) errors.push(`${path}: duplicate occurrence ${occurrence.id}`);
    seenOccurrences.add(occurrence.id);
    if (mentionByKey.has(key)) {
      errors.push(`${path}: duplicate root occurrence assessment`);
      return;
    }
    const anchor = occurrence.linkedContext ?? span;
    const compiled: GroundedMention = {
      id: `m${index + 1}`,
      occurrence_id: occurrence.id,
      opinion_id: containingOpinion(context.opinions, anchor.start, anchor.end)?.id ?? null,
      target_identity: mention.target_identity,
      source_origin: mention.source_origin,
      voice: ACTOR_TO_ATTRIBUTION[mention.legal_actor],
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
      errors.push(`${path}: occurrence_id is required`);
      return null;
    }
    const key = `occurrence:${reference.occurrence_id}`;
    const mention = mentionByKey.get(key) ?? null;
    if (!mention) {
      errors.push(`${path}: occurrence assessment is not declared at the root`);
      return null;
    }
    if (mention.target_identity !== "target") {
      errors.push(`${path}: occurrence assessment is ${mention.target_identity}, not target`);
      return null;
    }
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
    const evidence = sourceLines(value.evidence_lines, `${path}.evidence_lines`);
    if (!evidence) return;
    if (evidence.start < opinion.start || evidence.end > opinion.end) {
      errors.push(`${path}.evidence_lines: evidence is outside ${opinionId}`);
      return;
    }
    const mentionIds = linked.map(({ id }) => id);
    const key = JSON.stringify([
      opinionId,
      [...mentionIds].sort(),
      value.treated_by,
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
      attribution: ACTOR_TO_ATTRIBUTION[value.treated_by],
      label: value.label,
      scope: SCOPE_TO_CANONICAL[value.scope],
      evidence_quote: evidence.quote,
      target_proposition_as_characterized: value.target_proposition_as_characterized,
    };
    treatments.push(compiled);
    treatmentByKey.set(key, compiled);
  };

  submission.issues.forEach((issue, issueIndex) => {
    const issueId = `i${issueIndex + 1}`;
    const opinionIds = new Set<string>();
    issue.answers.forEach((group, groupIndex) => {
      answerGroupNumber += 1;
      const answerGroupId = `a${answerGroupNumber}`;
      group.positions.forEach((position, positionIndex) => {
        positionNumber += 1;
        const path = `issues[${issueIndex}].answers[${groupIndex}].positions[${positionIndex}]`;
        if (!position.answer_evidence.some(({ origin }) => origin === "court_words")) {
          errors.push(`${path}: answer lacks current-court evidence`);
          return;
        }
        const evidenceInputs = position.answer_evidence;
        const candidates = context.opinions.flatMap((opinion) => {
          const resolved = evidenceInputs.map((item, evidenceIndex) =>
            sourceLines(item, `${path}.answer_evidence[${evidenceIndex}]`)
          );
          return resolved.every((item): item is ExactQuote => item !== null)
            && resolved.every((item) => item.start >= opinion.start && item.end <= opinion.end)
            ? [{ opinion, resolved }]
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
        const evidenceByValue = new Map<string, ModelOpinionIssuePosition["evidence"][number]>();
        const addEvidence = (item: LineEvidence, quote: ExactQuote) => {
          const voice = ORIGIN_TO_VOICE[item.origin];
          const key = `${voice}\0${quote.quote}`;
          const existing = evidenceByValue.get(key);
          if (existing) return existing.id;
          const compiled = { id: `${positionId}e${evidenceByValue.size + 1}`, quote: quote.quote, voice };
          evidenceByValue.set(key, compiled);
          return compiled.id;
        };
        const answerEvidenceIds = position.answer_evidence.map((item, index) => addEvidence(item, resolved[index]));
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
          basis_and_limits: [],
          evidence: [...evidenceByValue.values()],
        });

        position.target_treatments.forEach((treatment, treatmentIndex) => {
          const treatmentPath = `${path}.target_treatments[${treatmentIndex}]`;
          for (const reference of treatment.target_mentions) {
            const mention = resolveMention(reference, treatmentPath);
            if (mention?.opinion_id === opinion.id) mentionIssues.get(mention.id)!.add(issueId);
          }
          addTreatment(treatment, treatmentPath, opinion.id, issueId);
        });

        position.issue_only_joiners.forEach((join, joinIndex) => {
          const joinPath = `${path}.issue_only_joiners[${joinIndex}]`;
          const participant = participantByName.get(nameKey(join.participant_name));
          if (!participant) {
            errors.push(`${joinPath}: unknown participant ${join.participant_name}`);
            return;
          }
          const ownOpinion = participant.opinion_links.some(({ opinion_id }) => opinionIds.has(opinion_id));
          if (ownOpinion) {
            errors.push(`${joinPath}: redundant partial join; participant already has a position on issue ${issueId}`);
            return;
          }
          const evidence = sourceLines(join.evidence_lines, `${joinPath}.evidence_lines`);
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
  submission.case_history.forEach((history, index) => {
    const path = `case_history[${index}]`;
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
    const evidence = sourceLines(history.evidence_lines, `${path}.evidence_lines`);
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
    warnings: [...new Set(warnings)],
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

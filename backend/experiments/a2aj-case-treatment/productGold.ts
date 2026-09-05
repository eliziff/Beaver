import {
  compileStructure,
  PROCEDURAL_ACTIONS,
  RESULT_POSITIONS,
  TREATMENT_SIGNALS,
  type AnchoredSpan,
  type CaseMaterial,
  type DecisionStructure,
  type GoldRecord,
  type ProceduralAction,
  type ResultPosition,
  type StructureCompilation,
  type TreatmentSignal,
} from "./contract";

export const PRODUCT_GOLD_VERSION = "a2aj-product-treatment-gold-v1" as const;

export type ProductGoldRecord = {
  contract_version: typeof PRODUCT_GOLD_VERSION;
  document_id: number;
  citation: string;
  structure: {
    opinions: Array<{
      opinion_id: string;
      boundary: AnchoredSpan;
      writer: string | null;
      collective_author: string | null;
      result_position: ResultPosition;
    }>;
    participants: Array<{
      name: string;
      result_position: ResultPosition;
      opinion_links: Array<{
        opinion_id: string;
        relation: "wrote" | "joined" | "joined_in_part";
      }>;
    }>;
    nonparticipants: string[];
  };
  direct_outcomes: Array<{
    cited_decision: string;
    actions: Array<{
      action: ProceduralAction;
      affected_part: string | null;
    }>;
  }>;
  reported_history: Array<{
    cited_decision: string;
    action: ProceduralAction;
    later_decision: string | null;
    affected_part: string | null;
    opinion_id: string;
  }>;
  treatments: Array<{
    cited_decision: string;
    opinion_id: string;
    signals: TreatmentSignal[];
    other_signal: string | null;
    proposition: string;
    treatment: string;
  }>;
};

export type ProductSemanticView = {
  direct_outcomes: Array<{
    id: string;
    cited_decision: string;
    action: ProceduralAction;
    affected_part: string | null;
    evidence?: string[];
  }>;
  reported_history: Array<{
    id: string;
    cited_decision: string;
    action: ProceduralAction;
    later_decision: string | null;
    affected_part: string | null;
    treating_opinion: string;
    evidence?: string[];
  }>;
  treatments: Array<{
    id: string;
    cited_decision: string;
    treating_opinion: string;
    signals: TreatmentSignal[];
    other_signal: string | null;
    proposition: string;
    treatment: string;
    evidence?: string[];
  }>;
};

export const PRODUCT_JUDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    grades: {
      type: "array",
      maxItems: 2_000,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { enum: ["treatment", "direct_outcome", "reported_history"] },
          reference_id: { type: "string", pattern: "^g[tdh][1-9][0-9]*$" },
          candidate_ids: { type: "array", maxItems: 100, items: { type: "string", pattern: "^c[tdh][1-9][0-9]*$" } },
          verdict: { enum: ["pass", "minor_error", "major_error"] },
          explanation: { type: ["string", "null"], maxLength: 2_000 },
        },
        required: ["kind", "reference_id", "candidate_ids", "verdict", "explanation"],
      },
    },
    extras: {
      type: "array",
      maxItems: 2_000,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { enum: ["treatment", "direct_outcome", "reported_history"] },
          candidate_id: { type: "string", pattern: "^c[tdh][1-9][0-9]*$" },
          verdict: { enum: ["pass", "minor_error", "major_error"] },
          explanation: { type: "string", minLength: 1, maxLength: 2_000 },
        },
        required: ["kind", "candidate_id", "verdict", "explanation"],
      },
    },
  },
  required: ["grades", "extras"],
} as const;

export const PRODUCT_JUDGE_REPAIR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    assignments: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          candidate_id: { type: "string", pattern: "^c[tdh][1-9][0-9]*$" },
          reference_id: { type: ["string", "null"], pattern: "^g[tdh][1-9][0-9]*$" },
          verdict: { enum: ["pass", "minor_error", "major_error", null] },
          explanation: { type: ["string", "null"], maxLength: 2_000 },
        },
        required: ["candidate_id", "reference_id", "verdict", "explanation"],
      },
    },
  },
  required: ["assignments"],
} as const;

const opinionName = (record: ProductGoldRecord, opinionId: string) => {
  const opinion = record.structure.opinions.find(({ opinion_id }) => opinion_id === opinionId);
  const writers = record.structure.participants
    .filter(({ opinion_links }) => opinion_links.some(({ opinion_id, relation }) =>
      opinion_id === opinionId && relation === "wrote"))
    .map(({ name }) => name);
  return writers.length ? writers.join(" and ") : opinion?.writer ?? opinion?.collective_author ?? "writer not stated";
};

function productDecisionStructure(record: ProductGoldRecord): DecisionStructure {
  return {
    disposition_spans: [],
    opinions: record.structure.opinions.map((opinion) => ({
      opinion_id: opinion.opinion_id,
      boundary: opinion.boundary,
      collective_author: null,
      result_position: opinion.result_position,
      result_evidence: null,
    })),
    participants: [],
    nonparticipants: [],
  };
}

/** Resolves exact boundaries, then overlays product gold's evidence-free roster facts. */
export function compileProductDecisionStructure(
  record: ProductGoldRecord,
  material: CaseMaterial,
): StructureCompilation {
  const resolved = compileStructure(productDecisionStructure(record), material);
  if (!resolved.compiled) return resolved;
  const boundaryById = new Map(resolved.compiled.opinions.map((opinion) => [opinion.opinion_id, opinion.boundary]));
  const linkedNames = (opinionId: string, relation: "wrote" | "joined" | "joined_in_part") =>
    record.structure.participants
      .filter(({ opinion_links }) => opinion_links.some((link) =>
        link.opinion_id === opinionId && link.relation === relation))
      .map(({ name }) => name);
  return {
    ...resolved,
    compiled: {
      ...resolved.compiled,
      opinions: resolved.compiled.opinions.map((opinion) => {
        const gold = record.structure.opinions.find(({ opinion_id }) => opinion_id === opinion.opinion_id)!;
        return {
          ...opinion,
          collective_author: gold.collective_author,
          result_position: gold.result_position,
          writers: linkedNames(opinion.opinion_id, "wrote"),
          full_joiners: linkedNames(opinion.opinion_id, "joined"),
          qualified_joiners: linkedNames(opinion.opinion_id, "joined_in_part").map((name) => ({
            name,
            evidence: opinion.boundary,
          })),
        };
      }),
      participants: record.structure.participants.map((participant) => ({
        name: participant.name,
        result_position: participant.result_position,
        result_only: false,
        links: participant.opinion_links.map((link) => ({
          ...link,
          evidence: boundaryById.get(link.opinion_id)!,
        })),
      })),
      nonparticipants: [...record.structure.nonparticipants],
    },
  };
}

export function productReferenceView(record: ProductGoldRecord): ProductSemanticView {
  let directIndex = 0;
  return {
    direct_outcomes: record.direct_outcomes.flatMap((outcome) => outcome.actions.map((action) => ({
      id: `gd${++directIndex}`,
      cited_decision: outcome.cited_decision,
      action: action.action,
      affected_part: action.affected_part,
    }))),
    reported_history: record.reported_history.map((history, index) => ({
      id: `gh${index + 1}`,
      cited_decision: history.cited_decision,
      action: history.action,
      later_decision: history.later_decision,
      affected_part: history.affected_part,
      treating_opinion: opinionName(record, history.opinion_id),
    })),
    treatments: record.treatments.map((treatment, index) => ({
      id: `gt${index + 1}`,
      cited_decision: treatment.cited_decision,
      treating_opinion: opinionName(record, treatment.opinion_id),
      signals: treatment.signals,
      other_signal: treatment.other_signal,
      proposition: treatment.proposition,
      treatment: treatment.treatment,
    })),
  };
}

export function productJudgePrompt(reference: ProductSemanticView, candidate: ProductSemanticView) {
  return `Assess whether the candidate accurately states what the judicial opinions say about other adjudicative decisions.

For a treatment, assess the cited decision, treating opinion, proposition, legal operation, and material scope. A treatment signal is a headline label: one accurate candidate signal is sufficient even when the reference lists several compatible labels. A party's submission, an unadopted quotation, or another decision's reasoning is not the current opinion's position. For a direct outcome, assess what the present court did to the decision below and the affected part. For reported history, assess which earlier decision was affected, what the later decision did to it, and the direction of that relationship. When the earlier/later decision, action, and direction are right, a missing or imprecise affected_part is minor_error unless it changes whole-versus-part scope.

Match candidate items that collectively express each reference item. Equivalent wording and harmless differences in how a point is divided are acceptable; one candidate may match several reference items when it combines them. Assign redundant or finer-grained candidate restatements to the reference item that already covers their substance. Use an empty candidate_ids array when a reference item is missing. Then grade every unmatched candidate item as an extra; an extra passes only when its evidence establishes an accurate, materially distinct item omitted from the reference.

pass means substantively accurate. minor_error means a localized imprecision that leaves the proposition, legal operation, attribution, procedural action, direction, and material scope intact. major_error means a substantive omission, invention, wrong attribution, wrong proposition or operation, reversed procedural direction, or materially wrong scope. A matched pass has a null explanation; otherwise explain the error concisely.

Return only schema JSON.

[REFERENCE]
${JSON.stringify(reference)}

[CANDIDATE]
${JSON.stringify(candidate)}`;
}

export function productJudgeRepairPrompt(
  reference: ProductSemanticView,
  candidate: ProductSemanticView,
  previous: unknown,
  errors: string[],
) {
  const unmatched = new Set(errors
    .filter((error) => error.startsWith("unmatched candidate "))
    .map((error) => error.slice("unmatched candidate ".length)));
  const candidateItems = [...candidate.direct_outcomes, ...candidate.reported_history, ...candidate.treatments]
    .filter(({ id }) => unmatched.has(id));
  return `Repair only the unmatched candidate items listed below. For each item, attach it to one existing reference item when it expresses that reference's substance; otherwise set reference_id to null and grade it as an extra. Attachments use null verdict and explanation. Extras require pass, minor_error, or major_error and a concise explanation. Return only schema JSON.

[REFERENCE]
${JSON.stringify(reference)}

[UNMATCHED CANDIDATES]
${JSON.stringify(candidateItems)}

[PREVIOUS GRADE]
${JSON.stringify(previous)}

[VALIDATION]
${JSON.stringify(errors)}`;
}

export function normalizeProductJudgeResult(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result = value as { grades?: Array<Record<string, unknown>>; extras?: Array<Record<string, unknown>> };
  if (!Array.isArray(result.grades) || !Array.isArray(result.extras)) return value;
  const matched = new Set(result.grades.flatMap(({ candidate_ids }) =>
    Array.isArray(candidate_ids) ? candidate_ids.map(String) : []));
  const seen = new Set<string>();
  return {
    ...result,
    extras: result.extras.filter(({ candidate_id }) => {
      const id = String(candidate_id ?? "");
      if (matched.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    }),
  };
}

export function mergeProductJudgeRepair(value: unknown, candidate: ProductSemanticView, repair: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !repair || typeof repair !== "object" || Array.isArray(repair)) return value;
  const result = value as { grades?: Array<Record<string, unknown>>; extras?: Array<Record<string, unknown>> };
  const assignments = (repair as { assignments?: unknown }).assignments;
  if (!Array.isArray(result.grades) || !Array.isArray(result.extras) || !Array.isArray(assignments)) return value;
  const candidateKinds = new Map([...candidate.direct_outcomes, ...candidate.reported_history, ...candidate.treatments]
    .map(({ id }) => [id, id.includes("t") ? "treatment" : id.includes("d") ? "direct_outcome" : "reported_history"]));
  const grades = result.grades.map((grade) => ({ ...grade, candidate_ids: Array.isArray(grade.candidate_ids) ? [...grade.candidate_ids] : [] }));
  const extras = [...result.extras];
  const matched = new Set(grades.flatMap(({ candidate_ids }) => Array.isArray(candidate_ids) ? candidate_ids.map(String) : []));
  for (const assignment of assignments) {
    if (!assignment || typeof assignment !== "object" || Array.isArray(assignment)) continue;
    const item = assignment as Record<string, unknown>;
    const candidateId = String(item.candidate_id ?? "");
    if (!candidateKinds.has(candidateId) || matched.has(candidateId)) continue;
    const referenceId = item.reference_id == null ? null : String(item.reference_id);
    if (referenceId !== null) {
      const grade = grades.find(({ reference_id }) => String(reference_id) === referenceId);
      if (!grade) continue;
      grade.candidate_ids!.push(candidateId);
      matched.add(candidateId);
      continue;
    }
    if (!["pass", "minor_error", "major_error"].includes(String(item.verdict)) || typeof item.explanation !== "string" || !item.explanation.trim()) continue;
    extras.push({ kind: candidateKinds.get(candidateId), candidate_id: candidateId, verdict: item.verdict, explanation: item.explanation });
    matched.add(candidateId);
  }
  return normalizeProductJudgeResult({ ...result, grades, extras });
}

export function productJudgeErrors(reference: ProductSemanticView, candidate: ProductSemanticView, value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["judge result is not an object"];
  const result = value as { grades?: Array<Record<string, unknown>>; extras?: Array<Record<string, unknown>> };
  const grades = Array.isArray(result.grades) ? result.grades : [];
  const extras = Array.isArray(result.extras) ? result.extras : [];
  const expected = new Set([...reference.treatments, ...reference.direct_outcomes, ...reference.reported_history].map(({ id }) => id));
  const candidates = new Set([...candidate.treatments, ...candidate.direct_outcomes, ...candidate.reported_history].map(({ id }) => id));
  const kindFor = (id: string) => id.includes("t") ? "treatment" : id.includes("d") ? "direct_outcome" : "reported_history";
  const seenExpected = new Set<string>();
  const matchedCandidates = new Set<string>();
  const seenExtras = new Set<string>();
  const errors: string[] = [];
  const verdicts = new Set(["pass", "minor_error", "major_error"]);
  for (const grade of grades) {
    const referenceId = String(grade.reference_id ?? "");
    if (!expected.has(referenceId) || seenExpected.has(referenceId)) errors.push(`invalid or duplicate reference ${referenceId}`);
    if (grade.kind !== kindFor(referenceId)) errors.push(`wrong kind for ${referenceId}`);
    seenExpected.add(referenceId);
    for (const candidateId of Array.isArray(grade.candidate_ids) ? grade.candidate_ids.map(String) : []) {
      if (!candidates.has(candidateId)) errors.push(`invalid candidate ${candidateId}`);
      if (grade.kind !== kindFor(candidateId)) errors.push(`wrong kind for ${candidateId}`);
      matchedCandidates.add(candidateId);
    }
    const candidateIds = Array.isArray(grade.candidate_ids) ? grade.candidate_ids : [];
    if (!verdicts.has(String(grade.verdict))) errors.push(`invalid verdict for ${referenceId}`);
    if (!candidateIds.length && grade.verdict !== "major_error") {
      errors.push(`missing reference ${referenceId} must be a major_error`);
    }
    if (grade.verdict === "pass" && grade.explanation !== null) {
      errors.push(`passing reference ${referenceId} must have a null explanation`);
    }
    if (grade.verdict !== "pass" && (typeof grade.explanation !== "string" || !grade.explanation.trim())) {
      errors.push(`error grade ${referenceId} requires an explanation`);
    }
  }
  for (const extra of extras) {
    const candidateId = String(extra.candidate_id ?? "");
    if (!candidates.has(candidateId) || matchedCandidates.has(candidateId) || seenExtras.has(candidateId)) {
      errors.push(`invalid or duplicate extra ${candidateId}`);
    }
    if (extra.kind !== kindFor(candidateId)) errors.push(`wrong kind for ${candidateId}`);
    if (!verdicts.has(String(extra.verdict))) errors.push(`invalid verdict for ${candidateId}`);
    if (typeof extra.explanation !== "string" || !extra.explanation.trim()) {
      errors.push(`extra ${candidateId} requires an explanation`);
    }
    seenExtras.add(candidateId);
  }
  for (const id of expected) if (!seenExpected.has(id)) errors.push(`missing grade ${id}`);
  for (const id of candidates) if (!matchedCandidates.has(id) && !seenExtras.has(id)) errors.push(`unmatched candidate ${id}`);
  return errors;
}

export function productJudgeScore(value: unknown) {
  const result = value as { grades?: Array<Record<string, unknown>>; extras?: Array<Record<string, unknown>> };
  const grades = result.grades ?? [];
  const extras = result.extras ?? [];
  const points = (verdict: unknown) => verdict === "pass" ? 1 : verdict === "minor_error" ? 0.5 : 0;
  const scoreRows = (selected: Array<Record<string, unknown>>) => {
    const earned = selected.reduce((total, row) => total + points(row.verdict), 0);
    return { items: selected.length, earned, score: selected.length ? earned / selected.length : 1 };
  };
  const byKind = (kind: string) => scoreRows(grades.filter((row) => row.kind === kind));
  return {
    treatment: byKind("treatment"),
    direct_outcome: byKind("direct_outcome"),
    reported_history: byKind("reported_history"),
    overall: scoreRows(grades),
    extras: scoreRows(extras),
    major_errors: grades.filter(({ verdict }) => verdict === "major_error").length,
    unsupported_extras: extras.filter(({ verdict }) => verdict === "major_error").length,
  };
}

const BACKGROUND_ONLY_OPERATIONS = new Set([
  "used_as_child_protection_history",
  "used_as_evidentiary_history",
  "used_as_factual_background",
  "used_as_historical_premise",
]);

const REPORTED_HISTORY: Record<number, ProductGoldRecord["reported_history"]> = {
  192926: [
    {
      cited_decision: "Haig v. Canada (1991), 5 O.R. (3d) 245 (Gen. Div.)",
      action: "affirmed",
      later_decision: "(1992), 9 O.R. (3d) 495 (C.A.)",
      affected_part: null,
      opinion_id: "o4",
    },
    {
      cited_decision: "[1992] 1 F.C. 687",
      action: "affirmed",
      later_decision: "[1993] 3 F.C. 401",
      affected_part: null,
      opinion_id: "o1",
    },
  ],
  126799: [
    {
      cited_decision: "Morrell Estate v. Robinson, 2008 NSSC 295",
      action: "affirmed",
      later_decision: "Robinson v. Morrell Estate, 2009 NSCA 127",
      affected_part: null,
      opinion_id: "o1",
    },
  ],
  190600: [
    {
      cited_decision: "[2000] Q.J. No. 5908 (QL)",
      action: "reversed",
      later_decision: "(2002), 40 M.P.L.R. (3d) 157",
      affected_part: "the damages award against the municipality",
      opinion_id: "o1",
    },
  ],
  142972: [
    {
      cited_decision: "convicted on September 29, 1993 by His Honour Judge L.T.G. Collins",
      action: "affirmed",
      later_decision: "The appeal was dismissed by Justice Murphy of the Ontario Court (General Division) on November 24, 1994",
      affected_part: null,
      opinion_id: "o1",
    },
    {
      cited_decision: "On July 30, 2015, the applicant was convicted by Justice of the Peace J. Mariasine",
      action: "affirmed",
      later_decision: "Justice E. Rosenberg's November 23, 2016 appeal decision",
      affected_part: null,
      opinion_id: "o1",
    },
    {
      cited_decision: "On July 2, 2015, the applicant was convicted by Justice of the Peace J. Moffatt",
      action: "affirmed",
      later_decision: "Justice E. Rosenberg's November 23, 2016 appeal decision",
      affected_part: null,
      opinion_id: "o1",
    },
  ],
};

function writerFor(record: GoldRecord, opinionId: string) {
  return record.annotation.structure.participants.find(({ opinion_links }) =>
    opinion_links.some(({ opinion_id, relation }) => opinion_id === opinionId && relation === "wrote"))?.name ?? null;
}

export function projectProductGold(record: GoldRecord): ProductGoldRecord {
  const { structure, analysis } = record.annotation;
  return {
    contract_version: PRODUCT_GOLD_VERSION,
    document_id: record.document_id,
    citation: record.citation,
    structure: {
      opinions: structure.opinions.map((opinion) => ({
        opinion_id: opinion.opinion_id,
        boundary: opinion.boundary,
        writer: writerFor(record, opinion.opinion_id),
        collective_author: opinion.collective_author?.name ?? null,
        result_position: opinion.result_position,
      })),
      participants: structure.participants.map((participant) => ({
        name: participant.name,
        result_position: participant.result_position,
        opinion_links: participant.opinion_links.map(({ opinion_id, relation }) => ({ opinion_id, relation })),
      })),
      nonparticipants: structure.nonparticipants.map(({ name }) => name),
    },
    direct_outcomes: analysis.procedural_relationships.map((relationship) => ({
      cited_decision: relationship.cited_decision,
      actions: relationship.actions.map(({ action, affected_part }) => ({ action, affected_part })),
    })),
    reported_history: analysis.reported_history?.length
      ? analysis.reported_history.map(({ cited_decision, action, later_decision, affected_part, opinion_id }) => ({
        cited_decision,
        action,
        later_decision,
        affected_part,
        opinion_id: opinion_id!,
      }))
      : REPORTED_HISTORY[record.document_id] ?? [],
    treatments: analysis.treatments
      .filter(({ signals, other_signal }) =>
        !(signals.includes("other") && other_signal && BACKGROUND_ONLY_OPERATIONS.has(other_signal)))
      .map(({ cited_decision, opinion_id, signals, other_signal, proposition, treatment }) => ({
        cited_decision,
        opinion_id: opinion_id!,
        signals,
        other_signal,
        proposition,
        treatment,
      })),
  };
}

export function productGoldErrors(record: ProductGoldRecord) {
  const errors: string[] = [];
  if (record.contract_version !== PRODUCT_GOLD_VERSION) errors.push("wrong contract_version");
  const opinionIds = new Set(record.structure.opinions.map(({ opinion_id }) => opinion_id));
  if (!record.structure.opinions.length) errors.push("structure has no opinions");
  if (opinionIds.size !== record.structure.opinions.length) errors.push("duplicate opinion_id");
  const personKey = (name: string) => name.normalize("NFKD").replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const participantKeys = new Set<string>();
  for (const participant of record.structure.participants) {
    const key = personKey(participant.name);
    if (!key || participantKeys.has(key)) errors.push(`invalid or duplicate participant ${participant.name}`);
    participantKeys.add(key);
    if (!RESULT_POSITIONS.includes(participant.result_position)) errors.push(`invalid participant result for ${participant.name}`);
    for (const link of participant.opinion_links) {
      if (!opinionIds.has(link.opinion_id)) errors.push(`unknown participant opinion ${link.opinion_id}`);
      if (!["wrote", "joined", "joined_in_part"].includes(link.relation)) errors.push(`invalid opinion relation for ${participant.name}`);
    }
  }
  for (const opinion of record.structure.opinions) {
    const boundary = opinion.boundary;
    if (!/^o[1-9][0-9]*$/u.test(opinion.opinion_id)) errors.push(`invalid opinion_id ${opinion.opinion_id}`);
    if (!Number.isInteger(boundary.start_line) || !Number.isInteger(boundary.end_line) ||
        boundary.start_line < 1 || boundary.end_line < boundary.start_line ||
        !boundary.start_quote.trim() || !boundary.end_quote.trim()) errors.push(`invalid boundary for ${opinion.opinion_id}`);
    if (!RESULT_POSITIONS.includes(opinion.result_position)) errors.push(`invalid result for ${opinion.opinion_id}`);
    if (Boolean(opinion.writer) === Boolean(opinion.collective_author)) {
      errors.push(`${opinion.opinion_id} must have exactly one writer or collective_author`);
    }
    const linkedWriters = record.structure.participants.filter(({ opinion_links }) =>
      opinion_links.some(({ opinion_id, relation }) => opinion_id === opinion.opinion_id && relation === "wrote"));
    if (opinion.writer && !linkedWriters.some(({ name }) => personKey(name) === personKey(opinion.writer!))) {
      errors.push(`${opinion.opinion_id} writer is not linked as wrote`);
    }
  }
  const nonparticipantKeys = new Set<string>();
  for (const name of record.structure.nonparticipants) {
    const key = personKey(name);
    if (!key || participantKeys.has(key) || nonparticipantKeys.has(key)) errors.push(`invalid or duplicate nonparticipant ${name}`);
    nonparticipantKeys.add(key);
  }
  for (const treatment of record.treatments) {
    if (!opinionIds.has(treatment.opinion_id)) errors.push(`unknown treatment opinion ${treatment.opinion_id}`);
    if (!treatment.cited_decision.trim() || !treatment.proposition.trim() || !treatment.treatment.trim()) {
      errors.push("blank treatment field");
    }
    if (!treatment.signals.length || treatment.signals.some((signal) => !TREATMENT_SIGNALS.includes(signal))) {
      errors.push(`invalid treatment signal for ${treatment.cited_decision}`);
    }
    if (treatment.signals.includes("other") !== Boolean(treatment.other_signal)) {
      errors.push(`other_signal mismatch for ${treatment.cited_decision}`);
    }
  }
  for (const outcome of record.direct_outcomes) {
    if (!outcome.cited_decision.trim() || !outcome.actions.length) errors.push("invalid direct outcome");
    if (outcome.actions.some(({ action }) => !PROCEDURAL_ACTIONS.includes(action))) errors.push("invalid direct action");
  }
  for (const history of record.reported_history) {
    if (!opinionIds.has(history.opinion_id)) errors.push(`unknown history opinion ${history.opinion_id}`);
    if (!history.cited_decision.trim() || !PROCEDURAL_ACTIONS.includes(history.action)) errors.push("invalid reported history");
  }
  return errors;
}

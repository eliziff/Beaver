import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { productGoldErrors, type ProductGoldRecord } from "../productGold";

type LegacyRecord = {
  document_id: number;
  citation: string;
  annotation: {
    structure: {
      opinions: ProductGoldRecord["structure"]["opinions"];
      participants: Array<{
        name: string;
        result_position: ProductGoldRecord["structure"]["participants"][number]["result_position"];
        opinion_links: ProductGoldRecord["structure"]["participants"][number]["opinion_links"];
      }>;
      nonparticipants: Array<{ name: string }>;
    };
    analysis: {
      cited_decisions: Array<{
        decision_id: string;
        identifying_span: { start_quote: string; end_quote: string };
        procedural_relationship: { actions: ProductGoldRecord["direct_outcomes"][number]["actions"] } | null;
        treatments: ProductGoldRecord["treatments"];
      }>;
    };
  };
};

const here = path.resolve("backend/experiments/a2aj-case-treatment/gold");
const packets = path.resolve("backend/experiments/a2aj-case-treatment/runs/product-gold-30-direct/packets");
const parse = <T>(file: string) => readFile(file, "utf8").then((text) => text.trim().split(/\r?\n/u).map((line) => JSON.parse(line) as T));
const writer = (record: LegacyRecord, opinionId: string) => record.annotation.structure.participants.find(({ opinion_links }) =>
  opinion_links.some(({ opinion_id, relation }) => opinion_id === opinionId && relation === "wrote"))?.name ?? null;
const label = ({ start_quote, end_quote }: { start_quote: string; end_quote: string }) =>
  start_quote === end_quote ? start_quote : `${start_quote}, ${end_quote}`;

const aliases = new Map<number, Record<string, string | null>>([
  [193076, { d7: "d1", d26: "d1", d9: "d2", d24: "d2", d22: "d3", d25: "d8" }],
  [190759, { d4: "d3", d5: "d3", d7: "d3", d17: "d3", d23: "d3", d24: "d3", d38: "d3", d39: "d3", d42: "d3", d43: "d3", d44: "d3", d46: "d3", d10: "d8", d18: "d13", d19: "d12", d25: "d12", d26: "d11", d28: "d27", d40: "d15", d41: "d15", d47: "d29", d49: "d29", d50: "d2", d51: "d1" }],
  [142717, { d5: "d3", d8: "d7", d9: "d6", d10: "d6", d11: "d6", d30: "d6", d31: "d6", d44: "d6", d46: null, d52: "d6", d54: null, d16: "d12", d32: "d17", d47: "d17", d29: "d28", d36: "d13", d41: "d19", d51: "d19", d53: "d37", d55: null }],
  [189928, { d22: "d21", d49: "d40" }],
  [195153, { d49: "d46", d73: "d13", d76: "d48", d77: "d11" }],
  [188518, { d13: "d9", d17: "d4", d18: "d3", d19: "d3" }],
  [188057, { d20: "d18", d21: "d19", d22: "d1", d23: "d17", d43: "d18", d44: "d19", d45: "d18", d46: "d18", d47: "d10", d48: "d18" }],
  [12801, { d5: null, d6: "d1", d7: "d1", d8: "d1", d15: "d1", d22: "d1", d24: "d1", d9: "d4", d10: "d4", d13: "d4", d14: "d4", d16: "d4", d17: "d4", d18: null, d25: "d4", d20: "d19", d23: "d19" }],
  [128901, { d7: "d6", d13: "d12", d14: "d1", d17: "d2", d18: "d3", d19: "d4", d21: "d5", d22: "d6", d23: "d8", d24: "d9", d25: "d10" }],
  [219243, { d2: "d1" }],
  [125095, { d7: "d5", d8: "d5", d15: "d14", d18: "d14", d23: "d14", d38: "d24" }],
  [112480, { d2: "d1", d3: "d1", d4: "d1", d5: "d1", d7: "d6", d9: "d8" }],
  [13208, { d3: "d1", d4: "d2", d5: "d1", d6: "d1", d7: "d2" }],
]);

const labels = new Map<number, Record<string, string>>([
  [193076, { d1: "Provincial Court forfeiture decision, (1990), 9 W.C.B. (2d) 426", d2: "Ontario Court of Appeal decision, (1991), 5 O.R. (3d) 225", d8: "Ontario District Court decision" }],
  [189928, { d1: "Ontario Court of Appeal judgment under appeal", d2: "Parker A.C.J.H.C.'s trial judgment", d4: "Roe v. Wade, 410 U.S. 113 (1973)", d11: "Reference re B.C. Motor Vehicle Act, [1985] 2 S.C.R. 486" }],
  [195153, { d3: "Canada (Human Rights Commission) v. Taylor", d55: "Attorney General of Canada v. Dupond, [1978] 2 S.C.R. 770", d56: "Attorney General of Canada v. Law Society of British Columbia, [1982] 2 S.C.R. 307", d66: "Boos v. Barry, 108 S. Ct. 1157 (1988)", d72: "Saskatchewan (Human Rights Commission) v. Engineering Students' Society (1989), 56 D.L.R. (4th) 604" }],
  [224932, { d15: "R. v. Blackman, 2008 SCC 37" }],
  [12801, { d1: "Real Estate Council Hearing Committee decision", d4: "Financial Institutions Commission appeal decision" }],
  [125095, { d35: "S.W. v. P.W., [1991] N.S.J. No. 637 (N.S.F.C.)" }],
  [112480, { d1: "Tax Court judgment under appeal" }],
  [13208, { d1: "order awarding special costs", d2: "supplementary order extending special costs to post-judgment proceedings" }],
]);

const treatmentDrops = new Map<number, Set<string>>([
  [224932, new Set(["d12", "d13", "d14"])],
]);

const directDecisionIds = new Map<number, Set<string>>([
  [193076, new Set(["d1", "d2"])],
  [190759, new Set(["d1", "d2"])],
  [142717, new Set(["d1"])],
  [189928, new Set(["d1", "d2"])],
  [195153, new Set(["d1"])],
  [224932, new Set(["d1"])],
  [188518, new Set(["d4"])],
  [188057, new Set(["d1"])],
  [12801, new Set(["d4"])],
  [125095, new Set(["d1", "d2", "d11"])],
  [127930, new Set(["d1", "d2", "d3"])],
  [112480, new Set(["d1"])],
  [13208, new Set(["d1", "d2"])],
]);

const reportedHistories = new Map<number, ProductGoldRecord["reported_history"]>([
  [193076, [
    { cited_decision: "Provincial Court forfeiture decision, (1990), 9 W.C.B. (2d) 426", action: "affirmed", later_decision: "Ontario District Court decision", affected_part: null, opinion_id: "o1" },
    { cited_decision: "Provincial Court forfeiture decision, (1990), 9 W.C.B. (2d) 426", action: "reversed", later_decision: "Ontario Court of Appeal decision, (1991), 5 O.R. (3d) 225", affected_part: "the forfeiture order", opinion_id: "o1" },
    { cited_decision: "Ontario District Court decision", action: "reversed", later_decision: "Ontario Court of Appeal decision, (1991), 5 O.R. (3d) 225", affected_part: "the affirmed forfeiture order", opinion_id: "o1" },
  ]],
  [190759, [
    { cited_decision: "Ontario Review Board disposition of May 17, 2000", action: "reversed", later_decision: "Ontario Court of Appeal, (2001), 54 O.R. (3d) 257", affected_part: "continued hospital detention with limited escorted leave", opinion_id: "o1" },
  ]],
  [189928, [
    { cited_decision: "Parker A.C.J.H.C.'s trial judgment", action: "reversed", later_decision: "Ontario Court of Appeal judgment under appeal", affected_part: "the jury acquittals; a new trial was ordered", opinion_id: "o1" },
  ]],
  [195153, [
    { cited_decision: "Alberta Court of Queen's Bench judgment", action: "reversed", later_decision: "Alberta Court of Appeal judgment", affected_part: "the rejection of the Charter challenge and resulting conviction", opinion_id: "o1" },
  ]],
  [224932, [
    { cited_decision: "R. v. Bradshaw, 2012 BCSC 2025", action: "reversed", later_decision: "R. v. Bradshaw, 2017 SCC 35", affected_part: "the hearsay admissibility ruling and conviction", opinion_id: "o1" },
  ]],
  [188518, [
    { cited_decision: "arbitrator's March 19, 1987 award", action: "quashed", later_decision: "Quebec Superior Court judgment", affected_part: "the award allowing the grievances after excluding the university's evidence", opinion_id: "o1" },
    { cited_decision: "Quebec Superior Court judgment", action: "affirmed", later_decision: "Quebec Court of Appeal, [1990] R.J.Q. 2183", affected_part: "the order vacating the award and directing a new arbitration", opinion_id: "o1" },
  ]],
  [12801, [
    { cited_decision: "Real Estate Council Hearing Committee decision", action: "affirmed", later_decision: "Financial Institutions Commission appeal decision", affected_part: "the preliminary limitation and late-disclosure rulings", opinion_id: "o1" },
  ]],
  [225103, [
    { cited_decision: "Ross River Dena Council v. Canada (Attorney General), 2012 YKSC 4", action: "reversed", later_decision: "Ross River Dena Council v. Canada (Attorney General), 2013 YKCA 6", affected_part: "the severed threshold rulings", opinion_id: "o1" },
  ]],
]);

const auditedAdditions = new Map<number, {
  direct_outcomes?: ProductGoldRecord["direct_outcomes"];
  reported_history?: ProductGoldRecord["reported_history"];
  treatments?: ProductGoldRecord["treatments"];
}>([
  [220108, {
    direct_outcomes: [{
      cited_decision: "2003 income-tax assessment",
      actions: [{ action: "affirmed", affected_part: "instalment interest imposed under subsection 161(2)" }],
    }],
    treatments: [{
      cited_decision: "Strain v. The Queen, [1998] 2 C.T.C. 2136", opinion_id: "o1", signals: ["approved"], other_signal: null,
      proposition: "Source deductions and required instalments do not create double taxation because any overpayment is refundable under subsection 164(1).",
      treatment: "Little J. expressly agreed with Strain's answer to the double-taxation objection.",
    }],
  }],
  [224932, {
    reported_history: [{
      cited_decision: "trial decision in R. v. Couture", action: "reversed", later_decision: "R. v. Couture, 2007 SCC 28",
      affected_part: "the finding that repeated disclosures supplied corroboration for threshold reliability", opinion_id: "o2",
    }],
    treatments: [
      {
        cited_decision: "R. v. Bradshaw, 2017 SCC 35", opinion_id: "o1", signals: ["followed"], other_signal: null,
        proposition: "Necessary hearsay is admissible only when threshold reliability overcomes the dangers created by the absence of contemporaneous cross-examination.",
        treatment: "Bennett J.A. treated Bradshaw as the governing framework and threshold reliability as the live requirement.",
      },
      {
        cited_decision: "R. v. Bradshaw, 2017 SCC 35; R. v. Khelawon, 2006 SCC 57; R. v. Youvarajah, 2013 SCC 41", opinion_id: "o1", signals: ["followed"], other_signal: null,
        proposition: "Threshold reliability may rest on adequate procedural substitutes for testing a statement or on substantive guarantees that the statement is inherently trustworthy.",
        treatment: "Bennett J.A. adopted the two routes as the organizing framework for Ms. Asp's statements.",
      },
      {
        cited_decision: "R. v. Bradshaw, 2017 SCC 35", opinion_id: "o1", signals: ["followed"], other_signal: null,
        proposition: "Procedural reliability ordinarily requires meaningful substitutes for in-court testimony, such as recording, an oath or warning, and usually cross-examination.",
        treatment: "Bennett J.A. used Bradshaw's safeguards to define the procedural-reliability inquiry.",
      },
      {
        cited_decision: "R. v. Bradshaw, 2017 SCC 35", opinion_id: "o1", signals: ["followed"], other_signal: null,
        proposition: "Jury instructions and Vetrovec warnings do not replace the missing means to test an un-cross-examined hearsay statement.",
        treatment: "Bennett J.A. adopted Bradshaw's limit when assessing the safeguards surrounding Ms. Asp's statements.",
      },
      {
        cited_decision: "R. v. Bradshaw, 2017 SCC 35", opinion_id: "o1", signals: ["followed"], other_signal: null,
        proposition: "Substantive reliability is assessed from the circumstances in which the statement was made and evidence that corroborates or conflicts with it.",
        treatment: "Bennett J.A. used that rule to examine inherent trustworthiness.",
      },
      {
        cited_decision: "R. v. Bradshaw, 2017 SCC 35; R. v. Khelawon, 2006 SCC 57; R. v. Couture, 2007 SCC 28; R. v. U. (F.J.), [1995] 3 S.C.R. 764; R. v. Blackman, 2008 SCC 37", opinion_id: "o1", signals: ["followed"], other_signal: null,
        proposition: "Procedural and substantive reliability may work together, but the threshold remains high and the combined route will seldom justify admission.",
        treatment: "Bennett J.A. accepted the combined route while emphasizing Bradshaw's warning that it must be used with great care.",
      },
      {
        cited_decision: "R. v. Blackman, 2008 SCC 37", opinion_id: "o2", signals: ["approved"], other_signal: null,
        proposition: "Restricting corroboration at the threshold stage avoids an unwieldy trial within a trial and prevents strong evidence of guilt from bootstrapping unreliable inculpatory hearsay.",
        treatment: "Dickson J.A. endorsed those policy reasons for confining corroborative evidence.",
      },
      {
        cited_decision: "R. v. Bradshaw, 2017 SCC 35", opinion_id: "o1", signals: ["applied"], other_signal: null,
        proposition: "A Vetrovec witness's hearsay is not categorically inadmissible, but proving its trustworthiness is exceptionally difficult because such a witness may lie even under oath.",
        treatment: "Bennett J.A. applied Bradshaw's warning to the overlapping dangers created by Ms. Asp's Vetrovec status and the Mr. Big operation.",
      },
    ],
  }],
  [195153, {
    direct_outcomes: [{
      cited_decision: "Alberta Court of Appeal, 87 A.R. 177",
      actions: [{ action: "remitted", affected_part: "issues left unresolved after the Court of Appeal struck down the provisions" }],
    }],
    reported_history: [
      { cited_decision: "Collin v. Smith, 578 F.2d 1197 (7th Cir. 1978)", action: "leave_refused", later_decision: "Supreme Court of the United States", affected_part: "certiorari", opinion_id: "o2" },
      { cited_decision: "American Booksellers Ass'n, Inc. v. Hudnut, 771 F.2d 323 (7th Cir. 1985)", action: "leave_refused", later_decision: "Supreme Court of the United States", affected_part: "certiorari", opinion_id: "o2" },
      { cited_decision: "Saskatchewan (Human Rights Commission) v. Engineering Students' Society (1989), 56 D.L.R. (4th) 604", action: "leave_refused", later_decision: null, affected_part: null, opinion_id: "o2" },
    ],
    treatments: [
      {
        cited_decision: "RWDSU v. Dolphin Delivery Ltd., [1986] 2 S.C.R. 573", opinion_id: "o1", signals: ["explained"], other_signal: null,
        proposition: "Freedom of expression was a central value of Canadian parliamentary democracy before the Charter, while the suggested exclusion for violence had not determined a Supreme Court decision.",
        treatment: "Dickson C.J. adopted Dolphin Delivery's historical account but cautioned against treating its comment about violence as a decided limit on section 2(b).",
      },
      {
        cited_decision: "Taylor and Western Guard Party v. Canada, Communication No. 104/1981", opinion_id: "o1", signals: ["applied"], other_signal: null,
        proposition: "Racist telephone messages were advocacy of racial or religious hatred that Canada was obliged by article 20(2) of the ICCPR to prohibit.",
        treatment: "Dickson C.J. used the Human Rights Committee's decision to support the importance and international compatibility of prohibiting hate propaganda.",
      },
      {
        cited_decision: "RWDSU v. Dolphin Delivery Ltd., [1986] 2 S.C.R. 573", opinion_id: "o2", signals: ["limited"], other_signal: null,
        proposition: "Dolphin Delivery's exclusion of violence concerns actual or threatened physical coercion, not offensive advocacy that neither compels action nor urges violence.",
        treatment: "McLachlin J. confined the exception and refused to extend it to Keegstra's hate propaganda.",
      },
      {
        cited_decision: "Reference re Alberta Statutes, [1938] S.C.R. 100", opinion_id: "o2", signals: ["explained"], other_signal: null,
        proposition: "A province could not interfere with political expression essential to the free operation of national democratic institutions.",
        treatment: "McLachlin J. used the Alberta Press Reference to explain the quasi-constitutional protection of political expression before the Charter.",
      },
      {
        cited_decision: "Saumur v. City of Quebec, [1953] 2 S.C.R. 299; Switzman v. Elbling, [1957] S.C.R. 285", opinion_id: "o2", signals: ["explained"], other_signal: null,
        proposition: "Some judges derived an implied bill of rights from the Constitution Act, 1867's provision for a constitution similar in principle to that of the United Kingdom.",
        treatment: "McLachlin J. used Saumur and Switzman to explain the development of pre-Charter protection for expression.",
      },
      {
        cited_decision: "West Virginia State Board of Education v. Barnette, 319 U.S. 624 (1943)", opinion_id: "o2", signals: ["approved"], other_signal: null,
        proposition: "Government may not prescribe orthodoxy in politics, nationalism, religion, or other matters of opinion.",
        treatment: "McLachlin J. invoked Barnette's anti-orthodoxy principle to illustrate free speech's constitutional importance.",
      },
    ],
  }],
]);

function canonicalDecisions(record: LegacyRecord) {
  const map = aliases.get(record.document_id) ?? {};
  const decisions = structuredClone(record.annotation.analysis.cited_decisions);
  const byId = new Map(decisions.map((decision) => [decision.decision_id, decision]));
  for (const [sourceId, targetId] of Object.entries(map)) {
    if (!targetId) continue;
    const source = byId.get(sourceId);
    const target = byId.get(targetId);
    if (!source || !target) throw new Error(`${record.document_id}: invalid alias ${sourceId} -> ${targetId}`);
    target.treatments.push(...source.treatments);
    if (source.procedural_relationship?.actions.length) {
      target.procedural_relationship ??= { actions: [] };
      target.procedural_relationship.actions.push(...source.procedural_relationship.actions);
    }
  }
  const removed = new Set(Object.keys(map));
  return decisions.filter(({ decision_id }) => !removed.has(decision_id) && !treatmentDrops.get(record.document_id)?.has(decision_id)).map((decision) => {
    decision.treatments = [...new Map(decision.treatments.map((treatment) => [JSON.stringify([
      treatment.opinion_id, treatment.signals, treatment.other_signal, treatment.proposition, treatment.treatment,
    ]), treatment])).values()];
    if (decision.procedural_relationship) {
      decision.procedural_relationship.actions = [...new Map(decision.procedural_relationship.actions.map((action) => [JSON.stringify(action), action])).values()];
    }
    return decision;
  });
}

function spans(value: unknown): Array<{ start_line: number; end_line: number; start_quote: string; end_quote: string }> {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(spans);
  const item = value as Record<string, unknown>;
  const found = typeof item.start_line === "number" && typeof item.end_line === "number" &&
    typeof item.start_quote === "string" && typeof item.end_quote === "string" ? [item as ReturnType<typeof spans>[number]] : [];
  return [...found, ...Object.values(item).flatMap(spans)];
}

async function validateSpans(record: LegacyRecord) {
  const text = await readFile(path.join(packets, `${record.document_id}.txt`), "utf8");
  const lines = new Map([...text.matchAll(/^(\d{5}) \| (.*)$/gmu)].map((match) => [Number(match[1]), match[2]]));
  const invalid = spans(record.annotation).filter((span) =>
    !lines.get(span.start_line)?.includes(span.start_quote) || !lines.get(span.end_line)?.includes(span.end_quote));
  if (invalid.length) throw new Error(`${record.document_id}: ${invalid.length} source spans no longer resolve`);
  return spans(record.annotation).length;
}

async function main() {
  const { document_ids: selection } = JSON.parse(await readFile(path.join(here, "selection-scaled-30.json"), "utf8")) as { document_ids: number[] };
  const ids = new Set(selection);
  const prior = await parse<LegacyRecord>(path.join(here, "gold.jsonl"));
  const audited = await parse<ProductGoldRecord>(path.join(here, "gold-product-10-v2.jsonl"));
  const byId = new Map(audited.map((record) => [record.document_id, record]));
  let validatedSpans = 0;

  for (const record of prior.filter(({ document_id }) => ids.has(document_id))) {
    validatedSpans += await validateSpans(record);
    if (byId.has(record.document_id)) continue;
    const decisions = canonicalDecisions(record);
    byId.set(record.document_id, {
    contract_version: "a2aj-product-treatment-gold-v1",
    document_id: record.document_id,
    citation: record.citation,
    structure: {
      opinions: record.annotation.structure.opinions.map((opinion) => ({
        opinion_id: opinion.opinion_id,
        boundary: opinion.boundary,
        writer: writer(record, opinion.opinion_id),
        collective_author: opinion.collective_author?.name ?? null,
        result_position: opinion.result_position,
      })),
      participants: record.annotation.structure.participants.map(({ name, result_position, opinion_links }) => ({
        name,
        result_position,
        opinion_links: opinion_links.map(({ opinion_id, relation }) => ({ opinion_id, relation })),
      })),
      nonparticipants: record.annotation.structure.nonparticipants.map(({ name }) => name),
    },
    direct_outcomes: decisions.flatMap((decision) => decision.procedural_relationship?.actions.length &&
      (!directDecisionIds.has(record.document_id) || directDecisionIds.get(record.document_id)!.has(decision.decision_id)) ? [{
      cited_decision: labels.get(record.document_id)?.[decision.decision_id] ?? label(decision.identifying_span),
      actions: decision.procedural_relationship.actions.map(({ action, affected_part }) => ({ action, affected_part })),
    }] : []),
    reported_history: reportedHistories.get(record.document_id) ?? [],
    treatments: decisions.flatMap((decision) => decision.treatments.map(({ opinion_id, signals, other_signal, proposition, treatment }) => ({
      cited_decision: labels.get(record.document_id)?.[decision.decision_id] ?? label(decision.identifying_span),
      opinion_id,
      signals,
      other_signal,
      proposition,
      treatment,
    }))),
    });
  }

  const records = selection.map((documentId) => byId.get(documentId)).filter((record): record is ProductGoldRecord => Boolean(record));
  if (records.length !== selection.length) throw new Error(`Expected ${selection.length} records; found ${records.length}`);
  for (const record of records) {
    const additions = auditedAdditions.get(record.document_id);
    if (!additions) continue;
    for (const outcome of additions.direct_outcomes ?? []) {
      const existing = record.direct_outcomes.find(({ cited_decision }) => cited_decision === outcome.cited_decision);
      if (existing) existing.actions.push(...outcome.actions);
      else record.direct_outcomes.push(outcome);
    }
    record.reported_history.push(...additions.reported_history ?? []);
    record.treatments.push(...additions.treatments ?? []);
  }
  const errors = records.flatMap((record) => productGoldErrors(record).map((error) => `${record.document_id}: ${error}`));
  if (errors.length) throw new Error(errors.join("\n"));
  const destination = path.join(here, "gold-product-30-v1.jsonl");
  const mechanicalDestination = path.join(here, "gold-structure-30-v6.jsonl");
  const priorById = new Map(prior.map((record) => [record.document_id, record]));
  const mechanical = selection.map((documentId) => {
    const record = structuredClone(priorById.get(documentId)!) as LegacyRecord & { contract_version: string };
    record.contract_version = "a2aj-proposition-treatment-v6";
    for (const participant of record.annotation.structure.participants) {
      for (const link of participant.opinion_links) delete (link as typeof link & { scope?: unknown }).scope;
    }
    const citedDecisions = record.annotation.analysis.cited_decisions;
    (record.annotation as unknown as { analysis: unknown }).analysis = {
      decision_mentions: citedDecisions.map(({ identifying_span }) => ({
        cited_decision: label(identifying_span),
        identifying_block: `p${identifying_span.start_line}`,
      })),
      procedural_relationships: [],
      treatments: [],
    };
    return record;
  });
  await writeFile(destination, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  await writeFile(mechanicalDestination, `${mechanical.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  console.log(JSON.stringify({ destination, mechanical_destination: mechanicalDestination, cases: records.length, treatments: records.reduce((sum, record) => sum + record.treatments.length, 0), validated_spans: validatedSpans }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

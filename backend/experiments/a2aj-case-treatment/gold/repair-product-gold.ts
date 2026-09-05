import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { productGoldErrors, type ProductGoldRecord } from "../productGold";

type Candidate = {
  direct_outcomes: Array<{ id: string; cited_decision: string; action: ProductGoldRecord["direct_outcomes"][number]["actions"][number]["action"]; affected_part: string | null }>;
  reported_history: Array<{ id: string; cited_decision: string; action: ProductGoldRecord["reported_history"][number]["action"]; later_decision: string | null; affected_part: string | null }>;
  treatments: Array<{ id: string; cited_decision: string; signals: ProductGoldRecord["treatments"][number]["signals"]; other_signal: string | null; proposition: string; treatment: string }>;
};

type Selection = { documentId: number; opinionId: string; ids: string[] };

const root = path.resolve("backend/experiments/a2aj-case-treatment");
const simple = path.join(root, "runs/v6-product-simple-luna-max-20260830/product-judge-v1/prompts");
const hyper = path.join(root, "runs/v6-product-hypersimple-luna-max-20260830/product-judge-v1/prompts");
const source = path.join(root, "gold/gold-product-10-v1.jsonl");
const destination = path.join(root, "gold/gold-product-10-v2.jsonl");

const selections: Record<"simple" | "hyper", { treatments: Selection[]; history: Selection[]; direct: Selection[] }> = {
  simple: {
    treatments: [
      { documentId: 814, opinionId: "o1", ids: ["ct1", "ct2", "ct3", "ct4", "ct5"] },
      { documentId: 118406, opinionId: "o1", ids: ["ct1", "ct2", "ct6", "ct8", "ct9", "ct10", "ct11", "ct25", "ct26", "ct27", "ct30", "ct31"] },
      { documentId: 118406, opinionId: "o2", ids: ["ct34", "ct37", "ct38", "ct40", "ct42", "ct43", "ct45", "ct46", "ct53", "ct65"] },
      { documentId: 13847, opinionId: "o4", ids: ["ct35"] },
      { documentId: 13847, opinionId: "o5", ids: ["ct61"] },
      { documentId: 190600, opinionId: "o1", ids: ["ct10", "ct11", "ct13", "ct14", "ct15", "ct16", "ct17", "ct18"] },
      { documentId: 192926, opinionId: "o1", ids: ["ct15"] },
      { documentId: 192926, opinionId: "o2", ids: ["ct49"] },
      { documentId: 192926, opinionId: "o3", ids: ["ct59"] },
      { documentId: 192926, opinionId: "o4", ids: ["ct61", "ct62", "ct87", "ct88", "ct95", "ct105", "ct106"] },
    ],
    history: [
      { documentId: 118406, opinionId: "o1", ids: ["ch1", "ch2"] },
    ],
    direct: [],
  },
  hyper: {
    treatments: [
      { documentId: 92143, opinionId: "o1", ids: ["ct1", "ct2", "ct3", "ct4"] },
      { documentId: 118406, opinionId: "o1", ids: ["ct32"] },
      { documentId: 118406, opinionId: "o2", ids: ["ct39", "ct44", "ct52", "ct69"] },
      { documentId: 126799, opinionId: "o1", ids: ["ct12", "ct13", "ct20"] },
      { documentId: 126799, opinionId: "o2", ids: ["ct27", "ct38", "ct48"] },
      { documentId: 126799, opinionId: "o3", ids: ["ct39", "ct43"] },
      { documentId: 13847, opinionId: "o1", ids: ["ct1", "ct2"] },
      { documentId: 13847, opinionId: "o5", ids: ["ct68"] },
      { documentId: 192926, opinionId: "o1", ids: ["ct16"] },
      { documentId: 192926, opinionId: "o4", ids: ["ct56", "ct88"] },
    ],
    history: [
      { documentId: 126799, opinionId: "o1", ids: ["ch2", "ch3"] },
      { documentId: 13847, opinionId: "o1", ids: ["ch1", "ch2", "ch3", "ch4", "ch5"] },
      { documentId: 13847, opinionId: "o2", ids: ["ch6"] },
      { documentId: 13847, opinionId: "o5", ids: ["ch7"] },
      { documentId: 135183, opinionId: "o1", ids: ["ch1"] },
    ],
    direct: [
      { documentId: 13847, opinionId: "o1", ids: ["cd3"] },
    ],
  },
};

const candidates = new Map<string, Candidate>();
async function candidate(arm: "simple" | "hyper", documentId: number) {
  const key = `${arm}:${documentId}`;
  if (!candidates.has(key)) {
    const lines = (await readFile(path.join(arm === "simple" ? simple : hyper, `${documentId}.txt`), "utf8")).split(/\r?\n/u);
    candidates.set(key, JSON.parse(lines[14]) as Candidate);
  }
  return candidates.get(key)!;
}

async function main() {
  const records = (await readFile(source, "utf8")).trim().split(/\r?\n/u).map((line) => JSON.parse(line) as ProductGoldRecord);
  const byId = new Map(records.map((record) => [record.document_id, record]));

  for (const arm of ["simple", "hyper"] as const) {
    for (const selection of selections[arm].treatments) {
      const record = byId.get(selection.documentId)!;
      const pool = (await candidate(arm, selection.documentId)).treatments;
      for (const id of selection.ids) {
        const item = pool.find((value) => value.id === id);
        if (!item) throw new Error(`Missing ${arm}/${selection.documentId}/${id}`);
        record.treatments.push({
          cited_decision: item.cited_decision,
          opinion_id: selection.opinionId,
          signals: item.signals,
          other_signal: item.other_signal,
          proposition: item.proposition,
          treatment: item.treatment,
        });
      }
    }
    for (const selection of selections[arm].history) {
      const record = byId.get(selection.documentId)!;
      const pool = (await candidate(arm, selection.documentId)).reported_history;
      for (const id of selection.ids) {
        const item = pool.find((value) => value.id === id);
        if (!item) throw new Error(`Missing ${arm}/${selection.documentId}/${id}`);
        record.reported_history.push({ ...item, id: undefined, opinion_id: selection.opinionId } as ProductGoldRecord["reported_history"][number]);
      }
    }
    for (const selection of selections[arm].direct) {
      const record = byId.get(selection.documentId)!;
      const pool = (await candidate(arm, selection.documentId)).direct_outcomes;
      for (const id of selection.ids) {
        const item = pool.find((value) => value.id === id);
        if (!item) throw new Error(`Missing ${arm}/${selection.documentId}/${id}`);
        record.direct_outcomes.push({ cited_decision: item.cited_decision, actions: [{ action: item.action, affected_part: item.affected_part }] });
      }
    }
  }

  const errors = records.flatMap((record) => productGoldErrors(record).map((error) => `${record.document_id}: ${error}`));
  if (errors.length) throw new Error(errors.join("\n"));
  await writeFile(destination, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  console.log(JSON.stringify({
    destination,
    cases: records.length,
    treatments: records.reduce((sum, record) => sum + record.treatments.length, 0),
    direct_outcomes: records.reduce((sum, record) => sum + record.direct_outcomes.length, 0),
    reported_history: records.reduce((sum, record) => sum + record.reported_history.length, 0),
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

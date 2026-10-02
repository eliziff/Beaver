// Measures, on A2AJ's own records, the facts the matcher's rules rely on:
//  1. cited year vs decision year, per citation format and year bracket;
//  2. whether a citation's native court id equals the record's A2AJ dataset;
//  3. how many (dataset, year, name) groups already hold several records under each name rule,
//     and how many NEW collisions the Crown alias and party-order rules create.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { buildNameIndex, extract, loadA2AJ, RULES, yearKind } from "./lib";

(async () => {
  const started = Date.now();
  const { cases, datasets } = loadA2AJ();
  const deltas: Record<string, Record<string, number>> = {};
  const court: Record<string, number> = { same: 0, other: 0, none: 0 };
  const courtOther: Record<string, number> = {};
  let n = 0;
  for (const item of cases.values()) {
    if (item.year === null) continue;
    for (const form of item.citations) {
      const reading = extract(form).citations[0];
      if (!reading?.fields?.yearNumber) continue;
      const kind = `${reading.format}/${yearKind(reading)}${reading.format === "reporter" ? `/${reading.court?.id ?? "no-court"}` : ""}`;
      const d = String(reading.fields.yearNumber - item.year);
      (deltas[kind] ??= {})[d] = (deltas[kind][d] ?? 0) + 1;
      const ds = datasets.has(reading.court?.id?.toUpperCase() ?? "") ? reading.court!.id.toUpperCase() : null;
      if (!reading.court?.id) court.none++;
      else if (ds === item.dataset) court.same++;
      else { court.other++; const k = `${reading.court.id}->${item.dataset}`; courtOther[k] = (courtOther[k] ?? 0) + 1; }
      n++;
    }
  }
  const collisions: Record<string, unknown> = {};
  const groupsOf = (rule: keyof typeof RULES) => buildNameIndex(cases.values(), RULES[rule]);
  const indexes = Object.fromEntries(Object.keys(RULES).map((r) => [r, groupsOf(r as keyof typeof RULES)]));
  for (const [rule, index] of Object.entries(indexes)) {
    let multi = 0, recordsInMulti = 0;
    for (const ids of index.values()) if (ids.length > 1) { multi++; recordsInMulti += ids.length; }
    collisions[rule] = { keys: index.size, multiRecordKeys: multi, recordsInMultiKeys: recordsInMulti };
  }
  // New collisions: keys under a looser rule holding >1 record whose keys under the stricter rule differ.
  const created = (looser: string, stricter: string) => {
    const strictIndex = indexes[stricter];
    const strictKeysOf = new Map<number, Set<string>>();
    for (const [key, ids] of strictIndex) for (const id of ids) (strictKeysOf.get(id) ?? strictKeysOf.set(id, new Set()).get(id)!).add(key);
    const examples: string[] = []; let count = 0;
    for (const [key, ids] of indexes[looser]) {
      if (ids.length < 2) continue;
      // a collision is new when no stricter key already contains all of these ids
      const shared = [...strictKeysOf.get(ids[0]) ?? []].some((k) => ids.every((id) => strictIndex.get(k)!.includes(id)));
      if (shared) continue;
      count++;
      if (examples.length < 40) examples.push(`${key.replace(/\|/gu, " | ")} :: ${ids.map((id) => `${cases.get(id)!.names[0]} [${cases.get(id)!.citations[0]}, ${cases.get(id)!.date?.slice(0, 10)}]`).join(" ;; ")}`);
    }
    return { newCollisionKeys: count, examples };
  };
  collisions.newFromCasefold = created("casefold", "exact");
  collisions.newFromCrown = created("crown", "casefold");
  collisions.newFromUnordered = created("crownUnordered", "crown");
  const out = { citationsRead: n, yearDeltaCitedMinusDecision: deltas, courtVsDataset: court,
    courtOther, collisions, seconds: Math.round((Date.now() - started) / 1000) };
  writeFileSync(path.join(__dirname, "results", "measure.json"), JSON.stringify(out, null, 1));
  console.log(JSON.stringify({ ...out, collisions: Object.fromEntries(Object.entries(collisions).map(([k, v]) => [k, (v as { examples?: unknown }).examples ? { ...(v as object), examples: (v as { examples: string[] }).examples.slice(0, 8) } : v])) }, null, 1));
})();

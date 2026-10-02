// Offline evaluation of the style-of-cause fallback. Reads only local data:
//   A2AJ bulk sqlite (Beaver's provider store), the ALR footnote gold (read in place),
//   CanLII case metadata (ALR Quote Verifier's canlii db), results/measure.json and results/recordings/.
// Writes results/summary.json, results/wrong-matches.json and results/canlii-absent-accepts.json.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildNameIndex, buildTokenIndex, type Citation, courtResolver, extract, loadA2AJ, matchStyle, native,
  nearNameGuard, normaliseName, type Outcome, proceedingGuard, type Query, RULES, YEAR_RULES, type YearKind, yearKind } from "./lib";

const HERE = __dirname;
const LOCAL = process.env.LOCALAPPDATA ?? "";
const ALR_ROOT = process.env.ALR_QUOTE_VERIFIER_ROOT?.trim() ||
  path.join(process.env.USERPROFILE ?? "", "Desktop", "Martys Qote Verifier", "ALR-Quote-Verifier");
const CANLII_DB = process.env.CANLII_CASES_DB?.trim() ||
  path.join(LOCAL, "ALR Quote Verifier", "data", "canlii-186d92f8c0a4.db");
const readJsonl = (file: string) => readFileSync(file, "utf8").split(/\r?\n/u).filter(Boolean).map((l) => JSON.parse(l));

type Trial = { style: string; cite: string; format: string; yearKind: YearKind; year: number; dataset: string; truth: number | null };
type Tally = { n: number; correct: number; wrong: number; zero: number; multi: number };
const tally = (): Tally => ({ n: 0, correct: 0, wrong: 0, zero: 0, multi: 0 });
const ratio = (a: number, b: number) => b ? +(a / b).toFixed(4) : null;
const score = (t: Tally) => ({ ...t, precision: ratio(t.correct, t.correct + t.wrong), recall: ratio(t.correct, t.n),
  abstainZero: ratio(t.zero, t.n), abstainMulti: ratio(t.multi, t.n) });
const GUARDS = ["none", "proceeding", "nearName", "both"] as const;
type Guard = typeof GUARDS[number];
// Configurations whose wrong matches, per-court rows and absent-target accepts are written out.
const SELECTED = ["exact/strict/none", "exact/aware/none", "exact/aware2/none", "crown/aware2/none", "crown/aware2/proceeding", "casefold/aware/none", "crown/aware/none",
  "crownUnordered/aware/none", "casefold/aware/both", "crown/aware/both"];

(async () => {
  const started = Date.now();
  const { cases, keyIndex, datasets } = loadA2AJ();
  const measure = JSON.parse(readFileSync(path.join(HERE, "results", "measure.json"), "utf8"));
  const datasetOf = courtResolver(datasets, measure.courtOther);
  const describe = (id: number) => { const c = cases.get(id)!; return `${c.names[0]} | ${c.citations.join(" / ")} | ${c.dataset} | ${c.date?.slice(0, 10)}`; };
  const ruleNames = Object.keys(RULES);
  const indexes = new Map(ruleNames.map((r) => [r, buildNameIndex(cases.values(), RULES[r])]));
  const tokenIndex = buildTokenIndex(cases.values());
  const run = (config: string, t: Pick<Trial, "style" | "dataset" | "year" | "yearKind">): Outcome => {
    const [rule, yearRule, guard] = config.split("/") as [string, string, Guard];
    const query: Query = { style: t.style, dataset: t.dataset, years: YEAR_RULES[yearRule].window(t.yearKind, t.year) };
    let o = matchStyle(indexes.get(rule)!, RULES[rule], query);
    if (guard === "proceeding" || guard === "both") o = proceedingGuard(indexes.get(rule)!, RULES[rule], query, o);
    if (guard === "nearName" || guard === "both") o = nearNameGuard(tokenIndex, query, o);
    return o;
  };
  const configs = ruleNames.flatMap((r) => Object.keys(YEAR_RULES).flatMap((y) => GUARDS.map((g) => `${r}/${y}/${g}`)));

  // ------------------------------------------------------------ trials from citing text (ALR gold)
  const textTrials = (texts: string[]) => {
    const trials: Trial[] = [], seen = new Set<string>();
    const stats = { texts: texts.length, caseCitations: 0, ineligibleNoStyleYearOrCourt: 0, ambiguousDirectKey: 0,
      eligibleTrials: 0, withKnownRecord: 0, withoutDirectRecord: 0 };
    for (const text of texts) {
      let parsed;
      try { parsed = extract(text); } catch { continue; }
      const groups = parsed.authorities?.length ? parsed.authorities : parsed.citations.map((_, i) => [i]);
      for (const group of groups) {
        const members = group.map((i) => parsed.citations[i])
          .filter((c): c is Citation => !!c && (c as { authority?: string }).authority === "case");
        // The known record: every direct citation key in the authority (parallel citations included) names one record.
        const truthIds = new Set<number>();
        for (const c of members) for (const id of (c.key ? keyIndex.get(c.key) : undefined) ?? []) truthIds.add(id);
        for (const c of members) {
          stats.caseCitations++;
          const style = c.style?.text?.trim(), year = c.fields?.yearNumber, dataset = datasetOf(c.court?.id);
          if (!style || !year || !dataset) { stats.ineligibleNoStyleYearOrCourt++; continue; }
          const key = `${style}|${c.span.text}|${dataset}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (truthIds.size > 1) { stats.ambiguousDirectKey++; continue; }
          stats.eligibleTrials++;
          if (truthIds.size) stats.withKnownRecord++; else stats.withoutDirectRecord++;
          trials.push({ style, cite: c.span.text, format: c.format, yearKind: yearKind(c), year, dataset,
            truth: truthIds.size ? [...truthIds][0] : null });
        }
      }
    }
    return { trials, stats };
  };
  const alrDir = path.join(ALR_ROOT, "dev", "benchmarks");
  const published = new Set<string>(), corrected = new Set<string>();
  for (const row of readJsonl(path.join(alrDir, "field_gold_provisional.jsonl")))
    for (const part of row.parts ?? []) {
      if (part.part_text) published.add(part.part_text);
      const value = part.fields?.corrected?.value;
      if (typeof value === "string" && value.trim()) corrected.add(value);
    }
  for (const row of readJsonl(path.join(alrDir, "fast_split_gold_all.jsonl")))
    if (row.status === "accepted") for (const part of row.expected_verbatim_parts ?? []) published.add(part);
  const alrPublished = textTrials([...published]);
  const alrCorrected = textTrials([...corrected].filter((t) => !published.has(t)));

  // ------------------------------------------------------------ CanLII metadata: title + neutral case id
  const canliiDb = new DatabaseSync(CANLII_DB, { readOnly: true });
  const canliiRows = canliiDb.prepare("SELECT databaseId, caseId, title FROM cases").all() as
    { databaseId: string; caseId: string; title: string }[];
  canliiDb.close();
  const idPattern = /^(\d{4})([a-z]+)(\d+)$/u; // CanLII case-id layout: 2005scc72, 1954canlii3
  const coverage = new Map<string, [number, number]>();
  for (const c of cases.values()) if (c.year) {
    const r = coverage.get(c.dataset);
    coverage.set(c.dataset, r ? [Math.min(r[0], c.year), Math.max(r[1], c.year)] : [c.year, c.year]);
  }
  const inCoverage = (dataset: string, year: number) => year >= coverage.get(dataset)![0] && year <= coverage.get(dataset)![1];
  const databaseSeries = new Map<string, Map<string, number>>();
  const neutralRows: { title: string; year: number; dataset: string; text: string }[] = [];
  for (const row of canliiRows) {
    const m = idPattern.exec(row.caseId);
    if (!m || m[2] === "canlii") continue;
    const dataset = datasetOf(m[2]);
    const counts = databaseSeries.get(row.databaseId) ?? new Map<string, number>();
    databaseSeries.set(row.databaseId, counts);
    counts.set(dataset ?? "", (counts.get(dataset ?? "") ?? 0) + 1);
    if (!dataset || !row.title?.trim() || !inCoverage(dataset, +m[1])) continue;
    neutralRows.push({ title: row.title.trim(), year: +m[1], dataset, text: `${m[1]} ${m[2].toUpperCase()} ${+m[3]}` });
  }
  const neutralKeys: string[] = [];
  for (let i = 0; i < neutralRows.length; i += 5000)
    neutralKeys.push(...native.citationLookupKeys(neutralRows.slice(i, i + 5000).map((r) => r.text)));
  const canliiPresent: Trial[] = [], canliiAbsent: Trial[] = [];
  neutralRows.forEach((r, i) => {
    if (!neutralKeys[i]) return;
    const ids = keyIndex.get(neutralKeys[i]);
    const trial: Trial = { style: r.title, cite: r.text, format: "neutral", yearKind: "decision", year: r.year,
      dataset: r.dataset, truth: ids?.size === 1 ? [...ids][0] : null };
    if (ids?.size === 1) canliiPresent.push(trial); else if (!ids) canliiAbsent.push(trial);
  });

  // ------------------------------------------------------------ year-rule isolation: SCC records under their own name
  const scrSelf: Trial[] = [];
  for (const c of cases.values()) {
    if (c.dataset !== "SCC" || c.year === null || !c.names[0]) continue;
    for (const form of c.citations) {
      const reading = extract(form).citations[0];
      if (!reading || reading.format !== "reporter" || !reading.fields?.yearNumber) continue;
      scrSelf.push({ style: c.names[0], cite: form, format: "reporter", yearKind: yearKind(reading),
        year: reading.fields.yearNumber, dataset: "SCC", truth: c.id });
    }
  }

  // ------------------------------------------------------------ grid
  const sets: Record<string, Trial[]> = {
    "alr-published": alrPublished.trials.filter((t) => t.truth),
    "alr-corrected": alrCorrected.trials.filter((t) => t.truth),
    "canlii-title": canliiPresent,
    "canlii-title-SCC": canliiPresent.filter((t) => t.dataset === "SCC"),
    "scc-own-name-reporter-year": scrSelf,
  };
  const grid: Record<string, Record<string, ReturnType<typeof score>>> = {};
  const byFormat: Record<string, Record<string, Record<string, ReturnType<typeof score>>>> = {};
  const byDataset: Record<string, Record<string, ReturnType<typeof score>>> = {};
  const wrongs: Record<string, unknown[]> = {};
  for (const config of configs) for (const [set, trials] of Object.entries(sets)) {
    const total = tally(), formats: Record<string, Tally> = {}, datasetsTally: Record<string, Tally> = {};
    const selected = SELECTED.includes(config);
    for (const t of trials) {
      const o = run(config, t);
      const parts = [total, (formats[`${t.format}/${t.yearKind}`] ??= tally())];
      if (selected && set === "canlii-title") parts.push(datasetsTally[t.dataset] ??= tally());
      for (const x of parts) {
        x.n++;
        if (o.status === "zero") x.zero++; else if (o.status === "multi") x.multi++;
        else if (o.ids[0] === t.truth) x.correct++; else x.wrong++;
      }
      if (selected && o.status === "match" && o.ids[0] !== t.truth)
        (wrongs[`${set} :: ${config}`] ??= []).push({ style: t.style, cite: t.cite, dataset: t.dataset, year: t.year,
          picked: describe(o.ids[0]), truth: describe(t.truth!) });
    }
    (grid[set] ??= {})[config] = score(total);
    (byFormat[set] ??= {})[config] = Object.fromEntries(Object.entries(formats).map(([k, v]) => [k, score(v)]));
    if (selected && set === "canlii-title")
      byDataset[config] = Object.fromEntries(Object.entries(datasetsTally).sort().map(([k, v]) => [k, score(v)]));
  }

  // Decisions CanLII lists in an A2AJ court and year range but A2AJ lacks: every accept is a namesake.
  const absentTarget: Record<string, unknown> = {}, absentAccepts: Record<string, unknown[]> = {};
  for (const config of configs) {
    const accepts = canliiAbsent.map((t) => ({ t, o: run(config, t) })).filter(({ o }) => o.status === "match");
    absentTarget[config] = { n: canliiAbsent.length, accepted: accepts.length, acceptRate: ratio(accepts.length, canliiAbsent.length),
      acceptedSCC: accepts.filter(({ t }) => t.dataset === "SCC").length, nSCC: canliiAbsent.filter((t) => t.dataset === "SCC").length };
    if (SELECTED.includes(config)) absentAccepts[config] = accepts.map(({ t, o }) =>
      ({ style: t.style, cite: t.cite, dataset: t.dataset, picked: describe(o.ids[0]) }));
  }
  // ALR citations whose direct keys reach no A2AJ record: the target population, examined by hand.
  const alrNoKey = [...alrPublished.trials, ...alrCorrected.trials].filter((t) => !t.truth);
  const alrNoDirectKey = Object.fromEntries(SELECTED.map((config) => [config, alrNoKey.map((t) => {
    const o = run(config, t);
    return { style: t.style, cite: t.cite, dataset: t.dataset, year: t.year,
      outcome: o.status === "match" ? `match: ${describe(o.ids[0])}` : `${o.status} (${o.ids.length})` };
  })]));

  // CanLII-ID (pre-neutral) decisions of A2AJ courts: the motivating population; coverage only, no truth.
  const databaseDataset = new Map<string, string>();
  for (const [db, counts] of databaseSeries) {
    const [best] = [...counts].sort((a, b) => b[1] - a[1]);
    if (best?.[0] && best[1] / [...counts.values()].reduce((a, b) => a + b, 0) > 0.95) databaseDataset.set(db, best[0]);
  }
  // `uniqueCanLIINamesake`: a unique A2AJ match although CanLII itself lists another decision of that
  // court and year under the same normalised title - an upper bound on wrong accepts in this population.
  const canliiIdCoverage: Record<string, Record<string, { n: number; unique: number; zero: number; multi: number;
    uniqueCanLIINamesake: number }>> = {};
  const idConfigs = SELECTED.filter((c) => !c.includes("strict"));
  const canliiNames = new Map(idConfigs.map((config) => [config, new Map<string, number>()]));
  const idRows: { title: string; dataset: string; year: number }[] = [];
  for (const row of canliiRows) {
    const m = idPattern.exec(row.caseId), dataset = databaseDataset.get(row.databaseId);
    if (!m || !dataset || !row.title?.trim()) continue;
    for (const config of idConfigs) {
      const key = `${dataset}|${m[1]}|${normaliseName(row.title.trim(), RULES[config.split("/")[0]])}`;
      canliiNames.get(config)!.set(key, (canliiNames.get(config)!.get(key) ?? 0) + 1);
    }
    if (m[2] === "canlii" && inCoverage(dataset, +m[1])) idRows.push({ title: row.title.trim(), dataset, year: +m[1] });
  }
  for (const r of idRows) for (const config of idConfigs) {
    const o = run(config, { style: r.title, dataset: r.dataset, year: r.year, yearKind: "decision" });
    const x = ((canliiIdCoverage[config] ??= {})[r.dataset] ??= { n: 0, unique: 0, zero: 0, multi: 0, uniqueCanLIINamesake: 0 });
    x.n++; x[o.status === "match" ? "unique" : o.status]++;
    if (o.status === "match" && (canliiNames.get(config)!.get(
      `${r.dataset}|${r.year}|${normaliseName(r.title, RULES[config.split("/")[0]])}`) ?? 0) > 1) x.uniqueCanLIINamesake++;
  }
  // Every ALR trial the selected configurations do not resolve correctly, with its outcome.
  const alrAbstains = Object.fromEntries(SELECTED.map((config) => [config,
    [...sets["alr-published"], ...sets["alr-corrected"]].map((t) => ({ t, o: run(config, t) }))
      .filter(({ t, o }) => !(o.status === "match" && o.ids[0] === t.truth))
      .map(({ t, o }) => ({ style: t.style, cite: t.cite, dataset: t.dataset, year: t.year, outcome: o.status,
        record: describe(t.truth!) }))]));

  // ------------------------------------------------------------ the motivating citations, against local data and recordings
  // They come from a private document, so they and their live answers stay in the ignored
  // results/recordings/ (cases.json: [{ text, expected, fetch?, search? }]); without it this is skipped.
  const recordings = path.join(HERE, "results", "recordings");
  const recorded = (file: string) => JSON.parse(readFileSync(path.join(recordings, file), "utf8"));
  const motivating = (existsSync(path.join(recordings, "cases.json")) ? recorded("cases.json") as
    Array<{ text: string; expected: string; fetch?: string; search?: string }> : []).map((m) => {
    const c = extract(m.text).citations[0];
    const t = { style: c.style!.text, dataset: datasetOf(c.court?.id)!, year: c.fields!.yearNumber!, yearKind: yearKind(c) };
    const outcomes = Object.fromEntries(SELECTED.map((config) => {
      const o = run(config, t);
      return [config, o.status === "match" ? `match: ${cases.get(o.ids[0])!.citations[0]}` : `${o.status} (${o.ids.length})`];
    }));
    const live = m.search ? (() => {
      const rows = recorded(m.search).results as Record<string, string>[];
      return {
        fetchByCanLIICitation: JSON.stringify(recorded(m.fetch!)),
        liveNameSearchRows: rows.map((r) => `${r.name_en} | ${r.citation_en} | ${r.document_date_en.slice(0, 10)}`),
        everyLiveRowEqualsLocalRecord: rows.every((r) => {
          const ids = keyIndex.get(native.citationLookupKey(r.citation_en));
          const local = ids?.size === 1 ? cases.get([...ids][0])! : null;
          return !!local && local.names.includes(r.name_en) && local.date?.slice(0, 10) === r.document_date_en.slice(0, 10);
        }),
      };
    })() : undefined;
    return { citation: m.text, expected: m.expected, query: t, outcomes, live };
  });

  const summary = {
    generatedBy: "experiments/a2aj-style-of-cause-match/eval.ts", a2ajCases: cases.size,
    yearRules: Object.fromEntries(Object.entries(YEAR_RULES).map(([k, v]) => [k, v.name])),
    courtMapFromA2AJ: Object.fromEntries(datasetOf.map),
    alrStats: { published: alrPublished.stats, corrected: alrCorrected.stats },
    canlii: { rows: canliiRows.length, neutralInA2AJCoverage: neutralRows.length, present: canliiPresent.length, absent: canliiAbsent.length },
    motivating, grid, byDataset, absentTarget, canliiIdCoverage, alrNoDirectKey, alrAbstains, byFormat,
    seconds: Math.round((Date.now() - started) / 1000),
  };
  writeFileSync(path.join(HERE, "results", "summary.json"), JSON.stringify(summary, null, 1));
  writeFileSync(path.join(HERE, "results", "wrong-matches.json"), JSON.stringify(wrongs, null, 1));
  writeFileSync(path.join(HERE, "results", "canlii-absent-accepts.json"), JSON.stringify(absentAccepts, null, 1));
  // console: the compact view
  const row = (set: string, config: string) => { const s = grid[set][config];
    return `${set.padEnd(27)} ${config.padEnd(27)} n=${String(s.n).padStart(6)} P=${s.precision} R=${s.recall} zero=${s.abstainZero} multi=${s.abstainMulti} wrong=${s.wrong}`; };
  for (const set of Object.keys(sets)) for (const config of SELECTED) console.log(row(set, config));
  for (const config of SELECTED) console.log("absent", config, JSON.stringify(absentTarget[config]));
  console.log(JSON.stringify(motivating.map((m) => [m.citation, m.outcomes]), null, 1));
  console.log("seconds", summary.seconds);
})();

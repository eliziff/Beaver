import { useEffect, useState, type FormEvent } from "react";
import { ChevronRight, Plus, X } from "lucide-react";
import { Modal } from "../modals/Modal";
import { usePagedChains } from "@/app/hooks/usePagedChains";
import { getResearchItems } from "@/app/lib/api/researchFiles";
import { researchLabelPath, type ResearchLabel, type ResearchPageItem, type ResearchQueryInput, type ResearchQueryCoverage, type ResearchSelection, type ResearchSource } from "@/app/lib/researchFiles";
import { errorMessage } from "@/app/lib/utils";
import { ChoiceMenu } from "./ResearchControls";
import { useSourcesWorkspace } from "./SourcesWorkspace";
const RECIPE = "beaver.research.recipe.v1";
const UNCLASSIFIED = "Unclassified", PAGE_SIZE = 50;
type Rule = NonNullable<ResearchQueryInput["rules"]>[number];
const queryText = (input: Record<string, unknown>) => Array.isArray(input.rules)
  ? input.rules.map((rule) => String((rule as { phrase?: unknown }).phrase ?? "")).filter(Boolean).join("; ")
  : String(input.pattern ?? input.query ?? "Search");
const queryRules = (input: Record<string, unknown>) => Array.isArray(input.rules) ? input.rules as Rule[] : [];
const queryConflict = (input: Record<string, unknown>): NonNullable<ResearchQueryInput["conflict"]> =>
  ["prompt", "first", "longer", "shorter", "append"].includes(String(input.conflict))
    ? input.conflict as NonNullable<ResearchQueryInput["conflict"]> : "first";
const receiptLabel = (labels: Record<string, ResearchLabel>, id: string,
  paths: Record<string, string> = {}) => paths[id] ??
  (researchLabelPath(labels, id).map(({ name }) => name).join(" / ") || id);
const slotSummary = (slots: Record<string, string[]>, labels: Record<string, ResearchLabel>,
  paths: Record<string, string> = {}) => {
  const counts = new Map<string, number>();
  Object.values(slots).forEach((ids) => ids.forEach((id) => { const name = receiptLabel(labels, id, paths);
    counts.set(name, (counts.get(name) ?? 0) + 1); }));
  return [...counts].map(([name, count]) => `${name}${count > 1 ? ` × ${count}` : ""}`).join(", ");
};
const readRecipe = (id?: string) => { try { const value = JSON.parse(localStorage.getItem(`${RECIPE}:${id ?? "empty"}`) ?? "null");
  const valid = Array.isArray(value?.rules) && value.rules.every((rule: Rule) => rule && typeof rule.phrase === "string" &&
    typeof rule.slot === "string" && ["before", "after"].includes(rule.direction) && ["sentence", "line", "paragraph", "chars"].includes(rule.unit));
  return valid ? { rules: value.rules as Rule[], conflict: queryConflict(value) }
    : { rules: [] as Rule[], conflict: "first" as const };
  } catch { return { rules: [] as Rule[], conflict: "first" as const }; } };

const sourceName = (source: ResearchSource) => source.reference.title || source.reference.citation || source.reference.id;
export function ResearchSearchPanel({ active, target, setTarget, selections, matches, onMatches, onStatus: setStatus }: {
  active: boolean; target: "sources" | "passages"; setTarget: (target: "sources" | "passages") => void;
  selections: Record<"sources" | "passages", ResearchSelection>;
  matches: { evidence: Set<string>; sources: Set<string> } | null;
  onMatches: (evidenceIds: string[], sourceIds: string[]) => void; onStatus: (message: string) => void;
}) {
  const { file, mutations: commit } = useSourcesWorkspace(), labels = file?.state.labels ?? {};
  const [recipe, setRecipe] = useState(() => readRecipe(file?.document.id));
  const [plain, setPlain] = useState(""), [syntax, setSyntax] = useState<"literal" | "terms">("literal"),
    [historyOpen, setHistoryOpen] = useState(false),
    [openQueries, setOpenQueries] = useState<Set<string>>(() => new Set());
  const [ruleEditor, setRuleEditor] = useState<number | null>(null);
  const [searchResult, setSearchResult] = useState<{ input: ResearchQueryInput; coverage: ResearchQueryCoverage } | null>(null);
  const [busy, setBusy] = useState(false);
  const toggleQuery = (id: string) => setOpenQueries((values) => { const next = new Set(values);
    if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const queryPages = usePagedChains<ResearchPageItem>((_key, cursor, signal) => getResearchItems(file!.document.id,
    { kind: "queries", cursor, limit: PAGE_SIZE }, signal), [file?.document.id],
    "queries", !!file && historyOpen && active, { queries: file?.state.queries?.sha256 ?? "" });
  const queryCount = file?.state.queries?.count ?? 0;
  useEffect(() => { localStorage.setItem(`${RECIPE}:${file?.document.id ?? "empty"}`, JSON.stringify(recipe)); }, [file?.document.id, recipe]);

  useEffect(() => { if (!matches) setSearchResult(null); }, [matches]);
  function showMatches(evidenceIds: string[], sourceIds: string[]) {
    setSearchResult(null);
    onMatches(evidenceIds, sourceIds);
  }
  async function query(input: ResearchQueryInput, continuing = false) {
    if (!file) return;
    const scope = selections[input.target ?? "sources"];
    if (!continuing && (scope.sourceIds?.length === 0 || scope.labelIds?.length === 0 && !scope.unlabelled))
      return setStatus(`No ${scope.target} selected`);
    setBusy(true); setStatus("");
    try { const request = continuing ? input : { ...input, ...scope };
      const result = await commit.query(request);
      const limited = result.receipt.failures.some(({ code }) => code.endsWith("_limit")), failed =
        new Set(result.receipt.failures.filter(({ code }) => !code.endsWith("_limit")).map(({ sourceId }) => sourceId)).size;
      showMatches([...new Set([...(continuing ? matches?.evidence ?? [] : []), ...result.receipt.evidenceIds])],
        [...new Set([...(continuing ? matches?.sources ?? [] : []), ...result.receipt.matchedSourceIds])]);
      setSearchResult(result.coverage ? { input: request, coverage: result.coverage } : null);
      setStatus([`${result.receipt.evidenceIds.length} matches`, limited && "limit reached",
        failed && `${failed} source failure${failed === 1 ? "" : "s"}`].filter(Boolean).join(" · ")); }
    catch (reason) { setStatus(errorMessage(reason, "Search failed")); }
    finally { setBusy(false); }
  }
  function runQuery() {
    const rules = recipe.rules.filter(({ phrase, slot }) => phrase.trim() && slot.trim())
      .map((rule) => ({ ...rule, phrase: rule.phrase.trim(), slot: labels[rule.slot]?.scope === "highlight" ? rule.slot : UNCLASSIFIED }));
    if (rules.length) void query({ syntax: "literal", target: "sources", rules, conflict: recipe.conflict });
    else setStatus("Add a capture rule first");
  }
  function runPlain(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (plain.trim()) void query({ text: plain.trim(), syntax, target });
  }
  const editRule = (patch: Partial<Rule>) => setRecipe((current) => ({ ...current,
    rules: current.rules.map((rule, index) => index === ruleEditor ? { ...rule, ...patch } : rule) }));
  const closeRule = () => { setRecipe((current) => ({ ...current,
    rules: current.rules.filter((rule, index) => index !== ruleEditor || !!rule.phrase.trim()) })); setRuleEditor(null); };
  const ruleText = (rule: Rule, paths: Record<string, string> = {}) => `${rule.phrase} → ${rule.direction} ${rule.unit}${rule.unit === "chars" ? ` (${rule.chars ?? 100})` : ""} → ${receiptLabel(labels, rule.slot, paths)}`;
  const queryChain = queryPages.chains.queries,
    historyQueries = queryChain?.items.flatMap((item) => item.kind === "query" ? [item.value] : []) ?? [];
  const searchPanel = () => file ? <>
    <form onSubmit={runPlain} className="mb-2 grid grid-cols-2 gap-1.5 border-b border-gray-200 pb-2">
      <input required autoComplete="off" value={plain} onChange={(event) => setPlain(event.target.value)} aria-label="Search saved source text"
        placeholder="Find in saved text" className="col-span-2 h-8 min-w-0 rounded-md border border-gray-300 px-2 text-sm" />
      <ChoiceMenu label="Search syntax" value={syntax} onChange={(value) => setSyntax(value as typeof syntax)}
        options={[{ value: "literal", label: "Exact" }, { value: "terms", label: "All terms" }]} />
      <ChoiceMenu label="Search target" value={target} onChange={(value) => setTarget(value as typeof target)}
        options={[{ value: "sources", label: "Source text" }, { value: "passages", label: "Saved passages" }]} />
      <button disabled={busy} className="col-span-2 h-8 rounded-md bg-gray-900 px-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-40">Find passages</button>
    </form>
    <details className="group/rules mb-2 rounded-md border border-gray-200">
      <summary className="flex h-8 cursor-pointer list-none items-center gap-1.5 bg-gray-50 px-2 text-xs font-medium text-gray-800">
        <ChevronRight className="size-3.5 group-open/rules:rotate-90" aria-hidden="true" />Capture rules
        {!!recipe.rules.length && <span className="ms-auto tabular-nums text-gray-500">{recipe.rules.length}</span>}
      </summary>
    <div className="p-2"><div className="mb-2 flex gap-1.5">
      <button type="button" onClick={() => { setRuleEditor(recipe.rules.length); setRecipe((current) => ({ ...current,
        rules: [...current.rules, { phrase: "", direction: "after", unit: "sentence", slot: UNCLASSIFIED }] })); }}
        className="inline-flex h-8 flex-1 items-center justify-center gap-1 whitespace-nowrap rounded-md border border-gray-300 bg-white px-1.5 text-[13px] font-medium text-gray-700 hover:bg-gray-50"><Plus className="size-3.5" />Add rule</button>
      <button type="button" disabled={busy || !recipe.rules.length} onClick={runQuery}
        className="h-8 flex-1 whitespace-nowrap rounded-md bg-brand px-1.5 text-[13px] font-medium text-white hover:bg-brand-dark disabled:opacity-40">Run rules</button>
    </div>
    <div className="space-y-1">{recipe.rules.map((rule, index) => <div key={index}
      className="flex min-h-8 items-center gap-1 rounded bg-gray-50 px-1.5 text-xs">
      <button type="button" onClick={() => setRuleEditor(index)}
        className="min-w-0 flex-1 truncate text-left hover:underline">{ruleText(rule)}</button>
      <button type="button" onClick={() => setRecipe((current) => ({ ...current,
        rules: current.rules.filter((_, item) => item !== index) }))} aria-label={`Remove rule ${index + 1}`}
        className="grid size-6 place-items-center rounded text-gray-400 hover:bg-gray-200 hover:text-red-700"><X className="size-3" /></button>
    </div>)}</div>
    {!!recipe.rules.length && <label className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 text-xs text-gray-600">When rules overlap
      <ChoiceMenu label="Conflict policy" value={recipe.conflict} onChange={(value) => setRecipe((current) => ({ ...current, conflict: value as typeof current.conflict }))}
        options={[{ value: "prompt", label: "Keep for review" }, { value: "first", label: "First rule wins" }, { value: "longer", label: "Longer passage" }, { value: "shorter", label: "Shorter passage" }, { value: "append", label: "Keep both" }]} />
    </label>}
    </div></details>
    {!!queryCount && <details open={historyOpen}
      className="group/history mt-2 overflow-hidden rounded-md border border-gray-200 text-xs text-gray-600">
      <summary onClick={(event) => { event.preventDefault(); setHistoryOpen((open) => !open); }} className="flex h-8 cursor-pointer list-none items-center gap-1.5 bg-gray-50 px-2 font-medium text-gray-800">
        <ChevronRight className="size-3.5 group-open/history:rotate-90" aria-hidden="true" />Search history
        <span className="ms-auto tabular-nums text-gray-500">{queryCount}</span>
      </summary>{historyOpen && <div className="space-y-1.5 border-t border-gray-200 p-2">
      <ol className="space-y-1">{historyQueries
        .map((item) => { const openQuery = openQueries.has(item.query_id), saved = openQuery ? queryRules(item.input) : [],
          scopeLabels = openQuery && Array.isArray(item.input.label_ids)
            ? item.input.label_ids.map((id) => receiptLabel(labels, String(id), item.labelPaths)) : [],
          failures = new Map(item.failures.map((value) => [value.sourceId, value.code])),
          searched = openQuery ? item.sourceIds.map((id) => { const source = file.state.sources[id],
            reference = source?.reference ?? item.sourceReferences?.[id], failure = failures.get(id);
            return `${source ? sourceName(source) : reference?.title || reference?.citation || reference?.id || id}${failure ? ` · ${failure}` : ""}`; }).join("\n") : "",
          audit = openQuery ? item.sourceIds.map((id) => {
            const hashes = item.sourceFingerprints?.[id], failure = failures.get(id);
            return `[${id}]${hashes?.length ? ` · ${hashes.join(", ")}` : ""}${failure ? ` · ${failure}` : ""}`; }).join("\n") : "";
          return <li key={item.query_id}>
        <details open={openQuery} className="group/query rounded-md border border-gray-200 bg-white"><summary
          onClick={(event) => { event.preventDefault(); toggleQuery(item.query_id); }} className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1.5">
          <ChevronRight className="size-3 group-open/query:rotate-90" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate font-medium text-gray-800">{queryText(item.input)}</span>
          <span className="shrink-0 tabular-nums text-gray-500">{item.evidenceIds.length} matches</span></summary>
          {openQuery && <div className="space-y-1 border-t border-gray-100 px-2 py-1.5 leading-4">
          <p>{saved.length ? saved.map((rule) => ruleText(rule, item.labelPaths)).join("; ") : `${String(item.input.syntax ?? "literal")} · ${String(item.input.target ?? "sources")}`}</p>
          <p className="text-gray-500">{new Date(item.executed_at).toLocaleString()} · {item.model || "human"} · {item.sourceIds.length} sources · {item.failures.length} failures</p>
          {!!scopeLabels.length && <p>Scope: {scopeLabels.join(", ")}</p>}
          {searched && <p aria-label="Sources searched" className="whitespace-pre-wrap">{searched}</p>}
          {!!Object.keys(item.slots).length && <p>Slots: {slotSummary(item.slots, labels, item.labelPaths)}</p>}
          {audit && <details className="rounded bg-gray-50"><summary className="cursor-pointer px-1.5 py-1 font-medium">Technical details</summary>
            <pre aria-label="Search fingerprints" className="max-h-28 overflow-y-auto whitespace-pre-wrap break-all px-1.5 pb-1.5 text-xs">{audit}</pre>
          </details>}
          {(!!saved.length || !!item.evidenceIds.length) && <div className="mt-1 flex flex-wrap gap-1">
            {!!saved.length && <button type="button" onClick={() => setRecipe({ rules: saved, conflict: queryConflict(item.input) })}
              className="rounded border px-2 py-1 font-medium text-gray-700 hover:bg-gray-50">Use these rules</button>}
            {!!item.evidenceIds.length && <button type="button" onClick={() => showMatches(item.evidenceIds, item.matchedSourceIds)}
              className="rounded border px-2 py-1 font-medium text-gray-700 hover:bg-gray-50">View matches</button>}
          </div>}
          </div>}</details></li>; })}</ol>
      {queryChain?.loading && !queryChain.items.length && <p role="status">Loading search history…</p>}
      {!!queryChain?.error && <button type="button" onClick={() => void queryPages.fetchPage("queries", null, false)}
        className="w-full rounded py-1 text-sm font-medium text-red-700">Retry search history</button>}
      {queryChain?.nextCursor && <button type="button" disabled={queryChain.loading}
        onClick={() => void queryPages.fetchPage("queries", queryChain.nextCursor, true)}
        className="w-full rounded py-1 font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-40">Load earlier searches</button>}
      </div>}</details>}
  </> : <p className="p-2 text-xs text-gray-500">Open or create a workspace to search saved sources.</p>;

  return <>{searchPanel()}          {searchResult && <div className="mb-3 space-y-2 text-sm text-gray-600">
            <p>{searchResult.coverage.complete ? "Search complete" : "Partial search"} · {searchResult.coverage.attempted_sources} of {searchResult.coverage.selected_sources} sources searched</p>
            {searchResult.coverage.next_after && <button type="button" disabled={busy}
              onClick={() => void query({ ...searchResult.input, after: searchResult.coverage.next_after! }, true)}
              className="h-9 rounded-md border border-gray-300 bg-white px-3 font-medium hover:bg-gray-50 disabled:opacity-40">{busy ? "Searching…" : "Continue search"}</button>}
          </div>}

    <Modal open={ruleEditor !== null} onClose={closeRule} size="sm" className="!h-fit max-h-[calc(100dvh-2rem)] [&_.modal-scroll-body]:flex-none"
      breadcrumbs={["Search Saved sources", "Capture rule"]}
      cancelAction={{ label: "Done", onClick: closeRule }}
      primaryAction={{ label: "Run rules", onClick: () => { closeRule(); runQuery(); }, disabled: busy }}>
      {ruleEditor !== null && recipe.rules[ruleEditor] && <div className="grid grid-cols-2 gap-3 pb-5 text-[13px]">
        <label className="col-span-2 grid gap-1 text-gray-600">Phrase to find
          <input autoFocus autoComplete="off" value={recipe.rules[ruleEditor].phrase} onChange={(event) => editRule({ phrase: event.target.value })}
            className="h-9 rounded border border-gray-300 px-2 text-sm text-gray-900" />
        </label>
        <label className="grid gap-1 text-gray-600">Direction
          <ChoiceMenu label="Direction" value={recipe.rules[ruleEditor].direction} onChange={(direction) => editRule({ direction: direction as Rule["direction"] })}
            options={[{ value: "after", label: "After phrase" }, { value: "before", label: "Before phrase" }]} />
        </label>
        <label className="grid gap-1 text-gray-600">Unit
          <ChoiceMenu label="Unit" value={recipe.rules[ruleEditor].unit} onChange={(unit) => editRule({ unit: unit as Rule["unit"] })}
            options={[{ value: "sentence", label: "Sentence" }, { value: "line", label: "Line" }, { value: "paragraph", label: "Paragraph" }, { value: "chars", label: "Characters" }]} />
        </label>
        <label className="grid gap-1 text-gray-600">Save as highlight
          <ChoiceMenu label="Save as highlight" value={recipe.rules[ruleEditor].slot} onChange={(slot) => editRule({ slot })}
            options={[{ value: UNCLASSIFIED, label: "Unclassified" },
              ...Object.values(labels).filter(({ scope }) => scope === "highlight").sort((a, b) => a.order - b.order)
                .map((label) => ({ value: label.id, label: label.name }))]} />
        </label>
        {recipe.rules[ruleEditor].unit === "chars" && <label className="grid gap-1 text-gray-600">Characters
          <input type="number" min="10" max="50000" value={recipe.rules[ruleEditor].chars ?? 100}
            onChange={(event) => editRule({ chars: Number(event.target.value) })} className="h-9 rounded border px-2 text-sm text-gray-900" />
        </label>}
      </div>}
    </Modal>

  </>;
}

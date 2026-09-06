import { useEffect, useState, type FormEvent } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { ActionMenu } from "../ui/action-menu";
import { Button } from "../ui/button";
import { usePagedChains } from "@/app/hooks/usePagedChains";
import { getResearchItems } from "@/app/lib/api/researchFiles";
import { researchLabelPath, type ResearchLabel, type ResearchPageItem, type ResearchQueryInput, type ResearchQueryCoverage, type ResearchSelection } from "@/app/lib/researchFiles";
import { errorMessage } from "@/app/lib/utils";
import { sourceName } from "./useSourceReader";
import { useSourcesWorkspace } from "./SourcesWorkspace";

const UNCLASSIFIED = "Unclassified", PAGE_SIZE = 50;
type Rule = NonNullable<ResearchQueryInput["rules"]>[number];
type Extent = "match" | `${Rule["direction"]}:${"sentence" | "paragraph"}`;
/** How much text each match carries; anything beyond the match reuses the capture-rule machinery. */
const EXTENTS: readonly { value: Extent; label: string }[] = [
  { value: "match", label: "Match" },
  { value: "around:sentence", label: "Sentence" }, { value: "around:paragraph", label: "Paragraph" },
  { value: "after:sentence", label: "Sentence after" }, { value: "before:sentence", label: "Sentence before" },
  { value: "after:paragraph", label: "Paragraph after" }, { value: "before:paragraph", label: "Paragraph before" },
];
const queryText = (input: Record<string, unknown>) => Array.isArray(input.rules)
  ? input.rules.map((rule) => String((rule as { phrase?: unknown }).phrase ?? "")).filter(Boolean).join("; ")
  : String(input.pattern ?? input.query ?? "Search");
const queryRules = (input: Record<string, unknown>) => Array.isArray(input.rules) ? input.rules as Rule[] : [];
const receiptLabel = (labels: Record<string, ResearchLabel>, id: string, paths: Record<string, string> = {}) => paths[id] ??
  (researchLabelPath(labels, id).map(({ name }) => name).join(" / ") || id);
const slotSummary = (slots: Record<string, string[]>, labels: Record<string, ResearchLabel>, paths: Record<string, string> = {}) => {
  const counts = new Map<string, number>();
  Object.values(slots).forEach((ids) => ids.forEach((id) => { const name = receiptLabel(labels, id, paths);
    counts.set(name, (counts.get(name) ?? 0) + 1); }));
  return [...counts].map(([name, count]) => `${name}${count > 1 ? ` × ${count}` : ""}`).join(", ");
};
const ruleText = (labels: Record<string, ResearchLabel>, rule: Rule, paths?: Record<string, string>) =>
  `${rule.phrase} → ${rule.direction} ${rule.unit}${rule.unit === "chars" ? ` (${rule.chars ?? 100})` : ""} → ${receiptLabel(labels, rule.slot, paths)}`;

function ChoiceMenu<T extends string>({ label, value, options, onChange, disabled }: { label: string; value: T;
  options: readonly { value: T; label: string }[]; onChange: (value: T) => void; disabled?: boolean }) {
  return <ActionMenu label={label} className="min-w-0" items={options.map((option) => ({
    label: option.label, checked: option.value === value, onSelect: () => onChange(option.value) }))}
    triggerClassName={`h-8 w-full min-w-0 items-center justify-between gap-1 rounded-md border border-gray-300 bg-white px-2 text-sm text-gray-800 hover:border-gray-500 ${disabled ? "pointer-events-none opacity-40" : ""}`}>
    <span className="truncate">{options.find((option) => option.value === value)?.label}</span><ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
  </ActionMenu>;
}

export function ResearchSearchPanel({ active, selection, matches, onMatches, onStatus: setStatus }: {
  active: boolean; selection: ResearchSelection;
  matches: { evidence: Set<string>; sources: Set<string> } | null;
  onMatches: (evidenceIds: string[], sourceIds: string[]) => void; onStatus: (message: string) => void;
}) {
  const { file, mutations: commit } = useSourcesWorkspace(), labels = file?.state.labels ?? {};
  const [text, setText] = useState(""), [syntax, setSyntax] = useState<"literal" | "terms">("literal"),
    [extent, setExtent] = useState<Extent>("match"), [historyOpen, setHistoryOpen] = useState(false),
    [openQueries, setOpenQueries] = useState<Set<string>>(() => new Set());
  const [searchResult, setSearchResult] = useState<{ input: ResearchQueryInput; coverage: ResearchQueryCoverage } | null>(null);
  const [busy, setBusy] = useState(false);
  const extentAllowed = syntax === "literal";
  const toggleQuery = (id: string) => setOpenQueries((values) => { const next = new Set(values);
    if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const queryPages = usePagedChains<ResearchPageItem>((_key, cursor, signal) => getResearchItems(file!.document.id,
    { kind: "queries", cursor, limit: PAGE_SIZE }, signal), [file?.document.id],
    "queries", !!file && historyOpen && active, { queries: file?.state.queries?.sha256 ?? "" });
  const queryCount = file?.state.queries?.count ?? 0;
  useEffect(() => { if (!matches) setSearchResult(null); }, [matches]);
  async function query(input: ResearchQueryInput, continuing = false) {
    if (!file) return;
    if (!continuing && selection.sourceIds?.length === 0) return setStatus("No sources selected");
    setBusy(true); setStatus("");
    try { const request = continuing ? input : { ...input, ...selection };
      const result = await commit.query(request);
      const limited = result.receipt.failures.some(({ code }) => code.endsWith("_limit")), failed =
        new Set(result.receipt.failures.filter(({ code }) => !code.endsWith("_limit")).map(({ sourceId }) => sourceId)).size;
      onMatches([...new Set([...(continuing ? matches?.evidence ?? [] : []), ...result.receipt.evidenceIds])],
        [...new Set([...(continuing ? matches?.sources ?? [] : []), ...result.receipt.matchedSourceIds])]);
      setSearchResult(result.coverage ? { input: request, coverage: result.coverage } : null);
      setStatus([`${result.receipt.evidenceIds.length} matches`, limited && "limit reached",
        failed && `${failed} source failure${failed === 1 ? "" : "s"}`].filter(Boolean).join(" · ")); }
    catch (reason) { setStatus(errorMessage(reason, "Search failed")); }
    finally { setBusy(false); }
  }
  function find(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const phrase = text.trim(); if (!phrase) return;
    const [direction, unit] = extent.split(":") as [Rule["direction"], Rule["unit"]];
    void query(extentAllowed && extent !== "match"
      ? { syntax: "literal", target: "sources", rules: [{ phrase, direction, unit, slot: UNCLASSIFIED }], conflict: "append" }
      : { text: phrase, syntax, target: "sources" });
  }
  const rerun = (input: Record<string, unknown>) => { const rules = queryRules(input);
    void query(rules.length ? { syntax: "literal", target: "sources", rules, conflict: "append" }
      : { text: queryText(input), syntax: input.syntax === "terms" ? "terms" : "literal", target: "sources" }); };
  const queryChain = queryPages.chains.queries, history = queryChain?.items.flatMap((item) => item.kind === "query" ? [item.value] : []) ?? [];
  if (!file) return <p className="p-2 text-xs text-gray-500">Open or create a workspace to search saved sources.</p>;
  return <>
    <form onSubmit={find} className="mb-2 grid grid-cols-2 gap-1.5 border-b border-gray-200 pb-2">
      <input required autoComplete="off" value={text} onChange={(event) => setText(event.target.value)} aria-label="Search saved source text"
        placeholder="Find in saved text" className="col-span-2 h-8 min-w-0 rounded-md border border-gray-300 px-2 text-sm" />
      <ChoiceMenu label="Search syntax" value={syntax} onChange={setSyntax}
        options={[{ value: "literal", label: "Exact" }, { value: "terms", label: "All terms" }]} />
      <ChoiceMenu label="Passage extent" value={extentAllowed ? extent : "match"} disabled={!extentAllowed} onChange={setExtent} options={EXTENTS} />
      <Button type="submit" size="compact" disabled={busy} className="col-span-2">Find passages</Button>
    </form>
    {searchResult && <div className="mb-2 flex flex-wrap items-center gap-2 text-sm text-gray-600">
      <p>{searchResult.coverage.complete ? "Search complete" : "Partial search"} · {searchResult.coverage.attempted_sources} of {searchResult.coverage.selected_sources} sources searched</p>
      {searchResult.coverage.next_after && <Button variant="outline" size="compact" disabled={busy}
        onClick={() => void query({ ...searchResult.input, after: searchResult.coverage.next_after! }, true)}>{busy ? "Searching…" : "Continue search"}</Button>}
    </div>}
    {!!queryCount && <details open={historyOpen} className="group/history mb-2 overflow-hidden rounded-md border border-gray-200 text-xs text-gray-600">
      <summary onClick={(event) => { event.preventDefault(); setHistoryOpen((open) => !open); }} className="flex h-8 cursor-pointer list-none items-center gap-1.5 bg-gray-50 px-2 font-medium text-gray-800">
        <ChevronRight className="size-3.5 group-open/history:rotate-90" aria-hidden="true" />Searches
        <span className="ms-auto tabular-nums text-gray-500">{queryCount}</span>
      </summary>{historyOpen && <div className="space-y-1.5 border-t border-gray-200 p-2">
      <ol className="space-y-1">{history.map((item) => { const openQuery = openQueries.has(item.query_id), saved = openQuery ? queryRules(item.input) : [],
          scopeLabels = openQuery && Array.isArray(item.input.label_ids)
            ? item.input.label_ids.map((id) => receiptLabel(labels, String(id), item.labelPaths)) : [],
          failures = new Map(item.failures.map((value) => [value.sourceId, value.code])),
          searched = openQuery ? item.sourceIds.map((id) => { const source = file.state.sources[id],
            reference = source?.reference ?? item.sourceReferences?.[id], failure = failures.get(id);
            return `${source ? sourceName(source) : reference?.title || reference?.citation || reference?.id || id}${failure ? ` · ${failure}` : ""}`; }).join("\n") : "",
          audit = openQuery ? item.sourceIds.map((id) => { const hashes = item.sourceFingerprints?.[id], failure = failures.get(id);
            return `[${id}]${hashes?.length ? ` · ${hashes.join(", ")}` : ""}${failure ? ` · ${failure}` : ""}`; }).join("\n") : "";
        return <li key={item.query_id}>
        <details open={openQuery} className="group/query rounded-md border border-gray-200 bg-white"><summary
          onClick={(event) => { event.preventDefault(); toggleQuery(item.query_id); }} className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1.5">
          <ChevronRight className="size-3 group-open/query:rotate-90" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate font-medium text-gray-800">{queryText(item.input)}</span>
          <span className="shrink-0 tabular-nums text-gray-500">{item.evidenceIds.length} matches</span></summary>
          {openQuery && <div className="space-y-1 border-t border-gray-100 px-2 py-1.5 leading-4">
          <p>{saved.length ? saved.map((rule) => ruleText(labels, rule, item.labelPaths)).join("; ") : `${String(item.input.syntax ?? "literal")} · ${String(item.input.target ?? "sources")}`}</p>
          <p className="text-gray-500">{new Date(item.executed_at).toLocaleString()} · {item.model || "human"} · {item.sourceIds.length} sources · {item.failures.length} failures</p>
          {!!scopeLabels.length && <p>Scope: {scopeLabels.join(", ")}</p>}
          {searched && <p aria-label="Sources searched" className="whitespace-pre-wrap">{searched}</p>}
          {!!Object.keys(item.slots).length && <p>Slots: {slotSummary(item.slots, labels, item.labelPaths)}</p>}
          {audit && <details className="rounded bg-gray-50"><summary className="cursor-pointer px-1.5 py-1 font-medium">Technical details</summary>
            <pre aria-label="Search fingerprints" className="max-h-28 overflow-y-auto whitespace-pre-wrap break-all px-1.5 pb-1.5 text-xs">{audit}</pre>
          </details>}
          <div className="mt-1 flex flex-wrap gap-1">
            <Button variant="outline" size="compact" disabled={busy} onClick={() => rerun(item.input)}>Run again</Button>
            {!!item.evidenceIds.length && <Button variant="outline" size="compact" onClick={() => { setSearchResult(null); onMatches(item.evidenceIds, item.matchedSourceIds); }}>View matches</Button>}
          </div>
          </div>}</details></li>; })}</ol>
      {queryChain?.loading && !queryChain.items.length && <p role="status">Loading searches…</p>}
      {!!queryChain?.error && <button type="button" onClick={() => void queryPages.fetchPage("queries", null, false)}
        className="w-full rounded py-1 text-sm font-medium text-red-700">Retry searches</button>}
      {queryChain?.nextCursor && <button type="button" disabled={queryChain.loading}
        onClick={() => void queryPages.fetchPage("queries", queryChain.nextCursor, true)}
        className="w-full rounded py-1 font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-40">Load earlier searches</button>}
      </div>}</details>}
  </>;
}

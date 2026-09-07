import { useEffect, useState, type FormEvent } from "react";
import { BookOpen, ChevronRight } from "lucide-react";
import { Button } from "../ui/button";
import { usePagedChains } from "@/app/hooks/usePagedChains";
import { getResearchItems } from "@/app/lib/api/researchFiles";
import { researchLabelPath, type ResearchLabel, type ResearchPageItem, type ResearchQueryInput,
  type ResearchQueryReceipt, type ResearchSelection } from "@/app/lib/researchFiles";
import { errorMessage } from "@/app/lib/utils";
import { passageLabel, trimPassageMarker } from "@/app/lib/researchPassage";
import { ResearchLabelFolder } from "./ResearchLabelMarker";
import { ResearchLabelWaterfall } from "./ResearchLabelPicker";
import { sourceName, type SourceReader } from "./useSourceReader";
import { useSourcesWorkspace } from "./SourcesWorkspace";

const PAGE_SIZE = 50;
type Rule = NonNullable<ResearchQueryInput["rules"]>[number];
const UNITS: readonly { value: Rule["unit"] | "match"; label: string }[] = [{ value: "match", label: "the match" },
  { value: "sentence", label: "its sentence" }, { value: "paragraph", label: "its paragraph" }];
const DIRECTIONS: readonly { value: Rule["direction"]; label: string }[] = [{ value: "around", label: "around" },
  { value: "after", label: "after" }, { value: "before", label: "before" }];
const queryPhrase = (input: Record<string, unknown>) => Array.isArray(input.rules)
  ? input.rules.map((rule) => String((rule as { phrase?: unknown }).phrase ?? "")).filter(Boolean).join("; ")
  : String(input.text ?? input.pattern ?? input.query ?? "Search");
const CHOICE = "h-7 rounded-md border border-gray-200 px-2 text-xs text-gray-700 aria-pressed:border-gray-500 aria-pressed:bg-gray-100 aria-pressed:font-medium";

const WINDOW = 90;
/** A match is read around its phrase, not as a whole paragraph: window it, then mark it. */
function marked(text: string, phrase: string) {
  const at = phrase ? text.toLowerCase().indexOf(phrase.toLowerCase()) : -1;
  if (at < 0) return text.length > WINDOW * 2 ? `${text.slice(0, WINDOW * 2).trimEnd()}…` : text;
  const from = Math.max(0, at - WINDOW), to = Math.min(text.length, at + phrase.length + WINDOW);
  return <>{from ? "…" : ""}{text.slice(from, at)}
    <mark className="rounded-sm bg-amber-100 text-gray-900">{text.slice(at, at + phrase.length)}</mark>
    {text.slice(at + phrase.length, to)}{to < text.length ? "…" : ""}</>;
}

/** Choosing a label, a highlight type or a search scope is always the same waterfall, in a plain panel. */
function LabelChoice({ title, labels, scope, selectedId, onChoose, onClose, noneLabel }: {
  title: string; labels: Record<string, ResearchLabel>; scope: ResearchLabel["scope"];
  selectedId: string | null; onChoose: (id: string | null) => void; onClose: () => void; noneLabel?: string }) {
  return <div role="group" aria-label={title} className="grid min-w-0 gap-1.5 rounded-lg border border-gray-200 bg-gray-50 p-2">
    <p className="text-xs font-medium text-gray-700">{title}</p>
    <ResearchLabelWaterfall labels={labels} scope={scope} selectedId={selectedId} noneLabel={noneLabel}
      onChoose={(id) => { onChoose(id); onClose(); }} />
  </div>;
}

export function ResearchSearchPanel({ active, selection, reader, onStatus: setStatus }: {
  active: boolean; selection: ResearchSelection; reader?: SourceReader; onStatus: (message: string) => void;
}) {
  const { file, mutations: commit, evidence, highlight } = useSourcesWorkspace();
  const labels = file?.state.labels ?? {};
  const [phrase, setPhrase] = useState(""), [direction, setDirection] = useState<Rule["direction"]>("around"),
    [unit, setUnit] = useState<Rule["unit"] | "match">("match");
  const [busy, setBusy] = useState(false), [historyOpen, setHistoryOpen] = useState(false);
  const [result, setResult] = useState<{ phrase: string; matches: Set<string>; sourceIds: string[] } | null>(null);
  const [more, setMore] = useState<{ input: ResearchQueryInput; phrase: string } | null>(null);
  /** Which slice of the saved research this search reads, and what a result can be filed into. */
  const [scopeId, setScopeId] = useState<string | null>(null);
  const [choosing, setChoosing] = useState<{ kind: "scope" } | { kind: "file"; sourceId: string }
    | { kind: "highlight"; sourceId: string; evidenceIds: string[] } | null>(null);
  const scopeLabel = scopeId && labels[scopeId] ? labels[scopeId] : null;
  const pen = (labels[highlight.pen ?? ""]?.scope === "highlight" ? labels[highlight.pen!] : undefined)
    ?? Object.values(labels).filter((label) => label.scope === "highlight").sort((a, b) => a.order - b.order)[0];
  const penName = pen ? researchLabelPath(labels, pen.id).map(({ name }) => name).join(" / ") : "Highlight";
  const queryPages = usePagedChains<ResearchPageItem>((_key, cursor, signal) => getResearchItems(file!.document.id,
    { kind: "queries", cursor, limit: PAGE_SIZE }, signal), [file?.document.id],
    "queries", !!file && historyOpen && active, { queries: file?.state.queries?.sha256 ?? "" });
  const history = queryPages.chains.queries?.items.flatMap((item) => item.kind === "query" ? [item.value] : []) ?? [];
  /** A match can sit on any page of a source's evidence; keep paging until it is on screen. */
  useEffect(() => {
    for (const id of result?.sourceIds ?? []) {
      const page = evidence.chains[id];
      if (!page) void evidence.fetchPage(id, null, false);
      else if (!page.loading && !page.error && page.nextCursor && !page.items.some((item) =>
        (item.kind === "passage" || item.kind === "evidence") && result!.matches.has(item.value.receipt.evidence_id)))
        void evidence.fetchPage(id, page.nextCursor, true);
    }
  }, [result, evidence.chains, evidence.fetchPage]);

  /** The chosen label narrows the search itself: its sources, or — for a highlight type — its saved passages. */
  const scoped = (input: ResearchQueryInput): ResearchQueryInput => {
    const request = { ...input, ...selection };
    if (!scopeLabel) return request;
    return { ...request, target: scopeLabel.scope === "highlight" ? "passages" : "sources",
      labelIds: [...new Set([...(request.labelIds ?? []), scopeLabel.id])] };
  };
  async function run(input: ResearchQueryInput, text: string, continuing = false) {
    if (!file) return;
    if (!continuing && selection.sourceIds?.length === 0) return setStatus("No sources to search");
    setBusy(true); setStatus("");
    try {
      const request = continuing ? input : scoped(input);
      const { receipt, coverage } = await commit.query(request);
      setResult((current) => ({ phrase: text,
        matches: new Set([...(continuing ? current?.matches ?? [] : []), ...receipt.evidenceIds]),
        sourceIds: [...new Set([...(continuing ? current?.sourceIds ?? [] : []), ...receipt.matchedSourceIds])] }));
      setMore(coverage?.next_after ? { input: { ...request, after: coverage.next_after }, phrase: text } : null);
      if (!receipt.evidenceIds.length) setStatus("No matches");
    } catch (reason) { setStatus(errorMessage(reason, "Search failed")); }
    finally { setBusy(false); }
  }
  function find(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const text = phrase.trim(); if (!text) return;
    void run(unit === "match" ? { text, syntax: "literal", target: "sources" }
      : { syntax: "literal", target: "sources", rules: [{ phrase: text, direction, unit }], conflict: "append" }, text);
  }
  function rerun(receipt: ResearchQueryReceipt) {
    const rules = Array.isArray(receipt.input.rules) ? receipt.input.rules as Rule[] : [];
    const text = queryPhrase(receipt.input);
    setPhrase(text);
    void run(rules.length ? { syntax: "literal", target: "sources", rules, conflict: "append" }
      : { text, syntax: receipt.input.syntax === "terms" ? "terms" : "literal", target: "sources" }, text);
  }
  /** Marking matches and filing sources both persist the moment the label is chosen. */
  async function markPassages(sourceIds: string[], evidenceIds: string[], typeId?: string) {
    if (!file || !evidenceIds.length) return;
    setStatus("");
    try {
      let target = typeId ?? pen?.id;
      if (!target) { target = crypto.randomUUID();
        await commit.act({ type: "label", id: target, name: "Highlight", parentId: null, scope: "highlight", color: "#d6b85a" }); }
      if (target !== pen?.id) highlight.setPen(target);
      await commit.act({ type: "label-selection", target: "passages", sourceIds, evidenceIds, assign: [target], mode: "replace" });
      setStatus(`Saved ${evidenceIds.length} under ${labels[target] ? researchLabelPath(labels, target).map(({ name }) => name).join(" / ") : penName}`);
    } catch (reason) { setStatus(errorMessage(reason, "Could not save these matches")); }
  }
  async function fileSource(sourceId: string, labelId: string | null) {
    const source = file?.state.sources[sourceId]; if (!source || !labelId) return;
    setStatus("");
    try {
      await commit.act({ type: "annotate", kind: "source", id: sourceId,
        labelIds: [...new Set([...source.labelIds, labelId])] });
      setStatus(`Filed ${sourceName(source)} under ${researchLabelPath(labels, labelId).map(({ name }) => name).join(" / ")}`);
    } catch (reason) { setStatus(errorMessage(reason, "Could not file this source")); }
  }
  const rows = (sourceId: string) => (evidence.chains[sourceId]?.items ?? []).flatMap((item) =>
    (item.kind === "passage" || item.kind === "evidence") && result?.matches.has(item.value.receipt.evidence_id) ? [item.value] : []);
  const found = result?.sourceIds.filter((id) => file?.state.sources[id] && rows(id).length) ?? [];
  const pending = (result?.sourceIds.length ?? 0) - found.length;
  if (!file) return <p className="p-2 text-xs text-gray-500">Open a workspace to search its saved sources.</p>;
  return <div className="grid min-w-0 content-start gap-2">
    <form onSubmit={find} className="flex min-w-0 items-center gap-1.5">
      <input required autoComplete="off" value={phrase} onChange={(event) => setPhrase(event.target.value)}
        aria-label="Phrase to find in saved sources" placeholder="Find a phrase in saved sources"
        className="h-8 min-w-0 flex-1 rounded-md border border-gray-300 px-2 text-sm" />
      <Button type="submit" size="compact" disabled={busy}>{busy ? "Finding…" : "Find"}</Button>
    </form>
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-gray-600">
      <span className="text-gray-500">Search in</span>
      <button type="button" onClick={() => setChoosing({ kind: "scope" })} aria-pressed={!!scopeLabel}
        title={scopeLabel ? researchLabelPath(labels, scopeLabel.id).map(({ name }) => name).join(" / ") : "All saved sources"}
        className={`${CHOICE} flex min-w-0 max-w-full items-center gap-1.5`}>
        <ResearchLabelFolder labels={labels} labelId={scopeLabel?.id ?? null} size="sm" />
        <span className="truncate">{scopeLabel ? scopeLabel.name : "All saved sources"}</span>
      </button>
      {scopeLabel && <span className="text-gray-500">{scopeLabel.scope === "highlight" ? "highlighted passages" : "and everything under it"}</span>}
    </div>
    {choosing?.kind === "scope" && <LabelChoice title="Search in" labels={labels} scope="source" noneLabel="All saved sources"
      selectedId={scopeLabel?.scope === "source" ? scopeLabel.id : null} onClose={() => setChoosing(null)} onChoose={setScopeId} />}
    {choosing?.kind === "scope" && <LabelChoice title="Or one highlight type" labels={labels} scope="highlight"
      selectedId={scopeLabel?.scope === "highlight" ? scopeLabel.id : null} onClose={() => setChoosing(null)} onChoose={setScopeId} />}
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-gray-600">
      <span className="text-gray-500">Capture</span>
      {UNITS.map((option) => <button key={option.value} type="button" onClick={() => setUnit(option.value)}
        aria-pressed={unit === option.value} className={CHOICE}>{option.label}</button>)}
      {unit !== "match" && DIRECTIONS.map((option) => <button key={option.value} type="button" onClick={() => setDirection(option.value)}
        aria-pressed={direction === option.value} aria-label={`${option.label} the phrase`} className={CHOICE}>{option.label}</button>)}
    </div>
    {!!result && <section aria-label="Matches" className="grid min-w-0 gap-2 border-t border-gray-200 pt-2">
      {!!result.matches.size && <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-gray-600">{result.matches.size} match{result.matches.size === 1 ? "" : "es"}</span>
        <Button size="compact" variant="outline"
          onClick={() => void markPassages(result.sourceIds, [...result.matches])}>Highlight all as {penName}</Button>
      </div>}
      {found.map((sourceId) => <div key={sourceId} className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <h3 className="min-w-0 flex-1 truncate text-xs font-semibold text-gray-800">{sourceName(file.state.sources[sourceId])}</h3>
          <button type="button" onClick={() => setChoosing({ kind: "file", sourceId })} className={CHOICE}>File under…</button>
        </div>
        {choosing?.kind === "file" && choosing.sourceId === sourceId &&
          <LabelChoice title={`File ${sourceName(file.state.sources[sourceId])} under`} labels={labels} scope="source"
            selectedId={null} onClose={() => setChoosing(null)} onChoose={(id) => void fileSource(sourceId, id)} />}
        <ul className="mt-1 grid min-w-0 gap-1">{rows(sourceId).map(({ receipt }) => <li key={receipt.evidence_id}
          className="flex min-w-0 items-start gap-1.5 rounded border-s-2 border-gray-200 ps-2">
          <span className="line-clamp-4 min-w-0 flex-1 text-xs leading-5 text-gray-700 [overflow-wrap:anywhere]">
            <span className="me-1 font-medium text-gray-500">{passageLabel(receipt.locator)}</span>
            {marked(trimPassageMarker(receipt.span_text ?? "", receipt.locator), result.phrase)}
          </span>
          {reader?.canRead(file.state.sources[sourceId]) && <button type="button"
            aria-label={`Open ${passageLabel(receipt.locator)} in ${sourceName(file.state.sources[sourceId])}`} title="Open here"
            onClick={() => void reader.readSource(file.state.sources[sourceId], receipt.locator.label, receipt.evidence_id)}
            className="mt-0.5 grid size-6 shrink-0 place-items-center rounded text-gray-500 hover:bg-gray-200">
            <BookOpen aria-hidden className="size-3.5" /></button>}
          <button type="button" className={`${CHOICE} mt-0.5 shrink-0`}
            onClick={() => setChoosing({ kind: "highlight", sourceId, evidenceIds: [receipt.evidence_id] })}>Highlight</button>
        </li>)}</ul>
        {choosing?.kind === "highlight" && choosing.sourceId === sourceId &&
          <LabelChoice title="Highlight as" labels={labels} scope="highlight" selectedId={pen?.id ?? null}
            onClose={() => setChoosing(null)}
            onChoose={(id) => void markPassages([sourceId], choosing.evidenceIds, id ?? undefined)} />}
      </div>)}
      {!!pending && <p role="status" className="text-xs text-gray-500">Loading {pending} more source{pending === 1 ? "" : "s"}…</p>}
      {!found.length && !pending && <p className="text-xs text-gray-500">Nothing matched “{result.phrase}”.</p>}
      {!!more && <Button size="compact" variant="outline" disabled={busy} className="justify-self-start"
        onClick={() => void run(more.input, more.phrase, true)}>Continue searching</Button>}
    </section>}
    {!!(file.state.queries?.count ?? 0) && <details open={historyOpen} className="group/history border-t border-gray-200 pt-2 text-xs">
      <summary onClick={(event) => { event.preventDefault(); setHistoryOpen((open) => !open); }}
        className="inline-flex cursor-pointer list-none items-center gap-1 text-gray-700">
        <ChevronRight aria-hidden className="size-3 group-open/history:rotate-90" />Previous searches
      </summary>
      {historyOpen && <ol className="mt-1.5 grid gap-1">{history.map((item) => <li key={item.query_id}
        className="flex min-w-0 items-center gap-2">
        <button type="button" disabled={busy} onClick={() => rerun(item)}
          className="min-w-0 flex-1 truncate rounded px-1 py-0.5 text-start text-gray-700 hover:bg-gray-50">
          {queryPhrase(item.input)}
          <span className="ms-1.5 tabular-nums text-gray-500">{item.evidenceIds.length}</span>
        </button>
        <p aria-label="Sources searched" className="max-w-40 shrink-0 truncate text-gray-500"
          title={item.sourceIds.map((id) => {
            const source = file.state.sources[id], reference = source?.reference ?? item.sourceReferences?.[id];
            const failure = item.failures.find((value) => value.sourceId === id)?.code;
            return `${source ? sourceName(source) : reference?.title || reference?.citation || id}${failure ? ` · ${failure}` : ""}`;
          }).join("\n")}>{item.sourceIds.length} source{item.sourceIds.length === 1 ? "" : "s"}</p>
      </li>)}</ol>}
    </details>}
  </div>;
}

import { useEffect, useState, type FormEvent, type MouseEvent } from "react";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { createPortal } from "react-dom";
import { useAnchoredPopover } from "@/app/hooks/useAnchoredPopover";
import { Button } from "../ui/button";
import { InlineNameInput } from "../shared/InlineNameInput";
import { usePagedChains } from "@/app/hooks/usePagedChains";
import { BeaverApiError } from "@/app/lib/api/client";
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
/** Every chooser in this panel wears the dock's own compact outline control. */
const DOCK_CONTROL = "h-8 shrink-0 rounded-md border border-gray-300 bg-white px-2 text-xs font-medium text-gray-800 hover:bg-gray-50";
const NEW_LABEL = "flex h-7 items-center gap-1 self-start rounded-md px-1.5 text-xs text-gray-600 hover:bg-gray-100";
/** The highlight palette the labels tree hands out, so a type made here looks like one made there. */
const COLOURS = ["#d6b85a", "#8aa8c7", "#90ac99", "#bda0b5", "#b4ab91", "#9fa7bf"];
const labelPath = (labels: Record<string, ResearchLabel>, id: string) =>
  researchLabelPath(labels, id).map(({ name }) => name).join(" / ");

/** Plain text stays a phrase; these markers make it a Boolean expression the backend evaluates. */
const OPERATORS = /["()&|]|(?:^|\s)-\S|(?:^|\s)(?:AND|OR|NOT|ET|OU|NON)(?:\s|$)/iu;
/** A Boolean expression is marked on its first searchable term, not on the expression itself. */
function markPhrase(text: string) {
  if (!OPERATORS.test(text)) return text;
  for (const token of text.match(/"[^"]*"|[^\s()]+/gu) ?? []) {
    if (token.startsWith('"')) return token.replace(/"/gu, "");
    if (!token.startsWith("-") && !/^(?:AND|OR|NOT|ET|OU|NON|&&?|\|\|?)$/iu.test(token)) return token;
  }
  return "";
}

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

/** Choosing a label, a highlight type or a search scope is always the same waterfall, and it always
 *  drops straight under the control that opened it, inside the dock: opening one never moves the
 *  input or the results. A label with children keeps the panel open so the user can walk down to the
 *  one they mean, and a label that does not exist yet is made here, where it is wanted. */
function LabelChoice({ title, anchor, labels, scopes, selectedId, onChoose, onCreate, onClose, noneLabel }: {
  title: string; anchor: HTMLElement | null; labels: Record<string, ResearchLabel>;
  scopes: readonly ResearchLabel["scope"][]; selectedId: string | null;
  onChoose: (id: string | null) => void;
  onCreate: (scope: ResearchLabel["scope"], name: string, parentId: string | null) => Promise<string | null>;
  onClose: () => void; noneLabel?: string }) {
  const popover = useAnchoredPopover({ anchor, below: true, stationary: true, onDismiss: onClose });
  const [naming, setNaming] = useState<ResearchLabel["scope"] | null>(null);
  const [walked, setWalked] = useState<string | null>(null);
  const walk = (id: string | null) => { onChoose(id); setWalked(id);
    if (!id || !Object.values(labels).some((label) => label.parentId === id)) onClose(); };
  /** A new label lands where the user walked to, not under whatever was already chosen for them. */
  const parentOf = (scope: ResearchLabel["scope"]) => labels[walked ?? ""]?.scope === scope ? walked : null;
  return createPortal(<div ref={popover} role="dialog" aria-label={title} popover="manual"
    className="fixed inset-auto z-[220] m-0 grid max-h-[min(26rem,calc(100dvh-1rem))] w-[min(20rem,calc(100vw-1rem))] content-start gap-1.5 overflow-y-auto overscroll-contain rounded-lg border border-gray-300 bg-white p-2 shadow-lg">
    <p className="text-xs font-medium text-gray-700">{title}</p>
    {scopes.map((scope) => { const noun = scope === "source" ? "label" : "highlight type", parentId = parentOf(scope);
      return <div key={scope} className="grid min-w-0 gap-0.5">
      {scopes.length > 1 && <p className="px-1.5 text-[11px] leading-4 text-gray-500">{scope === "source" ? "Labels" : "Highlight types"}</p>}
      <ResearchLabelWaterfall labels={labels} scope={scope}
        selectedId={labels[selectedId ?? ""]?.scope === scope ? selectedId : null}
        noneLabel={scope === "source" ? noneLabel : undefined} onChoose={walk} />
      {naming === scope ? <div className="flex h-7 items-center px-1.5">
        <InlineNameInput kind="new-folder" label={`New ${noun} name`} onCancel={() => setNaming(null)}
          onCommit={(value) => { setNaming(null); if (!value.trim()) return;
            void onCreate(scope, value.trim(), parentId).then((id) => { if (id) { onChoose(id); onClose(); } }); }} />
      </div> : <button type="button" onClick={() => setNaming(scope)} className={NEW_LABEL}>
        <Plus aria-hidden className="size-3" />
        <span className="min-w-0 truncate">New {noun}{parentId ? ` in ${labels[parentId]!.name}` : ""}</span>
      </button>}
    </div>; })}
  </div>, anchor?.closest('dialog,[role="dialog"],[data-assistant-dock]') ?? document.body);
}

export function ResearchSearchPanel({ active, selection, reader, onStatus: setStatus }: {
  active: boolean; selection: ResearchSelection; reader?: SourceReader; onStatus: (message: string) => void;
}) {
  const { file, mutations: commit, evidence, highlight } = useSourcesWorkspace();
  const labels = file?.state.labels ?? {};
  const [phrase, setPhrase] = useState(""), [direction, setDirection] = useState<Rule["direction"]>("around"),
    [unit, setUnit] = useState<Rule["unit"] | "match">("match");
  const [busy, setBusy] = useState(false), [historyOpen, setHistoryOpen] = useState(false),
    [hint, setHint] = useState("");
  const [result, setResult] = useState<{ phrase: string; matches: Set<string>; sourceIds: string[] } | null>(null);
  const [more, setMore] = useState<{ input: ResearchQueryInput; phrase: string } | null>(null);
  /** Which slice of the saved research this search reads, and what a result can be filed into. */
  const [scopeId, setScopeId] = useState<string | null>(null);
  type Choice = { kind: "scope" } | { kind: "file"; sourceId: string }
    | { kind: "highlight"; sourceId: string; evidenceIds: string[] };
  const [choosing, setChoosing] = useState<(Choice & { anchor: HTMLElement }) | null>(null);
  const opener = (choice: Choice) => (event: MouseEvent<HTMLButtonElement>) =>
    setChoosing({ ...choice, anchor: event.currentTarget });
  const scopeLabel = scopeId && labels[scopeId] ? labels[scopeId] : null;
  const pen = (labels[highlight.pen ?? ""]?.scope === "highlight" ? labels[highlight.pen!] : undefined)
    ?? Object.values(labels).filter((label) => label.scope === "highlight").sort((a, b) => a.order - b.order)[0];
  const penName = pen ? labelPath(labels, pen.id) : "Highlight";
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
        (item.kind === "passage" || item.kind === "evidence") && item.value.receipt.locator.kind !== "document" &&
        result!.matches.has(item.value.receipt.evidence_id)))
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
    setBusy(true); setStatus(""); setHint("");
    try {
      const request = continuing ? input : scoped(input);
      const { receipt, coverage } = await commit.query(request);
      setResult((current) => ({ phrase: text,
        matches: new Set([...(continuing ? current?.matches ?? [] : []), ...receipt.evidenceIds]),
        sourceIds: [...new Set([...(continuing ? current?.sourceIds ?? [] : []), ...receipt.matchedSourceIds])] }));
      setMore(coverage?.next_after ? { input: { ...request, after: coverage.next_after }, phrase: text } : null);
      if (!receipt.evidenceIds.length) setStatus("No matches");
    } catch (reason) {
      // A malformed expression is the user still typing, not a failure: it never leaves the input.
      if (reason instanceof BeaverApiError && reason.code === "invalid_query") setHint(reason.message);
      else setStatus(errorMessage(reason, "Search failed"));
    }
    finally { setBusy(false); }
  }
  function find(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const text = phrase.trim(); if (!text) return;
    const syntax = OPERATORS.test(text) ? "terms" as const : "literal" as const;
    void run(unit === "match" ? { text, syntax, target: "sources" }
      : { syntax, target: "sources", rules: [{ phrase: text, direction, unit }], conflict: "append" }, text);
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
      // A type made a moment ago is not in this render's labels yet: name it from what the write returned.
      const next = await commit.act({ type: "label-selection", target: "passages", sourceIds, evidenceIds, assign: [target], mode: "replace" });
      setStatus(`Saved ${evidenceIds.length} under ${labelPath(next.state.labels, target) || penName}`);
    } catch (reason) { setStatus(errorMessage(reason, "Could not save these matches")); }
  }
  async function fileSource(sourceId: string, labelId: string | null) {
    const source = file?.state.sources[sourceId]; if (!source || !labelId) return;
    setStatus("");
    try {
      const next = await commit.act({ type: "annotate", kind: "source", id: sourceId, labelIds: [labelId] });
      setStatus(`Filed ${sourceName(source)} under ${labelPath(next.state.labels, labelId)}`);
    } catch (reason) { setStatus(errorMessage(reason, "Could not file this source")); }
  }
  /** A label the user wants but has not made yet is created here, then used at once. */
  async function createLabel(scope: ResearchLabel["scope"], name: string, parentId: string | null) {
    setStatus("");
    const id = crypto.randomUUID();
    try {
      await commit.act({ type: "label", id, name, parentId, scope, ...(scope === "highlight"
        ? { color: COLOURS[Object.values(labels).filter((label) => label.scope === "highlight").length % COLOURS.length] } : {}) });
      return id;
    } catch (reason) {
      setStatus(errorMessage(reason, `Could not add this ${scope === "source" ? "label" : "highlight type"}`));
      return null;
    }
  }
  /** The whole-source receipt matches every phrase its text holds; it is the source, not a passage
   *  in it, so it never doubles a located match. */
  const rows = (sourceId: string) => {
    const matched = (evidence.chains[sourceId]?.items ?? []).flatMap((item) =>
      (item.kind === "passage" || item.kind === "evidence") && result?.matches.has(item.value.receipt.evidence_id) ? [item.value] : []);
    const located = matched.filter(({ receipt }) => receipt.locator.kind !== "document");
    return located.length ? located : matched;
  };
  const found = result?.sourceIds.filter((id) => file?.state.sources[id] && rows(id).length) ?? [],
    mark = markPhrase(result?.phrase ?? "");
  const pending = (result?.sourceIds.length ?? 0) - found.length;
  if (!file) return <p className="p-2 text-xs text-gray-500">Open a workspace to search its saved sources.</p>;
  return <div className="grid min-w-0 content-start gap-2">
    <form onSubmit={find} className="flex min-w-0 items-center gap-1.5">
      <input required autoComplete="off" value={phrase} aria-invalid={!!hint || undefined}
        aria-describedby={hint ? "research-search-hint" : undefined}
        onChange={(event) => { setPhrase(event.target.value); setHint(""); }}
        aria-label="Phrase to find in saved sources" placeholder={'Find a phrase — or lease AND (renewal OR "option to renew")'}
        className="h-8 min-w-0 flex-1 rounded-md border border-gray-300 px-2 text-sm aria-[invalid]:border-amber-500" />
      <Button type="submit" size="compact" disabled={busy}>{busy ? "Finding…" : "Find"}</Button>
    </form>
    {!!hint && <p id="research-search-hint" role="status" className="truncate text-xs text-amber-700">{hint}</p>}
    {/* One fixed row that never wraps: choosing a scope changes what it says, never where anything sits. */}
    <div className="flex h-8 min-w-0 flex-nowrap items-center gap-1.5 text-xs text-gray-600">
      <span className="shrink-0 text-gray-500">Search in</span>
      <button type="button" onClick={opener({ kind: "scope" })} aria-expanded={choosing?.kind === "scope"}
        aria-label={`Search in ${scopeLabel ? researchLabelPath(labels, scopeLabel.id).map(({ name }) => name).join(" / ") : "all saved sources"}`}
        title={scopeLabel ? researchLabelPath(labels, scopeLabel.id).map(({ name }) => name).join(" / ") : "All saved sources"}
        className={`${DOCK_CONTROL} flex min-w-0 max-w-[65%] items-center gap-1.5`}>
        <ResearchLabelFolder labels={labels} labelId={scopeLabel?.id ?? null} size="sm" />
        <span className="min-w-0 truncate">{scopeLabel ? scopeLabel.name : "All saved sources"}</span>
        <ChevronDown aria-hidden className="size-3 shrink-0 text-gray-400" />
      </button>
      {scopeLabel && <span className="min-w-0 truncate text-gray-500">{scopeLabel.scope === "highlight" ? "highlighted passages" : "and everything under it"}</span>}
    </div>
    <details className="group text-xs text-gray-600">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-gray-700">
        <ChevronRight aria-hidden className="size-3 group-open:rotate-90" />Capture options</summary>
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
      {UNITS.map((option) => <button key={option.value} type="button" onClick={() => setUnit(option.value)}
        aria-pressed={unit === option.value} className={CHOICE}>{option.label}</button>)}
      {unit !== "match" && DIRECTIONS.map((option) => <button key={option.value} type="button" onClick={() => setDirection(option.value)}
        aria-pressed={direction === option.value} aria-label={`${option.label} the phrase`} className={CHOICE}>{option.label}</button>)}
      </div>
    </details>
    {!!result && <section aria-label="Matches" className="grid min-w-0 gap-2 border-t border-gray-200 pt-2">
      {!!result.matches.size && <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-xs text-gray-600">{result.matches.size} match{result.matches.size === 1 ? "" : "es"}</span>
        <Button size="compact" variant="outline" title={`Highlight all as ${penName}`}
          className="ms-auto min-w-0 shrink truncate"
          onClick={() => void markPassages(result.sourceIds, [...result.matches])}>Highlight all as {penName}</Button>
      </div>}
      {found.map((sourceId) => <div key={sourceId} className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <h3 className="min-w-0 flex-1 truncate text-xs font-semibold text-gray-800">{sourceName(file.state.sources[sourceId])}</h3>
          <button type="button" onClick={opener({ kind: "file", sourceId })} className={CHOICE}>File under…</button>
        </div>
        {/* Clicking the match opens the source there, exactly as clicking a passage row in the tree does. */}
        <ul className="mt-1 grid min-w-0 gap-1">{rows(sourceId).map(({ receipt }) => {
          const source = file.state.sources[sourceId], at = receipt.locator.kind === "document" ? "" : passageLabel(receipt.locator);
          const body = <>{!!at && <span className="me-1 font-medium text-gray-500">{at}</span>}
            {marked(trimPassageMarker(receipt.span_text ?? "", receipt.locator), mark)}</>;
          return <li key={receipt.evidence_id}
            className="flex min-w-0 items-start gap-1.5 rounded border-s-2 border-gray-200 ps-2">
          {reader?.canRead(source)
            ? <button type="button" title="Open here"
              aria-label={`Open ${at || sourceName(source)} in ${sourceName(source)}`}
              onClick={() => void reader.readSource(source, receipt.locator.label, receipt.evidence_id)}
              className="line-clamp-4 min-w-0 flex-1 rounded text-start text-xs leading-5 text-gray-700 [overflow-wrap:anywhere] hover:bg-gray-100">{body}</button>
            : <span className="line-clamp-4 min-w-0 flex-1 text-xs leading-5 text-gray-700 [overflow-wrap:anywhere]">{body}</span>}
          <button type="button" className={`${CHOICE} mt-0.5 shrink-0`}
            onClick={opener({ kind: "highlight", sourceId, evidenceIds: [receipt.evidence_id] })}>Highlight</button>
        </li>; })}</ul>
      </div>)}
      {!!pending && <p role="status" className="text-xs text-gray-500">Loading {pending} more source{pending === 1 ? "" : "s"}…</p>}
      {!found.length && !pending && <p className="text-xs text-gray-500">Nothing matched “{result.phrase}”.</p>}
      {!!more && <Button size="compact" variant="outline" disabled={busy} className="justify-self-start"
        onClick={() => void run(more.input, more.phrase, true)}>Continue searching</Button>}
    </section>}
    {choosing && <LabelChoice anchor={choosing.anchor} labels={labels} onClose={() => setChoosing(null)} onCreate={createLabel}
      {...(choosing.kind === "scope"
        ? { title: "Search in", scopes: ["source", "highlight"] as const, noneLabel: "All saved sources",
            selectedId: scopeLabel?.id ?? null, onChoose: setScopeId }
        : choosing.kind === "file"
          ? { title: `File ${sourceName(file.state.sources[choosing.sourceId])} under`, scopes: ["source"] as const,
              selectedId: null, onChoose: (id: string | null) => void fileSource(choosing.sourceId, id) }
          : { title: "Highlight as", scopes: ["highlight"] as const, selectedId: pen?.id ?? null,
              onChoose: (id: string | null) => void markPassages([choosing.sourceId], choosing.evidenceIds, id ?? undefined) })} />}
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

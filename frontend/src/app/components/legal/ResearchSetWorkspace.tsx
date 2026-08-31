import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ProjectChoiceList } from "@/app/components/projects/ProjectChoiceList";
import { DraftMenu } from "@/app/components/shared/DraftMenu";
import type { ResearchEvidence, ResearchSetAction, ResearchSetMetadata, ResearchSetProduct,
  ResearchSetQueryInput, ResearchSetQueryResult, ResearchSource } from "@/app/lib/researchSets";
import { legalSourceViewerHref, researchLabelPath, researchSourceTitle,
  sourceMatchesLabel } from "@/app/lib/researchSets";
import { ResearchLabelCircle } from "./ResearchLabelCircle";

type Props = { sets: ResearchSetMetadata[] | null; product: ResearchSetProduct | null; busy?: boolean;
  onSelect(id: string): void; onCreate(): Promise<void>; onRename(title: string): Promise<void>;
  onDuplicate(): Promise<void>; onDelete(): Promise<void>;
  onAction(action: ResearchSetAction): Promise<void>;
  onMove(projectId: string | null): Promise<void>;
  onQuery(input: ResearchSetQueryInput): Promise<ResearchSetQueryResult>;
  onAssistant?(): void };

export function ResearchSetWorkspace({ sets, product, busy = false, onSelect, onCreate,
  onRename, onDuplicate, onDelete, onAction, onMove, onQuery, onAssistant }: Props) {
  const [activeLabel, setActiveLabel] = useState<string | null>(null);
  const [shown, setShown] = useState(100);
  const labels = product?.state.labels ?? {};
  const sources = product ? Object.values(product.state.sources).filter((source) =>
    sourceMatchesLabel(source, activeLabel, labels)) : [];
  const evidenceBySource = useMemo(() => product ? Object.values(product.state.evidence)
    .reduce<Record<string, ResearchEvidence[]>>((items, evidence) => {
      (items[evidence.sourceId] ??= []).push(evidence); return items;
    }, {}) : {}, [product]);

  return <section aria-label="Saved research" className="space-y-4">
    <div className="flex flex-wrap items-end gap-2 rounded-lg border border-gray-200 bg-white p-4">
      <DraftMenu drafts={sets ?? []} current={product ?? undefined} busy={busy}
        itemLabel="research set" onNew={() => void onCreate()}
        onOpen={({ id }) => onSelect(id)} onRename={(title) => void onRename(title)}
        onDuplicate={() => void onDuplicate()} onDelete={() => void onDelete()} />
      {product && onAssistant && <button type="button" onClick={onAssistant}
        className="h-10 rounded-md bg-gray-900 px-3 text-sm font-medium text-white">Ask Beaver</button>}
    </div>
    {!product ? <p className="rounded-lg border border-dashed p-8 text-center text-sm text-gray-600">
      Save a source or create a set to begin.
    </p> : <div className="space-y-3">
      <details className="rounded-lg border bg-white p-4">
        <summary className="cursor-pointer text-sm font-medium">Move this set</summary>
        <button type="button" disabled={busy} onClick={() => void onMove(null)}
          className="my-3 h-9 rounded-md border px-3 text-sm">Personal library</button>
        <ProjectChoiceList value={product.projectId} onChange={(id) => void onMove(id)} disabled={busy} />
      </details>
      <LabelBar labels={labels} active={activeLabel} setActive={setActiveLabel}
        busy={busy} onAction={onAction} />
      <QueryBar disabled={busy} activeLabel={activeLabel} onQuery={onQuery} />
      {sources.slice(0, shown).map((source) => <SourceDetails key={source.id} source={source} product={product}
        evidence={evidenceBySource[source.id] ?? []} busy={busy} onAction={onAction} />)}
      {sources.length > shown && <button type="button" onClick={() => setShown(shown + 100)}
        className="h-9 rounded-md border px-3 text-sm">Show more sources</button>}
      {!sources.length && <p className="rounded-lg border border-dashed p-6 text-sm text-gray-600">
        No sources match this view.
      </p>}
      <details open className="rounded-lg border bg-white p-4"><summary className="cursor-pointer text-sm font-medium">Memo.md</summary>
        <form onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget);
          void onAction({ type: "memo", markdown: String(data.get("markdown") ?? "") });
        }} className="mt-3 space-y-2"><textarea key={`${product.id}:${product.state.memo}`}
          name="markdown" defaultValue={product.state.memo} placeholder="Write the memo in Markdown…"
          className="min-h-48 w-full rounded-md border p-3 font-mono text-sm" />
          <div className="flex gap-2"><button disabled={busy} className="h-9 rounded-md bg-gray-900 px-3 text-sm text-white">Save memo</button>
            <button type="button" onClick={() => void navigator.clipboard.writeText(
              `${product.state.memo}\n\n<!-- beaver-research-set:${product.id} -->`)}
              className="h-9 rounded-md border px-3 text-sm">Copy .md</button>
          </div></form></details>
      <details className="rounded-lg border bg-white p-4">
        <summary className="cursor-pointer text-sm font-medium">Audit · {product.state.audit.length}</summary>
        <ol className="mt-3 space-y-2 text-xs text-gray-600">
          {[...product.state.audit].reverse().slice(0, 50).map((entry, index) =>
            <li key={`${entry.at}-${index}`}>{new Date(entry.at).toLocaleString()} · {entry.actor.kind}
              {entry.actor.kind === "model" ? ` ${entry.actor.id}` : ""} · {entry.action}</li>)}
        </ol>
      </details>
    </div>}
  </section>;
}

function LabelBar({ labels, active, setActive, busy, onAction }: {
  labels: ResearchSetProduct["state"]["labels"]; active: string | null;
  setActive(id: string | null): void; busy: boolean;
  onAction(action: ResearchSetAction): Promise<void> }) {
  const list = Object.values(labels).sort((a, b) => labelName(labels, a.id)
    .localeCompare(labelName(labels, b.id)));
  return <section className="rounded-lg border bg-white p-4" aria-label="Research labels">
    <form onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget;
      const data = new FormData(form), name = String(data.get("name") ?? "").trim();
      if (name) void onAction({ type: "label", name,
        parentId: String(data.get("parent") ?? "") || null }).then(() => form.reset());
    }} className="flex flex-wrap gap-2">
      <input name="name" required aria-label="New label" placeholder="New label"
        className="h-9 w-36 rounded-md border px-2 text-sm" />
      <select name="parent" aria-label="Parent label"
        className="h-9 rounded-md border bg-white px-2 text-sm"><option value="">Top level</option>
        {list.map((label) => <option key={label.id} value={label.id}>{labelName(labels, label.id)}</option>)}
      </select>
      <button disabled={busy} className="h-9 rounded-md border px-3 text-sm">Add</button>
    </form>
    <div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={() => setActive(null)}
      className={`rounded-full border px-3 py-1 text-xs ${!active ? "bg-gray-900 text-white" : ""}`}>All</button>
      {list.map((label) => <span key={label.id} className="inline-flex rounded-full border">
        <button type="button" onClick={() => setActive(label.id)}
          className={`inline-flex items-center gap-1 rounded-s-full px-2 py-1 text-xs ${active === label.id ? "bg-gray-900 text-white" : ""}`}>
          <ResearchLabelCircle labels={labels} labelIds={[label.id]} size="sm" />
          {labelName(labels, label.id)}
        </button><button type="button" disabled={busy} aria-label={`Delete ${label.name}`}
          onClick={() => void onAction({ type: "remove", kind: "label", id: label.id })}
          className="rounded-e-full px-2 text-gray-500 hover:text-red-700">×</button>
      </span>)}</div>
  </section>;
}

function QueryBar({ disabled, activeLabel, onQuery }: { disabled: boolean;
  activeLabel: string | null; onQuery: Props["onQuery"] }) {
  const [status, setStatus] = useState("");
  return <form onSubmit={(event) => { event.preventDefault();
    const data = new FormData(event.currentTarget);
    const query = String(data.get("query") ?? "").trim();
    if (!query) return;
    setStatus("Searching…"); void onQuery({ text: query, syntax: "terms",
      target: data.get("target") === "passages" ? "passages" : "sources",
      labelIds: activeLabel ? [activeLabel] : [] }).then(({ counts }) =>
      setStatus(`${counts.matches} matches in ${counts.matchedSources} sources`), () => setStatus("Search failed"));
  }} className="flex flex-wrap items-center gap-2 rounded-lg border bg-white p-4">
    <input name="query" required aria-label="Query saved research" placeholder="Query these sources"
      className="h-10 min-w-52 flex-1 rounded-md border px-3 text-sm" />
    <select name="target" aria-label="Search target" className="h-10 rounded-md border bg-white px-2 text-sm">
      <option value="sources">Full sources</option><option value="passages">Saved passages</option>
    </select>
    <button disabled={disabled} className="h-10 rounded-md bg-gray-900 px-3 text-sm text-white">Search</button>
    {status && <span role="status" className="text-xs text-gray-600">{status}</span>}
  </form>;
}

function SourceDetails({ source, product, evidence, busy, onAction }: { source: ResearchSource;
  evidence: ResearchEvidence[];
  product: ResearchSetProduct; busy: boolean; onAction(action: ResearchSetAction): Promise<void> }) {
  const [open, setOpen] = useState(false);
  return <details onToggle={(event) => setOpen(event.currentTarget.open)}
    className="rounded-lg border bg-white p-4">
    <summary className="flex cursor-pointer list-none items-center gap-3">
      <ResearchLabelCircle labels={product.state.labels} labelIds={source.labelIds} />
      <span className="min-w-0 flex-1"><strong className="block truncate text-sm">{researchSourceTitle(source)}</strong>
        <span className="text-xs text-gray-500">{source.reference.citation ?? source.reference.collection}</span></span>
      <span className="text-xs text-gray-500">{evidence.length} passages</span>
    </summary>
    {open && <div className="mt-4 space-y-3 border-t pt-4">
      {(source.reference.provider === "a2aj" || source.reference.provider === "journal") &&
        <Link to={legalSourceViewerHref(source.reference, { setId: product.id, sourceId: source.id })}
          className="text-sm underline">Open source</Link>}
      <Annotation item={source} kind="source" labels={product.state.labels} busy={busy} onAction={onAction} />
      {evidence.map((item) => <EvidenceDetails key={item.receipt.evidence_id} item={item}
        product={product} busy={busy} onAction={onAction} />)}
      <button type="button" disabled={busy}
        onClick={() => void onAction({ type: "remove", kind: "source", id: source.id })}
        className="text-xs text-red-700">Remove source</button>
    </div>}
  </details>;
}

function EvidenceDetails({ item, product, busy, onAction }: { item: ResearchEvidence;
  product: ResearchSetProduct; busy: boolean; onAction(action: ResearchSetAction): Promise<void> }) {
  const [open, setOpen] = useState(false);
  return <details onToggle={(event) => setOpen(event.currentTarget.open)}
    className="rounded-md border p-3"><summary className="cursor-pointer text-sm">
    {item.receipt.locator.label} · {item.receipt.span_text?.slice(0, 120)}</summary>
    {open && <><blockquote className="my-3 border-s-2 ps-3 text-sm leading-6">{item.receipt.span_text}</blockquote>
    <Annotation item={item} kind="evidence" labels={product.state.labels} busy={busy} onAction={onAction} />
    <button type="button" disabled={busy} onClick={() => void onAction({ type: "remove",
      kind: "evidence", id: item.receipt.evidence_id })}
      className="mt-2 text-xs text-red-700">Remove passage</button></>}
  </details>;
}

function Annotation({ item, kind, labels, busy, onAction }: { item: { id?: string;
  receipt?: { evidence_id: string }; labelIds: string[]; note: string };
  kind: "source" | "evidence"; labels: ResearchSetProduct["state"]["labels"];
  busy: boolean; onAction(action: ResearchSetAction): Promise<void> }) {
  const id = item.id ?? item.receipt!.evidence_id;
  return <form onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget);
    void onAction({ type: "annotate", kind, id,
      labelIds: data.getAll("labels").map(String), note: String(data.get("note") ?? "") });
  }} className="space-y-2"><div className="flex flex-wrap gap-2">
    {Object.values(labels).map((label) => <label key={label.id} className="text-xs">
      <input type="checkbox" name="labels" value={label.id}
        defaultChecked={item.labelIds.includes(label.id)} /> {labelName(labels, label.id)}
    </label>)}</div>
    <textarea name="note" defaultValue={item.note} placeholder="Note"
      className="min-h-16 w-full rounded-md border p-2 text-sm" />
    <button disabled={busy} className="h-8 rounded-md border px-3 text-xs">Save labels and note</button>
  </form>;
}

const labelName = (labels: ResearchSetProduct["state"]["labels"], id: string) =>
  researchLabelPath(labels, id).map(({ name }) => name).join(" / ");

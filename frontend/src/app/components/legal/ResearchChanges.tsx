import { useEffect, useRef, useState } from "react";
import { getResearchItems } from "@/app/lib/api/researchFiles";
import { researchLabelPath, type ResearchChange, type ResearchFile, type ResearchLabel } from "@/app/lib/researchFiles";
import { actOnTabularChange, getTabularHistory, updateTabularReview, type ColumnConfig, type TabularDocument, type TabularReview } from "@/app/lib/api/tabular";
import { usePagedChains } from "@/app/hooks/usePagedChains";
import { errorMessage } from "@/app/lib/utils";
import { Modal } from "../modals/Modal";
import { Button } from "../ui/button";
import { TableProposalReview, isColumnProposal } from "../tabular/TableProposalReview";
import { ResearchTree } from "./ResearchTree";
import { SourcesWorkspace } from "./SourcesWorkspace";
import type { ResearchFileMutations } from "./useResearchFileMutations";

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
/** A proposal that only creates labels and assigns sources reads as the tree it would produce. */
function labelProposal(change: ResearchChange, file: ResearchFile) {
  const labels = { ...file.state.labels }, marks: Record<string, "added" | "changed"> = {};
  const sources = Object.fromEntries(Object.entries(file.state.sources)
    .map(([id, source]) => [id, { ...source, labelIds: [...source.labelIds] }]));
  for (const item of change.changes) {
    if (item.target === "label" && item.after) {
      const current = labels[item.id];
      if (item.field === "$") { labels[item.id] = object(item.after) as unknown as ResearchLabel; }
      else if (current) labels[item.id] = { ...current, [item.field]: item.after };
      else return null;
      marks[item.id] = item.before ? "changed" : "added";
    } else if (item.target === "source" && item.field.startsWith("labelIds.")) {
      const source = sources[item.sourceId ?? item.id]; if (!source) return null;
      const labelId = item.field.slice("labelIds.".length);
      source.labelIds = item.after ? [...new Set([...source.labelIds, labelId])]
        : source.labelIds.filter((id) => id !== labelId);
      marks[source.id] = "changed";
    } else return null;
  }
  return Object.keys(marks).length ? { labels, marks, sources: Object.values(sources) } : null;
}
function descriptions(change: ResearchChange, file?: ResearchFile, review?: TabularReview, documents: TabularDocument[] = []) {
  const labels = { ...file?.state.labels };
  for (const item of change.changes) if (item.target === "label" && item.field === "$") {
    const value = object(item.after ?? item.before);
    if (typeof value.name === "string") labels[item.id] = value as ResearchLabel;
  }
  const labelName = (id: string) => researchLabelPath(labels, id).map(({ name }) => name).join(" / ") || "Label";
  const columnNames = new Map(review?.columns_config?.map(({ index, name }) => [index, name]));
  for (const item of change.changes) { const column = /^columns_config\.(\d+)\.\$$/u.exec(item.field), value = object(item.after ?? item.before);
    if (column && typeof value.name === "string") columnNames.set(Number(column[1]), value.name); }
  const columnName = (index: number) => columnNames.get(index) || `Column ${index + 1}`;
  const valueText = (value: unknown, field: string) => {
    if (value === null || value === undefined || value === "") return "None";
    if (field === "parentId") return labelName(String(value));
    if (field === "scope") return value === "highlight" ? "Passages" : "Sources";
    if (Array.isArray(value)) return value.map((item) => field === "columns_order" ? columnName(Number(item)) : typeof item === "string" && labels[item] ? labelName(item)
      : typeof item === "object" ? field === "columns_config" ? [object(item).name, object(item).prompt, object(item).format].filter(Boolean).join(" · ")
      : JSON.stringify(item, null, 2) : String(item)).join("\n");
    if (typeof value !== "object") return String(value);
    const item = object(value), reference = object(item.reference), receipt = object(item.receipt);
    if (/^columns_config\.\d+\.\$$/u.test(field)) return [item.name, item.prompt, item.format, Array.isArray(item.tags) ? item.tags.join(", ") : ""].filter(Boolean).join("\n");
    const content = object(item.content);
    if ("content" in item) return [item.status, content.flag, content.summary,
      ...(Array.isArray(content.claims) ? content.claims.map((claim) => object(claim).text) : [])].filter(Boolean).join("\n\n");
    return String(item.name ?? reference.title ?? reference.citation ?? receipt.span_text ?? JSON.stringify(value, null, 2));
  };
  return change.changes.map((item) => {
      const source = file?.state.sources[item.sourceId ?? item.id], membership = item.field.startsWith("labelIds."),
        link = item.field.startsWith("tables.") || item.field.startsWith("chats."),
        column = /^columns_config\.(\d+)\.(.+)$/u.exec(item.field),
        result = object(item.after ?? item.before), document = documents.find(({ id }) => id === result.document_id),
        subject = item.target === "label" ? labelName(item.id)
          : item.target === "table" ? column ? columnName(Number(column[1])) : review?.title || "Table"
          : item.target === "result" ? [document?.filename ?? "Result", review?.columns_config?.find(({ index }) => index === result.column_index)?.name].filter(Boolean).join(" · ")
          : source?.reference.title ?? source?.reference.citation ?? (item.target === "passage" ? "Passage" : item.target === "workspace" ? "Workspace" : "Source"),
        property = column?.[2] ?? item.field,
        field = membership ? labelName(item.field.slice("labelIds.".length)) : link ? item.field.startsWith("tables.") ? "Table" : "Chat"
          : property === "$" ? "" : property === "columns_order" ? "Column order" : property === "name" && column ? "Title"
          : property.replace(/_/gu, " ").replace(/([a-z])([A-Z])/gu, "$1 $2").replace(/^./u, (letter) => letter.toUpperCase());
      return { label: [subject, item.target === "passage" ? "passage" : "", field].filter(Boolean).join(" · "),
        before: membership || link ? item.before ? "Included" : "Not included" : valueText(item.before, item.field),
        after: membership || link ? item.after ? "Included" : "Not included" : valueText(item.after, item.field) };
    });
}

/** Accepting an edited column proposal applies it first, then saves the edits against the accepted version. */
async function applyToTable(review: TabularReview, changeId: string, type: "accept" | "reject" | "undo", columns?: ColumnConfig[]) {
  const accepted = await actOnTabularChange(review, changeId, type);
  return type === "accept" && columns
    ? updateTabularReview(review.id, { columns_config: columns, expected_version: accepted.updated_at })
    : accepted;
}

type Props = { historyOpen: boolean; onCloseHistory: () => void } &
  ({ file: ResearchFile; mutations: ResearchFileMutations; review?: never; documents?: never; onChanged?: never }
  | { review: TabularReview; documents: TabularDocument[]; onChanged: () => Promise<void>; file?: never; mutations?: never });
export function ResearchChanges({ file, mutations, review, documents, onChanged, historyOpen, onCloseHistory }: Props) {
  const [reviewing, setReviewing] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [undo, setUndo] = useState<string | null>(null), [dismissed, setDismissed] = useState<string | null>(null);
  const pending = file?.state.proposals ?? review?.proposals ?? [], open = historyOpen || reviewing;
  const historyKey = file?.state.history?.sha256 ?? `${review?.updated_at}:${review?.history_count}`, firstKey = useRef(historyKey);
  const pages = usePagedChains<ResearchChange>(async (_key, cursor, signal) => {
    if (file) { const page = await getResearchItems(file.document.id, { kind: "history", cursor, limit: 50 }, signal);
      return { ...page, items: page.items.flatMap((item) => item.kind === "change" ? [item.value] : []) }; }
    const page = await getTabularHistory(review!.id, Number(cursor ?? 0), signal);
    return { items: page.items, next_cursor: page.next_offset === null ? null : String(page.next_offset) };
  }, [file?.document.id, review?.id], "history", open || historyKey !== firstKey.current, { history: historyKey });
  const chain = pages.chains.history, changes = chain?.items ?? [],
    visible = reviewing && !historyOpen ? changes.filter(({ status }) => status === "pending") : changes,
    undone = new Set(changes.flatMap(({ undoOf }) => undoOf ?? [])),
    latest = changes[0], assistantChange = latest && latest.executor !== "human" && latest.status === "applied" &&
      !latest.undoOf && !undone.has(latest.id) && dismissed !== latest.id ? latest : null;
  useEffect(() => {
    if (reviewing && !historyOpen && visible.length < pending.length && chain?.nextCursor && !chain.loading && !chain.error)
      void pages.fetchPage("history", chain.nextCursor, true);
  }, [reviewing, historyOpen, visible.length, pending.length, chain, pages.fetchPage]);
  const close = () => { if (!busy) { setReviewing(false); setError(""); onCloseHistory(); } };
  const run = async (type: "accept" | "reject" | "undo", changeId: string, columns?: ColumnConfig[]) => {
    setBusy(true); setError("");
    try {
      const proposals = mutations ? (await mutations.act({ type, changeId })).state.proposals
        : (await applyToTable(review!, changeId, type, columns)).proposals;
      await onChanged?.();
      if (type === "accept") setUndo(changeId);
      if (type === "undo") setUndo(null);
      if (reviewing && !proposals?.length) setReviewing(false);
    } catch (reason) { setError(errorMessage(reason, "Could not update this change. Review the current workspace and try again.")); }
    finally { setBusy(false); }
  };
  return <>
    {pending.length > 0 ? <div className="mb-2 flex shrink-0 items-center justify-between gap-2 border-b border-gray-200 pb-2 text-sm">
      <span>{pending.length} suggested {pending.length === 1 ? "change" : "changes"}</span>
      <Button variant="outline" size="compact" onClick={() => { setReviewing(true); setError(""); }}>Review</Button>
    </div> : undo ? <div className="mb-2 flex shrink-0 items-center justify-between gap-2 text-sm">
      <span role="status">Changes accepted</span><Button variant="outline" size="compact" disabled={busy}
        onClick={() => void run("undo", undo)}>Undo</Button>
    </div> : assistantChange && <div className="mb-2 flex shrink-0 items-center gap-2 border-b border-gray-200 pb-2 text-sm">
      <span role="status" className="min-w-0 flex-1 truncate" title={assistantChange.title}>Assistant: {assistantChange.title}</span>
      <Button variant="outline" size="compact" disabled={busy} onClick={() => void run("undo", assistantChange.id)}>Undo</Button>
      <Button variant="ghost" size="compact" aria-label="Dismiss" onClick={() => setDismissed(assistantChange.id)}>×</Button>
    </div>}
    {!open && error && <p role="alert" className="mb-2 text-sm text-red-700">{error}</p>}
    <Modal open={open} onClose={close} size="lg" breadcrumbs={[historyOpen ? `${file ? "Workspace" : "Table"} history` : "Review changes"]}
      footerStatus={error && <p role="alert" className="text-sm text-red-700">{error}</p>}>
      <div className="space-y-3 pb-3 text-sm">
        {visible.map((change) => { const proposed = file && change.status === "pending" && !historyOpen
          ? labelProposal(change, file) : null;
          return <details key={change.id} open={reviewing && !historyOpen} className="border-b border-gray-200 pb-3 last:border-0">
          <summary className="cursor-pointer font-medium text-gray-900">{change.title}</summary>
          <p className="my-2 text-xs text-gray-500">{change.executor === "human" ? "You" : "Assistant"} · {new Date(change.createdAt).toLocaleString()}
            {historyOpen && ` · ${change.status}`}</p>
          <p className="mb-2 text-xs text-gray-500">{Object.entries(change.counts).filter(([, count]) => count > 0)
            .map(([kind, count]) => `${count} ${count === 1 ? kind.replace(/s$/u, "") : kind}`).join(" · ")}</p>
          {review && change.status === "pending" && !historyOpen && isColumnProposal(change)
            ? <TableProposalReview review={review} change={change} busy={busy}
                onAccept={(columns) => void run("accept", change.id, columns ?? undefined)}
                onReject={() => void run("reject", change.id)} />
            : <>
              {proposed
                ? <SourcesWorkspace file={file}><ResearchTree sources={proposed.sources}
                    preview={{ labels: proposed.labels, marks: proposed.marks }} /></SourcesWorkspace>
                : <ul className="space-y-3">{descriptions(change, file, review, documents).map((item, index) => <li key={index}>
                <p className="font-medium text-gray-700">{item.label}</p>
                <del className="block whitespace-pre-wrap text-gray-500 [overflow-wrap:anywhere]">{item.before}</del>
                <ins className="block whitespace-pre-wrap text-green-800 no-underline [overflow-wrap:anywhere]">{item.after}</ins>
              </li>)}</ul>}
              <div className="mt-3 flex gap-2">
                {change.status === "pending" ? <><Button size="compact" disabled={busy} onClick={() => void run("accept", change.id)}>Accept changes</Button>
                  <Button variant="outline" size="compact" disabled={busy} onClick={() => void run("reject", change.id)}>Keep existing</Button></>
                  : change.status === "applied" && !undone.has(change.id) && <Button variant="outline" size="compact" disabled={busy}
                    onClick={() => void run("undo", change.id)}>Undo</Button>}
              </div>
            </>}
        </details>; })}
        {chain?.loading && <p role="status" className="text-gray-500">Loading changes…</p>}
        {!!chain?.error && <p role="alert" className="text-red-700">Could not load changes. <button type="button" className="underline"
          onClick={() => void pages.fetchPage("history", null, false)}>Retry</button></p>}
        {!chain?.loading && !chain?.error && !visible.length && <p className="text-gray-500">{reviewing ? "No pending changes." : "No changes yet."}</p>}
        {historyOpen && chain?.nextCursor && <Button variant="outline" size="compact" disabled={chain.loading}
          onClick={() => void pages.fetchPage("history", chain.nextCursor, true)}>Earlier changes</Button>}
      </div>
    </Modal>
  </>;
}

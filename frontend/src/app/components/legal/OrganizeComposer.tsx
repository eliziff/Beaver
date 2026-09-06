import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button } from "../ui/button";
import { errorMessage } from "@/app/lib/utils";
import { useSourcesWorkspace } from "./SourcesWorkspace";

export type OrganizeTarget = "labels" | "table";
const DEFAULTS: Record<OrganizeTarget, string> = {
  labels: "Organize the sources and passages in scope into labels that fit this research, refining existing labels where helpful.",
  table: "Arrange the research in scope in this table: choose rows, columns and grouping that suit the work so far.",
};
const PROPOSE = "Propose these changes for my review rather than applying them.";
/** The request the assistant receives: the user's own words (or the visible default) plus the review clause. */
export const organizeRequest = (target: OrganizeTarget, text: string, propose: boolean) =>
  [text.trim() || DEFAULTS[target], propose ? PROPOSE : ""].filter(Boolean).join(" ");
const count = (value: number, noun: string) => `${value} ${noun}${value === 1 ? "" : "s"}`;

export function OrganizeComposer({ target, onRun, onClose, facts, running, onCancel, chatHref }: {
  target: OrganizeTarget;
  onRun: (request: string, propose: boolean) => Promise<void>;
  onClose?: () => void;
  facts?: string;
  running?: boolean;
  onCancel?: () => void;
  chatHref?: string;
}) {
  const { file, selection } = useSourcesWorkspace();
  const [text, setText] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const restricted = !!(selection.sourceIds || selection.evidenceIds || selection.members || selection.labelIds);
  const sources = Object.values(file?.state.sources ?? {}).filter((source) => !restricted ||
    selection.sourceIds?.includes(source.id) || selection.members?.some(({ sourceId }) => sourceId === source.id));
  const passages = selection.evidenceIds?.length ?? sources.reduce((sum, { passages }) => sum + (passages?.count ?? 0), 0);
  const scope = facts ?? [count(sources.length, "source"), count(passages, "passage"),
    file?.state.chats?.length ? count(file.state.chats.length, "chat") : "",
    file?.state.tables?.length ? count(file.state.tables.length, "table") : ""].filter(Boolean).join(" · ") +
    (restricted ? " in the current selection" : "");
  async function run(propose: boolean) {
    setBusy(true); setError("");
    try { await onRun(organizeRequest(target, text, propose), propose); }
    catch (reason) { setError(errorMessage(reason, "Could not start organizing")); }
    finally { setBusy(false); }
  }
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void run(false); };
  if (running) return <div role="status" className="mb-2 flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-2 py-1.5 text-sm text-gray-700">
    <span className="min-w-0 flex-1 truncate">Organizing…</span>
    {chatHref && <Link to={chatHref} className="text-gray-600 underline">Open chat</Link>}
    {onCancel && <Button type="button" variant="outline" size="compact" onClick={onCancel}>Cancel</Button>}
  </div>;
  return <form aria-label={target === "labels" ? "Organize labels" : "Organize table"} onSubmit={submit}
    className="mb-2 space-y-1.5 rounded-md border border-gray-200 bg-gray-50 p-2">
    <p className="text-xs text-gray-500">{scope}</p>
    <textarea aria-label="Organization request" rows={2} value={text} placeholder={DEFAULTS[target]}
      onChange={(event) => setText(event.target.value)}
      onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void run(false); } }}
      className="w-full resize-none rounded-md border border-gray-300 bg-white px-2 py-1 text-sm" />
    <div className="flex flex-wrap items-center gap-1.5">
      <Button type="submit" size="compact" disabled={busy}>Organize</Button>
      <Button type="button" variant="outline" size="compact" disabled={busy} onClick={() => void run(true)}>Propose</Button>
      {onClose && <Button type="button" variant="ghost" size="compact" disabled={busy} onClick={onClose}>Cancel</Button>}
      {error && <span role="alert" className="text-xs text-red-700">{error}</span>}
    </div>
  </form>;
}

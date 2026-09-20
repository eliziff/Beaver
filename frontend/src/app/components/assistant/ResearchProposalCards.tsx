import { useEffect, useState } from "react";
import { applyWorkspaceLabels, getResearchItems, proposeWorkspaceLabels,
  type ResearchLabelDesign, type ResearchLabelProposal, type ResearchTableInput } from "@/app/lib/api/researchFiles";
import { errorMessage } from "@/app/lib/utils";
import { ResearchProposalEditor } from "../legal/ResearchProposalEditor";
import { useSourcesWorkspace } from "../legal/SourcesWorkspace";
import { Modal } from "../modals/Modal";
import { Button } from "../ui/button";

type Draft = { id: string; status: string; title: string; organization: {
  chatId?: string; design: ResearchLabelDesign; input: Omit<ResearchTableInput, "design">;
  fingerprint: string; items?: ResearchLabelProposal["items"];
  request?: string;
} };

/** Drafts live in workspace history, so closing the editor never erases a rejected proposal. */
export function ResearchProposalCards({ chatId, refreshKey }: { chatId: string; refreshKey: unknown }) {
  const { file, refresh } = useSourcesWorkspace();
  const [drafts, setDrafts] = useState<Draft[]>([]), [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const id = file?.document.id;
  useEffect(() => { setDrafts([]); setError(""); }, [id, chatId]);
  useEffect(() => {
    if (!id) return;
    setError("");
    let cancelled = false;
    void (async () => {
      const collected: Draft[] = [];
      let cursor: string | null = null;
      do {
        const page = await getResearchItems(id, { kind: "history", limit: 100, cursor });
        for (const item of page.items) {
          const draft = item.value as unknown as Draft;
          if (draft.organization?.design && draft.organization.chatId === chatId) collected.push(draft);
        }
        cursor = page.next_cursor;
      } while (cursor && !cancelled);
      if (!cancelled) setDrafts(collected.reverse());
    })().catch((reason) => { if (!cancelled) setError(errorMessage(reason, "Could not load organization drafts")); });
    return () => { cancelled = true; };
  }, [id, chatId, refreshKey, revision]);
  if (!id) return null;
  return <div className="space-y-3">
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {drafts.map((draft) => <ProposalCard key={draft.id} fileId={id} draft={draft} metadata={{
      sources: Object.values(file?.state.sources ?? {}).map((source) => ({ id: source.id, title: source.reference.title ?? source.reference.citation ?? source.reference.id })),
      items: draft.organization.items ?? [],
    }}
      onSaved={() => { setRevision((value) => value + 1); void refresh(); }} />)}
  </div>;
}

function ProposalCard({ draft, fileId, onSaved, metadata }: { draft: Draft; fileId: string; onSaved: () => void;
  metadata: Pick<ResearchLabelProposal, "sources" | "items"> }) {
  const [design, setDesign] = useState(draft.organization.design), [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const pending = draft.status === "pending";
  const dirty = JSON.stringify(design) !== JSON.stringify(draft.organization.design);
  async function save(apply: boolean) {
    setBusy(true); setError("");
    try {
      const input = { ...draft.organization.input, proposalId: draft.id, design, fingerprint: draft.organization.fingerprint };
      if (apply) await applyWorkspaceLabels(fileId, input);
      else await proposeWorkspaceLabels(fileId, input, () => undefined);
      setExpanded(false); onSaved();
    } catch (reason) { setError(errorMessage(reason, "Could not save this proposal")); }
    finally { setBusy(false); }
  }
  const editor = <ResearchProposalEditor proposal={metadata} design={design} onChange={setDesign} disabled={!pending || busy} />;
  const actions = pending && <div className="flex flex-wrap gap-2">
    <Button variant="outline" disabled={busy} onClick={() => void save(false)}>Save draft</Button>
    <Button disabled={busy} onClick={() => void save(true)}>Apply labels</Button>
  </div>;
  return <details open={pending} className="rounded-lg border border-gray-300 p-3">
    <summary className="cursor-pointer text-sm font-medium">{draft.title} · {pending ? "Draft" : draft.status === "applied" ? "Applied" : "Superseded"}</summary>
    {draft.organization.request && <p className="my-2 whitespace-pre-wrap text-sm text-gray-600">{draft.organization.request}</p>}
    <div className="my-2 flex justify-end"><Button variant="outline" onClick={() => setExpanded(true)}>Expand editor</Button></div>
    {!expanded && editor}
    {pending && dirty && <p role="status" className="my-2 text-xs text-gray-600">Unsaved edits. Save the draft so the chat can use them.</p>}
    {error && <p role="alert" className="my-2 text-sm text-red-700">{error}</p>}
    <div className="mt-3">{actions}</div>
    <Modal open={expanded} onClose={() => setExpanded(false)} breadcrumbs={["Organization proposal"]} size="lg">
      <div className="space-y-3 py-3">{editor}{actions}</div>
    </Modal>
  </details>;
}

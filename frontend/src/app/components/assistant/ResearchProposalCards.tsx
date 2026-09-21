import { useEffect, useRef, useState } from "react";
import { applyWorkspaceLabels, getResearchItems, proposeWorkspaceLabels,
  type ResearchLabelProposal } from "@/app/lib/api/researchFiles";
import type { ResearchChange, ResearchFile } from "@/app/lib/researchFiles";
import { errorMessage } from "@/app/lib/utils";
import { ResearchProposalEditor } from "../legal/ResearchProposalEditor";
import { useSourcesWorkspace } from "../legal/SourcesWorkspace";
import { Modal } from "../modals/Modal";
import { Button } from "../ui/button";

type Draft = ResearchChange & { organization: NonNullable<ResearchChange["organization"]> &
  Partial<Pick<ResearchLabelProposal, "sources" | "items">> };

/** Chat links to the review modal; it does not contain another copy of the workspace editor. */
export function ResearchProposalCards({ chatId, refreshKey }: { chatId: string; refreshKey: unknown }) {
  const { file, refresh } = useSourcesWorkspace();
  const [loaded, setLoaded] = useState<{ fileId: string; chatId: string; drafts: Draft[] } | null>(null);
  const [error, setError] = useState(""), [revision, setRevision] = useState(0);
  const id = file?.document.id;
  useEffect(() => {
    if (!id) return;
    let cancelled = false; const controller = new AbortController(); setError("");
    void (async () => {
      const drafts: Draft[] = [];
      let cursor: string | null = null;
      do {
        const page = await getResearchItems(id, { kind: "history", limit: 20, cursor }, controller.signal);
        if (cancelled) return;
        for (const item of page.items) {
          if (item.kind !== "change") continue;
          const draft = item.value as Draft;
          if (draft.organization?.design && draft.organization.chatId === chatId && !draft.supersededBy && draft.status !== "rejected") {
            drafts.push(draft); break;
          }
        }
        cursor = page.next_cursor;
      } while (cursor && !drafts.length);
      if (!cancelled) setLoaded({ fileId: id, chatId, drafts });
    })().catch((reason) => { if (!cancelled) setError(errorMessage(reason, "Could not load organization proposals")); });
    return () => { cancelled = true; controller.abort(); };
  }, [id, chatId, refreshKey, revision]);
  if (!file) return null;
  const drafts = loaded?.fileId === id && loaded.chatId === chatId ? loaded.drafts : [];
  return <div className="space-y-1">
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {drafts.map((draft) => <ProposalCard key={draft.id} file={file} draft={draft}
      onSaved={() => { setRevision((value) => value + 1); void refresh().catch((reason) => setError(errorMessage(reason, "Could not refresh the workspace"))); }} />)}
  </div>;
}

function ProposalCard({ draft, file, onSaved }: { draft: Draft; file: ResearchFile; onSaved: () => void }) {
  const [design, setDesign] = useState(draft.organization.design), [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const saving = useRef(false);
  const pending = draft.status === "pending" && !draft.supersededBy,
    dirty = JSON.stringify(design) !== JSON.stringify(draft.organization.design),
    status = draft.supersededBy ? "Superseded" : draft.status === "applied" ? "Applied" : pending ? "Draft" : "Discarded";
  const { sources, items } = draft.organization, available = !!sources && !!items;
  async function save(apply: boolean) {
    if (saving.current || !pending || !available) return;
    saving.current = true; setBusy(true); setError("");
    try {
      const input: Parameters<typeof applyWorkspaceLabels>[1] = { ...draft.organization.input, proposalId: draft.id, design,
        fingerprint: draft.organization.fingerprint };
      if (apply) await applyWorkspaceLabels(file.document.id, input);
      else await proposeWorkspaceLabels(file.document.id, input, () => undefined);
      setOpen(false); onSaved();
    } catch (reason) { setError(errorMessage(reason, "Could not save this proposal")); }
    finally { saving.current = false; setBusy(false); }
  }
  function close() {
    if (busy) return;
    if (pending && dirty) { void save(false); return; }
    setOpen(false);
  }
  return <>
    <div className="flex min-w-0 items-center gap-2 text-sm">
      <Button variant="ghost" size="compact" className="min-w-0 justify-start" title={draft.title} onClick={() => {
        setDesign(draft.organization.design); setError(""); setOpen(true);
      }}><span className="truncate">{pending ? "Review organization" : draft.title}</span></Button>
      <span className="shrink-0 text-xs text-gray-500">{status}</span>
    </div>
    {open && <Modal open onClose={close} breadcrumbs={["Organize research"]} size="lg"
      footerStatus={error ? <p role="alert" className="text-sm text-red-700">{error}</p> : !available
        ? <p role="alert" className="text-sm text-red-700">The original proposal material is unavailable. Ask for a refreshed proposal.</p> : undefined}
      secondaryAction={pending ? { label: "Save draft", disabled: busy || !available || !dirty, onClick: () => void save(false) } : undefined}
      primaryAction={pending ? { label: busy ? "Saving…" : "Apply labels", disabled: busy || !available, onClick: () => void save(true) } : undefined}>
      {available && <div className="py-4"><ResearchProposalEditor file={file} proposal={{ sources, items }}
        design={design} onChange={setDesign} disabled={!pending || busy} /></div>}
    </Modal>}
  </>;
}

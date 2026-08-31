import { ArrowDown, ArrowUp, BookOpen, Download, FilePlus2, FolderSearch,
  Loader2, Plus, RefreshCw, Scale } from "lucide-react";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState,
  type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { DraftMenu } from "@/app/components/shared/DraftMenu";
import { LibraryDocumentPicker } from "@/app/components/shared/LibraryDocumentPicker";
import { MoreActionsMenu } from "@/app/components/shared/MoreActionsMenu";
import type { Document } from "@/app/components/shared/types";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { downloadBlob } from "@/app/lib/download";
import { cn } from "@/app/lib/utils";
import type { AuthoritiesFile, AuthoritiesHost, AuthoritiesSourceIssue } from "./host";
import type { AuthoritiesAction, AuthoritiesOutputMode, AuthoritiesProduct,
  AuthorityIdentity, AuthorityKind, AuthorityOccurrence } from "./types";

export function AuthoritiesWorkspace({ host, headerActions,
  onDraftChange, refreshToken }: {
  host: AuthoritiesHost;
  headerActions?: ReactNode;
  onDraftChange?: (draft?: AuthoritiesProduct) => void;
  refreshToken?: number;
}) {
  const [params, setParams] = useSearchParams();
  const requested = params.get("draft") ?? "";
  const requestedRef = useRef(requested);
  requestedRef.current = requested;
  const projectId = params.get("project") || undefined;
  const [drafts, setDrafts] = useState<AuthoritiesProduct[]>([]);
  const [draft, setDraft] = useState<AuthoritiesProduct>();
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Document[]>([]);
  const [searching, setSearching] = useState(false);
  const [sourceIssues, setSourceIssues] = useState<Record<string, AuthoritiesSourceIssue>>({});
  const refreshDraftEffect = useEffectEvent(async () => {
    if (!draft) return;
    try {
      const next = await host.get(draft.id);
      if (next.revision > draft.revision) remember(next);
    } catch (caught) { setError(errorText(caught)); }
  });
  const display = useCallback((next?: AuthoritiesProduct) => {
    setDraft(next);
    setSelectedId(orderedOccurrences(next)[0]?.id ?? "");
    setError(""); setMessage("");
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    const exactId = requestedRef.current;
    void Promise.all([host.list(projectId), exactId ? host.get(exactId) : null])
      .then(([items, exact]) => {
        if (!active) return;
        setDrafts(items);
        display(exact ?? items[0]);
      }).catch((caught) => active && setError(errorText(caught)))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [projectId, display, host]);

  useEffect(() => {
    if (loading || !requested || requested === draft?.id) return;
    const saved = drafts.find(({ id }) => id === requested);
    if (saved) { display(saved); return; }
    void host.get(requested).then((next) => { remember(next); display(next); })
      .catch((caught) => setError(errorText(caught)));
  }, [requested, loading, draft?.id, drafts, display, host]);

  useEffect(() => { onDraftChange?.(busy ? undefined : draft); },
    [draft, busy, onDraftChange]);

  useEffect(() => {
    let active = true;
    if (!draft || !host.sourceIssues) {
      setSourceIssues({});
      return () => { active = false; };
    }
    void host.sourceIssues(draft).then((issues) => active && setSourceIssues(issues))
      .catch((caught) => active && setError(errorText(caught)));
    return () => { active = false; };
  }, [draft, host]);

  useEffect(() => {
    if (refreshToken !== undefined) void refreshDraftEffect();
  }, [refreshToken]);

  const occurrences = useMemo(() => orderedOccurrences(draft), [draft]);
  const selected = occurrences.find(({ id }) => id === selectedId) ?? occurrences[0];
  const authorities = draft?.state.authorityOrder.flatMap((id) => {
    const authority = draft.state.authorities[id];
    return authority ? [authority] : [];
  }) ?? [];
  const missingPdfs = authorities.filter((item) => !item.excluded && item.source.kind !== "attached");
  const needsPdfs = draft?.state.outputMode !== "table";
  const importedRole = draft?.state.import.kind === "document"
    ? draft.state.import.bindingRole : undefined;
  const importedIssue = importedRole ? sourceIssues[importedRole] : undefined;

  function remember(next: AuthoritiesProduct) {
    setDraft(next);
    setDrafts((current) => [next, ...current.filter(({ id }) => id !== next.id)]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  }
  function open(next?: AuthoritiesProduct, navigate = true) {
    display(next);
    if (navigate) {
      const nextParams = new URLSearchParams(params);
      if (next) nextParams.set("draft", next.id); else nextParams.delete("draft");
      setParams(nextParams, { replace: true });
    }
  }
  async function run<T>(operation: () => Promise<T>, done: (value: T) => void,
    success = "") {
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try { const value = await operation(); done(value); setMessage(success); }
    catch (caught) { setError(errorText(caught)); }
    finally { setBusy(false); }
  }
  const act = (action: AuthoritiesAction) => draft && run(
    () => host.act(draft.id, draft.revision, action), remember);

  function createManual() {
    void run(() => host.create({ source: { kind: "manual" },
      title: "Book of Authorities", projectId }), (next) => { remember(next); open(next); });
  }
  function createFromDocument(document: Document) {
    void run(() => host.create({ source: { kind: "document", document },
      title: document.filename.replace(/\.[^.]+$/u, "") || "Authorities", projectId }),
    (next) => { remember(next); open(next); setLibraryOpen(false); }, "Citations found");
  }
  function addFile(selected?: AuthoritiesFile) {
    if (!selected) return;
    void run(() => host.create({ source: { kind: "file", selected },
      title: selected.file.name.replace(/\.[^.]+$/u, ""), projectId }),
    (next) => { remember(next); open(next); }, "Citations found");
  }
  async function pickFile(done: (selected?: AuthoritiesFile) => void) {
    try { done((await host.pickFiles?.(false))?.[0]); }
    catch (caught) {
      if ((caught as { name?: string })?.name !== "AbortError") setError(errorText(caught));
    }
  }
  function search(value: string) {
    setQuery(value); setSearching(true);
    void host.searchLibrary?.(value).then(setResults)
      .catch((caught) => setError(errorText(caught))).finally(() => setSearching(false));
  }
  function attach(authorityId: string, selected?: AuthoritiesFile) {
    if (!draft || !selected) return;
    void run(() => host.attach(draft.id, authorityId, draft.revision, selected),
      remember, `${selected.file.name} attached`);
  }
  function relinkSource(role: string) {
    if (!draft || !host.relinkSource) return;
    void run(() => host.relinkSource!(draft.id, role, draft.revision), remember,
      "Source relinked");
  }
  function rename(title: string) {
    if (!draft) return;
    void run(() => host.update(draft.id, draft.revision, title), remember);
  }
  function duplicate() {
    if (!draft) return;
    void run(() => host.duplicate(draft.id, `${draft.title} copy`),
      (next) => { remember(next); open(next); });
  }
  function removeDraft() {
    if (!draft) return;
    const id = draft.id;
    void run(() => host.remove(id), () => {
      const next = drafts.find((item) => item.id !== id);
      setDrafts((current) => current.filter((item) => item.id !== id));
      open(next);
    });
  }
  function build() {
    if (!draft || needsPdfs && missingPdfs.length) return;
    void run(() => host.build(draft.id, draft.revision), ({ product }) => remember(product),
      "Outputs ready");
  }

  if (loading) return <div className="flex min-h-full items-center justify-center" role="status"><Loader2 className="mr-2 h-4 w-4 motion-safe:animate-spin" /> Loading authorities</div>;
  return <div className="authorities-workspace min-h-full bg-[#f5f5f4] lg:h-full lg:min-h-0 lg:overflow-y-auto">
    <header className="border-b border-gray-200/80 bg-white/90 backdrop-blur">
      <div className="builder-header mx-auto flex max-w-[82rem] flex-wrap items-center justify-between gap-3 py-4 pe-4 ps-16 lg:px-6">
        <h1 className="font-serif text-2xl font-semibold text-gray-950">Authorities</h1>
        <div className="flex min-w-0 max-w-full items-center gap-2">
          {headerActions}
          <DraftMenu drafts={drafts} current={draft} busy={busy} itemLabel="authorities"
            onNew={() => open(undefined)} onOpen={open} onRename={rename}
            onDuplicate={duplicate} onDelete={removeDraft} />
        </div>
      </div>
    </header>
    {!draft ? <Start busy={busy} status={error || message} error={!!error} onFile={(file) =>
      addFile(file && { file })} onPick={host.pickFiles ? () => void pickFile(addFile) : undefined}
      onLibrary={host.searchLibrary ? () => { setLibraryOpen(true); search(""); } : undefined}
      onManual={createManual} /> :
      <div className="authorities-layout mx-auto grid max-w-[82rem] gap-5 px-4 py-5 sm:px-6">
        <div className="contents">
          <section className="authorities-citations min-w-0 rounded-xl border border-gray-200 bg-white shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-4 py-3">
              <div className="min-w-0"><h2 className="text-base font-semibold text-gray-950">Citations</h2>
                <p className="truncate text-xs text-gray-500">{draft.state.import.kind === "document" ? draft.state.import.filename : "Manual book"}</p></div>
              {draft.state.import.kind === "document" && <div className="flex flex-wrap gap-2">
                {importedRole && importedIssue && host.relinkSource && <Button type="button" variant="outline"
                  className="h-9 border-gray-400" disabled={busy}
                  onClick={() => relinkSource(importedRole)}><FilePlus2 />
                  {sourceAction(importedIssue, "source")}</Button>}
                <Button type="button" variant="outline" className="h-9" disabled={busy}
                  onClick={() => void run(() => host.refresh(draft.id, draft.revision), remember,
                    "Citations refreshed")}><RefreshCw /> Refresh</Button>
              </div>}
            </div>
            <CitationReview occurrences={occurrences} units={draft.state.units} selected={selected}
              authorities={authorities} onSelect={setSelectedId} onAction={act} />
          </section>
          <section className="authorities-sources min-w-0 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-base font-semibold text-gray-950">Sources</h2>
              <span className="text-xs text-gray-500">{authorities.length}</span></div>
            <div className="mt-3 space-y-2">{authorities.map((authority, index) => <AuthorityRow
              key={authority.id} authority={authority} index={index}
              order={draft.state.authorityOrder}
              busy={busy} removable={!occurrences.some(({ authorityId }) => authorityId === authority.id)}
              onAction={act} onPick={host.pickFiles
                ? () => void pickFile((selected) => attach(authority.id, selected)) : undefined}
              issue={authority.source.kind === "attached"
                ? sourceIssues[authority.source.bindingRole] : undefined}
              onRelink={host.relinkSource ? () => {
                if (authority.source.kind === "attached")
                  relinkSource(authority.source.bindingRole);
              } : undefined}
              onAttach={(file) => attach(authority.id, file && { file })} />)}
              {!authorities.length && <p className="rounded-lg border border-dashed border-gray-300 px-4 py-8 text-center text-sm text-gray-500">No authorities yet.</p>}
            </div>
            <AddAuthority disabled={busy} onAdd={(kind, citation, name) => act({ type: "add-authority", kind, citation, name })} />
          </section>
        </div>
        <aside className="authorities-build min-w-0" aria-label="Build outputs">
          <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
            <h2 className="text-base font-semibold text-gray-950">Create</h2>
            <OutputMode value={draft.state.outputMode} disabled={busy}
              onChange={(outputMode) => act({ type: "set-output-mode", outputMode })} />
            {draft.state.import.kind === "document" &&
              draft.state.import.fileType === "docx" &&
              <label className="mt-2 flex min-h-10 cursor-pointer items-center gap-2 rounded-md px-2 text-sm text-gray-700 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-red-600">
                <input type="checkbox" className="h-4 w-4 accent-red-700" disabled={busy}
                  checked={draft.state.insertIntoDocument}
                  onChange={(event) => act({ type: "set-document-output",
                    enabled: event.target.checked })} />
                Create Word copy with table
              </label>}
            {needsPdfs && !!missingPdfs.length && <p className="mt-3 text-sm leading-5 text-amber-800">Attach {missingPdfs.length} source PDF{missingPdfs.length === 1 ? "" : "s"} to build the book.</p>}
            <Button type="button" className="mt-3 h-11 w-full" disabled={busy || needsPdfs && !!missingPdfs.length} onClick={build}>
              {busy ? <Loader2 className="motion-safe:animate-spin" /> : <BookOpen />} Build
            </Button>
            <p className={cn("mt-2 min-h-5 text-center text-xs", error ? "text-red-700" : "text-gray-600")} role="status" aria-live="polite">{error || message}</p>
            {!!Object.keys(draft.outputs).length && <div className="mt-2 border-t border-gray-100 pt-2">{Object.entries(draft.outputs).map(([role, output]) => <button key={role} type="button"
              aria-label={`Download ${output.filename}`} title={output.filename}
              onClick={() => void host.download(output.documentId, output.versionId)
                .then((blob) => downloadBlob(blob, output.filename))}
              className="grid min-h-10 w-full grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-2 text-left text-sm outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-red-600"><Download className="h-4 w-4 text-red-700" /><span className="font-medium text-gray-900">{role === "table" ? "Table" : role === "book" ? "Book" : "Word copy"}</span><span className="min-w-0 truncate text-gray-500">{output.filename}</span><span className="text-[11px] uppercase text-gray-500">{output.filename.split(".").at(-1)}</span></button>)}</div>}
          </section>
        </aside>
      </div>}
    <LibraryDocumentPicker open={libraryOpen} title="Choose source document" formatLabel="PDF or Word"
      query={query} results={results} busy={searching} onQuery={search}
      onSelect={createFromDocument} onClose={() => setLibraryOpen(false)} />
  </div>;
}

function Start({ busy, status, error, onFile, onPick, onLibrary, onManual }: { busy: boolean;
  status: string; error: boolean;
  onFile: (file?: File) => void; onPick?: () => void; onLibrary?: () => void;
  onManual: () => void }) {
  return <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
    <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
      <Scale className="h-7 w-7 text-red-700" aria-hidden="true" />
      <h2 className="mt-4 font-serif text-2xl font-semibold text-gray-950">Start with a document</h2>
      <div className="mt-6 flex flex-wrap gap-2">
        {onPick ? <Button type="button" className="h-11" disabled={busy} onClick={onPick}>
          <FilePlus2 /> Add file</Button> : <label className={cn("inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg bg-gray-950 px-4 text-sm font-medium text-white focus-within:ring-2 focus-within:ring-red-600 focus-within:ring-offset-2", busy && "pointer-events-none opacity-50")}><FilePlus2 className="h-4 w-4" /> Add file
          <input className="sr-only" type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" disabled={busy}
            onChange={(event) => { onFile(event.target.files?.[0]); event.target.value = ""; }} /></label>}
        {onLibrary && <Button type="button" variant="outline" className="h-11 border-gray-400" disabled={busy} onClick={onLibrary}><FolderSearch /> Library</Button>}
        <Button type="button" variant="ghost" className="h-11" disabled={busy} onClick={onManual}><Plus /> Blank book</Button>
      </div>
      <p className={cn("mt-4 min-h-5 text-sm", error ? "text-red-700" : "text-gray-600")} role="status" aria-live="polite">{busy ? "Finding citations…" : status}</p>
    </section>
  </div>;
}

function CitationReview({ occurrences, units, selected, authorities, onSelect, onAction }: {
  occurrences: AuthorityOccurrence[]; selected?: AuthorityOccurrence;
  units: AuthoritiesProduct["state"]["units"];
  authorities: AuthorityIdentity[]; onSelect: (id: string) => void;
  onAction: (action: AuthoritiesAction) => void;
}) {
  if (!occurrences.length) return <p className="px-4 py-10 text-center text-sm text-gray-500">No citations found.</p>;
  const unit = units.find(({ id }) => id === selected?.unitId);
  const unitText = unit?.text ?? selected?.text ?? "";
  return <div className="authorities-review grid min-h-72">
    <div className="authorities-review-list max-h-[32rem] overflow-y-auto border-gray-100 p-2" aria-label="Detected citations">
      {occurrences.map((item, index) => {
        const authority = authorities.find(({ id }) => id === item.authorityId);
        return <button key={item.id} type="button"
        aria-current={item.id === selected?.id || undefined} onClick={() => onSelect(item.id)}
        className={cn("block min-h-11 w-full rounded-lg border-s-2 px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-red-600", item.id === selected?.id ? "border-red-700 bg-red-50" : item.reviewed ? "border-transparent hover:bg-gray-50" : "border-amber-500 hover:bg-amber-50")}>
        <span className="block text-[11px] text-gray-500">{location(item, index)}</span>
        {authority && authorityName(authority) !== authority.citation &&
          <span className="block truncate text-sm font-medium text-gray-900">{authorityName(authority)}</span>}
        <span className="block truncate text-xs font-medium text-gray-700">{authority?.citation ?? item.citation}</span>
      </button>;})}
    </div>
    {selected && <CitationEditor key={selected.id} selected={selected} unitText={unitText}
      footnote={unit?.kind === "footnote"} canMerge={(unit?.occurrenceIds.indexOf(selected.id) ?? 0) > 0}
      authorities={authorities} onAction={onAction} />}
  </div>;
}

function CitationEditor({ selected, unitText, footnote, canMerge, authorities, onAction }: {
  selected: AuthorityOccurrence; unitText: string; footnote: boolean; canMerge: boolean;
  authorities: AuthorityIdentity[]; onAction: (action: AuthoritiesAction) => void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const rememberCursor = () => setCursor(selectionOffset(surface.current));
  const context = highlight(unitText, selected);
  return <div className="min-w-0 p-4">
      {footnote ? <div ref={surface} contentEditable suppressContentEditableWarning role="textbox"
        aria-readonly="true" aria-label="Citation context" spellCheck={false}
        onMouseUp={rememberCursor} onKeyUp={rememberCursor}
        onBeforeInput={(event) => event.preventDefault()} onPaste={(event) => event.preventDefault()}
        onDrop={(event) => event.preventDefault()} onKeyDown={(event) => {
          if ((!event.ctrlKey && !event.metaKey && event.key.length === 1) ||
              ["Backspace", "Delete", "Enter"].includes(event.key)) event.preventDefault();
        }} className="whitespace-pre-wrap rounded-lg bg-gray-50 p-3 text-sm leading-6 text-gray-800 outline-none focus-visible:ring-2 focus-visible:ring-red-600">{context}</div>
        : <p className="whitespace-pre-wrap rounded-lg bg-gray-50 p-3 text-sm leading-6 text-gray-800">{context}</p>}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-medium text-gray-600">Authority
          <select value={selected.authorityId ?? ""} onChange={(event) => onAction({ type: "relink-occurrence", occurrenceId: selected.id, authorityId: event.target.value || null })}
            className="mt-1 h-10 w-full rounded-lg border border-gray-400 bg-white px-2 text-base text-gray-900 outline-none focus-visible:ring-2 focus-visible:ring-red-600">
            <option value="">Not linked</option>{authorities.map((item) => <option key={item.id} value={item.id}>{item.citation}</option>)}
          </select>
        </label>
        <label className="text-xs font-medium text-gray-600">Citation form
          <select value={selected.reference?.kind ?? "full"} disabled={!selected.authorityId}
            onChange={(event) => onAction({ type: "set-reference", occurrenceId: selected.id,
              reference: event.target.value === "full" || !selected.authorityId ? null : { kind: event.target.value as "supra" | "ibid", targetAuthorityId: selected.authorityId } })}
            className="mt-1 h-10 w-full rounded-lg border border-gray-400 bg-white px-2 text-base text-gray-900 outline-none focus-visible:ring-2 focus-visible:ring-red-600 disabled:bg-gray-100">
            <option value="full">Full citation</option><option value="supra">Supra</option><option value="ibid">Ibid</option>
          </select>
        </label>
      </div>
      {footnote && <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" variant="outline" className="h-9"
          disabled={cursor === null || cursor <= selected.start || cursor >= selected.end}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => cursor !== null && onAction({ type: "split-occurrence",
            occurrenceId: selected.id, cursor })}>Split at cursor</Button>
        {canMerge && <Button type="button" variant="ghost" className="h-9"
          onClick={() => onAction({ type: "merge-occurrence", occurrenceId: selected.id })}>Merge with previous</Button>}
      </div>}
    </div>;
}

function AuthorityRow({ authority, index, order, busy, onAction,
  removable, issue, onPick, onRelink, onAttach }: {
  authority: AuthorityIdentity; index: number; order: string[]; busy: boolean;
  removable: boolean; onAction: (action: AuthoritiesAction) => void;
  issue?: AuthoritiesSourceIssue; onPick?: () => void; onRelink?: () => void;
  onAttach: (file?: File) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(authorityName(authority));
  return <article className="rounded-lg border border-gray-200 p-3" onDragOver={(event) => event.preventDefault()}
    onDrop={(event) => { event.preventDefault(); onAttach(event.dataTransfer.files[0]); }}>
    <div className="flex items-start gap-3"><span className="mt-0.5 text-xs font-semibold tabular-nums text-gray-500">{index + 1}</span>
      <div className="min-w-0 flex-1">{editing ? <form className="flex max-w-xl gap-2" onSubmit={(event) => {
        event.preventDefault(); onAction({ type: "rename-authority", authorityId: authority.id,
          displayName: name.trim() || null }); setEditing(false);
      }}><Input autoFocus aria-label="Authority label" value={name} onChange={(event) => setName(event.target.value)} className="h-9 border-gray-400 md:text-sm" />
        <Button type="submit" className="h-9" disabled={busy}>Save</Button><Button type="button" className="h-9" variant="ghost" onClick={() => { setName(authorityName(authority)); setEditing(false); }}>Cancel</Button></form>
        : <h3 className="text-sm font-medium text-gray-950">{authorityName(authority)}</h3>}
        {authority.name && authority.name !== authority.citation && <p className="mt-0.5 text-xs text-gray-500">{authority.citation}</p>}</div>
      <div className="flex shrink-0 gap-1">
        {index > 0 && <Button type="button" variant="ghost" size="icon-sm" className="hidden h-9 w-9 text-gray-500 disabled:opacity-30 sm:inline-flex"
          disabled={busy} aria-label={`Move ${authorityName(authority)} up`}
          onClick={() => onAction({ type: "reorder-authorities", authorityIds: moveId(order, index, index - 1) })}><ArrowUp /></Button>}
        {index < order.length - 1 && <Button type="button" variant="ghost" size="icon-sm" className="hidden h-9 w-9 text-gray-500 disabled:opacity-30 sm:inline-flex"
          disabled={busy} aria-label={`Move ${authorityName(authority)} down`}
          onClick={() => onAction({ type: "reorder-authorities", authorityIds: moveId(order, index, index + 1) })}><ArrowDown /></Button>}
        <MoreActionsMenu label={`Options for ${authorityName(authority)}`}
          triggerClassName="h-9 w-9 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-red-600"
          items={[
            ...(index > 0 ? [{ label: "Move up", disabled: busy,
              onSelect: () => onAction({ type: "reorder-authorities", authorityIds: moveId(order, index, index - 1) }) }] : []),
            ...(index < order.length - 1 ? [{ label: "Move down", disabled: busy,
              onSelect: () => onAction({ type: "reorder-authorities", authorityIds: moveId(order, index, index + 1) }) }] : []),
            { label: "Edit label", onSelect: () => { setName(authorityName(authority)); setEditing(true); } },
            { label: "Remove", disabled: busy || !removable,
              onSelect: () => onAction({ type: "remove-authority", authorityId: authority.id }) },
          ]} />
      </div>
    </div>
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {authority.source.kind === "pending-canlii" && <a href={authority.source.pdfUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-9 items-center rounded-md bg-red-700 px-3 text-sm font-medium text-white outline-none hover:bg-red-800 focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2">Download from CanLII</a>}
      {authority.source.kind === "attached" ? <span className="min-w-0 truncate text-xs text-gray-600">{authority.source.filename}</span>
        : onPick ? <Button type="button" variant="outline" className="h-9 border-gray-400" disabled={busy} onClick={onPick}><FilePlus2 /> {authority.source.kind === "pending-canlii" ? "Add downloaded PDF" : "Add PDF"}</Button>
          : <label className="inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-md border border-gray-400 px-3 text-sm font-medium text-gray-700 outline-none focus-within:ring-2 focus-within:ring-red-600"><FilePlus2 className="h-4 w-4" /> {authority.source.kind === "pending-canlii" ? "Add downloaded PDF" : "Add PDF"}
          <input className="sr-only" type="file" accept=".pdf,application/pdf" disabled={busy} onChange={(event) => { onAttach(event.target.files?.[0]); event.target.value = ""; }} /></label>}
      {issue && onRelink && <Button type="button" variant="outline" className="h-9 border-gray-400"
        disabled={busy} onClick={onRelink}><FilePlus2 /> {sourceAction(issue, "PDF")}</Button>}
      {authority.source.kind === "unresolved" && authority.kind === "case" && <button type="button" disabled={busy} onClick={() => onAction({ type: "begin-canlii-handoff", authorityId: authority.id })} className="min-h-9 rounded-md px-2 text-sm text-gray-700 outline-none hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-red-600">CanLII</button>}
      <label className="ml-auto inline-flex min-h-9 items-center gap-2 text-sm text-gray-700"><input type="checkbox" checked={authority.excluded} disabled={busy}
        onChange={(event) => onAction({ type: "exclude-authority", authorityId: authority.id, excluded: event.target.checked })} className="h-4 w-4 accent-red-700" /> Leave out of book</label>
    </div>
  </article>;
}

function AddAuthority({ disabled, onAdd }: { disabled: boolean;
  onAdd: (kind: AuthorityKind, citation: string, name: string | null) => void }) {
  const [citation, setCitation] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<AuthorityKind>("case");
  return <details className="group mt-3 border-t border-gray-100 pt-3">
    <summary className="flex min-h-10 w-fit cursor-pointer list-none items-center gap-1.5 rounded-md px-2 text-sm font-medium text-gray-700 outline-none hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-red-600 [&::-webkit-details-marker]:hidden"><Plus className="h-4 w-4" /> Add authority</summary>
    <div className="mt-2 grid gap-2 sm:grid-cols-[9rem_minmax(0,1fr)_minmax(0,1fr)_auto]">
      <select aria-label="Authority type" value={kind} onChange={(event) => setKind(event.target.value as AuthorityKind)} className="h-10 rounded-lg border border-gray-400 bg-white px-2 text-base focus-visible:ring-2 focus-visible:ring-red-600"><option value="case">Case</option><option value="legislation">Legislation</option><option value="commentary">Commentary</option><option value="other">Other</option></select>
      <Input aria-label="Citation" placeholder="Citation" value={citation} onChange={(event) => setCitation(event.target.value)} className="h-10 border-gray-400 md:text-base" />
      <Input aria-label="Name" placeholder="Name (optional)" value={name} onChange={(event) => setName(event.target.value)} className="h-10 border-gray-400 md:text-base" />
      <Button type="button" disabled={disabled || !citation.trim()} onClick={() => { onAdd(kind, citation.trim(), name.trim() || null); setCitation(""); setName(""); }}>Add</Button>
    </div>
  </details>;
}

function OutputMode({ value, disabled, onChange }: { value: AuthoritiesOutputMode;
  disabled: boolean; onChange: (value: AuthoritiesOutputMode) => void }) {
  return <fieldset className="mt-3 grid grid-cols-3 rounded-lg bg-gray-100 p-1"><legend className="sr-only">Output</legend>
    {(["table", "book", "both"] as const).map((mode) => <label key={mode} className={cn("flex min-h-9 cursor-pointer items-center justify-center rounded-md px-2 text-sm font-medium capitalize has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-red-600", value === mode ? "bg-white text-gray-950 shadow-sm" : "text-gray-600 hover:text-gray-950")}><input className="sr-only" type="radio" name="authorities-output" value={mode} checked={value === mode} disabled={disabled} onChange={() => onChange(mode)} />{mode}</label>)}
  </fieldset>;
}

function orderedOccurrences(draft?: AuthoritiesProduct) {
  if (!draft) return [];
  return draft.state.units.flatMap((unit) => unit.occurrenceIds
    .flatMap((id) => draft.state.occurrences[id] ? [draft.state.occurrences[id]] : []));
}
function highlight(text: string, occurrence: AuthorityOccurrence) {
  if (occurrence.end <= text.length && occurrence.start < occurrence.end) return <>{text.slice(0, occurrence.start)}<mark className="rounded bg-amber-200 px-0.5 text-inherit">{text.slice(occurrence.start, occurrence.end)}</mark>{text.slice(occurrence.end)}</>;
  return <mark className="rounded bg-amber-200 px-0.5 text-inherit">{text}</mark>;
}
function location(item: AuthorityOccurrence, index: number) {
  const footnote = /^footnote:(\d+)$/u.exec(item.unitId);
  return footnote ? `Footnote ${footnote[1]}` : `Citation ${index + 1}`;
}
function authorityName(item: AuthorityIdentity) {
  return item.displayName || item.name || item.citation || "Untitled authority";
}
function moveId(order: string[], from: number, to: number) {
  const ids = [...order];
  ids.splice(to, 0, ids.splice(from, 1)[0]);
  return ids;
}
function selectionOffset(root: HTMLElement | null) {
  const selection = window.getSelection();
  if (!root || !selection?.anchorNode || !root.contains(selection.anchorNode)) return null;
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(selection.anchorNode, selection.anchorOffset);
  return range.toString().length;
}
function sourceAction(issue: AuthoritiesSourceIssue, label: string) {
  if (issue.status === "changed") return `Use updated ${label}`;
  return issue.reason === "permission" ? "Allow file access" : `Relink ${label}`;
}
function errorText(error: unknown) {
  return error instanceof Error ? error.message : "Authorities could not be updated.";
}

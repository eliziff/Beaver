import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { checkpointDocumentVersion, compareDocumentVersions, downloadDocument, getDocument,
    listDocumentVersions, restoreDocumentVersion, uploadDocumentVersion,
    type Document, type DocumentVersion } from "@/app/lib/api/documents";
import { downloadBlob } from "@/app/lib/download";
import { BeaverApiError } from "@/app/lib/api/client";

export type DocumentAction = "rename" | "upload" | "checkpoint" | "restore" | "compare" | "download";
type History = { currentVersionId: string | null; versions: DocumentVersion[];
    loaded?: boolean; loading?: boolean; error?: boolean; pendingAction?: DocumentAction; actionError?: string };
export type DocumentController = ReturnType<typeof useDocumentController>;
export function useDocumentController(documents: Document[],
    refreshCollection: (parent?: string | null) => Promise<void>, onError: (message: string) => void,
    initialDocument?: { id: string; versionId?: string | null }) {
    const docsById = useMemo(() => new Map(documents.map((doc) => [doc.id, doc])), [documents]);
    const [histories, setHistories] = useState(new Map<string, History>());
    const [selection, setSelection] = useState<{ doc: Document; versionId: string | null } | null>(null);
    const [pendingRestore, setPendingRestore] = useState<{ docId: string; version: DocumentVersion } | null>(null);
    const locks = useRef(new Set<string>()), activeId = useRef<string | null>(null);
    let doc = selection ? docsById.get(selection.doc.id) ?? selection.doc : null;
    if (doc && selection && ((doc.active_version_number ?? 0) < (selection.doc.active_version_number ?? 0)
        || doc.current_version_id === selection.doc.current_version_id
        && (doc.current_working_revision ?? -1) < (selection.doc.current_working_revision ?? -1))) doc = selection.doc;
    activeId.current = doc?.id ?? null;
    const history = doc ? histories.get(doc.id) : undefined, versions = history?.versions ?? [];
    const currentId = history?.currentVersionId ?? doc?.current_version_id ?? null;
    const current = versions.find(({ id }) => id === currentId) ?? null;
    const selected = versions.find(({ id }) => id === selection?.versionId) ?? current ?? versions[0] ?? null;
    const selectedId = selected?.id ?? selection?.versionId ?? currentId;
    const priorCurrent = current ? versions.find(({ version_number }) => version_number < current.version_number) ?? null : null;
    function update(id: string, patch: Partial<History>) {
        setHistories((all) => new Map(all).set(id, { currentVersionId: null, versions: [], ...all.get(id), ...patch }));
    }
    async function load(id: string, force = false) {
        if (!force && histories.get(id)?.loaded) return histories.get(id);
        update(id, { loading: true, error: false });
        try {
            const result = await listDocumentVersions(id);
            const history = { loaded: true, currentVersionId: result.current_version_id, versions: result.versions };
            update(id, history);
            return history;
        } catch (error) { console.error("listDocumentVersions failed", error); update(id, { error: true }); }
        finally { update(id, { loading: false }); }
    }
    const loadSelected = useEffectEvent(load);
    useEffect(() => { if (doc?.id) void loadSelected(doc.id); }, [doc?.id]);
    useEffect(() => {
        if (!initialDocument?.id) return;
        let cancelled = false;
        void getDocument(initialDocument.id).then((doc) => {
            if (!cancelled) setSelection({ doc, versionId: initialDocument.versionId ?? null });
        }).catch((error: Error) => { if (!cancelled) onError(error.message); });
        return () => { cancelled = true; };
    }, [initialDocument?.id, initialDocument?.versionId]);
    function head(id: string, document?: Document) {
        const history = histories.get(id), current = document ? { id: document.current_version_id, working_revision: document.current_working_revision } : history?.versions.find(({ id }) => id === history.currentVersionId);
        if (!current?.id || current.working_revision == null) throw new Error("Document revision is unavailable");
        return { id: current.id, working_revision: current.working_revision };
    }
    async function action(id: string, action: DocumentAction, mutation: () => Promise<Document | void>, refresh = false) {
        if (locks.current.has(id)) return false;
        locks.current.add(id);
        update(id, { pendingAction: action, actionError: undefined });
        try { const updated = await mutation();
            if (updated) setSelection((current) => current?.doc.id === id ? { ...current, doc: updated } : current);
            return true; }
        catch (error) {
            const latest = error instanceof BeaverApiError && error.status === 409
                ? await getDocument(id).catch(console.error) : undefined;
            if (latest) setSelection((current) => current?.doc.id === id ? { doc: latest, versionId: null } : current);
            const message = latest ? "This document changed; review the current version and try again." : `Could not ${{ rename: "rename this document", upload: "upload the new version",
                checkpoint: "create this version", restore: "restore this version", compare: "create the comparison",
                download: "download this version" }[action]}.`;
            update(id, { actionError: message });
            if (activeId.current !== id) onError(message);
            return false;
        } finally {
            if (refresh) await Promise.all([load(id, true), refreshCollection(docsById.get(id)?.folder_id)]).catch(console.error);
            locks.current.delete(id);
            update(id, { pendingAction: undefined });
        }
    }
    function selectMutated(id: string, version: DocumentVersion) {
        setSelection((current) => current?.doc.id === id ? { ...current, versionId: version.id, doc: { ...current.doc, filename: version.filename ?? current.doc.filename, current_version_id: version.id, current_working_revision: version.working_revision, active_version_number: version.version_number } } : current);
    }
    function forget(ids: Set<string>) {
        setHistories((all) => new Map([...all].filter(([id]) => !ids.has(id))));
        setSelection((current) => current && ids.has(current.doc.id) ? null : current);
    }
    async function restore() {
        if (!pendingRestore) return;
        const { docId, version } = pendingRestore;
        await action(docId, "restore", async () => {
            const current = head(docId);
            selectMutated(docId, await restoreDocumentVersion(docId, version.id, current.id, current.working_revision));
        }, true);
        setPendingRestore(null);
    }
    function checkpoint(id: string, comment?: string) {
        return action(id, "checkpoint", async () => {
            const current = head(id);
            selectMutated(id, await checkpointDocumentVersion(id, current.id, current.working_revision, comment));
        }, true);
    }
    function upload(doc: Document, files: File[]) {
        if (!files.length) return Promise.resolve(false);
        return action(doc.id, "upload", async () => {
            let current = head(doc.id, doc);
            for (const file of files)
                selectMutated(doc.id, current = await uploadDocumentVersion(doc.id, file, current.id, current.working_revision));
        }, true);
    }
    function download(id: string, versionId: string, filename: string) {
        return action(id, "download", () => downloadDocument(id, versionId)
            .then((result) => downloadBlob(result.blob, result.filename || filename)));
    }
    function compare(id: string, baselineId: string, versionId: string) {
        return action(id, "compare", () => compareDocumentVersions(id, baselineId, versionId)
            .then((result) => downloadBlob(result.blob, result.filename ?? "document changes.docx")));
    }
    return { docsById, doc, history, histories, versions, currentId, current, selected, selectedId, priorCurrent,
        versionId: selection?.versionId ?? null, load, action, forget, pendingRestore, setPendingRestore,
        restore, checkpoint, upload, download, compare,
        open: (doc: Document) => setSelection({ doc, versionId: null }), close: () => setSelection(null),
        selectVersion: (versionId: string) => setSelection((current) => current ? { ...current, versionId } : current) };
}

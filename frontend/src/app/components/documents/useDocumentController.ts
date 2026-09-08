import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { checkpointDocumentVersion, compareDocumentVersions, downloadDocument, getDocument,
    listDocumentVersions, restoreDocumentVersion, uploadDocumentVersion,
    type Document, type DocumentVersion } from "@/app/lib/api/documents";
import { downloadBlob } from "@/app/lib/download";

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
    const doc = selection ? docsById.get(selection.doc.id) ?? selection.doc : null;
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
        const cached = histories.get(id);
        if (!force && cached?.loaded) return cached;
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
    function head(id: string) {
        const history = histories.get(id), current = history?.versions.find(({ id }) => id === history.currentVersionId);
        if (!current) throw new Error("Document history is not loaded");
        return current;
    }
    async function action(id: string, action: DocumentAction, mutation: () => Promise<unknown>, refresh = false) {
        if (locks.current.has(id)) return false;
        locks.current.add(id);
        update(id, { pendingAction: action, actionError: undefined });
        try { await mutation(); return true; }
        catch {
            const message = `Could not ${{ rename: "rename this document", upload: "upload the new version",
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
    function selectMutated(id: string, versionId: string) {
        setSelection((current) => current?.doc.id === id ? { ...current, versionId } : current);
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
            selectMutated(docId, (await restoreDocumentVersion(docId, version.id, current.id, current.working_revision)).id);
        }, true);
        setPendingRestore(null);
    }
    function checkpoint(id: string, comment?: string) {
        return action(id, "checkpoint", async () => {
            const current = head(id);
            selectMutated(id, (await checkpointDocumentVersion(id, current.id, current.working_revision, comment)).id);
        }, true);
    }
    function upload(doc: Document, files: File[]) {
        return action(doc.id, "upload", async () => {
            if (!doc.current_version_id || doc.current_working_revision == null) throw new Error("Document revision is unavailable");
            let head = { id: doc.current_version_id, working_revision: doc.current_working_revision };
            for (const file of files) {
                head = await uploadDocumentVersion(doc.id, file, head.id, head.working_revision);
                selectMutated(doc.id, head.id);
            }
        }, true);
    }
    function download(id: string, versionId: string, filename: string) {
        return action(id, "download", async () => {
            const result = await downloadDocument(id, versionId);
            downloadBlob(result.blob, result.filename || filename);
        });
    }
    function compare(id: string, baselineId: string, versionId: string) {
        return action(id, "compare", async () => {
            const result = await compareDocumentVersions(id, baselineId, versionId);
            downloadBlob(result.blob, result.filename ?? "document changes.docx");
        });
    }
    return { docsById, doc, history, histories, versions, currentId, current, selected, selectedId, priorCurrent,
        versionId: selection?.versionId ?? null, load, action, forget, pendingRestore, setPendingRestore,
        restore, checkpoint, upload, download, compare,
        open: (doc: Document) => setSelection({ doc, versionId: null }), close: () => setSelection(null),
        selectVersion: (versionId: string) => setSelection((current) => current ? { ...current, versionId } : current) };
}

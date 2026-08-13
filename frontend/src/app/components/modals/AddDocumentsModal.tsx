import { useEffect, useRef, useState } from "react";
import { AlertCircle, Upload, Loader2, X } from "lucide-react";
import {
    uploadStandaloneDocument,
    uploadProjectDocument,
    addDocumentToProject,
} from "@/app/lib/beaverApi";
import type { Document } from "../shared/types";
import { FileDirectory } from "../shared/FileDirectory";
import type { DirectoryTab } from "../shared/FileDirectory";
import { Modal } from "./Modal";
import {
    SUPPORTED_DOCUMENT_ACCEPT,
    formatUnsupportedDocumentWarning,
    partitionSupportedDocumentFiles,
} from "@/app/lib/documentUploadValidation";
interface Props {
    open: boolean;
    onClose: () => void;
    onSelect: (documents: Document[], projectId?: string) => void;
    breadcrumb: string[];
    initialTab?: DirectoryTab;
    projectId?: string;
    documents?: Document[];
    showTabs?: boolean;
    accept?: string;
    initialSelectedDocuments?: Document[];
    externalUploadedDocuments?: Document[];
    primaryLabel?: string;
    keepMounted?: boolean;
}
function mergeDocuments(current: Document[], added: Document[]) {
    const documents = new Map(current.map((document) => [document.id, document]));
    for (const document of added) documents.set(document.id, document);
    return [...documents.values()];
}
function uploadFailureMessage(files: File[]) {
    return files.length === 1
        ? `Unable to upload ${files[0].name}. Check the file and your connection, then try again.`
        : `Unable to upload ${files.length} documents. Check the files and your connection, then try again.`;
}
function assignmentFailureMessage(documents: Document[]) {
    return documents.length === 1
        ? `Unable to add ${documents[0].filename} to this project. Check your connection and try again.`
        : `Unable to add ${documents.length} documents to this project. Check your connection and try again.`;
}
export function AddDocumentsModal({
    open,
    onClose,
    onSelect,
    breadcrumb,
    initialTab = "files",
    projectId,
    documents,
    showTabs = true,
    accept = SUPPORTED_DOCUMENT_ACCEPT,
    initialSelectedDocuments,
    externalUploadedDocuments,
    primaryLabel = "Confirm",
    keepMounted = false,
}: Props) {
    const [selectedDocuments, setSelectedDocuments] = useState<Document[]>([]);
    const [uploading, setUploading] = useState(false);
    const [uploadingFilenames, setUploadingFilenames] = useState<string[]>([]);
    const [uploadWarning, setUploadWarning] = useState<string | null>(null);
    const [extraUploadedDocs, setExtraUploadedDocs] = useState<Document[]>([]);
    const [hasOpened, setHasOpened] = useState(open);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const wasOpenRef = useRef(false);
    useEffect(() => {
        if (open) setHasOpened(true);
    }, [open]);
    const initialSelectionKey = (initialSelectedDocuments ?? [])
        .map((document) => document.id)
        .join("|");
    useEffect(() => {
        if (!open) {
            wasOpenRef.current = false;
            return;
        }
        setSelectedDocuments((prev) => {
            if (!wasOpenRef.current) return initialSelectedDocuments ?? [];
            return mergeDocuments(prev, initialSelectedDocuments ?? []);
        });
        setUploadingFilenames([]);
        setUploadWarning(null);
        if (!keepMounted) {
            setExtraUploadedDocs([]);
        }
        wasOpenRef.current = true;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, initialSelectionKey]);
    const externalUploadKey = (externalUploadedDocuments ?? [])
        .map((document) => document.id)
        .join("|");
    useEffect(() => {
        if (!externalUploadedDocuments?.length) return;
        setExtraUploadedDocs((prev) =>
            mergeDocuments(prev, externalUploadedDocuments),
        );
        if (open) {
            setSelectedDocuments((prev) =>
                mergeDocuments(prev, externalUploadedDocuments),
            );
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [externalUploadKey]);
    if (!open && (!keepMounted || !hasOpened)) return null;
    async function handleConfirm() {
        if (projectId) {
            const toAssign = selectedDocuments.filter(
                (d) => d.project_id !== projectId,
            );
            const alreadyHere = selectedDocuments.filter(
                (d) => d.project_id === projectId,
            );
            if (toAssign.length > 0) {
                setUploading(true);
                setUploadWarning(null);
                try {
                    const results = await Promise.allSettled(
                        toAssign.map((document) =>
                            Promise.resolve().then(() =>
                                addDocumentToProject(projectId, document.id),
                            ),
                        ),
                    );
                    const assigned = results.flatMap((result) =>
                        result.status === "fulfilled" ? [result.value] : [],
                    );
                    const failed = toAssign.filter(
                        (_, index) => results[index].status === "rejected",
                    );
                    if (failed.length) {
                        setSelectedDocuments(
                            mergeDocuments(
                                mergeDocuments(alreadyHere, assigned),
                                failed,
                            ),
                        );
                        setUploadWarning(assignmentFailureMessage(failed));
                    } else {
                        onSelect([...alreadyHere, ...assigned], projectId);
                        onClose();
                    }
                } finally {
                    setUploading(false);
                }
            } else {
                onSelect(alreadyHere, projectId);
                onClose();
            }
            return;
        }
        const projectIds = new Set(
            selectedDocuments.map((d) => d.project_id).filter(Boolean),
        );
        const singleProjectId =
            projectIds.size === 1 ? [...projectIds][0]! : undefined;
        onSelect(selectedDocuments, singleProjectId);
        onClose();
    }
    async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
        const files = Array.from(e.target.files || []);
        if (!files.length) return;
        const { supported, unsupported } =
            partitionSupportedDocumentFiles(files);
        const unsupportedWarning =
            formatUnsupportedDocumentWarning(unsupported);
        setUploadWarning(unsupportedWarning);
        if (supported.length === 0) {
            if (fileInputRef.current) fileInputRef.current.value = "";
            return;
        }
        setUploadingFilenames(supported.map((file) => file.name));
        setUploading(true);
        try {
            const results = await Promise.allSettled(
                supported.map((file) =>
                    Promise.resolve().then(() =>
                        projectId
                            ? uploadProjectDocument(projectId, file)
                            : uploadStandaloneDocument(file),
                    ),
                ),
            );
            const uploaded = results.flatMap((result) =>
                result.status === "fulfilled" ? [result.value] : [],
            );
            const failed = supported.filter(
                (_, index) => results[index].status === "rejected",
            );
            setExtraUploadedDocs((prev) => [...uploaded, ...prev]);
            setSelectedDocuments((prev) => mergeDocuments(prev, uploaded));
            if (failed.length) {
                setUploadWarning(
                    [unsupportedWarning, uploadFailureMessage(failed)]
                        .filter(Boolean)
                        .join(" "),
                );
            }
        } finally {
            setUploading(false);
            setUploadingFilenames([]);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    }
    return (
        <Modal
            open={open}
            onClose={onClose}
            keepMounted={keepMounted}
            breadcrumbs={breadcrumb}
            secondaryAction={{
                label: uploading ? "Uploading…" : "Upload",
                icon: uploading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                    <Upload className="h-3.5 w-3.5" />
                ),
                onClick: () => fileInputRef.current?.click(),
                disabled: uploading,
            }}
            primaryAction={{
                label: uploading ? "Saving…" : primaryLabel,
                onClick: handleConfirm,
                disabled: selectedDocuments.length === 0 || uploading,
            }}
        >
            <input
                ref={fileInputRef}
                type="file"
                accept={accept}
                multiple
                className="hidden"
                onChange={handleUpload}
            />
            {uploadWarning && (
                <div
                    role="alert"
                    aria-atomic="true"
                    className="mb-2 flex items-center gap-2 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-gray-900"
                >
                    <AlertCircle
                        aria-hidden="true"
                        className="h-3.5 w-3.5 shrink-0 text-red-600"
                    />
                    <span className="min-w-0 flex-1">{uploadWarning}</span>
                    <button
                        type="button"
                        onClick={() => setUploadWarning(null)}
                        className="shrink-0 rounded p-0.5 text-black hover:bg-gray-100"
                        aria-label="Dismiss warning"
                    >
                        <X aria-hidden="true" className="h-3.5 w-3.5" />
                    </button>
                </div>
            )}
            <div className="flex min-h-0 flex-1 flex-col">
                <FileDirectory
                    key={`${initialTab}:${open ? "open" : "closed"}`}
                    documents={
                        documents
                            ? [...extraUploadedDocs, ...documents]
                            : extraUploadedDocs
                    }
                    selectedDocuments={selectedDocuments}
                    onChange={setSelectedDocuments}
                    uploadingFilenames={uploadingFilenames}
                    showTabs={showTabs}
                    initialTab={initialTab}
                    excludeProjectId={projectId}
                />
            </div>
        </Modal>
    );
}

import { useState, type ReactNode } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { PillButton } from "@/app/components/ui/pill-button";
import { apiFetch } from "@/app/lib/beaverApi";import type { EditAnnotation, EditResolveHandlers } from "../../shared/types";
import { applyOptimisticResolution } from "../EditCard";
function BulkEditActions({
    pending,
    onViewClick,
    onResolveStart,
    onResolved,
    onError,
}: {
    pending: {
        annotation: EditAnnotation;
        filename: string;
    }[];
    onViewClick?: (ann: EditAnnotation, filename: string) => void;
} & EditResolveHandlers) {
    const [busy, setBusy] = useState<"accept" | "reject" | null>(null);
    const [progress, setProgress] = useState<{
        done: number;
        total: number;
    } | null>(null);
    if (pending.length === 0) return null;
    const handleAll = async (verb: "accept" | "reject") => {
        if (busy) return;
        setBusy(verb);
        setProgress({ done: 0, total: pending.length });
        try {
            let done = 0;
            for (const { annotation } of pending) {
                onResolveStart?.({
                    editId: annotation.edit_id,
                    documentId: annotation.document_id,
                    verb,
                });
                let revert: (() => void) | null = null;
                try {
                    revert = applyOptimisticResolution(annotation, verb);
                } catch (e) {
                    console.error(
                        "[BulkEditActions] optimistic update threw",
                        e,
                    );
                }
                try {
                    const resp = await apiFetch(                        `/single-documents/${annotation.document_id}/edits/${annotation.edit_id}/${verb}`,                        { method: "POST" },                    );                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    const data = (await resp.json()) as {
                        ok: boolean;
                        status?: "accepted" | "rejected";
                        version_id: string | null;
                        download_url: string | null;
                    };
                    const nextStatus =
                        data.status ??
                        (verb === "accept" ? "accepted" : "rejected");
                    onResolved?.({
                        editId: annotation.edit_id,
                        documentId: annotation.document_id,
                        status: nextStatus,
                        versionId: data.version_id,
                        downloadUrl: data.download_url,
                    });
                } catch (e) {
                    console.error("[BulkEditActions] resolve failed", e);
                    try {
                        revert?.();
                    } catch (revertErr) {
                        console.error(
                            "[BulkEditActions] revert threw",
                            revertErr,
                        );
                    }
                    onError?.({
                        editId: annotation.edit_id,
                        documentId: annotation.document_id,
                        versionId: annotation.version_id ?? null,
                        message:
                            verb === "accept"
                                ? "Couldn't save one or more accepts."
                                : "Couldn't save one or more rejects.",
                    });
                }
                done++;
                setProgress({ done, total: pending.length });
            }
        } finally {
            setBusy(null);
            setProgress(null);
        }
    };
    const first = pending[0];
    return (
        <div className="flex items-center gap-2">
            <PillButton
                tone="black"
                size="sm"
                onClick={() => handleAll("accept")}
                disabled={!!busy}
            >
                {busy === "accept" && (
                    <Loader2 className="h-3 w-3 animate-spin" />
                )}
                Accept all
            </PillButton>
            <PillButton
                tone="white"
                size="sm"
                onClick={() => handleAll("reject")}
                disabled={!!busy}
            >
                {busy === "reject" && (
                    <Loader2 className="h-3 w-3 animate-spin" />
                )}
                Reject all
            </PillButton>
            {progress && (
                <span className="text-xs font-serif text-gray-500">
                    {progress.done}/{progress.total}
                </span>
            )}
            {onViewClick && first && (
                <PillButton
                    tone="black"                    size="sm"
                    onClick={() =>
                        onViewClick(first.annotation, first.filename)
                    }
                    disabled={!!busy}
                    className="ml-auto"
                >
                    View
                </PillButton>
            )}
        </div>
    );
}
export function EditCardsSection({
    pending,
    filenameByDocId,
    cards,
    resolvedCount,
    onViewClick,
    onResolveStart,
    onResolved,
    onError,
}: {
    pending: {
        annotation: EditAnnotation;
        filename: string;
    }[];
    filenameByDocId: Map<string, string>;
    cards: ReactNode[];
    resolvedCount: number;
    onViewClick?: (ann: EditAnnotation, filename: string) => void;
} & EditResolveHandlers) {
    const [isOpen, setIsOpen] = useState(true);
    if (cards.length === 0) return null;
    const docCount = filenameByDocId.size;
    const summary =
        pending.length > 0
            ? docCount > 1
                ? `${pending.length} tracked changes across ${docCount} documents`
                : `${pending.length} tracked ${pending.length === 1 ? "change" : "changes"}`
            : docCount > 1
              ? `${resolvedCount} resolved tracked changes across ${docCount} documents`
              : `${resolvedCount} resolved tracked ${resolvedCount === 1 ? "change" : "changes"}`;
    return (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
            {/* Row 1: summary + chevron */}
            <div className="flex items-center gap-2 px-3 pt-3">
                <p className="flex-1 min-w-0 text-sm font-serif text-gray-700 truncate">
                    {summary}
                </p>
                <button
                    onClick={() => setIsOpen((v) => !v)}
                    aria-label={isOpen ? "Collapse edits" : "Expand edits"}
                    className="shrink-0 rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-800"
                >
                    <ChevronDown
                        className={`h-4 w-4 ${isOpen ? "" : "-rotate-90"}`}
                    />
                </button>
            </div>
            {/* Row 2: bulk action buttons */}
            {pending.length > 0 && (
                <div className="px-3 pt-3">
                    <BulkEditActions
                        pending={pending}
                        onViewClick={onViewClick}
                        onResolveStart={onResolveStart}
                        onResolved={onResolved}
                        onError={onError}
                    />
                </div>
            )}
            {/* Row 3: collapsible cards list */}
            {isOpen && (
                <div className="flex flex-col gap-2 px-3 pb-3 pt-3">
                    {cards}
                </div>
            )}
            {!isOpen && <div className="pb-3" />}
        </div>
    );
}

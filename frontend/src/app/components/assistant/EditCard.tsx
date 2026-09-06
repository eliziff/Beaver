import { useState } from "react";
import { resolveDocumentEdits, type EditAnnotation, type EditResolveHandlers } from "@/app/lib/api/documents";
import { Button } from "@/app/components/ui/button";


type EditVerb = "accept" | "reject";

const normalized = (text: string) => text.replace(/\s+/g, " ").trim();

function findMatch(
    container: Element,
    tag: "ins" | "del",
    id?: string,
    text = "",
) {
    if (id) {
        const match = container.querySelector<HTMLElement>(
            `${tag}[data-w-id="${id}"]`,
        );
        if (match) return match;
    }
    const target = normalized(text);
    if (!target) return null;
    const candidates = [
        ...container.querySelectorAll<HTMLElement>(tag),
    ];
    return (
        candidates.find(
            (element) => normalized(element.textContent ?? "") === target,
        ) ??
        candidates.find((element) =>
            normalized(element.textContent ?? "").includes(target),
        ) ??
        null
    );
}

function applyOptimisticResolution(
    edit: EditAnnotation,
    verb: EditVerb,
) {
    if (typeof document === "undefined") return () => {};
    const applied: [HTMLElement, string][] = [];
    document
        .querySelectorAll(
            `[data-document-id="${CSS.escape(edit.document_id)}"] .docx-view-container`,
        )
        .forEach((container) => {
            const inserted = findMatch(
                container,
                "ins",
                edit.ins_w_id,
                edit.inserted_text,
            );
            const deleted = findMatch(
                container,
                "del",
                edit.del_w_id,
                edit.deleted_text,
            );
            const changes: [HTMLElement | null, string][] = verb === "accept"
                ? [
                      [inserted, "docx-edit-kept"],
                      [deleted, "docx-edit-hidden"],
                  ]
                : [
                      [inserted, "docx-edit-hidden"],
                      [deleted, "docx-edit-kept"],
                  ];
            for (const [element, className] of changes) {
                if (!element) continue;
                element.classList.add(className);
                applied.push([element, className]);
            }
        });
    return () =>
        applied.forEach(([element, className]) =>
            element.classList.remove(className),
        );
}

export async function resolveEdits(
    edits: EditAnnotation[],
    verb: EditVerb,
    { onResolveStart, onResolved, onError }: EditResolveHandlers,
) {
    const documentId = edits[0]?.document_id;
    if (!documentId || edits.some((edit) => edit.document_id !== documentId)) return null;
    edits.forEach((edit) => onResolveStart?.({ editId: edit.edit_id, documentId, verb }));
    const reverts = edits.map((edit) => {
        try { return applyOptimisticResolution(edit, verb); }
        catch (error) { console.error("Optimistic edit update failed", error); return () => {}; }
    });
    try {
        const result = await resolveDocumentEdits(documentId, edits.map(({ edit_id }) => edit_id), verb);
        const status =
            result.status ?? (verb === "accept" ? "accepted" : "rejected");
        edits.forEach((edit) => onResolved?.({
            editId: edit.edit_id, documentId,
            status,
            versionId: result.version_id,
        }));
        return status;
    } catch (error) {
        console.error("Edit resolution failed", error);
        reverts.forEach((revert) => { try { revert(); } catch { /* Best-effort rollback. */ } });
        edits.forEach((edit) => onError?.({
            editId: edit.edit_id, documentId,
            versionId: edit.version_id ?? null,
            message: `Couldn't ${verb} this change. Please retry.`,
        }));
        return null;
    }
}

export const resolveEdit = (edit: EditAnnotation, verb: EditVerb,
    handlers: EditResolveHandlers) => resolveEdits([edit], verb, handlers);

export function useEditResolution(
    edit: EditAnnotation,
    resolvedStatus: "accepted" | "rejected" | undefined,
    isReloading: boolean | undefined,
    handlers: EditResolveHandlers,
) {
    const [busy, setBusy] = useState(false);
    const source = `${edit.edit_id}:${edit.status}`;
    const [local, setLocal] = useState({ source, status: edit.status });
    const status =
        resolvedStatus ?? (local.source === source ? local.status : edit.status);
    const resolve = async (verb: EditVerb) => {
        if (busy || status !== "pending") return;
        setBusy(true);
        try {
            const next = await resolveEdit(edit, verb, handlers);
            if (next) setLocal({ source, status: next });
        } finally {
            setBusy(false);
        }
    };
    return {
        status,
        resolve,
        disabled: busy || !!isReloading || status !== "pending",
    };
}

interface Props extends EditResolveHandlers {
    annotation: EditAnnotation;
    automatic?: boolean;
    changeNumber?: number;
    resolvedStatus?: "accepted" | "rejected";
    isReloading?: boolean;
    onViewClick?: (annotation: EditAnnotation) => void;
}

export function EditCard({
    annotation,
    automatic = false,
    changeNumber,
    resolvedStatus,
    isReloading,
    onViewClick,
    onResolveStart,
    onResolved,
    onError,
}: Props) {
    const { status, resolve, disabled } = useEditResolution(
        annotation,
        resolvedStatus,
        isReloading,
        { onResolveStart, onResolved, onError },
    );
    const resolved = status !== "pending";
    const diff = [
        ...(annotation.context_before
            ? [{ kind: "equal" as const, text: annotation.context_before }]
            : []),
        ...annotation.diff,
        ...(annotation.context_after
            ? [{ kind: "equal" as const, text: annotation.context_after }]
            : []),
    ];
    const displayDiff = diff.map((part, index, parts) => {
        if (part.kind !== "equal" || part.text.length <= 80) return part;
        if (index === 0)
            return { ...part, text: `…${part.text.slice(-60)}` };
        if (index === parts.length - 1)
            return { ...part, text: `${part.text.slice(0, 60)}…` };
        return {
            ...part,
            text: `${part.text.slice(0, 35)}…${part.text.slice(-35)}`,
        };
    });

    return (
        <div
            className={
                resolved
                    ? "rounded-lg bg-gray-50 px-3 py-2"
                    : "rounded-xl border border-gray-200 bg-white p-3 shadow-sm"
            }
        >
            {changeNumber !== undefined && (
                <p className="mb-1.5 text-xs text-gray-400">{changeNumber}</p>
            )}
            {annotation.reason && (
                <p className="mb-2 text-xs text-gray-500">
                    {annotation.reason}
                </p>
            )}
            <div
                className={`whitespace-pre-wrap font-serif text-sm leading-relaxed ${
                    resolved ? "" : "rounded-lg bg-gray-100/70 px-2 py-2"
                }`}
            >
                {displayDiff.map((part, index) => (
                    <span
                        key={`${part.kind}-${index}`}
                        className={
                            status === "rejected"
                                ? part.kind === "insert"
                                    ? "text-gray-400 line-through"
                                    : part.kind === "delete"
                                      ? "bg-gray-200/70 text-gray-900"
                                      : "text-gray-600"
                                : part.kind === "insert"
                                  ? "bg-green-100 text-green-800"
                                  : part.kind === "delete"
                                    ? "bg-red-100 text-red-700 line-through"
                                    : "text-gray-700"
                        }
                    >
                        {part.text}
                    </span>
                ))}
            </div>
            {resolved ? (
                <p className="mt-2 text-xs font-medium text-gray-500">
                    {automatic
                        ? "Applied in Auto Mode"
                        : status === "rejected"
                          ? "Kept original"
                          : "Accepted"}
                </p>
            ) : (
                <div className="mt-3 flex gap-2">
                    <Button
                        size="compact"
                        onClick={() => resolve("accept")}
                        disabled={disabled}
                    >
                        Accept
                    </Button>
                    <Button
                        variant="outline"
                        size="compact"
                        onClick={() => resolve("reject")}
                        disabled={disabled}
                    >
                        Reject
                    </Button>
                    {onViewClick && (
                        <Button
                            size="compact"
                            onClick={() => onViewClick(annotation)}
                            className="ml-auto"
                        >
                            View
                        </Button>
                    )}
                </div>
            )}
        </div>
    );
}

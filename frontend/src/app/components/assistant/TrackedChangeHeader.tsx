"use client";

import { useCallback, useEffect, useState } from "react";
import { getAuthHeader } from "@/app/lib/beaverApi";
import { PillButton } from "@/app/components/ui/pill-button";
import { applyOptimisticResolution } from "./EditCard";
import type { EditAnnotation } from "../shared/types";

type ResolveArgs = {
    editId: string;
    documentId: string;
    verb: "accept" | "reject";
};

type ResolvedArgs = {
    editId: string;
    documentId: string;
    status: "accepted" | "rejected";
    versionId: string | null;
    downloadUrl: string | null;
};

type ErrorArgs = {
    editId: string;
    documentId: string;
    versionId: string | null;
    message: string;
};

export function TrackedChangeHeader({
    edit,
    isEditReloading,
    onResolveStart,
    onResolved,
    onError,
}: {
    edit: EditAnnotation;
    isEditReloading?: boolean;
    onResolveStart?: (args: ResolveArgs) => void;
    onResolved?: (args: ResolvedArgs) => void;
    onError?: (args: ErrorArgs) => void;
}) {
    return (
        <div className="flex shrink-0 justify-end border-b border-gray-200 px-3 py-2">
            <EditResolveButtons
                edit={edit}
                isReloading={isEditReloading}
                onResolveStart={onResolveStart}
                onResolved={onResolved}
                onError={onError}
            />
        </div>
    );
}

function EditResolveButtons({
    edit,
    isReloading,
    onResolveStart,
    onResolved,
    onError,
}: {
    edit: EditAnnotation;
    isReloading?: boolean;
    onResolveStart?: (args: ResolveArgs) => void;
    onResolved?: (args: ResolvedArgs) => void;
    onError?: (args: ErrorArgs) => void;
}) {
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<"pending" | "accepted" | "rejected">(
        edit.status,
    );

    useEffect(() => {
        if (busy) return;
        setStatus(edit.status);
    }, [edit.status, edit.edit_id, busy]);

    const resolved = status !== "pending";

    const handle = useCallback(
        async (verb: "accept" | "reject") => {
            if (busy || resolved) return;
            setBusy(true);
            onResolveStart?.({
                editId: edit.edit_id,
                documentId: edit.document_id,
                verb,
            });
            let revert: (() => void) | null = null;
            try {
                revert = applyOptimisticResolution(edit, verb);
            } catch (e) {
                console.error(
                    "[TrackedChangeHeader] optimistic update threw",
                    e,
                );
            }
            try {
                const authHeaders = await getAuthHeader();
                const apiBase =
                    process.env.NEXT_PUBLIC_API_BASE_URL ??
                    "http://localhost:3001";
                const resp = await fetch(
                    `${apiBase}/single-documents/${edit.document_id}/edits/${edit.edit_id}/${verb}`,
                    {
                        method: "POST",
                        headers: authHeaders,
                    },
                );
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const data = (await resp.json()) as {
                    ok: boolean;
                    status?: "accepted" | "rejected";
                    version_id: string | null;
                    download_url: string | null;
                };
                const nextStatus =
                    data.status ??
                    (verb === "accept" ? "accepted" : "rejected");
                setStatus(nextStatus);
                onResolved?.({
                    editId: edit.edit_id,
                    documentId: edit.document_id,
                    status: nextStatus,
                    versionId: data.version_id,
                    downloadUrl: data.download_url,
                });
            } catch (e) {
                console.error("[TrackedChangeHeader] resolve failed", e);
                try {
                    revert?.();
                } catch (revertErr) {
                    console.error(
                        "[TrackedChangeHeader] revert threw",
                        revertErr,
                    );
                }
                onError?.({
                    editId: edit.edit_id,
                    documentId: edit.document_id,
                    versionId: edit.version_id ?? null,
                    message:
                        verb === "accept"
                            ? "Couldn't save accept — please retry."
                            : "Couldn't save reject — please retry.",
                });
            } finally {
                setBusy(false);
            }
        },
        [busy, resolved, edit, onResolveStart, onResolved, onError],
    );

    const inFlight = busy || !!isReloading;
    return (
        <div className="flex items-center gap-2">
            <PillButton
                tone="black"
                size="sm"
                onClick={() => handle("accept")}
                disabled={inFlight || resolved}
            >
                {status === "accepted" ? "Accepted" : "Accept"}
            </PillButton>
            <PillButton
                tone="white"
                size="sm"
                onClick={() => handle("reject")}
                disabled={inFlight || resolved}
            >
                {status === "rejected" ? "Rejected" : "Reject"}
            </PillButton>
        </div>
    );
}

import { useState, type ReactNode } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { PillButton } from "@/app/components/ui/pill-button";
import type { EditAnnotation, EditResolveHandlers } from "../../shared/types";
import { resolveEdit } from "../EditCard";

type PendingEdit = { annotation: EditAnnotation; filename: string };

function BulkEditActions({
    pending,
    disabled,
    onViewClick,
    ...handlers
}: {
    pending: PendingEdit[];
    disabled?: boolean;
    onViewClick?: (annotation: EditAnnotation, filename: string) => void;
} & EditResolveHandlers) {
    const [busy, setBusy] = useState<"accept" | "reject" | null>(null);
    const [done, setDone] = useState(0);

    const resolveAll = async (verb: "accept" | "reject") => {
        if (busy || disabled) return;
        setBusy(verb);
        try {
            for (const [index, { annotation }] of pending.entries()) {
                await resolveEdit(annotation, verb, handlers);
                setDone(index + 1);
            }
        } finally {
            setBusy(null);
            setDone(0);
        }
    };
    const first = pending[0];

    return (
        <div className="flex items-center gap-2">
            <PillButton
                tone="black"
                size="sm"
                onClick={() => resolveAll("accept")}
                disabled={disabled || !!busy}
            >
                {busy === "accept" && (
                    <Loader2 className="h-3 w-3 animate-spin" />
                )}
                Accept all
            </PillButton>
            <PillButton
                tone="white"
                size="sm"
                onClick={() => resolveAll("reject")}
                disabled={disabled || !!busy}
            >
                {busy === "reject" && (
                    <Loader2 className="h-3 w-3 animate-spin" />
                )}
                Reject all
            </PillButton>
            {busy && (
                <span className="text-xs text-gray-500">
                    {done}/{pending.length}
                </span>
            )}
            {onViewClick && (
                <PillButton
                    tone="black"
                    size="sm"
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
    documentCount,
    cards,
    resolvedCount,
    automatic = false,
    disabled = false,
    onViewClick,
    ...handlers
}: {
    pending: PendingEdit[];
    documentCount: number;
    cards: ReactNode[];
    resolvedCount: number;
    automatic?: boolean;
    disabled?: boolean;
    onViewClick?: (annotation: EditAnnotation, filename: string) => void;
} & EditResolveHandlers) {
    const [open, setOpen] = useState(true);

    const count = pending.length || resolvedCount;
    const summary = `${count} ${automatic ? "applied" : pending.length ? "tracked" : "resolved tracked"} ${
        count === 1 ? "change" : "changes"
    }${documentCount > 1 ? ` across ${documentCount} documents` : ""}`;

    return (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
            <div className="flex items-center gap-2 px-3 pt-3">
                <p className="min-w-0 flex-1 truncate font-serif text-sm text-gray-700">
                    {summary}
                </p>
                <button
                    onClick={() => setOpen((value) => !value)}
                    aria-label={open ? "Collapse edits" : "Expand edits"}
                    className="shrink-0 rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-800"
                >
                    <ChevronDown
                        className={`h-4 w-4 ${open ? "" : "-rotate-90"}`}
                    />
                </button>
            </div>
            {!!pending.length && (
                <div className="px-3 pt-3">
                    <BulkEditActions
                        pending={pending}
                        disabled={disabled}
                        onViewClick={onViewClick}
                        {...handlers}
                    />
                </div>
            )}
            {open ? (
                <div className="flex flex-col gap-2 px-3 pb-3 pt-3">
                    {cards}
                </div>
            ) : (
                <div className="pb-3" />
            )}
        </div>
    );
}

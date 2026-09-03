import { useState, type ReactNode } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import type { EditAnnotation, EditResolveHandlers } from "../../shared/types";
import { resolveEdits } from "../EditCard";

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
    const resolveAll = async (verb: "accept" | "reject") => {
        if (busy || disabled) return;
        setBusy(verb);
        try {
            const grouped = new Map<string, EditAnnotation[]>();
            for (const { annotation } of pending) {
                const group = grouped.get(annotation.document_id);
                if (group) group.push(annotation);
                else grouped.set(annotation.document_id, [annotation]);
            }
            await Promise.all([...grouped.values()].map((edits) =>
                resolveEdits(edits, verb, handlers)));
        } finally {
            setBusy(null);
        }
    };
    const first = pending[0];

    return (
        <div className="flex items-center gap-2">
            <Button
                size="compact"
                onClick={() => resolveAll("accept")}
                disabled={disabled || !!busy}
            >
                {busy === "accept" && (
                    <Loader2 className="h-3 w-3 animate-spin" />
                )}
                Accept all
            </Button>
            <Button
                variant="outline"
                size="compact"
                onClick={() => resolveAll("reject")}
                disabled={disabled || !!busy}
            >
                {busy === "reject" && (
                    <Loader2 className="h-3 w-3 animate-spin" />
                )}
                Reject all
            </Button>
            {onViewClick && (
                <Button
                    size="compact"
                    onClick={() =>
                        onViewClick(first.annotation, first.filename)
                    }
                    disabled={!!busy}
                    className="ml-auto"
                >
                    View
                </Button>
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

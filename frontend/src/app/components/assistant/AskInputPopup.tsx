import { useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, X } from "lucide-react";
import { PillButton } from "@/app/components/ui/pill-button";
import type {
    AskInputsEvent,
    AskInputsResponseEvent,
    Document,
} from "../shared/types";
import { AddDocumentsModal } from "../modals/AddDocumentsModal";

type AskEvent = AskInputsEvent;
type AskItem = AskEvent["items"][number];
type AskResponse = AskInputsResponseEvent;
type Resolution = "answered" | "skipped";
type Target = { inputId: string; typeIndex: number };
type Pick = Target & { document: Document };
type Ui = { active: number; dismissed: boolean; picks: Pick[]; resolved: Record<string, Resolution>; target: Target | null };
const OTHER = "__other__";

export function AskInputPopup({
    event, onSubmit, onDismiss,
}: {
    event: AskEvent;
    onSubmit?: (response: AskResponse, content: string, files: { filename: string; document_id: string }[]) => void;
    onDismiss?: () => void;
}) {
    const form = useRef<HTMLFormElement>(null);
    const sent = useRef(false);
    const [ui, setUi] = useState<Ui>({ active: 0, dismissed: false, picks: [], resolved: {}, target: null });
    const item = event.items[ui.active];
    const docsFor = (inputId: string, typeIndex?: number) => ui.picks
        .filter((pick) => pick.inputId === inputId && (typeIndex === undefined || pick.typeIndex === typeIndex))
        .map((pick) => pick.document);

    const finish = (resolved: Ui["resolved"]) => {
        const data = new FormData(form.current ?? undefined);
        const responses: AskResponse["responses"] = event.items.map((entry) => {
            const skipped = resolved[entry.id] === "skipped";
            if (entry.kind === "choice") return skipped
                ? { id: entry.id, kind: "choice", question: entry.question, skipped: true }
                : {
                    id: entry.id, kind: "choice", question: entry.question,
                    answer: data.get(entry.id) === OTHER
                        ? String(data.get(`${entry.id}-other`) ?? "").trim()
                        : String(data.get(entry.id) ?? ""),
                };
            const documents = (skipped ? [] : docsFor(entry.id)).map(({ id, filename }) => ({
                document_id: id, filename,
            }));
            return {
                id: entry.id, kind: "documents",
                filenames: documents.map(({ filename }) => filename),
                documents, ...(skipped && { skipped: true }),
            };
        });
        const files = [...new Map(
            responses.flatMap((response) => response.kind === "documents"
                ? (response.documents ?? []).map((doc) => [doc.document_id, doc] as const)
                : []),
        ).values()];
        const content = responses.map((response, index) => {
            if (response.kind === "choice") return response.skipped
                ? `${index + 1}. Skipped: ${response.question}`
                : `${index + 1}. ${response.question}\n${response.answer ?? ""}`;
            return response.skipped
                ? `${index + 1}. Skipped document request.`
                : `${index + 1}. Documents attached: ${response.filenames.join(", ")}`;
        }).join("\n\n");
        sent.current = true;
        onSubmit?.(
            { type: "ask_inputs_response", responses },
            `Responses to Beaver's questions:\n${content}`,
            files,
        );
    };

    const resolve = (resolution: Resolution) => {
        if (!item || sent.current) return;
        if (resolution === "answered" && item.kind === "documents" && !docsFor(item.id).length) return;
        if (resolution === "answered" && item.kind === "choice") {
            const data = new FormData(form.current ?? undefined);
            const other = form.current?.elements.namedItem(`${item.id}-other`) as HTMLTextAreaElement | null;
            other?.setCustomValidity(data.get(item.id) === OTHER && !other.value.trim() ? "Enter an answer." : "");
            if (!form.current?.reportValidity()) return;
        }
        const resolved = { ...ui.resolved, [item.id]: resolution };
        const active = event.items.findIndex((entry) => !resolved[entry.id]);
        setUi({ ...ui, active: active < 0 ? ui.active : active, resolved });
        if (active < 0 && onSubmit) finish(resolved);
    };
    const toggleSkip = () => {
        if (!item) return;
        if (ui.resolved[item.id] !== "skipped") return resolve("skipped");
        const resolved = { ...ui.resolved };
        delete resolved[item.id];
        setUi({ ...ui, resolved });
    };
    const addDocs = (selected: Document[]) => {
        if (!ui.target || !selected.length) return;
        const target = ui.target;
        setUi((current) => {
            const existing = new Set(current.picks
                .filter((pick) => pick.inputId === target.inputId)
                .map((pick) => pick.document.id));
            return {
                ...current,
                picks: [...current.picks, ...selected
                    .filter((doc) => !existing.has(doc.id))
                    .map((document) => ({ ...target, document }))],
            };
        });
    };
    const removeDoc = (inputId: string, typeIndex: number, id: string) => setUi((current) => ({
        ...current,
        picks: current.picks.filter((pick) =>
            pick.inputId !== inputId || pick.typeIndex !== typeIndex || pick.document.id !== id),
    }));

    if (ui.dismissed) return null;
    const multi = event.items.length > 1;
    return (
        <>
            <div data-shortcut-layer data-shortcut-open="true" className="relative mx-auto w-full max-w-2xl font-serif">
                <details
                    open
                    data-ask-input-panel
                    className="group h-10 overflow-hidden rounded-xl border border-gray-300 bg-white open:h-[min(28rem,70dvh)]"
                >
                    <summary role="button" className={`flex h-10 cursor-pointer list-none items-center gap-2 px-4 font-sans text-sm text-gray-800 hover:bg-gray-100 [&::-webkit-details-marker]:hidden ${multi ? "pr-32" : "pr-12"}`}>
                        <ChevronDown className="h-3.5 w-3.5 shrink-0 -rotate-90 group-open:rotate-0" />
                        <span className="truncate">
                            {event.items.length === 1 ? "1 question" : `Question ${ui.active + 1} of ${event.items.length}`}
                        </span>
                    </summary>
                    {multi && (
                        <div className="absolute right-11 top-0 flex h-10 items-center">
                            {([-1, 1] as const).map((offset) => {
                                const next = ui.active + offset;
                                const Icon = offset < 0 ? ChevronLeft : ChevronRight;
                                return (
                                    <button
                                        key={offset}
                                        type="button"
                                        aria-label={offset < 0 ? "Previous question" : "Next question"}
                                        disabled={next < 0 || next >= event.items.length}
                                        onClick={() => setUi({ ...ui, active: next })}
                                        className="grid h-9 w-9 place-items-center rounded-md text-gray-600 hover:bg-gray-100 disabled:opacity-30"
                                    >
                                        <Icon className="h-4 w-4" />
                                    </button>
                                );
                            })}
                        </div>
                    )}
                    <form
                        ref={form}
                        onSubmit={(submitEvent) => { submitEvent.preventDefault(); resolve("answered"); }}
                        className="flex h-[calc(100%-2.5rem)] min-h-0 flex-col border-t border-gray-200 px-3 pb-3 pt-3"
                    >
                        <div data-ask-input-options className="min-h-0 flex-1 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
                            {event.items.map((entry, index) => (
                                <fieldset
                                    key={entry.id}
                                    hidden={index !== ui.active}
                                    inert={ui.resolved[entry.id] ? true : undefined}
                                    aria-disabled={!!ui.resolved[entry.id] || undefined}
                                >
                                    <legend className="mb-3 whitespace-pre-wrap break-words text-base leading-6 text-gray-900">
                                        {entry.kind === "choice" ? entry.question : "Add the following documents if available:"}
                                    </legend>
                                    {entry.kind === "choice" ? (
                                        <Choices item={entry} required={index === ui.active} />
                                    ) : (
                                        <Documents
                                            item={entry}
                                            picks={ui.picks.filter((pick) => pick.inputId === entry.id)}
                                            onAdd={(typeIndex) => setUi({ ...ui, target: { inputId: entry.id, typeIndex } })}
                                            onRemove={(typeIndex, id) => removeDoc(entry.id, typeIndex, id)}
                                        />
                                    )}
                                </fieldset>
                            ))}
                        </div>
                        {item && (
                            <footer className="flex shrink-0 justify-end gap-2 pt-2">
                                <button type="button" onClick={toggleSkip} className="min-h-9 px-2 font-sans text-sm text-gray-600 hover:text-gray-900">
                                    {ui.resolved[item.id] === "skipped" ? "Answer instead" : "Decline to answer"}
                                </button>
                                <PillButton
                                    tone="black"
                                    type="submit"
                                    disabled={!!ui.resolved[item.id] || (item.kind === "documents" && !docsFor(item.id).length)}
                                    className="h-9 px-4 font-sans text-sm"
                                >
                                    {ui.resolved[item.id] === "answered" ? "Confirmed" : "Confirm"}
                                </PillButton>
                            </footer>
                        )}
                    </form>
                </details>
                <button
                    data-shortcut-close
                    type="button"
                    aria-label="Dismiss"
                    onClick={() => { setUi({ ...ui, dismissed: true }); onDismiss?.(); }}
                    className="absolute right-1 top-0 grid h-9 w-9 place-items-center rounded-md text-gray-600 hover:bg-gray-100"
                >
                    <X className="h-4 w-4" />
                </button>
            </div>
            <AddDocumentsModal
                open={!!ui.target}
                keepMounted
                onClose={() => setUi({ ...ui, target: null })}
                onSelect={addDocs}
                breadcrumb={["Assistant", "Add Documents"]}
                initialSelectedDocuments={ui.target ? docsFor(ui.target.inputId) : []}
            />
        </>
    );
}

function Choices({ item, required }: {
    item: Extract<AskItem, { kind: "choice" }>;
    required: boolean;
}) {
    const values = [
        ...item.options.map(({ value }) => value.trim()).filter(Boolean),
        OTHER,
    ];
    return (
        <div className="grid gap-1.5">
            {values.map((value, index) => {
                const label = value === OTHER
                    ? item.other_label || "Write your own answer"
                    : value;
                return (
                    <label key={`${item.id}-${index}`} className="flex min-h-11 cursor-pointer items-start gap-2 rounded-lg bg-gray-100/70 px-3 py-2.5 text-gray-700 hover:bg-gray-200/70 has-[:checked]:bg-gray-200">
                        <input
                            className="mt-0.5 h-5 w-5 shrink-0 accent-red-700"
                            type="radio"
                            name={item.id}
                            value={value}
                            aria-label={label}
                            required={required}
                        />
                        <span className="mt-0.5 w-4 shrink-0 text-xs text-gray-500">{index + 1}.</span>
                        {value === OTHER ? (
                            <textarea
                                name={`${item.id}-other`}
                                rows={2}
                                aria-label={label}
                                placeholder={label}
                                onFocus={(focusEvent) => {
                                    const choices = focusEvent.currentTarget.form?.elements.namedItem(item.id) as RadioNodeList | null;
                                    if (choices) choices.value = OTHER;
                                }}
                                onInput={(inputEvent) => inputEvent.currentTarget.setCustomValidity("")}
                                className="min-h-12 max-h-32 min-w-0 flex-1 resize-y overflow-y-auto bg-transparent text-[15px] leading-5 outline-none [field-sizing:content] placeholder:text-gray-700"
                            />
                        ) : (
                            <span className="min-w-0 flex-1 break-words text-[15px]">{label}</span>
                        )}
                    </label>
                );
            })}
        </div>
    );
}

function Documents({ item, picks, onAdd, onRemove }: {
    item: Extract<AskItem, { kind: "documents" }>;
    picks: Pick[];
    onAdd: (typeIndex: number) => void;
    onRemove: (typeIndex: number, id: string) => void;
}) {
    const rows = item.document_types?.length ? item.document_types : ["Documents"];
    return (
        <div className="grid gap-1.5">
            {rows.map((label, index) => (
                <div key={`${item.id}-${index}`}>
                    <button
                        type="button"
                        onClick={() => onAdd(index)}
                        className="flex min-h-11 w-full items-start gap-1 rounded-lg bg-gray-100/70 px-3 py-2.5 text-left text-gray-700 hover:bg-gray-200/70"
                    >
                        <span className="mt-0.5 w-4 shrink-0 text-xs text-gray-500">{index + 1}.</span>
                        <span className="min-w-0 flex-1 text-[15px]">{label}</span>
                        <span className="font-sans text-xs text-gray-500">+ Add</span>
                    </button>
                    {picks.filter((pick) => pick.typeIndex === index).map(({ document }) => (
                        <div key={document.id} className="mt-1 flex min-w-0 items-center gap-1 pl-3 text-xs text-gray-700">
                            <span className="min-w-0 flex-1 truncate">{document.filename}</span>
                            <button
                                type="button"
                                aria-label={`Remove ${document.filename}`}
                                onClick={() => onRemove(index, document.id)}
                                className="grid h-7 w-7 shrink-0 place-items-center rounded hover:bg-gray-100"
                            >
                                <X className="h-3 w-3" />
                            </button>
                        </div>
                    ))}
                </div>
            ))}
        </div>
    );
}

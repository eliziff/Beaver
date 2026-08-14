"use client";

import { useId, useState } from "react";

import { useUserProfile } from "@/app/contexts/UserProfileContext";
import {
    type DraftingCitationPlacement,
    type DraftingDocumentType,
    type DraftingStyleSettings as DraftingSettings,
} from "@/app/lib/beaverApi";
import { DEFAULT_DRAFTING_STYLE } from "@/app/lib/draftingStyle";

const DOCUMENTS: { value: DraftingDocumentType; label: string }[] = [
    { value: "memo", label: "Memo" },
    { value: "factum", label: "Factum" },
    { value: "letter", label: "Letter" },
    { value: "other", label: "Other" },
];

const CITATIONS: { value: DraftingCitationPlacement; label: string }[] = [
    { value: "footnotes", label: "Footnotes" },
    { value: "inline", label: "Inline" },
    { value: "none", label: "Do not show citations" },
];

const fieldClass =
    "h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-sm text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900 disabled:bg-gray-100 disabled:text-gray-500";

export function DraftingStyleSettings() {
    const { profile, loading, updateDraftingStyle } = useUserProfile();
    const [documentType, setDocumentType] =
        useState<DraftingDocumentType>("memo");
    const [draft, setDraft] = useState<DraftingSettings | null>(null);
    const [status, setStatus] = useState("");
    const id = useId();
    const settings = draft ?? profile?.draftingStyle ?? DEFAULT_DRAFTING_STYLE;

    const save = async (next: DraftingSettings) => {
        setDraft(next);
        setStatus("Saving…");
        const saved = await updateDraftingStyle(next);
        setStatus(saved ? "Saved" : "Could not save drafting style");
        if (saved) setDraft(null);
    };

    const updateDocument = (
        patch: Partial<DraftingSettings["documents"][DraftingDocumentType]>,
    ) => save({
        ...settings,
        documents: {
            ...settings.documents,
            [documentType]: {
                ...settings.documents[documentType],
                ...patch,
            },
        },
    });

    const style = settings.documents[documentType];
    const citationOptions = documentType === "factum"
        ? [
              ...CITATIONS.slice(0, 2),
              { value: "after-paragraph" as const, label: "After each paragraph" },
              CITATIONS[2],
          ]
        : CITATIONS;
    const disabled = loading || !profile;

    return (
        <div className="space-y-6">
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_14rem] sm:items-center">
                <label htmlFor={`${id}-document`} className="text-sm text-gray-900">
                    <span className="block font-medium">Document type</span>
                    <span className="mt-0.5 block text-xs leading-5 text-gray-500">
                        Set defaults separately for each kind of draft.
                    </span>
                </label>
                <select
                    id={`${id}-document`}
                    value={documentType}
                    onChange={(event) =>
                        setDocumentType(event.currentTarget.value as DraftingDocumentType)
                    }
                    className={fieldClass}
                >
                    {DOCUMENTS.map((document) => (
                        <option key={document.value} value={document.value}>
                            {document.label}
                        </option>
                    ))}
                </select>
            </div>

            <fieldset className="space-y-4 border-0 p-0">
                <legend className="text-sm font-semibold text-gray-900">
                    {DOCUMENTS.find(({ value }) => value === documentType)?.label} defaults
                </legend>
                <label className="grid gap-2 text-sm text-gray-900 sm:grid-cols-[minmax(0,1fr)_14rem] sm:items-center">
                    <span>
                        <span className="block font-medium">Citation placement</span>
                        <span className="mt-0.5 block text-xs leading-5 text-gray-500">
                            Source and pinpoint links are added automatically when citations are shown.
                        </span>
                    </span>
                    <select
                        value={style.citationPlacement}
                        disabled={disabled}
                        onChange={(event) =>
                            void updateDocument({
                                citationPlacement: event.currentTarget
                                    .value as DraftingCitationPlacement,
                            })
                        }
                        className={fieldClass}
                    >
                        {citationOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                                {option.label}
                            </option>
                        ))}
                    </select>
                </label>

                <label className="grid gap-2 text-sm text-gray-900 sm:grid-cols-[minmax(0,1fr)_14rem] sm:items-center">
                    <span>
                        <span className="block font-medium">Heading numbering</span>
                        <span className="mt-0.5 block text-xs leading-5 text-gray-500">
                            A request made in chat can still override this default.
                        </span>
                    </span>
                    <select
                        value={String(style.numberHeadings)}
                        disabled={disabled}
                        onChange={(event) => {
                            const value = event.currentTarget.value;
                            void updateDocument({
                                numberHeadings:
                                    value === "auto" ? "auto" : value === "true",
                            });
                        }}
                        className={fieldClass}
                    >
                        <option value="auto">Automatic</option>
                        <option value="true">Number headings</option>
                        <option value="false">Do not number</option>
                    </select>
                </label>
            </fieldset>

            {documentType === "memo" ? (
                <fieldset className="space-y-4 border-0 p-0">
                    <legend className="text-sm font-semibold text-gray-900">
                        Standard memo header
                    </legend>
                    <p className="text-xs leading-5 text-gray-500">
                        Beaver supplies these fields, the current date, and the Re title. The assistant does not write the block.
                    </p>
                    {(["to", "from"] as const).map((field) => (
                        <label
                            key={field}
                            className="grid gap-2 text-sm text-gray-900 sm:grid-cols-[minmax(0,1fr)_14rem] sm:items-center"
                        >
                            <span className="font-medium">
                                {field === "to" ? "To" : "From"}
                            </span>
                            <input
                                value={settings.memoHeader[field]}
                                disabled={disabled}
                                maxLength={200}
                                onChange={(event) => setDraft({
                                    ...settings,
                                    memoHeader: {
                                        ...settings.memoHeader,
                                        [field]: event.currentTarget.value,
                                    },
                                })}
                                onBlur={() => {
                                    const value = settings.memoHeader[field].trim();
                                    void save({
                                        ...settings,
                                        memoHeader: {
                                            ...settings.memoHeader,
                                            [field]: value || DEFAULT_DRAFTING_STYLE.memoHeader[field],
                                        },
                                    });
                                }}
                                className={fieldClass}
                            />
                        </label>
                    ))}
                </fieldset>
            ) : null}

            <p aria-live="polite" className="min-h-5 text-xs text-gray-600">
                {status}
            </p>
        </div>
    );
}

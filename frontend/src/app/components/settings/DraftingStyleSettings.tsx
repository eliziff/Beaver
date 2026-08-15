"use client";

import { useState } from "react";

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
    const [draft, setDraft] = useState<DraftingSettings | null>(null);
    const [status, setStatus] = useState("");
    const settings = draft ?? profile?.draftingStyle ?? DEFAULT_DRAFTING_STYLE;

    const save = async (next: DraftingSettings) => {
        setDraft(next);
        setStatus("Saving…");
        const saved = await updateDraftingStyle(next);
        setStatus(saved ? "Saved" : "Could not save drafting style");
        if (saved) setDraft(null);
    };

    const updateDocument = (
        documentType: DraftingDocumentType,
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

    const disabled = loading || !profile;

    return (
        <div className="space-y-6">
            <fieldset className="space-y-3 border-0 p-0">
                <legend className="text-sm font-semibold text-gray-900">Document defaults</legend>
                <p className="text-xs leading-5 text-gray-500">
                    Set citation formatting, source links, and heading numbering separately. A request in chat can override these defaults.
                </p>
                <div className="hidden grid-cols-[7rem_repeat(3,minmax(0,1fr))] gap-3 px-3 text-xs font-medium text-gray-500 sm:grid">
                    <span>Document</span>
                    <span>Citation placement</span>
                    <span>Source links</span>
                    <span>Heading numbering</span>
                </div>
                {DOCUMENTS.map((document) => {
                    const style = settings.documents[document.value];
                    const citationOptions = document.value === "factum"
                        ? [
                              ...CITATIONS.slice(0, 2),
                              { value: "after-paragraph" as const, label: "After each paragraph" },
                              CITATIONS[2],
                          ]
                        : CITATIONS;
                    return (
                        <div key={document.value} className="grid gap-3 rounded-md bg-gray-50 p-3 sm:grid-cols-[7rem_repeat(3,minmax(0,1fr))] sm:items-center">
                            <span className="text-sm font-semibold text-gray-900">{document.label}</span>
                            <label className="space-y-1 text-sm text-gray-900">
                                <span className="block font-medium sm:sr-only">Citation placement</span>
                                <select
                                    aria-label={`${document.label} citation placement`}
                                    value={style.citationPlacement}
                                    disabled={disabled}
                                    onChange={(event) => void updateDocument(document.value, {
                                        citationPlacement: event.currentTarget.value as DraftingCitationPlacement,
                                    })}
                                    className={fieldClass}
                                >
                                    {citationOptions.map((option) => (
                                        <option key={option.value} value={option.value}>{option.label}</option>
                                    ))}
                                </select>
                            </label>
                            <label className="space-y-1 text-sm text-gray-900">
                                <span className="block font-medium sm:sr-only">Source links</span>
                                <select
                                    aria-label={`${document.label} source links`}
                                    value={String(style.citationHyperlinks)}
                                    disabled={disabled}
                                    onChange={(event) => void updateDocument(document.value, {
                                        citationHyperlinks: event.currentTarget.value === "true",
                                    })}
                                    className={fieldClass}
                                >
                                    <option value="true">Add links</option>
                                    <option value="false">Do not add links</option>
                                </select>
                            </label>
                            <label className="space-y-1 text-sm text-gray-900">
                                <span className="block font-medium sm:sr-only">Heading numbering</span>
                                <select
                                    aria-label={`${document.label} heading numbering`}
                                    value={String(style.numberHeadings)}
                                    disabled={disabled}
                                    onChange={(event) => {
                                        const value = event.currentTarget.value;
                                        void updateDocument(document.value, {
                                            numberHeadings: value === "auto" ? "auto" : value === "true",
                                        });
                                    }}
                                    className={fieldClass}
                                >
                                    <option value="auto">Automatic</option>
                                    <option value="true">Number headings</option>
                                    <option value="false">Do not number</option>
                                </select>
                            </label>
                        </div>
                    );
                })}
            </fieldset>

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

            <p aria-live="polite" className="min-h-5 text-xs text-gray-600">
                {status}
            </p>
        </div>
    );
}

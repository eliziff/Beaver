"use client";

import { useEffect, useRef, useState } from "react";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { useQuickActionsPreference } from "@/app/components/assistant/quickActionsPreferences";
import { CheckboxInput } from "@/app/components/ui/checkbox";
import { AccountSection } from "../AccountSection";
import { AccountToggle } from "../AccountToggle";

export default function FeaturesPage() {
    const { profile, updateLegalResearchUs } = useUserProfile();
    const { visibleActions, showAllQuickActions, hideAllQuickActions } =
        useQuickActionsPreference();
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [draftLegalResearchUs, setDraftLegalResearchUs] = useState<
        boolean | null
    >(null);
    const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        return () => {
            if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
        };
    }, []);

    const persistedLegalResearchUs = profile?.legalResearchUs ?? true;
    const usEnabled = draftLegalResearchUs ?? persistedLegalResearchUs;
    const hasChanges =
        draftLegalResearchUs !== null &&
        draftLegalResearchUs !== persistedLegalResearchUs;
    const quickActionsEnabled = Object.values(visibleActions).some(Boolean);

    const handleUpdateLegalResearch = async () => {
        if (saving) return;
        setSaved(false);
        setSaveError(null);
        setSaving(true);
        const ok = await updateLegalResearchUs(usEnabled);
        setSaving(false);
        if (ok) {
            setDraftLegalResearchUs(null);
            setSaved(true);
            if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
            savedTimerRef.current = setTimeout(() => setSaved(false), 1600);
        } else {
            setSaveError("Could not update. Try again.");
        }
    };

    return (
        <div className="space-y-8">
            <section className="space-y-3">
                <div className="flex items-center gap-2">
                    <h2 className="text-2xl font-medium font-serif text-gray-900">
                        Assistant
                    </h2>
                </div>
                <AccountSection>
                    <div className="flex flex-col gap-3 px-4 py-5 sm:flex-row sm:items-center sm:justify-between">
                        <div className="space-y-1">
                            <p className="text-sm font-medium text-gray-900">
                                Quick actions
                            </p>
                            <p className="text-sm text-gray-500">
                                Show the quick actions row on the assistant
                                start screen.
                            </p>
                        </div>
                        <AccountToggle
                            checked={quickActionsEnabled}
                            size="md"
                            onChange={(checked) => {
                                if (checked) {
                                    showAllQuickActions();
                                } else {
                                    hideAllQuickActions();
                                }
                            }}
                        />
                    </div>
                </AccountSection>
            </section>

            <section className="space-y-3">
                <div className="flex items-center gap-2">
                    <h2 className="text-2xl font-medium font-serif text-gray-900">
                        Legal Research
                    </h2>
                </div>
                <AccountSection>
                    <div className="px-4 py-5">
                        <div className="space-y-1">
                            <p className="text-sm font-medium text-gray-900">
                                Jurisdiction
                            </p>
                            <p className="text-sm text-gray-500">
                                Choose which jurisdictions the assistant can
                                research. When a jurisdiction is enabled, its
                                case-law research tools are available in chat.
                            </p>
                        </div>
                        <label className="mt-4 flex min-h-10 cursor-pointer items-start justify-between gap-3 rounded-md bg-gray-50 px-3 py-3">
                            <span className="min-w-0 select-none">
                                <p className="text-sm text-gray-900">US + Canada</p>
                                <p className="text-sm text-gray-500">
                                    Enable case law research in chat
                                    (CourtListener for US and A2AJ for Canada).
                                </p>
                            </span>
                            <CheckboxInput
                                id="jurisdiction-us"
                                checked={usEnabled}
                                onChange={(event) => {
                                    setDraftLegalResearchUs(
                                        event.currentTarget.checked,
                                    );
                                    setSaved(false);
                                    setSaveError(null);
                                }}
                                disabled={saving}
                                className="mt-0.5"
                            />
                        </label>
                        <div className="mt-5 flex items-center justify-between gap-3">
                            <p className="text-sm text-red-600">
                                {saveError ?? ""}
                            </p>
                            <button
                                type="button"
                                onClick={() => void handleUpdateLegalResearch()}
                                disabled={saving || !hasChanges}
                                className="text-sm font-medium text-gray-700 transition-colors hover:text-gray-950 disabled:cursor-not-allowed disabled:text-gray-300"
                            >
                                {saving
                                    ? "Updating..."
                                    : saved
                                      ? "Updated"
                                      : "Update"}
                            </button>
                        </div>
                    </div>
                </AccountSection>
            </section>
        </div>
    );
}

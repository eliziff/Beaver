"use client";
import { useState } from "react";
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
    const [saveError, setSaveError] = useState<string | null>(null);
    const [pendingUs, setPendingUs] = useState<boolean | null>(null);
    const usEnabled = pendingUs ?? profile?.legalResearchUs ?? true;
    const quickActionsEnabled = Object.values(visibleActions).some(Boolean);
    const handleUpdateLegalResearch = async (enabled: boolean) => {
        if (saving) return;
        setSaveError(null);
        setPendingUs(enabled);
        setSaving(true);
        const ok = await updateLegalResearchUs(enabled);
        setSaving(false);
        setPendingUs(null);
        if (!ok) {
            setSaveError("Could not update. Try again.");
        }
    };
    return (
        <div className="space-y-8">
            <AccountSection heading="Assistant">
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
            <AccountSection heading="Legal Research">
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
                                <p className="text-sm text-gray-900">
                                    US + Canada
                                </p>
                                <p className="text-sm text-gray-500">
                                    Enable case law research in chat
                                    (CourtListener for US and A2AJ for Canada).
                                </p>
                            </span>
                            <CheckboxInput
                                id="jurisdiction-us"
                                checked={usEnabled}
                                onChange={(event) => {
                                    void handleUpdateLegalResearch(
                                        event.currentTarget.checked,
                                    );
                                }}
                                disabled={saving}
                                className="mt-0.5"
                            />
                        </label>
                        {saveError && (
                            <p className="mt-3 text-sm text-red-600">
                                {saveError}
                            </p>
                        )}
                    </div>
            </AccountSection>
        </div>
    );
}

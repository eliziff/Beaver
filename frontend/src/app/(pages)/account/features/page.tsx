import { useState } from "react";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { QUICK_ACTIONS, useAssistantPreferences } from "@/app/components/assistant/assistantPreferences";
import { CheckboxInput } from "@/app/components/ui/checkbox";
import { AccountSection, AccountSettingRow } from "../AccountSection";
import { Switch } from "@/app/components/ui/switch";
import { JurisdictionPreferenceEditor } from "@/app/components/settings/JurisdictionPreferenceEditor";
export default function FeaturesPage() {
    const { profile, updateProfile } = useUserProfile();
    const [preferences, savePreferences] = useAssistantPreferences();
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [pendingUs, setPendingUs] = useState<boolean | null>(null);
    const usEnabled = pendingUs ?? profile?.legalResearchUs ?? true;
    const quickActionsEnabled = Object.values(preferences.quickActions).some(Boolean);
    const handleUpdateLegalResearch = async (enabled: boolean) => {
        if (saving) return;
        setSaveError(null);
        setPendingUs(enabled);
        setSaving(true);
        const ok = await updateProfile({ legalResearchUs: enabled });
        setSaving(false);
        setPendingUs(null);
        if (!ok) {
            setSaveError("Could not update. Try again.");
        }
    };
    return (
        <div className="space-y-8">
            <AccountSection heading="Assistant">
                    <AccountSettingRow title="Quick actions"
                        description="Show the quick actions row on the assistant start screen.">
                        <Switch
                            checked={quickActionsEnabled}
                            ariaLabel="Show quick actions"
                            size="md"
                            onChange={(checked) => savePreferences({
                                quickActions: Object.fromEntries(
                                    QUICK_ACTIONS.map(({ id }) => [id, checked]),
                                ) as typeof preferences.quickActions,
                            })}
                        />
                    </AccountSettingRow>
            </AccountSection>
            <AccountSection heading="Jurisdiction preference">
                <div className="px-4 py-5">
                    <p className="mb-4 text-sm leading-5 text-gray-500">
                        This gives the assistant a standing assumption. A jurisdiction named in your message still takes priority.
                    </p>
                    <JurisdictionPreferenceEditor />
                </div>
            </AccountSection>
            <AccountSection heading="Case law sources">
                    <div className="px-4 py-5">
                        <div className="space-y-1">
                            <p className="text-sm font-medium text-gray-900">
                                US and Canadian sources
                            </p>
                            <p className="text-sm text-gray-500">
                                Make CourtListener and A2AJ available in chat.
                            </p>
                        </div>
                        <label className="mt-4 flex min-h-10 cursor-pointer items-start justify-between gap-3 rounded-md bg-gray-50 px-3 py-3">
                            <span className="min-w-0 select-none">
                                <p className="text-sm text-gray-900">
                                    Enable case law research
                                </p>
                                <p className="text-sm text-gray-500">
                                    CourtListener for the US and A2AJ for Canada.
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

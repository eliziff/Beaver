"use client";

import { Link } from "react-router-dom";
import { useState, type ReactNode } from "react";
import { Modal } from "@/app/components/modals/Modal";
import { ModalSelect } from "@/app/components/modals/ModalSelect";
import { Tabs } from "@/app/components/ui/tabs";
import { ApiKeySettings } from "./ApiKeySettings";
import { JurisdictionPreferenceEditor } from "./JurisdictionPreferenceEditor";
import { SubagentSettings } from "./SubagentSettings";
import { isLocalMode } from "@/app/lib/authMode";
import { AccountSection } from "@/app/(pages)/account/AccountSection";
import { useAssistantPreferences } from "@/app/components/assistant/assistantPreferences";
import { DraftingStyleSettings } from "./DraftingStyleSettings";
import { DisplaySettings } from "./DisplaySettings";
import { WorkflowFileTargetSettings } from "./WorkflowFileTargetSettings";

const TABS = ["General", "Display", "Drafting", "Providers", "Subagents"] as const;
type SettingsTab = (typeof TABS)[number];
const TAB_OPTIONS = TABS.map((value) => ({ value, label: value }));

export function AppSettingsModal({
    open,
    onClose,
}: {
    open: boolean;
    onClose: () => void;
}) {
    const [preferences, savePreferences] = useAssistantPreferences();
    const [selectedTab, setSelectedTab] = useState<SettingsTab>("General");

    const panels: Record<SettingsTab, ReactNode> = {
        General: (
            <div className="space-y-6">
                <section>
                    <h2 className="mb-1 text-base font-semibold text-gray-900">
                        Jurisdiction preference
                    </h2>
                    <p className="mb-4 max-w-2xl text-sm leading-6 text-gray-600">
                        This gives the Assistant a standing assumption. A
                        jurisdiction named in your message still takes priority.
                    </p>
                    <JurisdictionPreferenceEditor />
                </section>
                <section>
                    <h2 className="mb-3 text-base font-semibold text-gray-900">
                        File locations
                    </h2>
                    <AccountSection>
                        <WorkflowFileTargetSettings />
                    </AccountSection>
                </section>
            </div>
        ),
        Display: (
            <section>
                <h2 className="mb-3 text-base font-semibold text-gray-900">
                    Chat display
                </h2>
                <AccountSection className="space-y-5 p-4">
                    <DisplaySettings />
                    <label className="grid gap-2 text-sm text-gray-900 sm:grid-cols-[minmax(0,1fr)_12rem] sm:items-center">
                        <span>
                            <span className="block font-medium">
                                Assistant activity
                            </span>
                            <span className="mt-0.5 block text-xs leading-5 text-gray-500">
                                Auto shows available model thinking summaries without exposing tool arguments.
                            </span>
                        </span>
                        <ModalSelect
                            id="assistant-activity-detail" value={preferences.activityDetail}
                            onChange={(activityDetail) => savePreferences({
                                activityDetail: activityDetail as typeof preferences.activityDetail,
                            })} placeholder={null}
                            className="w-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900"
                            options={[
                                { value: "auto", label: "Auto" },
                                { value: "standard", label: "Standard" },
                                { value: "tools", label: "Tool calls" },
                                { value: "trace", label: "Full trace" },
                            ]} />
                    </label>
                </AccountSection>
            </section>
        ),
        Drafting: (
            <section>
                <h2 className="mb-1 text-base font-semibold text-gray-900">
                    Drafting style
                </h2>
                <p className="mb-4 max-w-2xl text-sm leading-6 text-gray-600">
                    Beaver applies these defaults after the assistant writes the document body.
                </p>
                <AccountSection className="p-4">
                    <DraftingStyleSettings />
                </AccountSection>
            </section>
        ),
        Providers: <ApiKeySettings />,
        Subagents: <SubagentSettings />,
    };

    return (
        <Modal
            open={open}
            onClose={onClose}
            breadcrumbs={["Settings"]}
            size="xl"
            className="h-[min(40rem,calc(100dvh-2rem))]"
            headerAction={
                !isLocalMode ? (
                    <Link
                        to="/account"
                        onClick={onClose}
                        className="text-xs font-medium text-gray-600 hover:text-gray-900"
                    >
                        Account
                    </Link>
                ) : undefined
            }
        >
            <Tabs value={selectedTab} onValueChange={setSelectedTab}
                options={TAB_OPTIONS} ariaLabel="Settings sections" variant="settings">
                <div className="min-w-0 py-4 focus-visible:outline-none">
                    {panels[selectedTab]}
                </div>
            </Tabs>
        </Modal>
    );
}

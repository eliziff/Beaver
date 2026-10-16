"use client";

import type { ReactNode } from "react";
import { Modal } from "@/app/components/modals/Modal";
import { Tabs } from "@/app/components/ui/tabs";
import { connectorsEnabled, isLocalMode } from "@/app/lib/authMode";
import { useAssistantPreferences } from "@/app/components/assistant/assistantPreferences";
import { ProfileSettings } from "@/app/components/account/PersonalisationPage";
import { JurisdictionPreferenceEditor } from "./JurisdictionPreferenceEditor";
import { SubagentSettings } from "./SubagentSettings";
import { AccountSection, SettingsSection } from "./AccountSection";
import { DraftingStyleSettings } from "./DraftingStyleSettings";
import { CaseLawSetting, DisplaySettings, ModelPreferenceSettings, ModelProviderSettings } from "./DisplaySettings";
import { WorkflowFileTargetSettings } from "./WorkflowFileTargetSettings";
import { ApiKeySettings } from "./ApiKeySettings";
import { MemoryEditor } from "./MemoryEditor";
import { OrganizationSettings } from "./OrganizationSettings";
import { ConnectorSettings } from "./ConnectorSettings";
import { AccountSettings } from "./AccountSettings";
import { ModalSelect } from "../modals/ModalSelect";

// Connectors need the server's capability; the account itself is managed only when signed in to a server.
const TABS = [["general", "General"], ["profile", "Profile"], ["drafting", "Drafting"], ["models", "Models"],
    ["memory", "Memory"], ...connectorsEnabled ? [["connectors", "Connectors"]] : [], ["organizations", "Organizations"],
    ...isLocalMode ? [] : [["account", "Account"]]].map(([value, label]) => ({ value, label }));

/** Every setting, one tab at a time; `tab` is the open tab's name in the page address. */
export function AppSettingsModal({ tab, onTabChange, onClose }: {
    tab: string; onTabChange: (tab: string) => void; onClose: () => void;
}) {
    const [preferences, savePreferences] = useAssistantPreferences();
    const selected = TABS.find(({ value }) => value === tab)?.value ?? "general";
    const panels: Record<string, () => ReactNode> = {
        general: () => <>
            <SettingsSection title="Display">
                <AccountSection className="space-y-5 p-4">
                    <DisplaySettings />
                    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                        <div className="min-w-0 flex-1">
                            <label htmlFor="assistant-activity" className="text-sm font-medium text-gray-900">Assistant activity</label>
                            <p className="mt-0.5 text-xs leading-5 text-gray-500">Auto shows available thinking summaries without tool arguments.</p>
                        </div>
                        <div className="w-full sm:w-40"><ModalSelect id="assistant-activity" value={preferences.activityDetail} placeholder={null}
                            onChange={(value) => savePreferences({ activityDetail: value as typeof preferences.activityDetail })}
                            options={[{ value: "auto", label: "Auto" }, { value: "standard", label: "Standard" },
                                { value: "tools", label: "Tool calls" }, { value: "trace", label: "Full trace" }]} /></div>
                    </div>
                </AccountSection>
            </SettingsSection>
            <SettingsSection title="Jurisdiction preference"
                description="This gives the assistant a standing assumption. A jurisdiction named in your message still takes priority.">
                <JurisdictionPreferenceEditor />
            </SettingsSection>
            <SettingsSection title="Case law sources"><AccountSection><CaseLawSetting /></AccountSection></SettingsSection>
            <SettingsSection title="File locations"
                description="Court Records and Authorities save the files they create in these folders.">
                <AccountSection><WorkflowFileTargetSettings /></AccountSection>
            </SettingsSection>
        </>,
        profile: () => <SettingsSection title="Profile"
            description="Authorities uses the court filing details to fill in the cover of an Alberta book.">
            <AccountSection className="p-4"><ProfileSettings /></AccountSection>
        </SettingsSection>,
        drafting: () => <SettingsSection title="Drafting style"
            description="Beaver applies these defaults after the assistant writes the document body.">
            <AccountSection className="p-4"><DraftingStyleSettings /></AccountSection>
        </SettingsSection>,
        models: () => <>
            <SettingsSection title="Providers" description="Turn off a provider to hide it from the model picker.">
                <AccountSection className="p-4"><ModelProviderSettings /></AccountSection>
            </SettingsSection>
            <SettingsSection title="API keys" description="Your saved keys are encrypted and take precedence over shared server keys.">
                <ApiKeySettings />
            </SettingsSection>
            {!isLocalMode && <SettingsSection title="Model preferences">
                <AccountSection><ModelPreferenceSettings /></AccountSection>
            </SettingsSection>}
            <SettingsSection title="Subagents"
                description="Delegate bounded source review when parallel research would materially help. Subagents cannot edit files.">
                <SubagentSettings />
            </SettingsSection>
        </>,
        memory: () => <SettingsSection title="Memory"><MemoryEditor /></SettingsSection>,
        connectors: () => <ConnectorSettings />,
        organizations: () => <SettingsSection title="Organizations" description="Share projects and workflows with your team.">
            <OrganizationSettings />
        </SettingsSection>,
        account: () => <AccountSettings />,
    };
    return <Modal open onClose={onClose} breadcrumbs={["Settings"]} size="xl"
        className="h-[min(40rem,calc(100dvh-2rem))]" bodyClassName="overflow-hidden px-0 py-0">
        <Tabs value={selected} onValueChange={onTabChange} options={TABS} ariaLabel="Settings sections" variant="settings"
            className="min-h-0 flex-1 overflow-hidden" railClassName="static px-5">
            <div key={selected} className="min-h-0 min-w-0 flex-1 space-y-8 overflow-y-auto overscroll-contain px-5 py-5">
                {panels[selected]()}
            </div>
        </Tabs>
    </Modal>;
}

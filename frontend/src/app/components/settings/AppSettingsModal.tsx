"use client";

import Link from "next/link";
import {
    useId,
    useRef,
    useState,
    type KeyboardEvent,
    type ReactNode,
} from "react";
import { Modal } from "@/app/components/modals/Modal";
import { ApiKeySettings } from "./ApiKeySettings";
import { JurisdictionPreferenceEditor } from "./JurisdictionPreferenceEditor";
import { SubagentSettings } from "./SubagentSettings";
import { isAnonymousMode } from "@/app/lib/authMode";
import { AccountSection } from "@/app/(pages)/account/AccountSection";
import { useFootnoteCitationPreference } from "@/app/components/assistant/citationDisplayPreference";
import { useActivityDetail } from "@/app/components/assistant/activityDisplayPreference";

const TABS = ["General", "Providers", "Subagents"] as const;
type SettingsTab = (typeof TABS)[number];

export function AppSettingsModal({
    open,
    onClose,
}: {
    open: boolean;
    onClose: () => void;
}) {
    const footnotes = useFootnoteCitationPreference();
    const activity = useActivityDetail();
    const [selectedTab, setSelectedTab] = useState<SettingsTab>("General");
    const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
    const idPrefix = useId();

    const selectTab = (index: number) => {
        const nextIndex = (index + TABS.length) % TABS.length;
        setSelectedTab(TABS[nextIndex]);
        tabRefs.current[nextIndex]?.focus();
    };
    const handleTabKeyDown = (
        event: KeyboardEvent<HTMLButtonElement>,
        index: number,
    ) => {
        if (event.key === "ArrowRight") selectTab(index + 1);
        else if (event.key === "ArrowLeft") selectTab(index - 1);
        else if (event.key === "Home") selectTab(0);
        else if (event.key === "End") selectTab(TABS.length - 1);
        else return;
        event.preventDefault();
    };

    const panels: Record<SettingsTab, ReactNode> = {
        General: (
            <div className="space-y-8">
                <section>
                    <h2 className="mb-2 font-serif text-2xl font-medium text-gray-900">
                        Jurisdiction preference
                    </h2>
                    <p className="mb-4 max-w-2xl text-sm leading-5 text-gray-500">
                        This gives the Assistant a standing assumption. A
                        jurisdiction named in your message still takes priority.
                    </p>
                    <AccountSection className="p-4">
                        <JurisdictionPreferenceEditor />
                    </AccountSection>
                </section>
                <section>
                    <h2 className="mb-2 font-serif text-2xl font-medium text-gray-900">
                        Activity detail
                    </h2>
                    <AccountSection className="p-4">
                        <label className="grid gap-2 text-sm text-gray-900 sm:grid-cols-[minmax(0,1fr)_12rem] sm:items-center">
                            <span>
                                <span className="block font-medium">
                                    Assistant activity
                                </span>
                                <span className="mt-0.5 block text-xs leading-5 text-gray-500">
                                    Full trace includes available provider reasoning summaries and complete tool arguments.
                                </span>
                            </span>
                            <select
                                value={activity.detail}
                                onChange={(event) =>
                                    activity.setDetail(
                                        event.currentTarget.value as
                                            | "standard"
                                            | "tools"
                                            | "trace",
                                    )
                                }
                                className="h-10 rounded-md border border-gray-300 bg-white px-3 text-sm text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900"
                            >
                                <option value="standard">Standard</option>
                                <option value="tools">Tool calls</option>
                                <option value="trace">Full trace</option>
                            </select>
                        </label>
                    </AccountSection>
                </section>
                <section>
                    <h2 className="mb-2 font-serif text-2xl font-medium text-gray-900">
                        Citation display
                    </h2>
                    <AccountSection className="p-4">
                        <label className="flex min-h-11 cursor-pointer items-center justify-between gap-4 text-sm text-gray-900">
                            <span>Show footnote citation list</span>
                            <input
                                type="checkbox"
                                checked={footnotes.enabled}
                                onChange={(event) =>
                                    footnotes.setEnabled(
                                        event.currentTarget.checked,
                                    )
                                }
                                className="h-4 w-4 shrink-0 accent-gray-950"
                            />
                        </label>
                    </AccountSection>
                </section>
            </div>
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
            headerAction={
                !isAnonymousMode ? (
                    <Link
                        href="/account"
                        onClick={onClose}
                        className="text-xs font-medium text-gray-600 hover:text-gray-900"
                    >
                        Account
                    </Link>
                ) : undefined
            }
        >
            <div
                role="tablist"
                aria-label="Settings sections"
                className="sticky top-0 z-10 grid shrink-0 grid-cols-3 gap-1 border-b border-gray-200 bg-white pb-2"
            >
                {TABS.map((tab, index) => {
                    const selected = tab === selectedTab;
                    return (
                        <button
                            key={tab}
                            ref={(node) => {
                                tabRefs.current[index] = node;
                            }}
                            type="button"
                            role="tab"
                            id={`${idPrefix}-tab-${index}`}
                            aria-selected={selected}
                            aria-controls={`${idPrefix}-panel-${index}`}
                            tabIndex={selected ? 0 : -1}
                            onClick={() => setSelectedTab(tab)}
                            onKeyDown={(event) =>
                                handleTabKeyDown(event, index)
                            }
                            className={`min-h-10 rounded-md border-2 px-2 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900 ${
                                selected
                                    ? "border-gray-900 bg-gray-100 text-gray-950"
                                    : "border-transparent text-gray-500 hover:bg-gray-50 hover:text-gray-900"
                            }`}
                        >
                            {tab}
                        </button>
                    );
                })}
            </div>
            {TABS.map((tab, index) => (
                <div
                    key={tab}
                    role="tabpanel"
                    id={`${idPrefix}-panel-${index}`}
                    aria-labelledby={`${idPrefix}-tab-${index}`}
                    tabIndex={0}
                    hidden={tab !== selectedTab}
                    className="min-w-0 py-5 focus-visible:outline-none"
                >
                    {panels[tab]}
                </div>
            ))}
        </Modal>
    );
}

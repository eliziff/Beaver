"use client";

import { ChevronDown } from "lucide-react";
import { usePathname } from "next/navigation";
import {
    jurisdictionPreferenceSummary,
    useJurisdictionPreference,
} from "./jurisdictionPreferences";
import { JurisdictionPreferenceEditor } from "@/app/components/settings/JurisdictionPreferenceEditor";

export function JurisdictionDock() {
    const pathname = usePathname();
    const { preference, setPreference } = useJurisdictionPreference();
    if (
        !pathname.includes("/assistant") ||
        !preference.showAssistantPanel
    ) {
        return null;
    }
    return (
        <aside
            aria-label="Jurisdiction preference"
            className="fixed bottom-4 left-4 z-[180] w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-gray-300 bg-white shadow-md lg:left-[17rem]"
        >
            <details className="group">
                <summary role="button" className="flex h-10 cursor-pointer list-none items-center gap-3 px-3 text-left [&::-webkit-details-marker]:hidden">
                    <span className="min-w-0 flex-1 text-xs font-medium text-gray-700">
                        Jurisdiction
                    </span>
                    <span className="max-w-40 truncate text-xs text-gray-500">
                        {jurisdictionPreferenceSummary(preference)}
                    </span>
                    <ChevronDown
                        aria-hidden="true"
                        className="h-3.5 w-3.5 shrink-0 -rotate-90 text-gray-500 group-open:rotate-0"
                    />
                </summary>
                <div className="max-h-[min(32rem,70dvh)] overflow-y-auto border-t border-gray-200 p-3">
                    <JurisdictionPreferenceEditor
                        compact
                        showPanelControl={false}
                    />
                    <div className="mt-3 flex justify-end border-t border-gray-200 pt-2">
                        <button
                            type="button"
                            onClick={() =>
                                setPreference({
                                    ...preference,
                                    showAssistantPanel: false,
                                })
                            }
                            className="min-h-9 px-2 text-xs font-medium text-gray-600 hover:text-gray-950"
                        >
                            Hide panel
                        </button>
                    </div>
                </div>
            </details>
        </aside>
    );
}

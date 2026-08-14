"use client";

import {
    setShowAutoMode,
    useShowAutoMode,
} from "@/app/components/assistant/editModePreference";
import { AccountToggle } from "@/app/(pages)/account/AccountToggle";

export function EditModeSettings() {
    const showAutoMode = useShowAutoMode();
    return (
        <div className="flex items-center justify-between gap-4">
            <div>
                <p className="text-sm font-medium text-gray-900">
                    Show Auto Mode
                </p>
                <p className="mt-0.5 text-xs leading-5 text-gray-500">
                    Adds an editing-mode control to chat. Manual Mode remains
                    the default.
                </p>
            </div>
            <AccountToggle
                checked={showAutoMode}
                onChange={setShowAutoMode}
                size="md"
                ariaLabel="Show Auto Mode"
            />
        </div>
    );
}

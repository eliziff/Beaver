"use client";
import { MoreHorizontal } from "lucide-react";
import {
    NativeActionSelect,
    type NativeAction,
} from "@/app/components/ui/native-action-select";
import { APP_SURFACE_HOVER_CLASS } from "@/app/components/ui/liquid-surface";
export type HeaderActionsMenuItem = NativeAction;
export function HeaderActionsMenu({
    items,
    title = "Actions",
}: {
    items: HeaderActionsMenuItem[];
    title?: string;
}) {
    return (
        <NativeActionSelect
            label={title}
            items={items}
            triggerClassName={`h-7 w-7 items-center justify-center rounded-md text-gray-600 hover:text-gray-950 ${APP_SURFACE_HOVER_CLASS}`}
        >
            <MoreHorizontal className="h-4 w-4" />
        </NativeActionSelect>
    );
}

import { MoreHorizontal } from "lucide-react";
import { ActionMenu, type ActionMenuItem } from "@/app/components/ui/action-menu";
import { APP_SURFACE_HOVER_CLASS } from "@/app/components/ui/liquid-surface";
export type HeaderActionsMenuItem = ActionMenuItem;
export function HeaderActionsMenu({
    items,
    title = "Actions",
}: {
    items: HeaderActionsMenuItem[];
    title?: string;
}) {
    return (
        <ActionMenu
            label={title}
            items={items}
            triggerClassName={`h-7 w-7 items-center justify-center rounded-md text-gray-600 hover:text-gray-950 ${APP_SURFACE_HOVER_CLASS}`}
        >
            <MoreHorizontal className="h-4 w-4" />
        </ActionMenu>
    );
}

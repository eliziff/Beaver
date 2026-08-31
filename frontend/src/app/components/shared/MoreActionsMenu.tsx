import { MoreHorizontal } from "lucide-react";
import { ActionMenu, type ActionMenuItem } from "@/app/components/ui/action-menu";
import { APP_SURFACE_HOVER_CLASS } from "@/app/components/ui/liquid-surface";

export type MoreActionsMenuItem = ActionMenuItem;

export function MoreActionsMenu({
    items,
    label = "Actions",
    triggerClassName = `h-7 w-7 items-center justify-center rounded-md text-gray-600 hover:text-gray-950 ${APP_SURFACE_HOVER_CLASS}`,
}: {
    items: MoreActionsMenuItem[];
    label?: string;
    triggerClassName?: string;
}) {
    return (
        <ActionMenu label={label} items={items} triggerClassName={triggerClassName}>
            <MoreHorizontal className="h-4 w-4" />
        </ActionMenu>
    );
}

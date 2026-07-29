import type { ReactNode } from "react";
import { TabPillButton } from "@/app/components/ui/tab-pill-button";
interface ToolbarItem<T extends string> {
    id: T;
    label: string;
}
interface Props<T extends string> {
    items?: readonly ToolbarItem<T>[];
    active?: T;
    onChange?: (id: T) => void;
    actions?: ReactNode;
}
export function TableToolbar<T extends string>({
    items = [],
    active,
    onChange,
    actions,
}: Props<T>) {
    const hasItems = items.length > 0;
    return (
        <div className="mx-4 mb-2 flex min-h-12 flex-wrap items-center gap-2 py-2 md:mx-6">
            {hasItems && (
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 py-0.5">
                    {items.map((item) => (
                        <TabPillButton
                            key={item.id}
                            active={active === item.id}
                            onClick={() => onChange?.(item.id)}
                        >
                            {item.label}
                        </TabPillButton>
                    ))}
                </div>
            )}
            {actions && (
                <div className="ml-auto flex shrink-0 items-center gap-2">
                    {actions}
                </div>
            )}
        </div>
    );
}

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
    return (
        <div className="mx-4 mb-2 flex min-h-12 flex-col items-stretch gap-2 py-2 sm:flex-row sm:flex-wrap sm:items-center md:mx-6">
            {!!items.length && (
                <div className="flex w-full min-w-0 flex-1 flex-wrap items-center gap-2 py-0.5 sm:w-auto">
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

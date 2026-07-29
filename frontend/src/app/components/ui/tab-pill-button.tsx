import type { ComponentProps } from "react";
import { cn } from "@/app/lib/utils";
type TabPillButtonProps = ComponentProps<"button"> & {
    active?: boolean;
};
export function TabPillButton({
    active,
    type = "button",
    className,
    ...props
}: TabPillButtonProps) {
    const stateClass =
        active === true
            ? "border-gray-900 bg-gray-900 text-white"
            : active === false
              ? "border-gray-300 bg-white text-gray-700 hover:bg-gray-100 hover:text-gray-900"
              : "border-gray-300 bg-white text-gray-800 hover:bg-gray-100 hover:text-gray-950";
    return (
        <button
            type={type}
            aria-pressed={active}
            className={cn(
                "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border px-4 text-sm font-medium disabled:cursor-default disabled:opacity-40",
                stateClass,
                className,
            )}
            {...props}
        />
    );
}

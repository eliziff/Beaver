"use client";

import * as React from "react";
import { cn } from "@/app/lib/utils";

type TabPillButtonProps = React.ComponentProps<"button"> & {
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
            ? "border-white/80 bg-white text-gray-900"
            : active === false
              ? "border-white/60 bg-white/45 text-gray-400 hover:bg-white/65 hover:text-gray-700"
              : "border-white/70 bg-white/65 text-gray-700 hover:bg-white hover:text-gray-900";

    return (
        <button
            type={type}
            aria-pressed={active}
            className={cn(
                "inline-flex h-7 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-xs font-medium shadow-sm transition-colors disabled:cursor-default disabled:opacity-40",
                stateClass,
                className,
            )}
            {...props}
        />
    );
}

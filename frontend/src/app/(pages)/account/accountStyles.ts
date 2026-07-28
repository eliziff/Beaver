import { cn } from "@/app/lib/utils";

export const accountGlassInputClassName = cn(
    "rounded-lg px-3 text-gray-900 placeholder:text-gray-400",
    "border border-gray-200 bg-gray-50 shadow-none",
    "focus-visible:border-gray-200 focus-visible:ring-2 focus-visible:ring-gray-300/45",
    "disabled:cursor-not-allowed disabled:text-gray-700 disabled:opacity-100 disabled:placeholder:text-gray-600",
);

export const accountGlassSectionClassName =
    "overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm";

export const accountGlassPrimaryButtonClassName =
    "rounded-lg border border-transparent bg-transparent px-3 text-gray-900 shadow-none hover:bg-gray-100 hover:text-gray-950 active:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-45";

export const accountGlassDangerOutlineButtonClassName =
    "rounded-lg border border-transparent bg-transparent px-3 text-red-600 shadow-none hover:bg-red-50 hover:text-red-700 active:bg-red-100 disabled:cursor-not-allowed disabled:opacity-45";

export const accountGlassIconButtonClassName =
    "justify-center rounded-lg bg-transparent px-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:cursor-not-allowed disabled:opacity-40";

export function accountTabButtonClassName(active: boolean) {
    return cn(
        "flex h-9 w-full items-center rounded-lg px-3 text-left text-sm font-medium whitespace-nowrap",
        active
            ? "bg-gray-100 text-gray-900"
            : "text-gray-500 hover:bg-gray-50 hover:text-gray-900",
    );
}

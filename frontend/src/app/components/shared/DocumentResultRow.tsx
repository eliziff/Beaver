import type { ButtonHTMLAttributes, ReactNode } from "react";
import { FileTypeIcon } from "./FileTypeIcon";
import { cn } from "@/app/lib/utils";

export function DocumentResultRow({ filename, fileType, metadata, trailing, compact = false, className, ...props }:
    Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
        filename: string; fileType?: string | null; metadata?: ReactNode; trailing?: ReactNode; compact?: boolean;
    }) {
    return <button type="button" className={cn(
        "flex min-h-14 w-full items-center gap-3 px-3 py-2.5 text-left outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-red-500",
        compact && "min-h-9 gap-2 px-0 py-0", className)} {...props}>
        <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-red-50 text-red-700",
            compact && "h-auto w-auto bg-transparent text-gray-600")}>
            <FileTypeIcon fileType={fileType ?? filename} className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
            <span className={cn("block truncate text-sm font-medium text-gray-900",
                compact && "text-xs font-normal text-gray-700")}>{filename}</span>
            {metadata && <span className="block text-xs text-gray-500">{metadata}</span>}
        </span>
        {trailing}
    </button>;
}

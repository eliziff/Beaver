import type { ReactNode } from "react";
import { cn } from "@/app/lib/utils";

export function CollectionState({ children, loading = false, error = false, className }: {
    children: ReactNode; loading?: boolean; error?: boolean; className?: string;
}) {
    return <p role={error ? "alert" : loading ? "status" : undefined}
        className={cn("flex min-h-32 items-center justify-center px-5 text-center text-sm",
            error ? "text-red-700" : "text-gray-500", className)}>{children}</p>;
}

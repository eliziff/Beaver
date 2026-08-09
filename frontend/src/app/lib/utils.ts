import { twMerge, type ClassNameValue } from "tailwind-merge";

export function cn(...inputs: ClassNameValue[]) {
    return twMerge(...inputs);
}

export function formatBytes(bytes: number | null | undefined): string | null {
    if (bytes == null) return null;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDate(iso: string | null | undefined): string | null {
    if (!iso) return null;
    return new Date(iso).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
    });
}

export function formatLongDate(iso: string | null | undefined): string | null {
    if (!iso) return null;
    const date = new Date(/^\d{4}-\d{2}-\d{2}$/u.test(iso) ? `${iso}T00:00:00Z` : iso);
    return Number.isNaN(date.getTime())
        ? iso
        : date.toLocaleDateString(undefined, {
              day: "numeric",
              month: "long",
              year: "numeric",
              timeZone: "UTC",
          });
}

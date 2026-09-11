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

const DATE_TIME = new Intl.DateTimeFormat("en-CA", { month: "long", day: "numeric",
    year: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
export function formatDateTime(iso: string | null | undefined): string | null {
    if (!iso) return null;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    const parts = Object.fromEntries(DATE_TIME.formatToParts(date)
        .map(({ type, value }) => [type, value]));
    return `${parts.month} ${parts.day}, ${parts.year} ${parts.hour}:${parts.minute} ${parts.dayPeriod.replaceAll(".", "").toUpperCase()}`;
}

export const errorMessage = (error: unknown, fallback = "") =>
    error instanceof Error ? error.message : fallback;

/** A `next` destination is only honoured when it is a path inside this app. */
export const safeNext = (value: string | null | undefined, fallback: string) =>
    value?.startsWith("/") && !value.startsWith("//") && !value.includes("\\")
        ? value : fallback;

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

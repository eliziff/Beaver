export function ThinkingSpinner({
    label = "Thinking",
    size = 20,
}: {
    label?: string;
    size?: number;
}) {
    return (
        <span
            role="status"
            aria-label={label}
            className="inline-block shrink-0 animate-spin rounded-full border-2 border-red-200 border-t-red-600"
            style={{ width: size, height: size }}
        />
    );
}

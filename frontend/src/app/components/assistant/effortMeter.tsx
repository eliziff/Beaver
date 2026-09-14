const OFF_EFFORTS = new Set(["", "off", "none", "automatic", "disabled"]);

/**
 * Which of the six meter bars an effort lights, measured against the model's own
 * ordered options so "low" reads low on every model rather than on a global scale.
 * `off`/`none`/`automatic` land on 0; unknown or single-option lists fall back to the
 * middle so the meter stays meaningful.
 */
export function effortLevel(effort: string | undefined, efforts: string[]): number {
    const normalized = effort?.trim().toLowerCase();
    if (!normalized || OFF_EFFORTS.has(normalized)) return 0;
    const active = efforts
        .map((value) => value.trim().toLowerCase())
        .filter((value) => !OFF_EFFORTS.has(value));
    const index = active.indexOf(normalized);
    if (index < 0 || active.length <= 1) return 3;
    return Math.round(1 + (5 * index) / (active.length - 1));
}

const BAR_WIDTHS = [3, 5, 7, 9, 11, 13];

/**
 * A color-agnostic six-bar effort meter, stacked vertically with the highest
 * effort bar widest at the top. The bars are decorative; the surrounding
 * control keeps the effort word as its accessible name.
 */
export function EffortMeter({ effort, efforts, className }: {
    effort?: string;
    efforts: string[];
    className?: string;
}) {
    const level = effortLevel(effort, efforts);
    return (
        <svg viewBox="0 0 13 15" width={13} height={15} aria-hidden="true" className={className}>
            {BAR_WIDTHS.map((width, index) => (
                <rect key={width} x={0} y={0.2 + (BAR_WIDTHS.length - 1 - index) * 2.5}
                    width={width} height={1.6} rx={0.8} fill="currentColor"
                    opacity={index < level ? 1 : 0.22} />
            ))}
        </svg>
    );
}

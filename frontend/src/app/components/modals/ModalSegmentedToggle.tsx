import type { LucideIcon } from "lucide-react";
interface SegmentedToggleOption<T extends string> {
    value: T;
    label: string;
    icon?: LucideIcon;
}
interface ModalSegmentedToggleProps<T extends string> {
    value: T;
    onChange: (value: T) => void;
    options: SegmentedToggleOption<T>[];
}
export function ModalSegmentedToggle<T extends string>({
    value,
    onChange,
    options,
}: ModalSegmentedToggleProps<T>) {
    return (
        <div
            className="inline-grid min-h-9 gap-1 rounded-md border border-gray-300 bg-white p-1"
            style={{
                gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))`,
            }}
        >
            {options.map((option) => {
                const Icon = option.icon;
                const active = option.value === value;
                return (
                    <button
                        key={option.value}
                        type="button"
                        onClick={() => onChange(option.value)}
                        aria-pressed={active}
                        className={`flex items-center justify-center gap-1.5 whitespace-normal break-normal rounded-sm px-3 py-1 text-xs font-medium leading-tight outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900 ${
                            active
                                ? "bg-gray-900 text-white"
                                : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                        }`}
                    >
                        {Icon && (
                            <Icon aria-hidden="true" className="h-3 w-3" />
                        )}
                        {option.label}
                    </button>
                );
            })}
        </div>
    );
}

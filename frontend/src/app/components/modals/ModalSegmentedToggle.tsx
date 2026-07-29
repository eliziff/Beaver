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
                        className={`flex items-center justify-center gap-1.5 whitespace-normal break-normal rounded-sm px-3 py-1 text-xs leading-tight ${
                            active
                                ? "bg-gray-100 text-gray-900"
                                : "text-gray-500 hover:text-gray-700"
                        }`}
                    >
                        {Icon && (
                            <Icon className="h-3 w-3" />
                        )}
                        {option.label}
                    </button>
                );
            })}
        </div>
    );
}

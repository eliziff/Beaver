import { ChevronDown } from "lucide-react";
import { ActionMenu } from "../ui/action-menu";

export function ChoiceMenu({ label, value, options, onChange, className = "" }: { label: string; value: string;
  options: readonly { value: string; label: string }[]; onChange: (value: string) => void; className?: string;
}) { const selected = options.find((option) => option.value === value)?.label;
  return <ActionMenu label={label} className={`min-w-0 ${className}`} items={options.map((option) => ({
    label: option.label, checked: option.value === value, onSelect: () => onChange(option.value) }))}
    triggerClassName="h-8 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-gray-300 bg-white px-2 text-sm text-gray-800 hover:border-gray-500">
    <span className="truncate">{selected}</span><ChevronDown aria-hidden="true" className="size-3.5" />
  </ActionMenu>; }

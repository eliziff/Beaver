import type { LucideIcon } from "lucide-react";
import { APP_SURFACE_HOVER_CLASS } from "@/app/components/ui/liquid-surface";

export function ChoiceCards<T extends string>({ options, onChoose }: {
    options: { id: T; icon: LucideIcon; title: string; hint: string }[];
    onChoose: (id: T) => void;
}) {
    return <div className="grid gap-3 sm:grid-cols-3">
        {options.map(({ id, icon: Icon, title, hint }) => <button key={id} type="button" aria-label={title}
            onClick={() => onChoose(id)}
            className={`flex flex-col items-start gap-1.5 rounded-lg border border-gray-200 p-4 text-left ${APP_SURFACE_HOVER_CLASS} focus-visible:outline focus-visible:outline-2 focus-visible:outline-gray-900`}>
            <Icon aria-hidden className="size-4 text-gray-600" />
            <span className="text-sm font-medium text-gray-900">{title}</span>
            <span className="text-xs text-gray-500">{hint}</span>
        </button>)}
    </div>;
}

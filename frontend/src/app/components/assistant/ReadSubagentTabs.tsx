import { CircleStop, LoaderCircle } from "lucide-react";
import { Tabs } from "@/app/components/ui/tabs";
import type { Citation } from "../shared/types";
import { ReadSubagentDock, type ReadSubagentPanel } from "./ReadSubagentDock";

export type ReadSubagentGroup = { id: string; label: string; panels: ReadSubagentPanel[] };

function AgentStatus({ panels }: { panels: ReadSubagentPanel[] }) {
    if (panels.some(({ status }) => status === "running")) {
        return <span role="status" className="shrink-0" title="Working"><LoaderCircle className="size-3 motion-safe:animate-spin" aria-hidden="true" /><span className="sr-only">Working</span></span>;
    }
    if (panels.some(({ status }) => status === "interrupted")) {
        return <span title="Stopped" className="shrink-0"><CircleStop className="size-3 text-gray-400" aria-hidden="true" /><span className="sr-only">Stopped</span></span>;
    }
    return panels.every(({ status }) => status === "completed")
        ? <span className="size-1.5 shrink-0 rounded-full bg-gray-400" title="Done"><span className="sr-only">Done</span></span>
        : null;
}

export function ReadSubagentTabs({
    groups,
    activeId,
    onActivate,
    onCitationClick,
}: {
    groups: ReadSubagentGroup[];
    activeId: string | null;
    onActivate: (id: string) => void;
    onCitationClick: (citation: Citation) => void;
}) {
    const active = groups.find(({ id }) => id === activeId) ?? groups[0];
    if (!active) return <div className="grid h-full place-items-center p-6 text-center text-sm text-gray-500">Reading-agent runs will appear here.</div>;
    return <Tabs value={active.id} onValueChange={onActivate}
        options={groups.map((group) => ({ value: group.id, label:
            <span className="flex min-w-0 items-center justify-center gap-2">
                <span className="truncate">{group.label}</span>
                <AgentStatus panels={group.panels} />
            </span> }))}
            ariaLabel="Reading agents" variant="dock" className="h-full">
        <ReadSubagentDock idPrefix={`reading-agent-${active.id}`}
            panels={active.panels} onCitationClick={onCitationClick} embedded />
    </Tabs>;
}

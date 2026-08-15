import { useEffect, useState } from "react";
import { ArrowUpRight, X } from "lucide-react";
import type {
    AutomationRunEvent,
    AutomationToolName,
} from "@/app/components/shared/types";
const LABELS: Record<AutomationToolName, string> = {
    create_table_of_authorities: "Create book/table of authorities",
    link_docx_citations: "Auto-add hyperlinks to citations",
    fix_docx_supras: "Fix supra references",
};
const LOCAL_AUTOMATION_EVENT = "beaver:assistant-automation";
export function automationLabel(tool: AutomationToolName) {
    return LABELS[tool];
}
export function automationRunKey(run: AutomationRunEvent) {
    return run.job_id ? `toa:${run.job_id}` : run.id;
}
export function publishAutomationRun(run: AutomationRunEvent) {
    window.dispatchEvent(
        new CustomEvent(LOCAL_AUTOMATION_EVENT, { detail: run }),
    );
}
export function AutomationRunButton({
    run,
    onOpen,
}: {
    run: AutomationRunEvent;
    onOpen: (run: AutomationRunEvent) => void;
}) {
    return (
        <button
            type="button"
            aria-label={`${automationLabel(run.tool)}: ${run.status}`}
            onClick={() => onOpen(run)}
            className="flex min-h-10 w-full max-w-xl items-center gap-3 rounded-md border border-gray-300 bg-white px-3 py-2 text-left hover:border-gray-500 hover:bg-gray-50"
        >
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-900">
                {automationLabel(run.tool)}
            </span>
            <span
                className="max-w-24 shrink-0 truncate text-xs capitalize text-gray-600"
                title={run.status}
            >
                {run.status}
            </span>
        </button>
    );
}
export function AutomationRunPanel({ run }: { run: AutomationRunEvent }) {
    const rows = [
        ["Stage", run.stage],
        ["Status", run.status],
        ...(typeof run.progress === "number"
            ? [["Progress", `${run.progress}%`]]
            : []),
        ...(run.version_number != null
            ? [["Version", `V${run.version_number}`]]
            : run.version_id
              ? [["Version", run.version_id]]
              : []),
        ...(run.counts ?? []).map(({ label, value }) => [label, String(value)]),
    ];
    return (
        <div className="min-w-0 space-y-4 p-4">
            <h2 className="text-base font-semibold text-gray-950">
                {automationLabel(run.tool)}
            </h2>
            <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
                {rows.map(([label, value]) => (
                    <div className="contents" key={label}>
                        <dt className="font-medium text-gray-600">{label}</dt>
                        <dd className="min-w-0 break-words text-gray-950">
                            {value}
                        </dd>
                    </div>
                ))}
            </dl>
            {run.message && (
                <p className="break-words text-sm leading-6 text-gray-700">
                    {run.message}
                </p>
            )}
            {run.error && (
                <p
                    role="alert"
                    className="break-words text-sm leading-6 text-red-700"
                >
                    {run.error}
                </p>
            )}
            {!!run.outputs?.length && (
                <div className="space-y-1.5">
                    <h3 className="text-sm font-medium text-gray-700">Output</h3>
                    {run.outputs.map((output) =>
                        output.url ? (
                            <a
                                key={`${output.name}:${output.url}`}
                                href={output.url}
                                target={/^https?:\/\//iu.test(output.url) ? "_blank" : undefined}
                                rel={/^https?:\/\//iu.test(output.url) ? "noopener noreferrer" : undefined}
                                className="block truncate text-sm text-blue-700 underline decoration-blue-300 underline-offset-2"
                            >
                                {output.name}
                            </a>
                        ) : (
                            <p
                                key={output.name}
                                className="truncate text-sm text-gray-950"
                            >
                                {output.name}
                            </p>
                        ),
                    )}
                </div>
            )}
            {run.app_url && (
                <a
                    href={run.app_url}
                    target={/^https?:\/\//iu.test(run.app_url) ? "_blank" : undefined}
                    rel={/^https?:\/\//iu.test(run.app_url) ? "noopener noreferrer" : undefined}
                    className="inline-flex h-9 items-center gap-1.5 rounded-md bg-gray-950 px-3 text-sm font-medium text-white hover:bg-black"
                >
                    Open full Authorities
                    <ArrowUpRight className="h-4 w-4" />
                </a>
            )}
        </div>
    );
}
export function AssistantAutomationActivity() {
    const [run, setRun] = useState<AutomationRunEvent | null>(null);
    const [expanded, setExpanded] = useState(false);
    useEffect(() => {
        const onRun = (event: Event) => {
            const next = (event as CustomEvent<AutomationRunEvent>).detail;
            if (next?.type !== "automation_run") return;
            if (next.status === "running") setExpanded(false);
            setRun((current) =>
                current && automationRunKey(current) === automationRunKey(next)
                    ? { ...current, ...next }
                    : next,
            );
        };
        window.addEventListener(LOCAL_AUTOMATION_EVENT, onRun);
        return () => window.removeEventListener(LOCAL_AUTOMATION_EVENT, onRun);
    }, []);
    if (!run) return null;
    return (
        <aside
            aria-label="Assistant activity"
            aria-live="polite"
            className="fixed bottom-4 right-4 z-[190] w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-gray-300 bg-white shadow-md"
        >
            <div className="flex h-10 items-center border-b border-gray-200 px-3">
                <span className="min-w-0 flex-1 text-xs font-medium text-gray-600">
                    Assistant activity
                </span>
                <button
                    type="button"
                    onClick={() => {
                        setRun(null);
                        setExpanded(false);
                    }}
                    aria-label="Dismiss automation activity"
                    className="flex h-7 w-7 items-center justify-center rounded-md text-gray-600 hover:bg-gray-100 hover:text-gray-950"
                >
                    <X className="h-4 w-4" />
                </button>
            </div>
            {expanded ? (
                <AutomationRunPanel run={run} />
            ) : (
                <div className="p-2">
                    <AutomationRunButton
                        run={run}
                        onOpen={() => setExpanded(true)}
                    />
                </div>
            )}
        </aside>
    );
}

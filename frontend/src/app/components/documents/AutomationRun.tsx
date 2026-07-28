"use client";

import { ArrowUpRight } from "lucide-react";
import type {
    AutomationRunEvent,
    AutomationToolName,
} from "@/app/components/shared/types";

const LABELS: Record<AutomationToolName, string> = {
    toa_submit_library_document: "Create book/table of authorities",
    toa_job_status: "Create book/table of authorities",
    library_link_docx_citations: "Auto-add hyperlinks to citations",
    library_fix_docx_supras: "Fix supra references",
};

export function automationLabel(tool: AutomationToolName) {
    return LABELS[tool];
}

export function automationRunKey(run: AutomationRunEvent) {
    return run.job_id ? `toa:${run.job_id}` : run.id;
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
                    className="inline-flex h-9 items-center gap-1.5 rounded-md bg-gray-950 px-3 text-sm font-medium text-white hover:bg-black"
                >
                    Open full Authorities
                    <ArrowUpRight className="h-4 w-4" />
                </a>
            )}
        </div>
    );
}

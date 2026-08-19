import { useEffect, useState } from "react";
import { ArrowUpRight, X } from "lucide-react";
import type { AutomationRunEvent, AutomationToolName } from "@/app/components/shared/types";
import { safeAssistantUrl } from "@/app/lib/assistantSession";

const LABELS: Record<AutomationToolName, string> = {
  create_table_of_authorities: "Create book/table of authorities",
  fix_docx_supras: "Fix supra references",
};
const LOCAL_AUTOMATION_EVENT = "beaver:assistant-automation";

export const automationLabel = (tool: AutomationToolName) => LABELS[tool];
export const automationRunKey = (run: AutomationRunEvent) => run.job_id ? `toa:${run.job_id}` : run.id;
export function publishAutomationRun(run: AutomationRunEvent) {
  window.dispatchEvent(new CustomEvent(LOCAL_AUTOMATION_EVENT, { detail: run }));
}

export function AutomationRunButton({ run, onOpen }: {
  run: AutomationRunEvent;
  onOpen: (run: AutomationRunEvent) => void;
}) {
  return (
    <button
      type="button"
      aria-label={`${automationLabel(run.tool)}: ${run.status}`}
      onClick={() => onOpen(run)}
      className="flex min-h-10 w-full max-w-xl items-center gap-3 rounded border px-3 py-2 text-left hover:bg-gray-50"
    >
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{automationLabel(run.tool)}</span>
      <span className="text-xs capitalize text-gray-600">{run.status}</span>
    </button>
  );
}

export function AutomationRunPanel({ run }: { run: AutomationRunEvent }) {
  const rows = [
    ["Stage", run.stage],
    ["Status", run.status],
    ...(run.progress == null ? [] : [["Progress", `${run.progress}%`]]),
    ...(run.version_number == null ? [] : [["Version", `V${run.version_number}`]]),
    ...(run.counts ?? []).map(({ label, value }) => [label, String(value)]),
  ];
  const appHref = safeAssistantUrl(run.app_url);
  return (
    <div className="min-w-0 space-y-4 p-4">
      <h2 className="font-semibold">{automationLabel(run.tool)}</h2>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
        {rows.map(([label, value]) => (
          <div className="contents" key={label}>
            <dt className="font-medium text-gray-600">{label}</dt>
            <dd className="break-words">{value}</dd>
          </div>
        ))}
      </dl>
      {run.message && <p className="text-sm">{run.message}</p>}
      {run.error && <p role="alert" className="text-sm text-red-700">{run.error}</p>}
      {!!run.outputs?.length && (
        <section>
          <h3 className="text-sm font-medium">Output</h3>
          {run.outputs.map((output) => {
            const href = safeAssistantUrl(output.url);
            return href
              ? <a key={`${output.name}:${href}`} href={href} target={href.startsWith("http") ? "_blank" : undefined} rel="noopener noreferrer" className="block truncate text-sm underline">{output.name}</a>
              : <p key={output.name} className="truncate text-sm">{output.name}</p>;
          })}
        </section>
      )}
      {appHref && (
        <a href={appHref} target={appHref.startsWith("http") ? "_blank" : undefined} rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded bg-gray-950 px-3 py-2 text-sm text-white">
          Open full Authorities <ArrowUpRight className="size-4" />
        </a>
      )}
    </div>
  );
}

export function AssistantAutomationActivity() {
  const [run, setRun] = useState<AutomationRunEvent | null>(null);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const update = (event: Event) => {
      const next = (event as CustomEvent<AutomationRunEvent>).detail;
      if (next?.type !== "automation_run") return;
      if (next.status === "running") setExpanded(false);
      setRun((current) => current && automationRunKey(current) === automationRunKey(next)
        ? { ...current, ...next }
        : next);
    };
    window.addEventListener(LOCAL_AUTOMATION_EVENT, update);
    return () => window.removeEventListener(LOCAL_AUTOMATION_EVENT, update);
  }, []);
  if (!run) return null;
  return (
    <aside aria-label="Assistant activity" aria-live="polite" className="fixed bottom-4 right-4 z-[190] w-[min(22rem,calc(100vw-2rem))] rounded border bg-white shadow-md">
      <header className="flex h-10 items-center border-b px-3 text-xs font-medium">
        <span className="flex-1">Assistant activity</span>
        <button type="button" onClick={() => setRun(null)} aria-label="Dismiss automation activity"><X className="size-4" /></button>
      </header>
      {expanded
        ? <AutomationRunPanel run={run} />
        : <div className="p-2"><AutomationRunButton run={run} onOpen={() => setExpanded(true)} /></div>}
    </aside>
  );
}

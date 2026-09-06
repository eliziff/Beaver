import { ArrowUpRight } from "lucide-react";
import { Link } from "react-router-dom";
import type { WorkflowRunEvent, WorkflowOperationName } from "@/app/lib/api/chat";
import { safeAssistantUrl } from "@/app/lib/safeAssistantUrl";

const LABELS: Record<WorkflowOperationName, string> = {
  create_table_of_authorities: "Create table/book of authorities",
  update_work_product: "Update legal work product",
};

const workflowOperationLabel = (tool: WorkflowOperationName) => LABELS[tool];
const workflowRunLabel = (run: WorkflowRunEvent) => run.work_product
  ? run.work_product.kind === "court-record" ? "Court Records" : "Authorities"
  : workflowOperationLabel(run.tool);
export const workflowRunKey = (run: WorkflowRunEvent) => run.job_id ? `toa:${run.job_id}` : run.id;
export function WorkflowRunButton({ run, onOpen }: {
  run: WorkflowRunEvent;
  onOpen: (run: WorkflowRunEvent) => void;
}) {
  const label = workflowRunLabel(run);
  return (
    <button
      type="button"
      aria-label={`${label}: ${run.status}`}
      onClick={() => onOpen(run)}
      className="flex min-h-10 w-full max-w-xl items-center gap-3 rounded border px-3 py-2 text-left hover:bg-gray-50"
    >
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>
      <span className="text-xs capitalize text-gray-600">{run.status}</span>
    </button>
  );
}

export function WorkflowRunPanel({ run }: { run: WorkflowRunEvent }) {
  const rows = [
    ...(run.progress == null ? [] : [["Progress", `${run.progress}%`]]),
    ...(run.version_number == null ? [] : [["Version", `V${run.version_number}`]]),
    ...(run.counts ?? []).map(({ label, value }) => [label, String(value)]),
  ];
  const appHref = safeAssistantUrl(run.app_url);
  const workspace = run.requested_action === "open" && run.work_product
    ? run.work_product.kind === "court-record"
      ? { href: `/court-records?draft=${encodeURIComponent(run.work_product.id)}`,
          label: "Open Court Records" }
      : { href: `/table-of-authorities?draft=${encodeURIComponent(run.work_product.id)}`,
          label: "Open Authorities" }
    : appHref ? { href: appHref, label: run.tool === "create_table_of_authorities"
      ? "Open Authorities" : "Open workspace" } : null;
  const actionClass = "inline-flex items-center gap-1 rounded bg-gray-950 px-3 py-2 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-950";
  const actionContent = workspace && <>{workspace.label}
    <ArrowUpRight aria-hidden="true" className="size-4" /></>;
  const activeStage = run.status === "running"
    ? run.stage === workflowOperationLabel(run.tool) || run.stage === "Update work product"
      ? "Running"
      : run.stage
    : null;
  return (
    <div className="min-w-0 space-y-4 p-4">
      <h2 className="font-semibold">{workflowRunLabel(run)}</h2>
      {activeStage && <p role="status" className="text-sm text-gray-600">{activeStage}</p>}
      {!!rows.length && (
        <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-[max-content_minmax(0,1fr)]">
          {rows.map(([label, value]) => (
            <div className="grid gap-0.5 sm:contents" key={label}>
              <dt className="break-words font-medium text-gray-600">{label}</dt>
              <dd className="break-words">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {run.message && <p className="text-sm">{run.message}</p>}
      {(run.error || run.status === "error") && <p role="alert" className="text-sm text-red-700">
        {run.error || "Unable to complete."}
      </p>}
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
      {workspace && (workspace.href.startsWith("/")
        ? <Link to={workspace.href} className={actionClass}>{actionContent}</Link>
        : <a href={workspace.href} target="_blank" rel="noopener noreferrer"
            className={actionClass}>{actionContent}</a>)}
    </div>
  );
}


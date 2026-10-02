import { Check, Clock, Download, Loader2 } from "lucide-react";
import { tabLabel, tabReference } from "../../../../shared/authorities-order.mjs";
import type { AuthoritiesBuildReceipt, AuthoritiesProduct } from "./types";
import { cn } from "@/app/lib/utils";

type Output = AuthoritiesProduct["outputs"][string];

/** What the Word copy holds, as the Build choices leave it. */
function wordCopyDetail(draft: AuthoritiesProduct) {
  const { settings, insertIntoDocument } = draft.state;
  const tab = tabReference(settings, tabLabel(1, settings.tabStyle, settings));
  const marks = !insertIntoDocument ? null : settings.tableDelivery === "native-marks" ? "Citations marked for Word’s table"
    : settings.tableDelivery === "linked-append" ? "A linked table on a last page" : "Citations marked, with Word’s table on a last page";
  return [marks, tab && `${tab} after each citation`].filter(Boolean).join("; ") + ".";
}

/** Every output the Build choices will make, each with its state and its download: a dock beside
 *  the choices, so a new build shows where its outputs are rather than below the page. */
export function OutputsDock({ draft, building, progress, previous, waiting, linkWarnings, onDownload, className }: {
  draft: AuthoritiesProduct; building: boolean; progress: string; previous: boolean;
  /** The final PDF is waiting for the brief saved as PDF. */
  waiting: boolean;
  linkWarnings?: AuthoritiesBuildReceipt["linkWarnings"];
  onDownload: (documentId: string, versionId: string, filename: string) => void;
  className?: string;
}) {
  const { state, outputs } = draft, roles = Object.keys(outputs);
  const word = state.import.kind === "document" && state.import.fileType === "docx";
  const tabs = (state.settings.citationSuffix ?? "none") !== "none";
  const rows = [
    ...state.outputMode !== "table" || state.settings.finalPdf ? [{ key: "book", title: "Book of Authorities",
      detail: "Each authority behind its tab, indexed and bookmarked.", roles: roles.filter((role) => role.startsWith("book")) }] : [],
    ...state.outputMode !== "book" ? [{ key: "table", title: "Table of Authorities",
      detail: "The authorities grouped, with where the brief cites each.", roles: ["table"] }] : [],
    ...word && (state.insertIntoDocument || tabs) ? [{ key: "word", title: "Word copy", detail: wordCopyDetail(draft),
      roles: ["annotated-document"] }]
      : !word && state.insertIntoDocument ? [{ key: "filing", title: "Filing PDF",
        detail: "The brief with a linked Table of Authorities after it.", roles: ["annotated-document"] }] : [],
    ...state.settings.finalPdf ? [{ key: "final", title: "Final PDF", waiting,
      detail: "The brief, then the book, its citations linked inside it.", roles: ["final-pdf", "link-report"] }] : [],
  ];
  return <aside aria-label="Outputs" className={cn("min-w-0 rounded-lg border border-gray-200 bg-gray-50 p-3", className)}>
    <h3 className="text-sm font-semibold text-gray-950">Outputs</h3>
    <p className="min-h-4 text-xs leading-4 text-gray-600" aria-live="polite">
      {building ? progress || "Building…" : previous ? "Previous build — rebuild to update" : ""}</p>
    <ul className="mt-2 grid gap-2">
      {rows.map((row) => {
        const files = row.roles.flatMap((role) => outputs[role] ? [[role, outputs[role]] as [string, Output]] : []);
        const ready = !!files.length && !previous && !building;
        const status = building && !row.waiting ? "Building" : row.waiting ? "Waiting for your brief PDF"
          : ready ? "Ready" : files.length ? "Previous build" : "Not built yet";
        return <li key={row.key} data-output={row.key} className={cn("rounded-md border bg-white p-2 transition-colors duration-500 motion-reduce:transition-none",
          ready ? "border-green-600/40" : "border-gray-200")}>
          <div className="flex flex-wrap items-center justify-between gap-x-2">
            <span className="whitespace-nowrap text-sm font-medium text-gray-950">{row.title}</span>
            <span role="status" className={cn("flex shrink-0 items-center gap-1 text-xs", ready ? "text-green-800" : "text-gray-600")}>
              {status === "Building" ? <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" />
                : ready ? <Check className="h-3.5 w-3.5" /> : row.waiting ? <Clock className="h-3.5 w-3.5" /> : null}{status}</span>
          </div>
          <p className="mt-0.5 text-xs leading-4 text-gray-600">{row.detail}</p>
          {row.key === "final" && ready && outputs["link-report"] && <p className="mt-1 text-xs leading-4 text-gray-700">
            {linkWarnings?.length ? `${linkWarnings.length} link${linkWarnings.length === 1 ? " wasn't" : "s weren't"} added; ` : ""}
            Unlinked citations lists them to finish in a PDF editor.</p>}
          {files.map(([role, output]) => <button key={role} type="button" title={output.filename}
            aria-label={`Download ${previous ? "previous " : ""}${output.filename}`}
            onClick={() => onDownload(output.documentId, output.versionId, output.filename)}
            className="mt-1 grid min-h-8 w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded px-1 text-left text-xs outline-none hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-red-600">
            <Download className="h-3.5 w-3.5 text-red-700" />
            <span className="min-w-0 truncate text-gray-800">{role === "link-report" ? "Unlinked citations" : output.filename}</span>
            <span className="text-[11px] uppercase text-gray-500">{output.filename.split(".").at(-1)}</span>
          </button>)}
        </li>;
      })}
    </ul>
  </aside>;
}

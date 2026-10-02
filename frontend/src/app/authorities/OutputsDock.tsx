import type { ReactNode } from "react";
import { BookOpen, Download, Loader2, SlidersHorizontal } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import type { AuthoritiesBuildReceipt, AuthoritiesProduct } from "./types";
import { cn } from "@/app/lib/utils";

type Output = AuthoritiesProduct["outputs"][string];
const ROW = "grid min-h-10 w-full grid-cols-[minmax(0,1fr)_auto_1rem] items-center gap-2 rounded-md px-2 text-left text-sm";
const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-red-600";
// Every row keeps a slot after it, so each row's type and icon sit in one column down the dock.
const LINE = "grid grid-cols-[minmax(0,1fr)_2rem] items-center gap-1";

/** Build, and everything it makes: one row an output, each a download once it is built. Every row
 *  is there from the start, so a build fills the dock in without moving anything. */
export function OutputsDock({ draft, busy, building, progress, note, previous, waiting, linkWarnings,
  onBuild, onCancel, onDownload, onFinalPdf, className }: {
  draft: AuthoritiesProduct; busy: boolean; building: boolean;
  /** What the build is doing now. */
  progress: string;
  /** What Build still needs before it can run. */
  note: string;
  previous: boolean;
  /** The final PDF is waiting for the brief saved as PDF. */
  waiting: boolean;
  linkWarnings?: AuthoritiesBuildReceipt["linkWarnings"];
  onBuild: () => void; onCancel: () => void;
  onDownload: (documentId: string, versionId: string, filename: string) => void;
  /** Opens the final PDF's own choices; absent where a book has no brief to append it to. */
  onFinalPdf?: () => void;
  className?: string;
}) {
  const { state, outputs } = draft, roles = Object.keys(outputs);
  const word = state.import.kind === "document" && state.import.fileType === "docx";
  const tabs = (state.settings.citationSuffix ?? "none") !== "none";
  const final = !!state.settings.finalPdf;
  const rows: Array<{ key: string; title: string; roles: string[] }> = [
    ...state.outputMode !== "table" || final ? [{ key: "book", title: "Book of Authorities",
      roles: roles.filter((role) => role.startsWith("book")) }] : [],
    ...state.outputMode !== "book" ? [{ key: "table", title: "Table of Authorities", roles: ["table"] }] : [],
    ...word && (state.insertIntoDocument || tabs) ? [{ key: "word", title: "Word copy", roles: ["annotated-document"] }]
      : !word && state.insertIntoDocument ? [{ key: "filing", title: "Filing PDF", roles: ["annotated-document"] }] : [],
  ];
  const download = (role: string, output: Output, title: ReactNode, small = false): ReactNode => <button key={role} type="button"
    title={output.filename} aria-label={`Download ${previous ? "previous " : ""}${output.filename}`}
    onClick={() => onDownload(output.documentId, output.versionId, output.filename)}
    className={cn(ROW, FOCUS, "hover:bg-white", small ? "min-h-8 text-xs text-gray-700" : "text-gray-950")}>
    <span className={cn("truncate", !small && "font-medium")}>{title}</span>
    <span className="text-[0.6875rem] uppercase tracking-wide text-gray-500">{output.filename.split(".").at(-1)}</span>
    <Download className={cn("text-gray-700", small ? "h-3.5 w-3.5" : "h-4 w-4")} />
  </button>;
  const unbuilt = (title: string, detail = ""): ReactNode => <div className={cn(ROW, "text-gray-500")}>
    <span className="truncate font-medium">{title}</span>
    <span className="col-span-2 truncate text-xs">{detail}</span>
  </div>;
  const status = building ? progress || "Building…" : note || (previous && roles.length ? "Changed since this build." : "");
  const finalFile = outputs["final-pdf"], report = outputs["link-report"];
  return <aside aria-label="Outputs" className={cn("min-w-0", className)}>
    <Button type="button" className="h-10 w-full" disabled={busy && !building} onClick={building ? onCancel : onBuild}>
      {building ? <><Loader2 className="motion-safe:animate-spin" /> Cancel</> : <><BookOpen /> Build</>}</Button>
    {/* The line is always there, so progress and notes never move the outputs. */}
    <p role="status" aria-live="polite" title={status} className="mt-1.5 min-h-4 truncate px-2 text-xs leading-4 text-gray-600">{status}</p>
    <h3 className="mt-3 px-2 text-sm font-semibold text-gray-950">Outputs</h3>
    <ul className="mt-1 grid gap-px">
      {rows.map((row) => {
        const files = row.roles.flatMap((role) => outputs[role] ? [[role, outputs[role]] as [string, Output]] : []);
        return <li key={row.key} data-output={row.key} data-ready={files.length && !previous && !building ? "" : undefined}>
          {(files.length ? files.map(([role, output]) => [role, download(role, output, row.title)] as const)
            : [[row.key, unbuilt(row.title)] as const]).map(([key, line]) => <div key={key} className={LINE}>{line}<span /></div>)}
        </li>;
      })}
      {onFinalPdf && <li data-output="final" data-ready={final && finalFile && !previous && !building ? "" : undefined}
        className="mt-1 border-t border-gray-200 pt-1">
        {/* Until it is built, the row itself opens the final PDF's choices; once built, it is the
            download, with its choices in the slot after it. */}
        <div className={LINE}>
          {final && finalFile ? download("final-pdf", finalFile, "Final PDF")
            : <button type="button" disabled={busy} onClick={onFinalPdf} aria-label={final ? "Final PDF options" : "Set up"}
              title={final ? "Final PDF options" : "Set up the final PDF"} className={cn(ROW, FOCUS, "text-gray-500 hover:bg-white disabled:opacity-50")}>
              <span className="truncate font-medium">Final PDF</span>
              <span className="truncate text-xs">{final ? waiting ? "Needs your brief PDF" : "" : "Set up"}</span>
              <SlidersHorizontal className="h-4 w-4 text-gray-700" /></button>}
          {final && finalFile ? <Button type="button" variant="ghost" size="icon-sm" aria-label="Final PDF options"
            title="Final PDF options" disabled={busy} onClick={onFinalPdf}><SlidersHorizontal /></Button> : <span />}
        </div>
        {final && finalFile && report && <div className={LINE}>{download("link-report", report, linkWarnings?.length
          ? `${linkWarnings.length} citation${linkWarnings.length === 1 ? "" : "s"} not linked` : "Unlinked citations", true)}<span /></div>}
      </li>}
    </ul>
  </aside>;
}

import { useEffect, useRef, type ReactNode } from "react";
import { BookOpen, Download, Loader2, SlidersHorizontal } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import type { AuthoritiesBuildReceipt, AuthoritiesProduct } from "./types";
import { cn } from "@/app/lib/utils";

type Output = AuthoritiesProduct["outputs"][string];
const ROW = "grid min-h-11 w-full grid-cols-[minmax(0,1fr)_auto_1rem] items-center gap-2 px-3 text-left text-sm";
const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-red-600";
// Every row keeps a slot after it, so each row's type and icon sit in one column down the dock. A row
// with nothing in its slot reaches over it, so its hover and its click cover the whole row.
const LINE = "grid grid-cols-[minmax(0,1fr)_2rem] items-center gap-1";
const WHOLE = "col-span-2 pr-12";
/** A row just built: green, as a PDF in the Sources list is when it is there, for a moment, then as it was. */
const BUILT: Keyframe[] = [{ backgroundColor: "#f0fdf4", boxShadow: "inset 3px 0 #15803d" },
  { backgroundColor: "#f0fdf4", boxShadow: "inset 3px 0 #15803d", offset: .55 },
  { backgroundColor: "rgb(240 253 244 / 0)", boxShadow: "inset 3px 0 rgb(21 128 61 / 0)" }];

/** Build, and everything it makes: one row an output, each a download once it is built. Every row
 *  is there from the start, so a build fills the dock in without moving anything. */
export function OutputsDock({ draft, busy, building, progress, note, waiting, linkWarnings,
  onBuild, onCancel, onDownload, onFinalPdf, className }: {
  draft: AuthoritiesProduct; busy: boolean; building: boolean;
  /** What the build is doing now. */
  progress: string;
  /** What Build still needs before it can run. */
  note: string;
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
  // Each output a build makes anew shows it in its own row, once that build is done.
  const list = useRef<HTMLUListElement>(null);
  const versions = roles.map((role) => `${role}:${outputs[role].versionId}`).join(",");
  const seen = useRef({ id: draft.id, versions });
  useEffect(() => {
    if (building) return;
    const before = seen.current;
    seen.current = { id: draft.id, versions };
    if (before.id !== draft.id || before.versions === versions) return;
    const made = new Set(versions.split(",")), kept = new Set(before.versions.split(","));
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    list.current?.querySelectorAll<HTMLElement>("[data-role]").forEach((line) => {
      const role = line.dataset.role!;
      if (made.has(`${role}:${outputs[role]?.versionId}`) && !kept.has(`${role}:${outputs[role]?.versionId}`))
        line.animate?.(BUILT, { duration: 2600, easing: still ? "step-end" : "ease-out" });
    });
  }, [versions, building, draft.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const download = (role: string, output: Output, title: ReactNode, small = false, whole = true): ReactNode => <button key={role} type="button"
    title={output.filename} aria-label={`Download ${output.filename}`}
    onClick={() => onDownload(output.documentId, output.versionId, output.filename)}
    className={cn(ROW, FOCUS, "hover:bg-gray-50", whole && WHOLE, small ? "min-h-8 text-xs text-gray-700" : "text-gray-950")}>
    <span className={cn("truncate", !small && "font-medium")}>{title}</span>
    <span className="text-[0.6875rem] uppercase tracking-wide text-gray-500">{output.filename.split(".").at(-1)}</span>
    <Download className={cn("text-gray-700", small ? "h-3.5 w-3.5" : "h-4 w-4")} />
  </button>;
  const unbuilt = (title: string, detail = ""): ReactNode => <div className={cn(ROW, WHOLE, "text-gray-500")}>
    <span className="truncate font-medium">{title}</span>
    <span className="col-span-2 truncate text-xs">{detail}</span>
  </div>;
  const status = building ? progress || "Building…" : note;
  const finalFile = outputs["final-pdf"], report = outputs["link-report"];
  return <aside aria-label="Outputs" className={cn("min-w-0", className)}>
    <Button type="button" className="h-10 w-full" disabled={busy && !building} onClick={building ? onCancel : onBuild}>
      {building ? <><Loader2 className="motion-safe:animate-spin" /> Cancel</> : <><BookOpen /> Build</>}</Button>
    {/* The line is always there, so progress and notes never move the outputs. */}
    <p role="status" aria-live="polite" title={status} className="mt-1.5 min-h-4 truncate px-2 text-xs leading-4 text-gray-600">{status}</p>
    {/* A quiet label over a bordered list, one row an output, as the book's own files are listed. */}
    <h3 className="mt-3 px-1 text-xs font-medium text-gray-500">Outputs</h3>
    <ul ref={list} className="mt-1.5 divide-y divide-gray-200 overflow-hidden rounded-lg border border-gray-300 bg-white">
      {rows.map((row) => {
        const files = row.roles.flatMap((role) => outputs[role] ? [[role, outputs[role]] as [string, Output]] : []);
        return <li key={row.key} data-output={row.key} data-ready={files.length && !building ? "" : undefined}>
          {(files.length ? files.map(([role, output]) => [role, download(role, output, row.title)] as const)
            : [[row.key, unbuilt(row.title)] as const]).map(([key, line]) => <div key={key} data-role={files.length ? key : undefined}
              className={LINE}>{line}</div>)}
        </li>;
      })}
      {onFinalPdf && <li data-output="final" data-ready={final && finalFile && !building ? "" : undefined}>
        {/* Until it is built, the row itself opens the final PDF's choices; once built, it is the
            download, with its choices in the slot after it, and the two light together as one row. */}
        <div data-role={final && finalFile ? "final-pdf" : undefined} className={cn(LINE, final && finalFile && "hover:bg-gray-50")}>
          {final && finalFile ? download("final-pdf", finalFile, "Final PDF", false, false)
            : <button type="button" disabled={busy} onClick={onFinalPdf} aria-label={final ? "Final PDF options" : "Set up"}
              title={final ? "Final PDF options" : "Set up the final PDF"} className={cn(ROW, WHOLE, FOCUS, "text-gray-500 hover:bg-gray-50 disabled:opacity-50")}>
              <span className="truncate font-medium">Final PDF</span>
              <span className="truncate text-xs">{final ? waiting ? "Needs your brief PDF" : "" : "Set up"}</span>
              <SlidersHorizontal className="h-4 w-4 text-gray-700" /></button>}
          {final && finalFile && <Button type="button" variant="ghost" size="icon-sm" aria-label="Final PDF options"
            title="Final PDF options" disabled={busy} onClick={onFinalPdf}><SlidersHorizontal /></Button>}
        </div>
        {final && finalFile && report && <div data-role="link-report" className={LINE}>{download("link-report", report, linkWarnings?.length
          ? `${linkWarnings.length} citation${linkWarnings.length === 1 ? "" : "s"} not linked` : "Unlinked citations", true)}</div>}
      </li>}
    </ul>
  </aside>;
}

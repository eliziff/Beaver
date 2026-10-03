import { useEffect, useId, useRef, type ReactNode } from "react";
import { ChevronRight, Download } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { cn } from "@/app/lib/utils";
import type { AuthoritiesBuildReceipt, AuthoritiesProduct } from "./types";

type Output = AuthoritiesProduct["outputs"][string];
/** One row of the Build step: its name, what it is now in one line, and, where there is something to
 *  choose, its settings opened in place under it. An output's row also holds the files it was built as. */
export type BuildRow = { key: string; title: string; summary: ReactNode; alert?: boolean; roles?: string[];
  settings?: ReactNode };
/** A row just built: marked as a chosen row is, for a moment, then as it was. */
const BUILT: Keyframe[] = [{ backgroundColor: "#fef2f2", boxShadow: "inset 3px 0 #b91c1c" },
  { backgroundColor: "#fef2f2", boxShadow: "inset 3px 0 #b91c1c", offset: .6 },
  { backgroundColor: "rgb(254 242 242 / 0)", boxShadow: "inset 3px 0 rgb(185 28 28 / 0)" }];
const FILE_LABEL: Record<string, string> = { pdf: "PDF", docx: "Word" };

/** The Build step's rows under their headings, one open at a time. */
export function BuildRows({ draft, groups, open, onOpen, building, linkWarnings, onDownload }: {
  draft: AuthoritiesProduct; groups: ReadonlyArray<{ label: string; rows: BuildRow[] }>;
  open?: string; onOpen: (key?: string) => void; building: boolean;
  linkWarnings?: AuthoritiesBuildReceipt["linkWarnings"];
  onDownload: (documentId: string, versionId: string, filename: string) => void;
}) {
  const { outputs } = draft, list = useRef<HTMLDivElement>(null);
  const versions = Object.keys(outputs).map((role) => `${role}:${outputs[role].versionId}`).join(",");
  const seen = useRef({ id: draft.id, versions });
  useEffect(() => {
    if (building) return;
    const before = seen.current;
    seen.current = { id: draft.id, versions };
    if (before.id !== draft.id || before.versions === versions) return;
    const kept = new Set(before.versions.split(","));
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    list.current?.querySelectorAll<HTMLElement>("[data-output]").forEach((row) => {
      if ((row.dataset.roles ?? "").split(" ").some((role) => outputs[role] && !kept.has(`${role}:${outputs[role].versionId}`)))
        row.animate?.(BUILT, { duration: 2600, easing: still ? "step-end" : "ease-out" });
    });
  }, [versions, building, draft.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div ref={list} className="overflow-hidden rounded-xl border border-gray-300 bg-white shadow-sm">
    {groups.map(({ label, rows }) => <section key={label} aria-label={label}>
      <h3 className="border-b border-gray-200 bg-gray-50 px-3 py-1 text-xs font-medium text-gray-500 [section+section>&]:border-t">{label}</h3>
      {rows.map((row) => <Row key={row.key} row={row} open={open === row.key} building={building}
        onToggle={() => onOpen(open === row.key ? undefined : row.key)}
        files={(row.roles ?? []).flatMap((role) => outputs[role] ? [[role, outputs[role]] as [string, Output]] : [])}
        linkWarnings={linkWarnings} onDownload={onDownload} />)}
    </section>)}
  </div>;
}

function Row({ row, open, building, files, linkWarnings, onToggle, onDownload }: { row: BuildRow; open: boolean;
  building: boolean; files: [string, Output][]; linkWarnings?: AuthoritiesBuildReceipt["linkWarnings"];
  onToggle: () => void; onDownload: (documentId: string, versionId: string, filename: string) => void }) {
  const id = useId();
  const line = <>
    {row.settings ? <ChevronRight aria-hidden="true" className={cn("size-4 text-gray-700 transition-transform motion-reduce:transition-none", open && "rotate-90")} />
      : <span />}
    <span className="truncate text-sm font-semibold text-gray-950">{row.title}</span>
    <span className={cn("line-clamp-2 text-sm", row.alert ? "text-red-800" : "text-gray-600")}>{row.summary}</span>
  </>;
  const LINE = "grid min-h-12 min-w-0 grid-cols-[1rem_10.5rem_minmax(0,1fr)] items-center gap-x-3 py-2 pl-3 text-left";
  return <div data-output={row.roles ? row.key : undefined} data-roles={row.roles?.join(" ")}
    data-ready={files.length && !building ? "" : undefined} className="border-b border-gray-200 last:border-b-0">
    <div className={cn("grid grid-cols-[minmax(0,1fr)_auto] items-center pr-2", row.settings && "hover:bg-gray-50")}>
      {row.settings ? <button type="button" aria-expanded={open} aria-controls={id} onClick={onToggle}
        className={cn(LINE, "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-red-600")}>{line}</button>
        : <div className={LINE}>{line}</div>}
      {files.length > 0 && <div className="flex items-center gap-1 pl-3">
        {files.map(([role, output], index) => <Button key={role} type="button" variant="outline" title={output.filename}
          aria-label={`Download ${output.filename}`} className="h-8 border-gray-400 px-2.5 text-xs"
          onClick={() => onDownload(output.documentId, output.versionId, output.filename)}>
          <Download className="size-3.5" />
          {role === "link-report" ? linkWarnings?.length
            ? `${linkWarnings.length} citation${linkWarnings.length === 1 ? "" : "s"} not linked` : "Unlinked citations"
            : files.filter(([key]) => key !== "link-report").length > 1 && /^book-\d+$/u.test(role) ? `Volume ${index + 1}`
            : FILE_LABEL[output.filename.split(".").at(-1)?.toLowerCase() ?? ""] ?? "Download"}</Button>)}
      </div>}
    </div>
    {open && row.settings && <div id={id} className="grid gap-5 pb-5 pl-10 pr-4 pt-1">{row.settings}</div>}
  </div>;
}

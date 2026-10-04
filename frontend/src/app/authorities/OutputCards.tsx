import { useEffect, useId, useRef, type ReactNode } from "react";
import { BookOpen, Check, Download, Loader2 } from "lucide-react";
import { cn } from "@/app/lib/utils";
import { Button } from "@/app/components/ui/button";
import type { AuthoritiesBuildReceipt, AuthoritiesProduct } from "./types";

type Output = AuthoritiesProduct["outputs"][string];
/** One output: what it makes, said in one sentence, whether it is made (the book always is), the
 *  button that opens its choices, and the files its builds made. */
export type OutputRow = { key: string; title: string; sentence: ReactNode; roles: string[];
  /** Whether it is made, where that is a choice. */
  made?: boolean; onMade?: (made: boolean) => void; madeLocked?: boolean; onChange?: () => void };
const FILE_LABEL: Record<string, string> = { pdf: "PDF", docx: "Word" };
/** What has just been built draws in: its check and its downloads, briefly, and not at all where motion is reduced. */
const ARRIVE: Keyframe[] = [{ opacity: 0, transform: "scale(.6)" }, { opacity: 1, transform: "scale(1)" }];
const listed = (names: string[]) => names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/** The outputs down the right of Build, one row each, then Build. Every row keeps its line for downloads
 *  and its check from the start, and Build keeps its status line, so a build fills them in without moving
 *  anything: each built output's downloads turn into solid buttons, its check draws in, and the status
 *  line says what is ready. */
export function OutputDock({ draft, rows, busy, building, progress, note, linkWarnings, onBuild, onCancel, onDownload }: {
  draft: AuthoritiesProduct; rows: OutputRow[]; busy: boolean; building: boolean;
  /** What the build is doing now. */
  progress: string;
  /** What Build still needs before it can run. */
  note: string;
  linkWarnings?: AuthoritiesBuildReceipt["linkWarnings"];
  onBuild: () => void; onCancel: () => void;
  onDownload: (documentId: string, versionId: string, filename: string) => void;
}) {
  const { outputs } = draft, id = useId();
  const list = useRef<HTMLUListElement>(null);
  const versions = Object.keys(outputs).map((role) => `${role}:${outputs[role].versionId}`).join(",");
  const seen = useRef({ id: draft.id, versions });
  useEffect(() => {
    if (building) return;
    const before = seen.current;
    seen.current = { id: draft.id, versions };
    if (before.id !== draft.id || before.versions === versions ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const kept = new Set(before.versions.split(","));
    list.current?.querySelectorAll<HTMLElement>("[data-output]").forEach((row) => {
      if ((row.dataset.roles ?? "").split(" ").some((role) => outputs[role] && !kept.has(`${role}:${outputs[role].versionId}`)))
        row.querySelectorAll<HTMLElement>("[data-arrive]").forEach((item) => item.animate?.(ARRIVE, { duration: 180, easing: "ease-out" }));
    });
  }, [versions, building, draft.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const built = rows.filter(({ roles }) => roles.some((role) => outputs[role]));
  const status = building ? progress || "Building…" : note
    || (built.length ? `${listed(built.map(({ title }) => title))} ${built.length === 1 ? "is" : "are"} ready.` : "");
  return <section aria-labelledby={`${id}-outputs`} className="min-w-0">
    <h3 id={`${id}-outputs`} className="mb-2 text-base font-semibold text-gray-950">Outputs</h3>
    <ul ref={list} className="divide-y divide-gray-300 overflow-hidden rounded-lg border border-gray-300 bg-white">
      {rows.map((row) => {
        const files = row.roles.flatMap((role) => outputs[role] ? [[role, outputs[role]] as [string, Output]] : []);
        const titleId = `${id}-${row.key}`;
        return <li key={row.key} data-output={row.key} data-roles={row.roles.join(" ")}
          className="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 px-3 py-3">
          {row.made === undefined ? <span /> : <input type="checkbox" checked={row.made} aria-labelledby={titleId}
            disabled={busy || row.madeLocked || !row.onMade} onChange={(event) => row.onMade?.(event.target.checked)}
            className="mt-0.5 size-4 accent-red-700" />}
          <div className="min-w-0">
            <h4 id={titleId} className="flex items-center gap-1.5 text-sm font-semibold text-gray-950">{row.title}
              <Check data-arrive aria-label={files.length ? "Built" : undefined} aria-hidden={!files.length || undefined}
                className={cn("size-4 shrink-0 text-gray-950", !files.length && "invisible")} /></h4>
            <p className="mt-0.5 text-xs leading-4 text-gray-600">{row.sentence}</p>
          </div>
          {row.onChange ? <Button type="button" variant="outline" className="h-8 w-[4.75rem] border-gray-400 px-2.5 text-xs"
            aria-label={`Change ${row.title}`} disabled={busy} onClick={row.onChange}>Change</Button> : <span className="w-[4.75rem]" />}
          {/* The downloads' line, there from the start. */}
          <div className="col-span-2 col-start-2 flex min-h-8 flex-wrap items-center gap-1.5">
            {files.length ? files.map(([role, output], index) => <button key={role} type="button" data-arrive title={output.filename}
              aria-label={`Download ${output.filename}`} onClick={() => onDownload(output.documentId, output.versionId, output.filename)}
              className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-md border border-gray-950 bg-gray-950 px-2.5 text-xs font-medium text-white outline-none hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-1">
              <Download className="size-3.5 shrink-0" />
              <span className="truncate">{role === "link-report" ? linkWarnings?.length
                ? `${linkWarnings.length} citation${linkWarnings.length === 1 ? "" : "s"} not linked` : "Unlinked citations"
                : files.filter(([key]) => key !== "link-report").length > 1 && /^book-\d+$/u.test(role) ? `Volume ${index + 1}`
                : FILE_LABEL[output.filename.split(".").at(-1)?.toLowerCase() ?? ""] ?? "Download"}</span></button>)
              : <span className="text-xs text-gray-500">{row.made === false ? "Not made" : "Not built yet"}</span>}
          </div>
        </li>;
      })}
    </ul>
    <div className="mt-3 flex items-center justify-end gap-3">
      {/* The line is always there, so progress, notes and what is ready never move Build. */}
      <p role="status" aria-live="polite" title={status} className="min-h-5 min-w-0 flex-1 truncate text-right text-sm text-gray-700">{status}</p>
      <Button type="button" className="h-10 w-32 shrink-0" disabled={busy && !building} onClick={building ? onCancel : onBuild}>
        {building ? <><Loader2 className="motion-safe:animate-spin" /> Cancel</> : <><BookOpen /> Build</>}</Button>
    </div>
  </section>;
}

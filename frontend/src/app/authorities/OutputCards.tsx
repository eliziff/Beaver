import { useEffect, useId, useRef, type ReactNode } from "react";
import { BookOpen, Check, Download, Loader2, SlidersHorizontal } from "lucide-react";
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
/** A row's own action in Build, the Book's and the Outputs' alike: bordered and quiet, one width, its icon
 *  and word on the line of the row's title or value. */
export const rowButton = "h-8 w-[5.75rem] shrink-0 gap-1.5 border-gray-300 px-2.5 text-[0.8125rem] font-medium text-gray-800 [&_svg]:size-3.5 [&_svg]:text-gray-600";
/** Whether an output is made: a box drawn as the app's own, red with a white check when made, at the
 *  title's height; the native checkbox underneath keeps its keyboard and its name. */
function MadeBox({ id, checked, disabled, labelledBy, onChange }: {
  id: string; checked: boolean; disabled: boolean; labelledBy: string; onChange: (checked: boolean) => void;
}) {
  return <span className="relative flex size-4 shrink-0">
    <input id={id} type="checkbox" checked={checked} disabled={disabled} aria-labelledby={labelledBy}
      onChange={(event) => onChange(event.target.checked)}
      className="peer size-4 cursor-pointer appearance-none rounded-[0.25rem] border-[1.5px] border-gray-500 bg-white outline-none transition-colors hover:border-gray-800 checked:border-red-700 checked:bg-red-700 checked:hover:border-red-800 checked:hover:bg-red-800 focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2 disabled:cursor-default disabled:opacity-50 motion-reduce:transition-none" />
    <Check aria-hidden="true" strokeWidth={3.5} className="pointer-events-none absolute inset-0 m-auto size-3 text-white opacity-0 peer-checked:opacity-100" />
  </span>;
}
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
        const boxId = `${titleId}-made`, made = row.made !== undefined;
        // The title's line holds the choice, the title and Change, centred on one line; what it makes
        // and its downloads sit under the title, the full width of the row.
        return <li key={row.key} data-output={row.key} data-roles={row.roles.join(" ")}
          className="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-3 px-3 pb-3 pt-2">
          {made ? <MadeBox id={boxId} checked={row.made!} labelledBy={titleId}
            disabled={busy || row.madeLocked || !row.onMade} onChange={(checked) => row.onMade?.(checked)} /> : <span />}
          <h4 id={titleId} className="flex min-h-8 min-w-0 items-center gap-1.5 text-sm font-semibold text-gray-950">
            {made ? <label htmlFor={boxId} className={cn("truncate", !(busy || row.madeLocked || !row.onMade) && "cursor-pointer")}>{row.title}</label>
              : <span className="truncate">{row.title}</span>}
            <Check data-arrive aria-label={files.length ? "Built" : undefined} aria-hidden={!files.length || undefined}
              className={cn("size-4 shrink-0 text-gray-950", !files.length && "invisible")} /></h4>
          {row.onChange ? <Button type="button" variant="outline" className={rowButton}
            aria-label={`Change ${row.title}`} disabled={busy} onClick={row.onChange}><SlidersHorizontal />Change</Button>
            : <span className="w-[5.75rem]" />}
          <p className="col-span-2 col-start-2 text-xs leading-4 text-gray-600">{row.sentence}</p>
          {/* The downloads' line, there from the start. */}
          <div className="col-span-2 col-start-2 mt-2 flex min-h-8 flex-wrap items-center gap-1.5">
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
      {/* Two lines, always there and as tall as Build, so progress, notes and what is ready never move it. */}
      <div className="flex min-h-10 min-w-0 flex-1 items-center justify-end">
        <p role="status" aria-live="polite" title={status} className="line-clamp-2 text-right text-sm leading-5 text-gray-700">{status}</p></div>
      <Button type="button" className="h-10 w-32 shrink-0" disabled={busy && !building} onClick={building ? onCancel : onBuild}>
        {building ? <><Loader2 className="motion-safe:animate-spin" /> Cancel</> : <><BookOpen /> Build</>}</Button>
    </div>
  </section>;
}

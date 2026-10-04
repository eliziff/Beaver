import { useEffect, useId, useRef, type ComponentType, type ReactNode } from "react";
import { BookOpen, Check, Download, FileStack, FileText, Loader2, SlidersHorizontal, TableProperties } from "lucide-react";
import { cn } from "@/app/lib/utils";
import { Button } from "@/app/components/ui/button";
import type { AuthoritiesBuildReceipt, AuthoritiesProduct } from "./types";

type Output = AuthoritiesProduct["outputs"][string];
/** One output: what it makes, said in one sentence, whether it is made (the book always is), the
 *  button that opens its choices, and the files its builds made. */
export type OutputRow = { key: string; title: string; sentence: ReactNode; roles: string[];
  /** Whether it is made, where that is a choice. */
  made?: boolean; onMade?: (made: boolean) => void; madeLocked?: boolean; onChange?: () => void };
const FILE_LABEL: Record<string, string> = { pdf: "PDF", docx: "Word", xlsx: "Excel", json: "JSON" };
const ICON: Record<string, ComponentType<{ className?: string }>> = { book: BookOpen, word: TableProperties, final: FileStack };
/** What has just been built draws in: its check and its downloads, briefly, and not at all where motion is reduced. */
const ARRIVE: Keyframe[] = [{ opacity: 0, transform: "scale(.6)" }, { opacity: 1, transform: "scale(1)" }];
/** And its card glows softly in the accent red, then fades: a shadow only, so nothing moves. */
const GLOW: Keyframe[] = [{ boxShadow: "0 0 0 0 rgb(185 28 28 / 0)" },
  { boxShadow: "0 0 0 3px rgb(185 28 28 / .22), 0 0 22px 2px rgb(185 28 28 / .28)", offset: 0.3 },
  { boxShadow: "0 0 0 0 rgb(185 28 28 / 0)" }];
const listed = (names: string[]) => names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/** Build's own action, the Book's and the Outputs' alike: bordered at all times, its word in red. */
export const buildAction = "h-8 shrink-0 gap-1.5 border-gray-300 px-2.5 text-[0.8125rem] font-medium text-accent-800 hover:bg-accent-50 hover:text-accent-900 [&_svg]:size-3.5";
/** A row's icon in a tile of its own; quiet where the output is not made. */
export function IconTile({ icon: Icon, muted = false }: { icon: ComponentType<{ className?: string }>; muted?: boolean }) {
  return <span aria-hidden="true" className={cn("grid size-10 shrink-0 place-items-center rounded-lg border border-gray-200 bg-gray-50",
    muted ? "text-gray-400" : "text-gray-800")}><Icon className="size-5" /></span>;
}
/** The heading over each half of Build: its name and one line about it, one height, so both halves start level. */
export function BuildHeading({ id, title, detail }: { id?: string; title: string; detail: string }) {
  return <header className="mb-3 min-h-11">
    <h3 id={id} className="text-base font-semibold leading-6 text-gray-950">{title}</h3>
    <p className="text-[0.8125rem] leading-5 text-gray-600">{detail}</p>
  </header>;
}
/** Whether an output is made: a red switch with its own edge, the native checkbox underneath. */
function MadeSwitch({ checked, disabled, labelledBy, onChange }: {
  checked: boolean; disabled: boolean; labelledBy: string; onChange: (checked: boolean) => void;
}) {
  return <span className="relative inline-flex shrink-0">
    <input type="checkbox" role="switch" checked={checked} disabled={disabled} aria-labelledby={labelledBy}
      onChange={(event) => onChange(event.target.checked)}
      className="peer absolute inset-0 z-10 m-0 cursor-pointer opacity-0 disabled:cursor-default" />
    <span aria-hidden="true" className={cn("flex h-6 w-11 items-center rounded-full border p-0.5 transition-colors motion-reduce:transition-none peer-focus-visible:ring-2 peer-focus-visible:ring-accent-600 peer-focus-visible:ring-offset-2 peer-disabled:opacity-50",
      checked ? "border-accent-700 bg-accent-700" : "border-gray-400 bg-gray-100")}>
      <span className={cn("size-[1.125rem] rounded-full bg-white shadow-sm transition-transform motion-reduce:transition-none",
        checked ? "translate-x-5" : "border border-gray-300")} />
    </span>
  </span>;
}

/** The outputs down the right of Build, a card each, then Build. Every card keeps its line for downloads
 *  and its check from the start, and Build keeps its status line, so a build fills them in without moving
 *  anything: each built output's downloads turn into solid buttons, its check draws in, and the status
 *  line says what is ready. */
export function OutputDock({ draft, rows, busy, building, progress, note, linkWarnings, onBuild, onCancel, onDownload,
  heading = { title: "Outputs", detail: "What Build makes, and the files it made." }, action = { label: "Build", icon: BookOpen } }: {
  draft: AuthoritiesProduct; rows: OutputRow[]; busy: boolean; building: boolean;
  /** What the build is doing now. */
  progress: string;
  /** What Build still needs before it can run. */
  note: string;
  linkWarnings?: AuthoritiesBuildReceipt["linkWarnings"];
  onBuild: () => void; onCancel: () => void;
  onDownload: (documentId: string, versionId: string, filename: string) => void;
  /** Another app's names for the outputs and for Build. */
  heading?: { title: string; detail: string }; action?: { label: string; icon: ComponentType };
}) {
  const { outputs } = draft, id = useId(), ActionIcon = action.icon;
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
      if ((row.dataset.roles ?? "").split(" ").some((role) => outputs[role] && !kept.has(`${role}:${outputs[role].versionId}`))) {
        row.querySelectorAll<HTMLElement>("[data-arrive]").forEach((item) => item.animate?.(ARRIVE, { duration: 180, easing: "ease-out" }));
        row.animate?.(GLOW, { duration: 1800, easing: "ease-out" });
      }
    });
  }, [versions, building, draft.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const built = rows.filter(({ roles }) => roles.some((role) => outputs[role]));
  const status = building ? progress || "Building…" : note
    || (built.length ? `${listed(built.map(({ title }) => title))} ${built.length === 1 ? "is" : "are"} ready.` : "");
  return <section aria-labelledby={`${id}-outputs`} className="min-w-0">
    <BuildHeading id={`${id}-outputs`} title={heading.title} detail={heading.detail} />
    <ul ref={list} className="grid gap-3">
      {rows.map((row) => {
        const files = row.roles.flatMap((role) => outputs[role] ? [[role, outputs[role]] as [string, Output]] : []);
        const titleId = `${id}-${row.key}`, off = row.made === false;
        return <li key={row.key} data-output={row.key} data-roles={row.roles.join(" ")}
          className={cn("rounded-lg border bg-white px-3 pb-3 pt-3", off ? "border-gray-300" : "border-gray-400")}>
          <div className="flex items-start gap-3">
            <IconTile icon={ICON[row.key] ?? FileText} muted={off} />
            <div className="min-w-0 flex-1">
              {/* The title's line: the title, its check once built, and whether it is made. */}
              <div className="flex min-h-6 items-center justify-between gap-2">
                <h4 id={titleId} className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-gray-950">
                  <span className="truncate">{row.title}</span>
                  <Check data-arrive aria-label={files.length ? "Built" : undefined} aria-hidden={!files.length || undefined}
                    className={cn("size-4 shrink-0 text-gray-950", !files.length && "invisible")} /></h4>
                {row.made === undefined ? <span className="text-xs text-gray-500">Always</span>
                  : <MadeSwitch checked={row.made} labelledBy={titleId} disabled={busy || !!row.madeLocked || !row.onMade}
                    onChange={(made) => row.onMade?.(made)} />}
              </div>
              <p className="mt-0.5 text-xs leading-4 text-gray-600">{row.sentence}</p>
            </div>
          </div>
          {/* The downloads' line, there from the start, with the output's own options at its end. */}
          <div className="mt-3 border-t border-gray-200 pt-3"><div className="flex min-h-8 flex-wrap items-center gap-1.5">
            {files.length ? files.map(([role, output], index) => <button key={role} type="button" data-arrive title={output.filename}
              aria-label={`Download ${output.filename}`} onClick={() => onDownload(output.documentId, output.versionId, output.filename)}
              className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-md border border-gray-950 bg-gray-950 px-2.5 text-xs font-medium text-white outline-none hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-accent-600 focus-visible:ring-offset-1">
              <Download className="size-3.5 shrink-0" />
              <span className="truncate">{role === "link-report" ? linkWarnings?.length
                ? `${linkWarnings.length} citation${linkWarnings.length === 1 ? "" : "s"} not linked` : "Unlinked citations"
                : files.filter(([key]) => key !== "link-report").length > 1 && /^book-\d+$/u.test(role) ? `Volume ${index + 1}`
                : FILE_LABEL[output.filename.split(".").at(-1)?.toLowerCase() ?? ""] ?? "Download"}</span></button>)
              : <span className="text-xs text-gray-500">{off ? "Not made" : "Not built yet"}</span>}
            {row.onChange && <Button type="button" variant="outline" className={cn(buildAction, "ml-auto")}
              aria-label={`Options for ${row.title}`} disabled={busy} onClick={row.onChange}><SlidersHorizontal />Options</Button>}
          </div></div>
        </li>;
      })}
    </ul>
    <div className="mt-3 flex items-center justify-end gap-3">
      {/* Two lines, always there and as tall as Build, so progress, notes and what is ready never move it. */}
      <div className="flex min-h-10 min-w-0 flex-1 items-center justify-end">
        <p role="status" aria-live="polite" title={status} className="line-clamp-2 text-right text-sm leading-5 text-gray-700">{status}</p></div>
      <Button type="button" className="h-10 min-w-32 shrink-0" disabled={busy && !building} onClick={building ? onCancel : onBuild}>
        {building ? <><Loader2 className="motion-safe:animate-spin" /> Cancel</> : <><ActionIcon /> {action.label}</>}</Button>
    </div>
  </section>;
}

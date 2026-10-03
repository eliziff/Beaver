import { useEffect, useRef, type ReactNode } from "react";
import { BookOpen, Download, Loader2, SlidersHorizontal } from "lucide-react";
import { Modal } from "@/app/components/modals/Modal";
import { Button } from "@/app/components/ui/button";
import { OptionCard } from "./OptionCards";
import type { AuthoritiesBuildReceipt, AuthoritiesProduct } from "./types";

type Output = AuthoritiesProduct["outputs"][string];
/** One output: what it makes, said in one sentence, the files its builds made, and its options. */
export type OutputCard = { key: string; title: string; sentence: string; roles: string[]; onOptions?: () => void };
/** A card just built: green, as a PDF in the Sources list is when it is there, for a moment, then as it was. */
const BUILT: Keyframe[] = [{ backgroundColor: "#f0fdf4", boxShadow: "inset 3px 0 #15803d" },
  { backgroundColor: "#f0fdf4", boxShadow: "inset 3px 0 #15803d", offset: .55 },
  { backgroundColor: "rgb(240 253 244 / 0)", boxShadow: "inset 3px 0 rgb(21 128 61 / 0)" }];
const FILE_LABEL: Record<string, string> = { pdf: "PDF", docx: "Word" };

/** The outputs as cards, one an output, each with its downloads once built; then Build. Every card
 *  keeps a line for its downloads from the start, so a build fills them in without moving anything. */
export function OutputCards({ draft, cards, busy, building, progress, note, linkWarnings, onBuild, onCancel, onDownload }: {
  draft: AuthoritiesProduct; cards: OutputCard[]; busy: boolean; building: boolean;
  /** What the build is doing now. */
  progress: string;
  /** What Build still needs before it can run. */
  note: string;
  linkWarnings?: AuthoritiesBuildReceipt["linkWarnings"];
  onBuild: () => void; onCancel: () => void;
  onDownload: (documentId: string, versionId: string, filename: string) => void;
}) {
  const { outputs } = draft, roles = Object.keys(outputs);
  const list = useRef<HTMLUListElement>(null);
  const versions = roles.map((role) => `${role}:${outputs[role].versionId}`).join(",");
  const seen = useRef({ id: draft.id, versions });
  useEffect(() => {
    if (building) return;
    const before = seen.current;
    seen.current = { id: draft.id, versions };
    if (before.id !== draft.id || before.versions === versions) return;
    const kept = new Set(before.versions.split(","));
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    list.current?.querySelectorAll<HTMLElement>("[data-output]").forEach((card) => {
      if ((card.dataset.roles ?? "").split(" ").some((role) => outputs[role] && !kept.has(`${role}:${outputs[role].versionId}`)))
        card.animate?.(BUILT, { duration: 2600, easing: still ? "step-end" : "ease-out" });
    });
  }, [versions, building, draft.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const status = building ? progress || "Building…" : note;
  return <section aria-label="Outputs" className="min-w-0">
    <h3 className="mb-2 text-sm font-semibold text-gray-950">Outputs</h3>
    <ul ref={list} className="grid gap-3 @min-[48rem]/build:grid-cols-3">
      {cards.map((card) => {
        const files = card.roles.flatMap((role) => outputs[role] ? [[role, outputs[role]] as [string, Output]] : []);
        return <li key={card.key} data-output={card.key} data-roles={card.roles.join(" ")}
          data-ready={files.length && !building ? "" : undefined}
          className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-gray-300 bg-white">
          <div className="flex flex-1 items-start gap-3 p-3">
            <div className="min-w-0 flex-1">
              <h4 className="text-sm font-semibold text-gray-950">{card.title}</h4>
              <p className="mt-0.5 text-xs leading-4 text-gray-600">{card.sentence}</p>
            </div>
            {card.onOptions && <Button type="button" variant="outline" className="h-8 shrink-0 border-gray-400 px-2.5 text-xs"
              aria-label={`${card.title} options`} disabled={busy} onClick={card.onOptions}><SlidersHorizontal />Options</Button>}
          </div>
          <div className="flex min-h-10 flex-wrap items-center gap-1 border-t border-gray-200 bg-gray-50 px-2 py-0.5">
            {files.length ? files.map(([role, output], index) => <button key={role} type="button" title={output.filename}
              aria-label={`Download ${output.filename}`} onClick={() => onDownload(output.documentId, output.versionId, output.filename)}
              className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-md px-2 text-xs font-medium text-gray-800 outline-none hover:bg-white focus-visible:ring-2 focus-visible:ring-red-600">
              <Download className="size-3.5 shrink-0" />
              <span className="truncate">{role === "link-report" ? linkWarnings?.length
                ? `${linkWarnings.length} citation${linkWarnings.length === 1 ? "" : "s"} not linked` : "Unlinked citations"
                : files.filter(([key]) => key !== "link-report").length > 1 && /^book-\d+$/u.test(role) ? `Volume ${index + 1}`
                : FILE_LABEL[output.filename.split(".").at(-1)?.toLowerCase() ?? ""] ?? "Download"}</span></button>)
              : <span className="px-2 text-xs text-gray-500">Not built yet</span>}
          </div>
        </li>;
      })}
    </ul>
    <div className="mt-4 flex items-center justify-end gap-3">
      {/* The line is always there, so progress and notes never move Build. */}
      <p role="status" aria-live="polite" title={status} className="min-h-5 min-w-0 flex-1 truncate text-right text-sm text-gray-600">{status}</p>
      <Button type="button" className="h-10 w-32 shrink-0" disabled={busy && !building} onClick={building ? onCancel : onBuild}>
        {building ? <><Loader2 className="motion-safe:animate-spin" /> Cancel</> : <><BookOpen /> Build</>}</Button>
    </div>
  </section>;
}

/** Every output's options in one kind of dialog: whether it is made, where that is a choice of its
 *  own, then what it holds. */
export function OutputOptionsModal({ title, open, onClose, made = true, onMade, madeLabel, madeDetail, lockedReason,
  disabled, children }: {
  title: string; open: boolean; onClose: () => void;
  made?: boolean; onMade?: (made: boolean) => void; madeLabel?: string; madeDetail?: ReactNode;
  /** Why the court decides whether it is made. */
  lockedReason?: string; disabled?: boolean; children?: ReactNode;
}) {
  return <Modal open={open} onClose={onClose} size="xl" breadcrumbs={[title]} fit
    primaryAction={{ label: "Done", onClick: onClose }}>
    <div className="grid gap-5 pb-5">
      {madeLabel && <OptionCard type="checkbox" checked={made} disabled={disabled || !onMade || !!lockedReason}
        onChange={(event) => onMade?.(event.target.checked)} label={madeLabel} detail={lockedReason ?? madeDetail} />}
      {made && children}
    </div>
  </Modal>;
}

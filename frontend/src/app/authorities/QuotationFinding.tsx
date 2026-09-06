import { useMemo, useState } from "react";
import { Modal } from "@/app/components/modals/Modal";
import { sequenceOpcodes } from "../../../../shared/sequence-diff.mjs";
import type { AuthoritiesDiscrepancy, AuthoritiesDiscrepancyAction } from "./types";

/** Presentation only: the native verifier decides whether a finding exists. */
export function quotationDiff(authored: string, source: string) {
  const tokens = (text: string) => text.match(/\s+|[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*|[^\s]/gu) ?? [];
  const before = tokens(authored), after = tokens(source);
  const opcodes = sequenceOpcodes(before, after);
  return {
    authored: opcodes.flatMap(([kind, a0, a1]) => a0 === a1 ? [] : [{ text: before.slice(a0, a1).join(""), changed: kind !== "equal" }]),
    source: opcodes.flatMap(([kind, , , b0, b1]) => b0 === b1 ? [] : [{ text: after.slice(b0, b1).join(""), changed: kind !== "equal" }]),
  };
}
export function readableLocator(kind: string, label: string) {
  const clean = label.replace(/^(?:paragraph|para?|par|page|section|sec)\s*/iu, "");
  return `${kind === "paragraph" ? "para" : kind === "section" ? "s" : "p"} ${clean}`;
}
function DiffPassage({ pieces, side }: { pieces: ReturnType<typeof quotationDiff>["authored"]; side: "authored" | "source" }) {
  return <p className="whitespace-pre-wrap break-words text-sm leading-7 text-gray-800">
    {pieces.map(({ text, changed }, index) => !changed ? <span key={index}>{text}</span>
      : side === "authored" ? <del key={index} className="rounded-sm bg-red-100 text-red-950 decoration-red-700 decoration-2">{text}</del>
        : <ins key={index} className="rounded-sm bg-emerald-100 text-emerald-950 decoration-emerald-700 decoration-2">{text}</ins>)}
  </p>;
}

export function SourceFinding({ finding, open, busy, onResolve, onClose }: {
  finding: AuthoritiesDiscrepancy; open: boolean; busy: boolean;
  onResolve?: (finding: AuthoritiesDiscrepancy, action: AuthoritiesDiscrepancyAction, done: () => void) => void;
  onClose: () => void;
}) {
  const [choice, setChoice] = useState<AuthoritiesDiscrepancyAction | null>(null);
  const source = finding.found ?? finding.cited;
  const diff = useMemo(() => quotationDiff(finding.authoredQuote, source.text), [finding.authoredQuote, source.text]);
  const wrongPinpoint = finding.kind === "wrong_pinpoint";
  const label = (action: AuthoritiesDiscrepancyAction) => action === "pinpoint"
    ? `Change pinpoint to ${readableLocator(source.locator.kind, source.locator.label)}`
    : action === "quote_exact" ? "Use the source’s exact wording"
      : action === "quote_editorial" ? "Mark the quotation’s edits with brackets and ellipses"
        : wrongPinpoint ? "Keep my pinpoint" : "Keep my quotation";
  return <Modal open={open} onClose={onClose} size="xl"
    breadcrumbs={[wrongPinpoint ? "Check pinpoint" : "Quotation differs from source"]}
    className="h-fit max-h-[calc(100dvh-2rem)]"
    secondaryAction={{ label: "Close", onClick: onClose, disabled: busy }}
    primaryAction={onResolve ? { label: "Apply choice", disabled: busy || !choice,
      onClick: () => choice && onResolve(finding, choice, () => { setChoice(null); onClose(); }) } : undefined}>
    <p className="mb-3 text-sm leading-6 text-gray-700">{wrongPinpoint
      ? `Your quotation was found at ${readableLocator(source.locator.kind, source.locator.label)}, rather than ${readableLocator(finding.authoredPinpoint.kind, finding.authoredPinpoint.text)}.`
      : `Your quotation does not match the source’s version at ${readableLocator(finding.cited.locator.kind, finding.cited.locator.label)}.`}</p>
    <div className="overflow-hidden rounded-lg border border-gray-300">
      <div className="grid sm:grid-cols-2">
        <section className="min-w-0 border-b border-gray-200 sm:border-b-0 sm:border-r">
          <h3 className="border-b border-gray-200 bg-gray-50 px-3 py-2 text-xs font-semibold text-gray-700">Your quotation</h3>
          <div className="max-h-64 overflow-y-auto p-3"><DiffPassage pieces={diff.authored} side="authored" /></div>
        </section>
        <section className="min-w-0">
          <h3 className="border-b border-gray-200 bg-gray-50 px-3 py-2 text-xs font-semibold text-gray-700">Source · {readableLocator(source.locator.kind, source.locator.label)}</h3>
          <div className="max-h-64 overflow-y-auto p-3"><DiffPassage pieces={diff.source} side="source" /></div>
        </section>
      </div>
    </div>
    {onResolve && <fieldset className="mt-4 space-y-1.5"><legend className="sr-only">How to handle this difference</legend>
      {finding.actions.map((action) => <label key={action} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${choice === action ? "border-red-700 bg-red-50/30" : "border-gray-200 hover:bg-gray-50"}`}>
        <input type="radio" name={`quotation-choice-${finding.id}`} value={action} checked={choice === action}
          disabled={busy} onChange={() => setChoice(action)} className="accent-red-700" />
        <span>{label(action)}</span>
      </label>)}
    </fieldset>}
  </Modal>;
}

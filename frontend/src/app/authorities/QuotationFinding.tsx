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

const comparisonWords = (text: string) => text.normalize("NFKC").toLowerCase()
  .match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.map((word) =>
    word.replace(/[‘’]/gu, "'")) ?? [];

/**
 * A repair suggestion is only useful when it is recognisably the same passage.
 * The native verifier can establish that authored text is not grounded by a cited
 * passage; it cannot, by itself, make an unrelated passage a safe replacement target.
 */
export function quotationAlignment(authored: string, source: string) {
  const before = comparisonWords(authored), after = comparisonWords(source);
  const shorter = Math.min(before.length, after.length);
  if (!shorter) return { matchedWords: 0, coverage: 0, longestRun: 0, credible: false };
  const equalRuns = sequenceOpcodes(before, after)
    .filter(([kind]) => kind === "equal")
    .map(([, a0, a1]) => a1 - a0);
  const matchedWords = equalRuns.reduce((sum, count) => sum + count, 0);
  const coverage = matchedWords / shorter;
  const longestRun = Math.max(0, ...equalRuns);
  const credible = shorter <= 3
    ? matchedWords >= 2 && coverage >= 2 / 3
    : matchedWords >= 3 && coverage >= 0.6 && longestRun >= 2;
  return { matchedWords, coverage, longestRun, credible };
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

const actionCopy = (action: AuthoritiesDiscrepancyAction, wrongPinpoint: boolean,
  sourceLabel: string) => action === "pinpoint"
  ? { title: `Change pinpoint to ${sourceLabel}`,
    detail: "The quotation appears verbatim there, so update the citation to where it was actually found." }
  : action === "quote_exact" ? { title: "Use the source’s exact wording",
    detail: "Replace the quoted text with the aligned wording from the cited passage." }
    : action === "quote_editorial" ? { title: "Keep the edit, but mark it",
      detail: "Use brackets and ellipses so the quotation shows how it differs from the source." }
      : { title: wrongPinpoint ? "Keep my pinpoint" : "Keep my quotation as written",
        detail: "Dismiss this check without changing the source document." };

export function SourceFinding({ finding, open, busy, onResolve, onClose }: {
  finding: AuthoritiesDiscrepancy; open: boolean; busy: boolean;
  onResolve?: (finding: AuthoritiesDiscrepancy, action: AuthoritiesDiscrepancyAction, done: () => void) => void;
  onClose: () => void;
}) {
  const [choice, setChoice] = useState<AuthoritiesDiscrepancyAction | null>(null);
  const wrongPinpoint = finding.kind === "wrong_pinpoint";
  const suggested = finding.found;
  const alignment = useMemo(() => suggested
    ? quotationAlignment(finding.authoredQuote, suggested.text)
    : { matchedWords: 0, coverage: 0, longestRun: 0, credible: false },
  [finding.authoredQuote, suggested?.text]);
  const aligned = wrongPinpoint || alignment.credible;
  const source = aligned && suggested ? suggested : finding.cited;
  const diff = useMemo(() => quotationDiff(finding.authoredQuote, source.text),
    [finding.authoredQuote, source.text]);
  const sourceLabel = readableLocator(source.locator.kind, source.locator.label);
  const actions = aligned ? finding.actions : finding.actions.filter((action) => action === "ignore");
  const title = wrongPinpoint ? "Check pinpoint" : aligned
    ? "Check quoted wording" : "Quote not confidently located";
  return <Modal open={open} onClose={onClose} size="xl"
    breadcrumbs={[title]}
    className="h-[min(44rem,calc(100dvh-2rem))]"
    secondaryAction={{ label: "Done", onClick: onClose, disabled: busy }}
    primaryAction={onResolve ? { label: choice === "ignore" ? "Dismiss check" : "Apply correction",
      disabled: busy || !choice,
      onClick: () => choice && onResolve(finding, choice, () => setChoice(null)) } : undefined}>
    <div className="pb-5">
      <p className="mb-4 text-sm leading-6 text-gray-700">{wrongPinpoint
        ? `Beaver found this quotation verbatim at ${sourceLabel}, rather than ${readableLocator(finding.authoredPinpoint.kind, finding.authoredPinpoint.text)}.`
        : aligned
          ? `Beaver found the same passage at ${sourceLabel}, but the quoted wording is not verbatim. Review the highlighted differences before changing anything.`
          : `The cited passage is too different from your quotation to treat it as the quotation’s source. Beaver will not suggest replacing your text from this passage.`}</p>
      {!aligned && <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm leading-5 text-amber-950">
        This is a verification failure, not a confirmed quotation mismatch. Check the citation or source manually if the quotation matters.
      </div>}
      <div className="overflow-hidden rounded-lg border border-gray-300 bg-white">
        <div className="grid sm:grid-cols-2">
          <section className="min-w-0 border-b border-gray-200 sm:border-b-0 sm:border-r">
            <h3 className="border-b border-gray-200 bg-gray-50 px-3 py-2 text-xs font-semibold text-gray-700">Your quotation</h3>
            <div className="max-h-72 overflow-y-auto p-4"><DiffPassage pieces={diff.authored} side="authored" /></div>
          </section>
          <section className="min-w-0">
            <h3 className="border-b border-gray-200 bg-gray-50 px-3 py-2 text-xs font-semibold text-gray-700">{aligned ? "Aligned source" : "Cited passage"} · {sourceLabel}</h3>
            <div className="max-h-72 overflow-y-auto p-4"><DiffPassage pieces={diff.source} side="source" /></div>
          </section>
        </div>
      </div>
      {onResolve && <fieldset className="mt-5 space-y-2"><legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">What should Beaver do?</legend>
        {actions.map((action) => {
          const copy = actionCopy(action, wrongPinpoint, sourceLabel);
          return <label key={action} className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-3 ${choice === action ? "border-red-700 bg-red-50/40" : "border-gray-200 hover:bg-gray-50"}`}>
            <input type="radio" name={`quotation-choice-${finding.id}`} value={action} checked={choice === action}
              disabled={busy} onChange={() => setChoice(action)} className="mt-0.5 accent-red-700" />
            <span className="min-w-0"><span className="block text-sm font-medium text-gray-950">{copy.title}</span>
              <span className="mt-0.5 block text-xs leading-5 text-gray-600">{copy.detail}</span></span>
          </label>;
        })}
      </fieldset>}
    </div>
  </Modal>;
}

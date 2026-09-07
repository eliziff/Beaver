import { useState } from "react";
import { Modal } from "@/app/components/modals/Modal";
import { Button } from "@/app/components/ui/button";
import { sequenceOpcodes } from "../../../../shared/sequence-diff.mjs";
import type { AuthoritiesDiscrepancy, AuthoritiesDiscrepancyAction } from "./types";

/** Presentation only; correction eligibility is enforced by the server. */
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
  const clean = label.replace(/^(?:paragraphs?|paras?|par|pages?|sections?|secs?|pp?|ss?)\.?\s*/iu, "");
  return `${kind === "paragraph" ? "para" : kind === "section" ? "s" : "p"} ${clean}`;
}
function DiffPassage({ pieces, source = false }: {
  pieces: ReturnType<typeof quotationDiff>["authored"]; source?: boolean;
}) {
  return <p className="whitespace-pre-wrap break-words text-sm leading-6 text-gray-800">
    {pieces.map(({ text, changed }, index) => !changed ? <span key={index}>{text}</span>
      : source ? <ins key={index} className="bg-emerald-100 text-emerald-950">{text}</ins>
        : <del key={index} className="bg-red-100 text-red-950">{text}</del>)}
  </p>;
}

/** The session, not a transient finding, owns the dialog's lifetime. */
export function QuotationReview({ items, initialId, busy, error, onResolve, onClose }: {
  items?: AuthoritiesDiscrepancy[]; initialId: string; busy: boolean; error?: string;
  onResolve?: (finding: AuthoritiesDiscrepancy, action: AuthoritiesDiscrepancyAction, done: () => void) => void;
  onClose: () => void;
}) {
  const [id, setId] = useState(initialId);
  const [choice, setChoice] = useState<{ id: string; action: AuthoritiesDiscrepancyAction }>();
  const index = Math.max(0, items?.findIndex(finding => finding.id === id) ?? 0);
  const finding = items?.[index];
  const action = choice?.id === finding?.id ? choice?.action : undefined;
  const unlocated = finding?.kind === "quote_unlocated" || finding?.found === null;
  const source = finding && (finding.found ?? finding.cited);
  const wrongPinpoint = finding?.kind === "wrong_pinpoint";
  const actions = finding?.actions.filter(value => !unlocated || value === "ignore") ?? [];
  const diff = finding && source && !unlocated ? quotationDiff(finding.authoredQuote, source.text) : null;
  const label = (value: AuthoritiesDiscrepancyAction) => value === "pinpoint"
    ? `Change pinpoint to ${readableLocator(source!.locator.kind, source!.locator.label)}`
    : value === "quote_exact" ? "Use the source wording"
      : value === "quote_editorial" ? "Mark edits with brackets and ellipses" : "Keep as written";
  return <Modal open onClose={onClose} size="2xl" breadcrumbs={["Check quotations"]}
    className="h-[min(42rem,calc(100dvh-2rem))]"
    headerAction={items && items.length > 1 ? <div className="flex shrink-0 items-center gap-2 text-xs">
      <Button variant="ghost" size="icon-sm" aria-label="Previous quotation" disabled={busy || index === 0}
        onClick={() => setId(items[index - 1].id)}>‹</Button>
      <span>{index + 1} / {items.length}</span>
      <Button variant="ghost" size="icon-sm" aria-label="Next quotation" disabled={busy || index === items.length - 1}
        onClick={() => setId(items[index + 1].id)}>›</Button>
    </div> : undefined}
    secondaryAction={{ label: "Done", onClick: onClose }}
    footerStatus={error ? <span role="alert" className="text-sm text-red-800">{error}</span> : undefined}
    primaryAction={finding && onResolve ? { label: action === "ignore" ? "Keep as written" : "Apply correction",
      disabled: busy || !action || !actions.includes(action),
      onClick: () => action && onResolve(finding, action, () => { setChoice(undefined); setId(items?.[index + 1]?.id ?? items?.[index - 1]?.id ?? ""); }) } : undefined}>
    {!finding ? <p role="status" className="py-8 text-sm text-gray-600">
      {error ? "Quotation check unavailable." : !items || busy ? "Rechecking quotations…" : "No quotations left to review."}
    </p> : <div className="shrink-0 pb-6">
      <p className="text-sm font-medium text-gray-900">{finding.citation} · {readableLocator(finding.authoredPinpoint.kind, finding.authoredPinpoint.text)} · Footnote {finding.footnoteId}</p>
      <p className="mb-4 mt-2 text-sm leading-6 text-gray-600">{unlocated
        ? "Quotation not located. Check the citation and passage; this is not a confirmed wording difference."
        : wrongPinpoint ? `The quotation was found at ${readableLocator(source!.locator.kind, source!.locator.label)}, not the cited pinpoint.`
          : "Compare the suggested source passage before applying a wording correction."}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <section className="min-w-0"><h3 className="mb-2 text-xs font-semibold text-gray-600">Your quotation</h3>
          <DiffPassage pieces={diff?.authored ?? [{ text: finding.authoredQuote, changed: false }]} /></section>
        <section className="min-w-0"><h3 className="mb-2 text-xs font-semibold text-gray-600">
          {unlocated ? "Cited passage" : "Source passage"} · {readableLocator(source!.locator.kind, source!.locator.label)}</h3>
          <DiffPassage source pieces={diff?.source ?? [{ text: source!.text, changed: false }]} /></section>
      </div>
      {onResolve && <fieldset className="mt-5 space-y-2 border-t border-gray-200 pt-4">
        <legend className="sr-only">Quotation decision</legend>
        {actions.map(value => <label key={value} className="flex cursor-pointer items-center gap-2 text-sm text-gray-800">
          <input type="radio" name="quotation-decision" value={value} checked={action === value} disabled={busy}
            onChange={() => setChoice({ id: finding.id, action: value })} className="accent-red-700" />{label(value)}
        </label>)}
      </fieldset>}
    </div>}
  </Modal>;
}

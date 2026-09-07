import { useState } from "react";
import type { ReactNode } from "react";
import { Modal } from "@/app/components/modals/Modal";
import { Button } from "@/app/components/ui/button";
import { sequenceOpcodes } from "../../../../shared/sequence-diff.mjs";
import type { AuthoritiesDiscrepancy, AuthoritiesDiscrepancyAction } from "./types";

/** Case, diacritics and quote/dash variants are not wording differences. */
const fold = (text: string) => text.normalize("NFKD").replace(/\p{M}+/gu, "")
  .replace(/["“”«»„]/gu, '"').replace(/['‘’‚`´]/gu, "'").replace(/[‐‑‒–—―−]/gu, "-").toLowerCase();

/** Presentation only; correction eligibility is enforced by the server. */
export function quotationDiff(authored: string, source: string) {
  const tokens = (text: string) => text.match(/\s+|[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*|[^\s]/gu) ?? [];
  const before = tokens(authored), after = tokens(source);
  const opcodes = sequenceOpcodes(before.map(fold), after.map(fold));
  return {
    authored: opcodes.flatMap(([kind, a0, a1]) => a0 === a1 ? [] : [{ text: before.slice(a0, a1).join(""), changed: kind !== "equal" }]),
    source: opcodes.flatMap(([kind, , , b0, b1]) => b0 === b1 ? [] : [{ text: after.slice(b0, b1).join(""), changed: kind !== "equal" }]),
  };
}
export function readableLocator(kind: string, label: string) {
  const clean = label.replace(/^(?:paragraphs?|paras?|par|pages?|sections?|secs?|pp?|ss?)\.?\s*/iu, "");
  return `${kind === "paragraph" ? "para" : kind === "section" ? "s" : "p"} ${clean}`;
}
/** The author's own words either side of the quote, so the quotation is recognisable at a glance. */
function quotationContext(proposition: string, quote: string, span = 90) {
  const at = proposition.indexOf(quote);
  if (at < 0) return { before: "", after: "" };
  const from = Math.max(0, at - span), to = Math.min(proposition.length, at + quote.length + span);
  return { before: (from ? "…" : "") + proposition.slice(from, at),
    after: proposition.slice(at + quote.length, to) + (to < proposition.length ? "…" : "") };
}
const Diff = ({ pieces, source = false }: {
  pieces: ReturnType<typeof quotationDiff>["authored"]; source?: boolean;
}) => <>{pieces.map(({ text, changed }, index) => !changed ? <span key={index}>{text}</span>
  : source ? <ins key={index} className="bg-emerald-100 text-emerald-950 no-underline">{text}</ins>
    : <del key={index} className="bg-red-100 text-red-950 no-underline">{text}</del>)}</>;
const Passage = ({ label, children }: { label: string; children: ReactNode }) =>
  <section className="min-w-0">
    <h3 className="mb-1 text-xs font-medium text-gray-500">{label}</h3>
    <p className="whitespace-pre-wrap break-words text-sm leading-6 text-gray-800">{children}</p>
  </section>;
const heading = (finding: AuthoritiesDiscrepancy) =>
  `${finding.citation} · ${readableLocator(finding.authoredPinpoint.kind, finding.authoredPinpoint.text)} · footnote ${finding.footnoteId}`;

/** The session, not a transient finding, owns the dialog's lifetime. */
export function QuotationReview({ items, initialId, busy, error, sourceUrl, onResolve, onClose }: {
  items?: AuthoritiesDiscrepancy[]; initialId: string; busy: boolean; error?: string;
  sourceUrl?: (finding: AuthoritiesDiscrepancy) => string | undefined;
  onResolve?: (finding: AuthoritiesDiscrepancy, action: AuthoritiesDiscrepancyAction, done: () => void) => void;
  onClose: () => void;
}) {
  const [id, setId] = useState(initialId);
  const [choice, setChoice] = useState<{ id: string; action: AuthoritiesDiscrepancyAction }>();
  // Only real wording differences are adjudicated; quotations that were not found are one batch.
  const differences = items?.filter(({ found }) => found) ?? [];
  const missing = items?.filter(({ found }) => !found) ?? [];
  const pages = [...differences.map(({ id: value }) => value), ...(missing.length ? ["missing"] : [])];
  const index = Math.max(0, pages.indexOf(missing.some(item => item.id === id) ? "missing" : id));
  const finding = differences.find(item => item.id === pages[index]);
  const source = finding?.found ?? null;
  const action = choice?.id === finding?.id ? choice?.action : undefined;
  const context = finding && quotationContext(finding.proposition, finding.authoredQuote);
  const diff = finding && source && quotationDiff(finding.authoredQuote, source.text);
  // Every option but "keep" rewrites the author's own Word file, so the label says so.
  const label = (value: AuthoritiesDiscrepancyAction) => value === "pinpoint"
    ? `Change pinpoint to ${readableLocator(source!.locator.kind, source!.locator.label)} (edits your .docx)`
    : value === "quote_exact" ? "Use the source wording (edits your .docx)"
      : value === "quote_editorial" ? "Mark edits with brackets and ellipses (edits your .docx)"
        : "Keep as written";
  return <Modal open onClose={onClose} size="2xl" breadcrumbs={["Check quotations"]}
    className="h-fit max-h-[calc(100dvh-2rem)]"
    headerAction={pages.length > 1 ? <div className="flex shrink-0 items-center gap-1 text-xs text-gray-600">
      <Button variant="ghost" size="icon-sm" aria-label="Previous quotation" disabled={busy || index === 0}
        onClick={() => setId(pages[index - 1])}>‹</Button>
      <span>{index + 1} / {pages.length}</span>
      <Button variant="ghost" size="icon-sm" aria-label="Next quotation" disabled={busy || index === pages.length - 1}
        onClick={() => setId(pages[index + 1])}>›</Button>
    </div> : undefined}
    secondaryAction={{ label: "Done", onClick: onClose }}
    footerStatus={error ? <span role="alert" className="text-sm text-red-800">{error}</span> : undefined}
    primaryAction={finding && onResolve ? { label: action === "ignore" ? "Keep as written" : "Apply correction",
      disabled: busy || !action || !finding.actions.includes(action),
      onClick: () => action && onResolve(finding, action, () => { setChoice(undefined); setId(pages[index + 1] ?? pages[index - 1] ?? ""); }) } : undefined}>
    {!items?.length && !finding ? <p role="status" className="py-6 text-sm text-gray-600">
      {error ? "The quotation check could not run." : !items || busy ? "Rechecking quotations…" : "No quotations left to review."}
    </p> : finding && source ? <div className="space-y-3 pb-4 pt-1">
      <div>
        <p className="text-sm font-medium text-gray-900">{heading(finding)}</p>
        <p className="text-sm text-gray-600">{finding.kind === "wrong_pinpoint"
          ? `These words appear at ${readableLocator(source.locator.kind, source.locator.label)}, not at the pinpoint you cited.`
          : "The wording differs from the source."}</p>
      </div>
      <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
        <Passage label="Your quotation">
          <span className="text-gray-400">{context!.before}</span>
          <Diff pieces={diff!.authored} />
          <span className="text-gray-400">{context!.after}</span>
        </Passage>
        <Passage label={`Source · ${readableLocator(source.locator.kind, source.locator.label)}`}>
          <Diff source pieces={diff!.source} />
        </Passage>
      </div>
      {onResolve && <fieldset className="space-y-1.5 border-t border-gray-200 pt-3">
        <legend className="sr-only">Quotation decision</legend>
        {finding.actions.map(value => <label key={value} className="flex cursor-pointer items-center gap-2 text-sm text-gray-800">
          <input type="radio" name="quotation-decision" value={value} checked={action === value} disabled={busy}
            onChange={() => setChoice({ id: finding.id, action: value })} className="accent-red-700" />{label(value)}
        </label>)}
      </fieldset>}
    </div> : <div className="space-y-3 pb-4 pt-1">
      <p className="text-sm text-gray-600">
        {missing.length === 1 ? "This quotation was not" : `These ${missing.length} quotations were not`} found
        in the passage cited. Check the pinpoint, or open the source to look for the wording.
      </p>
      <ul className="divide-y divide-gray-200 border-y border-gray-200">
        {missing.map(item => <li key={item.id} className="flex items-baseline justify-between gap-4 py-2">
          <div className="min-w-0">
            <p className="text-xs text-gray-500">{heading(item)}</p>
            <p className="break-words text-sm leading-6 text-gray-800">“{item.authoredQuote}”</p>
          </div>
          {sourceUrl?.(item) && <a className="shrink-0 text-sm text-red-700 underline" target="_blank"
            rel="noreferrer" href={sourceUrl(item)}>Open source</a>}
        </li>)}
      </ul>
    </div>}
  </Modal>;
}

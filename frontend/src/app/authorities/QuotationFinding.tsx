import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { StepProgress } from "./StepSection";
import { OptionCard } from "./OptionCards";
import { sequenceOpcodes } from "../../../../shared/sequence-diff.mjs";
import type { AuthoritiesDiscrepancy, AuthoritiesDiscrepancyAction } from "./types";

/** Case, diacritics and quote/dash variants are not wording differences. */
const fold = (text: string) => text.normalize("NFKD").replace(/\p{M}+/gu, "")
  .replace(/["“”«»„]/gu, '"').replace(/['‘’‚`´]/gu, "'").replace(/[‐‑‒–—―−]/gu, "-").toLowerCase();

/** Presentation only; correction eligibility is enforced by the server. */
function quotationDiff(authored: string, source: string) {
  const tokens = (text: string) => text.match(/\s+|[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*|[^\s]/gu) ?? [];
  const before = tokens(authored), after = tokens(source);
  const opcodes = sequenceOpcodes(before.map(fold), after.map(fold));
  return {
    authored: opcodes.flatMap(([kind, a0, a1]) => a0 === a1 ? [] : [{ text: before.slice(a0, a1).join(""), changed: kind !== "equal" }]),
    source: opcodes.flatMap(([kind, , , b0, b1]) => b0 === b1 ? [] : [{ text: after.slice(b0, b1).join(""), changed: kind !== "equal" }]),
    changes: opcodes.filter(([kind]) => kind !== "equal").map(([, a0, a1, b0, b1]) =>
      ({ before: before.slice(a0, a1).join("").trim(), after: after.slice(b0, b1).join("").trim() })),
  };
}
function readableLocator(kind: string, label: string) {
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

/** A citation that names a different case: what the source holds at the brief's citation, and the one case
 *  the brief's name finds, if any. */
type CaseFinding = { kind: "different_case"; id: string; actions: AuthoritiesDiscrepancyAction[]; occurrenceId: string;
  authorityId: string; footnoteId: number | string | null; citation: string; /** The note or paragraph it is in. */ text: string;
  cited: { citation: string; name: string }; named: { citation: string; name: string } | null };
export type Finding = AuthoritiesDiscrepancy | CaseFinding;
type Action = AuthoritiesDiscrepancyAction | "use_named_case" | "keep_cited_case";
const isCase = (finding: Finding): finding is CaseFinding => finding.kind === "different_case";

// Words taken out are struck in a soft red; words the source has are underlined in dark ink.
const Struck = ({ children }: { children: ReactNode }) =>
  <del className="rounded-sm bg-red-50 px-px text-red-800 decoration-red-700">{children}</del>;
const Added = ({ children }: { children: ReactNode }) =>
  <ins className="font-semibold text-gray-950 underline decoration-gray-950 decoration-2 underline-offset-[3px]">{children}</ins>;
const Diff = ({ pieces, source = false }: { pieces: ReturnType<typeof quotationDiff>["authored"]; source?: boolean }) =>
  <>{pieces.map(({ text, changed }, index) => !changed ? <span key={index}>{text}</span>
    : source ? <Added key={index}>{text}</Added> : <Struck key={index}>{text}</Struck>)}</>;
const Column = ({ label, children }: { label: string; children: ReactNode }) =>
  <section className="min-w-0 px-3 py-2.5">
    <h3 className="mb-1 text-xs font-semibold text-gray-500">{label}</h3>
    <p className="whitespace-pre-wrap break-words text-sm leading-6 text-gray-800">{children}</p>
  </section>;
const quoted = (text: string) => `“${text}”`;
/** "changes “danger” to “dangers”", the first two changes, each with its verb, and how many more; `done` in
 *  the past ("changed …"). */
const changeList = (changes: Array<{ before: string; after: string }>, done = false) => {
  const words = changes.slice(0, 2).map(({ before, after }) => before && after
    ? `${done ? "changed" : "changes"} ${quoted(before)} to ${quoted(after)}`
    : after ? `${done ? "added" : "adds"} ${quoted(after)}` : `${done ? "took out" : "takes out"} ${quoted(before)}`);
  return words.join(" and ") + (changes.length > 2 ? `, and ${changes.length - 2} more` : "");
};
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** What a finding shows: what and where, the brief's words beside the source's, and its choices. */
/** `note` gives a footnote's number as the brief prints it; `sourceName` an authority's name and citation. */
function view(finding: Finding, note: (footnoteId: number | string) => string, sourceName: (authorityId: string) => string) {
  if (isCase(finding)) {
    // The citation in its sentence; its citation struck only where there is a case to put in its place.
    const at = finding.citation.indexOf(finding.cited.citation), context = quotationContext(finding.text, finding.citation);
    const written = (inner: ReactNode) => <><span className="text-gray-400">{context.before}</span>
      {at < 0 ? finding.citation : <>{finding.citation.slice(0, at)}{inner}{finding.citation.slice(at + finding.cited.citation.length)}</>}
      <span className="text-gray-400">{context.after}</span></>;
    return {
      what: "Citation names a different case", where: finding.footnoteId ? `footnote ${note(finding.footnoteId)}` : "",
      yours: written(finding.named ? <Struck>{finding.cited.citation}</Struck> : finding.cited.citation),
      yoursNow: (action: Action) => {
        if (action === "use_named_case" && finding.named) return written(finding.named.citation);
        // The brief's name for the case, before its citation, takes the cited case's name.
        const name = at > 0 ? finding.citation.slice(0, at).replace(/[\s,]+$/u, "") : "";
        if (action !== "use_cited_name" || !name) return written(finding.cited.citation);
        return <><span className="text-gray-400">{context.before}</span><Added>{finding.cited.name}</Added>
          {finding.citation.slice(name.length)}<span className="text-gray-400">{context.after}</span></>;
      },
      sourceLabel: "Source",
      source: <>{finding.cited.citation} is <i>{finding.cited.name}</i>.{finding.named
        ? <><br /><i>{finding.named.name}</i> is <Added>{finding.named.citation}</Added>.</> : null}</>,
      options: (action: Action) => action === "use_named_case" && finding.named
        ? { label: `Cite ${finding.named.citation}`, detail: `Your Word copy cites ${finding.named.citation}, ${finding.named.name}, instead of ${finding.cited.citation}. The book includes that decision.` }
        : action === "use_cited_name" ? { label: `Name it ${finding.cited.name}`,
          detail: `Your Word copy keeps ${finding.cited.citation} and names it ${finding.cited.name}. The book includes it under that name.` }
        : action === "keep_cited_case" ? { label: `Keep ${finding.cited.citation}, under its own name`,
          detail: `Your brief is not changed. The book includes ${finding.cited.citation} as ${finding.cited.name}.` }
          : { label: "Keep as written", detail: `Your brief is not changed. The book includes ${finding.cited.citation} under the name your brief gives it.` },
      changed: (action: Action) => action === "use_named_case" && finding.named
        ? `Changed in your Word copy: ${quoted(finding.cited.citation)} is now ${quoted(finding.named.citation)}.`
        : action === "use_cited_name" ? `Changed in your Word copy: the case is now named ${finding.cited.name}.`
        : action === "keep_cited_case" ? `The book cites it as ${finding.cited.name}, ${finding.cited.citation}.` : "Kept as written.",
    };
  }
  if (finding.kind === "wrong_pinpoint") {
    // The quotation's words are right; what changes is the footnote's pinpoint, so the card shows the footnote.
    const pinpoint = readableLocator(finding.authoredPinpoint.kind, finding.authoredPinpoint.text);
    const next = (action: Action) => {
      const text = action === "pinpoint" ? finding.pinpoint : action === "pinpoint_extend" ? finding.extended : undefined;
      return text ? text.replace(/^at\s+/u, "") : null;
    };
    // The pinpoint leads on both sides; the words quoted and the paragraph's text are only there to recognise it.
    const found = readableLocator(finding.found.locator.kind, finding.found.locator.label);
    const footnote = (at: ReactNode) => <><span className="text-base font-medium text-gray-950">
      Footnote {note(finding.footnoteId)}: {finding.citation} at {at}</span>{"\n"}
      <span className="text-xs text-gray-500">quoting “{finding.authoredQuote}”</span></>;
    return {
      what: "Pinpoint does not include the quotation", where: `footnote ${note(finding.footnoteId)}`,
      yours: footnote(<Struck>{pinpoint}</Struck>),
      yoursNow: (action: Action) => footnote(next(action) ? <Added>{next(action)}</Added> : pinpoint),
      sourceLabel: sourceName(finding.authorityId) || "The source",
      source: <><span className="text-base font-medium text-gray-950">“{finding.authoredQuote}” is at <Added>{found}</Added></span>
        {"\n"}<span className="text-xs text-gray-500">{finding.found.text}</span></>,
      options: (action: Action) => next(action)
        ? { label: action === "pinpoint_extend" ? `Extend to ${next(action)}` : `Change to ${next(action)}`,
          detail: `Changes ${quoted(pinpoint)} to ${quoted(next(action)!)} in footnote ${note(finding.footnoteId)} of your Word copy.` }
        : { label: "Keep as written", detail: "Leaves your brief as it is." },
      changed: (action: Action) => next(action)
        ? `Changed in your Word copy: ${quoted(pinpoint)} is now ${quoted(next(action)!)}.` : "Kept as written.",
    };
  }
  const source = finding.found, context = quotationContext(finding.proposition, finding.authoredQuote);
  const diff = source && quotationDiff(finding.authoredQuote, source.text);
  const pinpoint = readableLocator(finding.authoredPinpoint.kind, finding.authoredPinpoint.text);
  const quote = (inner: ReactNode) => <><span className="text-gray-400">{context.before}</span>{inner}
    <span className="text-gray-400">{context.after}</span></>;
  const what = finding.kind === "quote_unlocated" ? "Quotation not found in the passage cited" : "Quotation differs from the source";
  return {
    what, where: `footnote ${note(finding.footnoteId)} · ${finding.citation} at ${pinpoint}`,
    yours: quote(finding.kind === "quote_mismatch" && diff ? <Diff pieces={diff.authored} /> : <>{finding.authoredQuote}</>),
    yoursNow: (action: Action) => quote(action === "quote_exact" && source ? <>{source.text}</> : <>{finding.authoredQuote}</>),
    // The source by its name and citation, not the brief's "Ibid" or short form.
    sourceLabel: `${sourceName(finding.authorityId) || "The source"} · ${source
      ? readableLocator(source.locator.kind, source.locator.label) : readableLocator(finding.cited.locator.kind, finding.cited.locator.label)}`,
    source: finding.kind === "quote_mismatch" && diff ? <Diff source pieces={diff.source} />
      : source ? <>{source.text}</> : <span className="text-gray-600">These words are not in the passage cited.</span>,
    options: (action: Action) => action === "quote_exact" ? { label: "Use the source’s wording",
        detail: `${diff ? sentence(changeList(diff.changes)) : "Changes the quotation"} in your Word copy.` }
        : action === "quote_editorial" ? { label: "Mark the change",
          detail: "Marks the source’s words in your quotation with brackets, and words left out with an ellipsis, in your Word copy." }
          : { label: "Keep as written", detail: "Leaves your brief as it is." },
    changed: (action: Action) => action === "quote_exact" && diff ? `In your Word copy, ${changeList(diff.changes, true)}.`
        : action === "quote_editorial" ? "Changed in your Word copy: the changes are marked." : "Kept as written.",
  };
}
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** The quotations and citations the check found, one at a time in the brief's order: what is wrong and where,
 *  the brief's words beside the source's, the choices as cards, and one Apply. A decision stays on the card
 *  with what it changed, and can be taken back. */
export function QuotationReview({ items, checked, note = String, sourceName = () => "", currentId, busy, error, onSelect, onOpenSource, onResolve, onUndo, onDone }: {
  /** The findings, undefined while being checked; `checked` names the check they come from. */
  items?: Finding[]; checked?: string; note?: (footnoteId: number | string) => string;
  sourceName?: (authorityId: string) => string; currentId: string; busy: boolean; error?: string;
  onSelect: (id: string) => void;
  onOpenSource?: (finding: AuthoritiesDiscrepancy) => void;
  onResolve?: (finding: Finding, action: AuthoritiesDiscrepancyAction, done: () => void) => void;
  onUndo?: (finding: Finding, done: () => void) => void;
  onDone: () => void;
}) {
  const [choice, setChoice] = useState<{ id: string; action: Action }>();
  // A finding just decided, kept on the card with what was done while the check no longer lists it; or just
  // undone (no action), kept with its choices until the recheck lists it again.
  const [decided, setDecided] = useState<{ finding: Finding; action?: Action; at: number; checked?: string }>();
  const list = items ?? [];
  const finding = decided?.finding.id === currentId ? decided.finding : list.find(({ id }) => id === currentId) ?? list[0];
  // It keeps its place among the others, so its number doesn't change.
  const order = decided && !list.some(({ id }) => id === decided.finding.id)
    ? [...list.slice(0, decided.at), decided.finding, ...list.slice(decided.at)] : list;
  const index = finding ? Math.max(0, order.findIndex(({ id }) => id === finding.id)) : 0;
  const shown = finding && view(finding, note, sourceName);
  const done = decided && finding && decided.finding.id === finding.id ? decided.action : undefined;
  const action = choice?.id === finding?.id ? choice?.action : undefined;
  const counts = { wording: list.filter(item => !isCase(item) && item.kind !== "quote_unlocated").length,
    citation: list.filter(isCase).length, missing: list.filter(item => !isCase(item) && item.kind === "quote_unlocated").length };
  const summary = list.length ? `${plural(list.length, "to review", "to review")}: ${[counts.wording && plural(counts.wording, "quotation"),
    counts.citation && plural(counts.citation, "citation"), counts.missing && `${counts.missing} not found`].filter(Boolean).join(", ")}`
    : "Nothing left to review";
  const section = useRef<HTMLElement>(null);
  // The card comes into view when a finding opens, and stays put while it is decided.
  useLayoutEffect(() => { section.current?.scrollIntoView?.({ block: "nearest" }); }, [currentId]);
  // A finding the list no longer has (decided elsewhere, or gone with a recheck) gives way to the one shown, so
  // what is decided next is the finding on the card.
  useEffect(() => { if (items && finding && finding.id !== currentId) onSelect(finding.id); }, [items, finding, currentId, onSelect]);
  // Once rechecked, the list says whether an undone finding is still one to review.
  useEffect(() => { if (items && decided && !decided.action && checked !== decided.checked) setDecided(undefined); },
    [items, checked, decided]);
  const go = (to: number) => { const next = order[to]; if (next) { setChoice(undefined); onSelect(next.id); } };
  const next = () => { setDecided(undefined); const rest = list.filter(({ id }) => id !== finding?.id); if (rest[0]) onSelect(rest[Math.min(index, rest.length - 1)].id); else onDone(); };
  return <section ref={section} aria-label="Check quotations and citations" className="mt-3 scroll-mt-4 rounded-xl border border-gray-300 bg-white shadow-sm">
    <div className="flex min-h-16 flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-4 py-3">
      <div className="min-w-0"><h2 className="font-semibold text-gray-950">Check quotations and citations</h2>
        <p className="truncate text-sm text-gray-600">{items ? summary : <StepProgress label="Rechecking" className="font-normal text-gray-600" />}</p></div>
      <div className="flex shrink-0 items-center gap-2">
        {order.length > 1 && <div className="flex items-center gap-1.5 text-xs text-gray-600">
          <Button variant="outline" size="icon-sm" className="border-gray-300" aria-label="Previous finding" disabled={busy || index === 0}
            onClick={() => go(index - 1)}><ChevronLeft /></Button>
          <span className="min-w-12 text-center tabular-nums">{index + 1} of {order.length}</span>
          <Button variant="outline" size="icon-sm" className="border-gray-300" aria-label="Next finding" disabled={busy || index === order.length - 1}
            onClick={() => go(index + 1)}><ChevronRight /></Button>
        </div>}
        <Button className="h-9" disabled={busy} onClick={onDone}>Done<ChevronRight /></Button>
      </div>
    </div>
    {(items || decided) && <div className="px-4 pb-4 pt-3.5">
      {!finding || !shown ? <p role="status" className="py-1 text-sm text-gray-600">
        {error ? "The check could not run." : "Nothing left to review."}</p> : <>
        <p className="mb-2.5 text-[0.8125rem] text-gray-600"><b className="font-semibold text-gray-950">{shown.what}</b>
          {shown.where && <> · {shown.where}</>}</p>
        <div className="grid overflow-hidden rounded-lg border border-gray-300 sm:grid-cols-2 sm:divide-x sm:divide-gray-200">
          <Column label={done ? "Your brief, now" : "Your brief"}>{done ? shown.yoursNow(done) : shown.yours}</Column>
          <Column label={shown.sourceLabel}>{shown.source}</Column>
        </div>
        {done ? <><div className="mt-3.5 flex items-center gap-3 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2.5">
          <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center rounded-full bg-gray-950 text-white"><Check className="size-3.5" /></span>
          <p role="status" className="min-w-0 flex-1 text-sm text-gray-800">{shown.changed(done)}</p>
          {onUndo && <Button variant="outline" className="h-9 border-gray-300" disabled={busy}
            onClick={() => onUndo(finding, () => setDecided({ finding, at: index, checked }))}>Undo</Button>}
          <Button className="h-9" disabled={busy} onClick={next}>Next<ChevronRight /></Button>
        </div>
        {error && <p role="alert" className="mt-2 text-sm text-red-800">{error}</p>}</> : <>
          {onResolve && finding.actions.length > 0 && <fieldset disabled={busy} className="@container/rows mt-3.5 grid gap-2">
            <legend className="sr-only">Decision</legend>
            {(finding.actions as Action[]).map(value => { const option = shown.options(value);
              return <OptionCard key={value} row name={`finding-${finding.id}`} checked={action === value}
                onChange={() => setChoice({ id: finding.id, action: value })} label={option.label} detail={option.detail} />; })}
          </fieldset>}
          <div className="mt-3.5 flex flex-wrap items-center justify-end gap-3">
            {error && <span role="alert" className="mr-auto text-sm text-red-800">{error}</span>}
            {onOpenSource && !isCase(finding) && <Button variant="outline" className="h-9 border-gray-300" disabled={busy}
              onClick={() => onOpenSource(finding)}>Open source</Button>}
            {onResolve && finding.actions.length > 0 && <Button className="h-9" disabled={busy || !action}
              onClick={() => action && onResolve(finding, action as AuthoritiesDiscrepancyAction, () => {
                setChoice(undefined); setDecided({ finding, action, at: index });
              })}>Apply</Button>}
          </div>
        </>}
      </>}
    </div>}
  </section>;
}

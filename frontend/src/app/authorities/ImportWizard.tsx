import { useState } from "react";
import { excerptContext, federalPaperBook } from "../../../../shared/authorities-sources.mjs";
import { ChevronLeft, ChevronRight, FileText, Loader2 } from "lucide-react";
import { Modal } from "@/app/components/modals/Modal";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { cn } from "@/app/lib/utils";
import { courtCover } from "../../../../shared/authorities-cover.mjs";
import { FileCard, OptionCards, type CardOption } from "./OptionCards";
import { authoritiesProfile } from "./profiles";
import { MarkingSample, passageOptions, YELLOW } from "./AuthoritiesHighlightEditor";
import { AuthoritiesCourtField, CoverFields, FRONT_KEYS, FrontLayout, PREVIEW_KEYS, FrontStep, IndexFields,
  Preview, previewActions, previewBook, StepTabs, useFilingContact, type FrontSlot, type OwnFront, type OwnPdfs,
  type Settings } from "./BookFront";
import type { AuthoritiesBookSlot, AuthoritiesFile, AuthoritiesHost } from "./host";
import type { AuthoritiesAction, AuthoritiesBuildSettings, AuthoritiesCover, AuthoritiesProduct,
  AuthoritiesProfileId } from "./types";

export const SOURCE_OPTIONS: ReadonlyArray<CardOption<AuthoritiesBuildSettings["sourceMode"]>> = [
  { value: "automatic", label: "Automatic sources",
    detail: "Uses original PDFs where they exist and builds the rest from their text." },
  { value: "manual-originals", label: "Use available original PDFs and manually add the PDFs myself for the rest",
    detail: "Uses original PDFs where they exist. Note: Requires you to upload a PDF for each of the rest." },
  { value: "render", label: "Rebuild all sources from text (where available)",
    detail: "Builds every source from its text, even where an original PDF exists." },
];
export const SCANNED_OPTIONS: ReadonlyArray<CardOption<AuthoritiesBuildSettings["scannedPdfPolicy"]>> = [
  { value: "full", label: "Recognize every page",
    detail: "Recognizes the text of every scanned page." },
  { value: "cited-pages", label: "Recognize cited pages",
    detail: "Recognizes the scanned pages your brief cites, to mark their passages." },
  { value: "page-margin", label: "Keep scans as images",
    detail: "Keeps scanned pages as images. Their cited passages are marked in the margin." },
];
export const GROUP_OPTIONS: ReadonlyArray<CardOption<NonNullable<AuthoritiesBuildSettings["grouping"]>>> = [
  { value: "legislation-first", label: "Legislation first", detail: "Lists legislation, then cases, then other authorities." },
  { value: "cases-first", label: "Cases first", detail: "Lists cases, then legislation, then other authorities." },
  { value: "none", label: "No groups", detail: "Lists every authority in one sequence." },
];
export const ORDER_OPTIONS: ReadonlyArray<CardOption<AuthoritiesBuildSettings["tableOrder"]>> = [
  { value: "first-reference", label: "First cited", detail: "Orders each group as your brief first cites its authorities." },
  { value: "alphabetical", label: "Alphabetical", detail: "Orders each group alphabetically." },
  { value: "custom", label: "As arranged", detail: "Keeps the order you set by dragging in Sources." },
];
export const HISTORY_OPTIONS: ReadonlyArray<CardOption<NonNullable<AuthoritiesBuildSettings["subsequentHistory"]>>> = [
  { value: "include", label: "Include subsequent history in book",
    detail: "Gives each decision in a case’s later history its own tab." },
  { value: "omit", label: "Do not include subsequent history in book",
    detail: "Keeps a case’s later history in its citation only." },
];
/** Whether the book has each case and other source whole or as an excerpt. A Federal Court book on paper has a
 *  decision on a free public database as an excerpt either way, unless the decision is chosen whole. */
const copyOptions = (federalPaper: boolean): ReadonlyArray<CardOption<NonNullable<AuthoritiesBuildSettings["caseCopy"]>>> => [
  { value: "whole", label: "Whole cases", detail: `Includes each case and other source in full.${federalPaper
    ? " Note: A Federal Court book on paper includes a decision on a free public database as an excerpt (Federal Courts Rules, r 70(2.1))." : ""}` },
  { value: "excerpt", label: "Excerpts",
    detail: "Includes the first page of each case and other source, the pages your brief cites, and one paragraph or page before and after each. Note: You can change how many in Source settings." },
];
/** A sample case of eight pages, cited at a paragraph on page 5 whose paragraph before begins on page 4: whole, or
 *  as an excerpt of its first page and those two, the rest faded. */
function ExcerptSample({ excerpt }: { excerpt: boolean }) {
  return <div role="img" aria-label={excerpt ? "A sample case of eight pages as an excerpt: its first page, the page it is cited at, and the page before, which holds the paragraph before the cited one"
    : "A sample case of eight pages in full"} className="m-auto grid w-full max-w-[34rem] grid-cols-4 gap-3">
    {Array.from({ length: 8 }, (_, index) => <div key={index} className="grid gap-1 text-center">
      <div className={cn("flex aspect-[8.5/11] flex-col gap-[5%] bg-white px-[12%] py-[14%] shadow-[0_1px_3px_rgb(0_0_0/.15)]",
        excerpt && ![0, 3, 4].includes(index) && "opacity-25")}>
        {!index && <span className="mx-auto mb-[5%] h-[4%] w-3/4 shrink-0 rounded-sm bg-gray-700" />}
        {Array.from({ length: index ? 9 : 7 }, (_, line) => <span key={line} className="h-[3%] shrink-0 rounded-sm bg-gray-300"
          style={index === 4 && line >= 2 && line <= 4 ? { background: YELLOW } : undefined} />)}
      </div>
      <span className="text-xs tabular-nums text-gray-600">{index + 1}</span>
    </div>)}
  </div>;
}
/** A count of the context an excerpt keeps, as a card holding its number. A number being typed is kept as typed
 *  until it is one. */
function ContextCount({ label, detail, value, disabled, onChange }: {
  label: string; detail: string; value: number; disabled?: boolean; onChange: (value: number) => void;
}) {
  const [typed, setTyped] = useState<string>();
  return <FileCard label={label} detail={detail} disabled={disabled} action={<Input type="number" min={0} inputMode="numeric"
    aria-label={label} value={typed ?? String(value)} disabled={disabled} onBlur={() => setTyped(undefined)}
    onChange={(event) => { const text = event.target.value, count = Number(text); setTyped(text);
      if (text.trim() && Number.isSafeInteger(count) && count >= 0 && count !== value) onChange(count); }}
    className="h-8 w-16 border-gray-300 text-sm md:text-sm" />} />;
}

type SourceSettings = Pick<AuthoritiesBuildSettings, "sourceMode" | "scannedPdfPolicy" | "grouping" | "tableOrder" |
  "subsequentHistory" | "contextParagraphs" | "contextPages">;
/** The sources' settings as cards, two columns: the same at import and, opened, at Sources, where the context an
 *  excerpt keeps is set too (`context`). */
export function SourceChoices({ settings, profileId, sources = true, recognition = true, context = false, disabled, onChange }: {
  settings: SourceSettings; profileId: AuthoritiesProfileId; sources?: boolean; recognition?: boolean; context?: boolean;
  disabled?: boolean; onChange: (patch: Partial<SourceSettings>) => void;
}) {
  const { paragraphs, pages } = excerptContext(settings);
  const locked = authoritiesProfile(profileId).locked?.settings;
  // Two columns, each its own stack: Order has two choices, so Subsequent history sits under it in the
  // room that leaves, and the step fits without scrolling.
  return <div className="grid content-start gap-5 lg:grid-cols-2">
    <div className="grid content-start gap-5">
      {sources && <OptionCards legend="Source handling" value={settings.sourceMode} options={SOURCE_OPTIONS} disabled={disabled}
        onChange={(sourceMode) => onChange({ sourceMode })} />}
      <OptionCards legend="Groups" value={settings.grouping ?? (settings.tableOrder === "first-reference" ? "none" : "cases-first")}
        options={GROUP_OPTIONS} disabled={disabled || !!locked?.grouping} onChange={(grouping) => onChange({ grouping })} />
      {context && <fieldset disabled={disabled}>
        <legend className="mb-1.5 text-[0.8125rem] font-medium text-gray-700">Excerpts</legend>
        <div className="grid gap-2">
          <ContextCount label="Paragraphs of context" value={paragraphs} disabled={disabled}
            detail="Kept before and after each cited paragraph of a case." onChange={(contextParagraphs) => onChange({ contextParagraphs })} />
          <ContextCount label="Pages of context" value={pages} disabled={disabled}
            detail="Kept before and after each cited page of a case without numbered paragraphs, or of another source."
            onChange={(contextPages) => onChange({ contextPages })} />
        </div>
      </fieldset>}
    </div>
    <div className="grid content-start gap-5">
      {sources && recognition && <OptionCards legend="Scanned PDFs" value={settings.scannedPdfPolicy} options={SCANNED_OPTIONS}
        disabled={disabled} onChange={(scannedPdfPolicy) => onChange({ scannedPdfPolicy })} />}
      <OptionCards legend="Order" value={settings.tableOrder} disabled={disabled || !!locked?.tableOrder}
        options={settings.tableOrder === "custom" ? ORDER_OPTIONS : ORDER_OPTIONS.filter(({ value }) => value !== "custom")}
        onChange={(tableOrder) => onChange({ tableOrder })} />
      <OptionCards legend="Subsequent history" value={settings.subsequentHistory ?? "include"} options={HISTORY_OPTIONS}
        disabled={disabled} onChange={(subsequentHistory) => onChange({ subsequentHistory })} />
    </div>
  </div>;
}

/** The import's choices: the court, the cover and the index, the sources, the excerpts, and the marking. */
const WIZARD_KEYS = [...FRONT_KEYS, "sourceMode", "scannedPdfPolicy", "caseCopy", "passageMarking", "subsequentHistory"] as const;
/** A book's steps; a court that takes only a table skips the cover, the index and the excerpts. */
const BOOK_STEPS = ["Cover", "Index", "Sources", "Excerpts", "Marking"] as const, TABLE_STEPS = ["Sources", "Marking"] as const;

export type Remembered = Pick<AuthoritiesBuildSettings, "sourceMode" | "passageMarking"> & {
  profileId: AuthoritiesProfileId;
};

/** The settings the import makes: the court's defaults, what was remembered from the last import,
 *  and what was chosen here, under the court's locks. A choice the court does not offer is dropped. */
function wizardSettings(profileId: AuthoritiesProfileId, chosen: Partial<Settings>, remembered: Remembered): Settings {
  const profile = authoritiesProfile(profileId);
  const offered = Object.entries(chosen).filter(([key, value]) => key !== "filingMedium" && key !== "bookRole" ||
    !!profile.options?.[key]?.some((option) => option.value === value));
  const settings: Settings = { profileId, ...profile.defaults.settings, sourceMode: remembered.sourceMode,
    ...profileId === remembered.profileId && { passageMarking: remembered.passageMarking },
    ...Object.fromEntries(offered), ...profile.locked?.settings };
  if (profile.requirements?.markedPassages && settings.passageMarking === "none")
    settings.passageMarking = profile.defaults.settings.passageMarking;
  return settings;
}
/** What finishing makes of the draft read from the brief: its court, then every choice here, then the
 *  cover as the form shows it, so the book says what the form and the preview say. */
const importActions = previewActions;

/** The import: the court and the front of the book, then the sources, the excerpts and the marking, each
 *  beside a preview of what it makes. The brief is read, and its sources found, while these are chosen. */
export function ImportWizard({ file, host, draft, remembered, jurisdictionOrder, recognitionAvailable, finishing,
  error, onCancel, onFinish }: {
  /** The brief's file name. */
  file?: string; host: AuthoritiesHost; draft?: AuthoritiesProduct; remembered: Remembered;
  jurisdictionOrder: string[]; recognitionAvailable: boolean;
  /** The finish was asked for and waits for the brief to be read. */
  finishing: boolean; error: string;
  onCancel: () => void; onFinish: (actions: (state: AuthoritiesProduct["state"]) => AuthoritiesAction[],
    remembered: Remembered, own: ReadonlyArray<readonly [AuthoritiesBookSlot, AuthoritiesFile]>) => void;
}) {
  const [step, setStep] = useState(0);
  const [profileId, setProfileId] = useState(remembered.profileId);
  const [chosen, setChosen] = useState<Partial<Settings>>({});
  const [cover, setCover] = useState<AuthoritiesCover>();
  // A cover or index of the user's own, added once the import finishes.
  const [own, setOwn] = useState<Record<FrontSlot, OwnFront>>({ cover: { own: false }, index: { own: false } });
  const pdfs: OwnPdfs = { attach: !!host.attachBookPdf,
    choose: host.pickFiles ? async () => (await host.pickFiles!({ multiple: false, accept: "pdf" }).catch(() => []))[0] : undefined };
  const ownFor = (slot: FrontSlot) => (value: OwnFront) => setOwn((current) => ({ ...current, [slot]: value }));
  // The cover as the draft will hold it under the court chosen here: the court's party roles, until a
  // party is named.
  const courtOf = draft?.state.settings.profileId ?? remembered.profileId;
  const shownCover = courtCover(cover ?? draft?.state.cover ?? EMPTY_COVER, courtOf, profileId);
  const changeCover = (change: (cover: AuthoritiesCover) => AuthoritiesCover) =>
    setCover((current) => change(courtCover(current ?? draft?.state.cover ?? EMPTY_COVER, courtOf, profileId)));
  useFilingContact(host, shownCover, profileId, changeCover);
  const settings = wizardSettings(profileId, chosen, remembered);
  const choose = (patch: Partial<Settings>) => setChosen((current) => ({ ...current, ...patch }));
  const profile = authoritiesProfile(profileId);
  const book = (profile.locked?.outputMode ?? profile.defaults.outputMode) !== "table";
  const finish = () => onFinish((state) => importActions(state, profileId, settings, shownCover, WIZARD_KEYS),
    { profileId, sourceMode: settings.sourceMode, passageMarking: settings.passageMarking },
    (["cover", "index"] as const).flatMap((slot) => book && own[slot].own && own[slot].chosen ? [[slot, own[slot].chosen!] as const] : []));
  // A brief that could not be read stops the import where it is: its error shows and the steps stay usable.
  const busy = finishing && !error;
  const front = previewBook();
  const frontActions = importActions(front.state, profileId, settings, shownCover, PREVIEW_KEYS);
  const steps: readonly string[] = book ? BOOK_STEPS : TABLE_STEPS, at = Math.min(step, steps.length - 1), name = steps[at];
  const last = at === steps.length - 1;
  // The court is the cover's first field (above the sources, where the court takes no book).
  const courtField = <AuthoritiesCourtField value={profileId} preferredKeys={jurisdictionOrder} disabled={busy} onChange={setProfileId} />;
  const court = <section aria-label="Court" className="grid max-w-md gap-1.5">
    {courtField}
    <p className="text-sm text-gray-600">This court takes a Table of Authorities, not a book.</p>
  </section>;
  // The brief named by its file, quietly, beside the title.
  const brief = file && <span title={file} className="inline-flex min-w-0 max-w-[min(34rem,60vw)] items-center gap-1.5 rounded-md border border-gray-300 bg-gray-50 px-2 py-0.5 text-sm font-normal leading-5 text-gray-700">
    <FileText aria-hidden="true" className="size-3.5 shrink-0 text-gray-500" /><span className="truncate">{file}</span></span>;
  return <Modal open onClose={onCancel} size="2xl" breadcrumbs={[<span key="title" className="flex min-w-0 items-center gap-3">Import{brief}</span>]}
    className="h-[min(54rem,calc(100dvh-2rem))] max-w-6xl" bodyClassName="pb-4 lg:overflow-hidden"
    footerStatus={<div className="mr-auto flex min-w-0 items-center gap-3">
      <Button type="button" variant="outline" className={cn("border-gray-400", !at && "invisible")}
        aria-hidden={!at || undefined} tabIndex={at ? undefined : -1} disabled={busy} onClick={() => setStep(at - 1)}>
        <ChevronLeft /> Back</Button>
      <span role="status" className={cn("min-w-0 truncate text-sm", error ? "text-red-800" : "text-gray-600")}>
        {error || (finishing ? <span className="inline-flex items-center gap-2"><Loader2 className="size-4 motion-safe:animate-spin" />
          Finding citations</span> : "")}</span>
    </div>}
    // Next on every step; the last imports.
    primaryAction={{ label: <>Next <ChevronRight /></>, disabled: busy || last && !!error, onClick: last ? finish : () => setStep(at + 1) }}>
    <StepTabs steps={steps} at={at} disabled={busy} onStep={setStep} />
    {name === "Cover" ? <FrontStep slot="cover" host={host} draft={front} actions={frontActions} value={own.cover} pdfs={pdfs}
      disabled={busy} onChange={ownFor("cover")} court={courtField}>
      <CoverFields cover={shownCover} profileId={profileId} settings={settings} disabled={busy} court={courtField}
        onCover={(next) => setCover(next)} onSettings={choose} />
    </FrontStep>
    : name === "Index" ? <FrontStep slot="index" host={host} draft={front} actions={frontActions} value={own.index} pdfs={pdfs}
      disabled={busy} onChange={ownFor("index")} own={<IndexFields own settings={settings} disabled={busy} onChange={choose} />}>
      <IndexFields settings={settings} disabled={busy} onChange={choose} />
    </FrontStep>
    : name === "Sources" ? <div className="grid content-start gap-5 overflow-y-auto p-1">
      {!book && court}
      <SourceChoices settings={settings} profileId={profileId} recognition={recognitionAvailable} disabled={busy} onChange={choose} />
    </div>
    : name === "Excerpts" ? <FrontLayout preview={<Preview label="Preview of a case in the book"><div className="flex min-h-0 flex-1 p-4">
      <ExcerptSample excerpt={settings.caseCopy === "excerpt"} /></div></Preview>}>
      <OptionCards legend="Cases and other sources" value={settings.caseCopy ?? "whole"} disabled={busy}
        options={copyOptions(federalPaperBook(settings))} onChange={(caseCopy) => choose({ caseCopy })} />
    </FrontLayout>
    : <FrontLayout preview={<Preview label="Preview of a marked page"><div className="flex min-h-0 flex-1 p-4"><MarkingSample type={settings.passageMarking} /></div></Preview>}>
      <OptionCards legend="Passage marking" value={settings.passageMarking} options={passageOptions(profileId)}
        disabled={busy} onChange={(passageMarking) => choose({ passageMarking })} />
    </FrontLayout>}
  </Modal>;
}
const EMPTY_COVER: AuthoritiesCover = { courtFileNumber: "", partyGroups: [], applicationUnder: "", title: "" };

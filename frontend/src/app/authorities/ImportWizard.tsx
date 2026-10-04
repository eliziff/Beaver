import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { Modal } from "@/app/components/modals/Modal";
import { Button } from "@/app/components/ui/button";
import { cn, errorMessage } from "@/app/lib/utils";
import type { PdfAnnotation } from "../../../../shared/pdf-annotations.mjs";
import { canonicalJson } from "../../../../shared/canonical-json.mjs";
import { courtCover } from "../../../../shared/authorities-cover.mjs";
import { OptionCards, type CardOption } from "./OptionCards";
import { authoritiesProfile } from "./profiles";
import { MarkingSample, passageOptions } from "./AuthoritiesHighlightEditor";
import { authorityName } from "./authorityPresentation";
import { AuthoritiesCourtField, CoverFields, FRONT_KEYS, FrontLayout, FrontPreview, IndexFields, PagePreview, Preview, savedCover,
  useFilingContact, type Settings } from "./BookFront";
import type { AuthoritiesHost } from "./host";
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
    detail: "Recognizes the text of the scanned pages your brief cites, so their passages can be marked." },
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
type SourceSettings = Pick<AuthoritiesBuildSettings, "sourceMode" | "scannedPdfPolicy" | "grouping" | "tableOrder">;
/** The sources' settings as cards, two columns: the same at import and, opened, at Sources. */
export function SourceChoices({ settings, profileId, sources = true, recognition = true, disabled, onChange }: {
  settings: SourceSettings; profileId: AuthoritiesProfileId; sources?: boolean; recognition?: boolean; disabled?: boolean;
  onChange: (patch: Partial<SourceSettings>) => void;
}) {
  const locked = authoritiesProfile(profileId).locked?.settings;
  return <div className="grid content-start gap-5 lg:grid-cols-2">
    {sources && <OptionCards legend="Source handling" value={settings.sourceMode} options={SOURCE_OPTIONS} disabled={disabled}
      onChange={(sourceMode) => onChange({ sourceMode })} />}
    {sources && recognition && <OptionCards legend="Scanned PDFs" value={settings.scannedPdfPolicy} options={SCANNED_OPTIONS}
      disabled={disabled} onChange={(scannedPdfPolicy) => onChange({ scannedPdfPolicy })} />}
    <OptionCards legend="Groups" value={settings.grouping ?? (settings.tableOrder === "first-reference" ? "none" : "cases-first")}
      options={GROUP_OPTIONS} disabled={disabled || !!locked?.grouping} onChange={(grouping) => onChange({ grouping })} />
    <OptionCards legend="Order" value={settings.tableOrder} disabled={disabled || !!locked?.tableOrder}
      options={settings.tableOrder === "custom" ? ORDER_OPTIONS : ORDER_OPTIONS.filter(({ value }) => value !== "custom")}
      onChange={(tableOrder) => onChange({ tableOrder })} />
  </div>;
}
/** The same choices named in a line, for the closed bar at Sources. */
export function sourceChoiceSummary(settings: SourceSettings, sources: boolean, recognition: boolean) {
  const name = <T extends string>(options: ReadonlyArray<CardOption<T>>, value?: T) => options.find((option) => option.value === value)?.label;
  return [sources && SHORT[settings.sourceMode], sources && recognition && SHORT[settings.scannedPdfPolicy],
    name(GROUP_OPTIONS, settings.grouping ?? (settings.tableOrder === "first-reference" ? "none" : "cases-first")),
    name(ORDER_OPTIONS, settings.tableOrder)].filter(Boolean).join(" · ");
}

/** The source and scan choices named in a word or two, for a setting shown as segments. */
export const SHORT: Record<string, string> = { automatic: "Automatic sources", "manual-originals": "Original PDFs, then my uploads",
  render: "Rebuild all from text", "page-margin": "Keep as images", "cited-pages": "Recognize cited pages", full: "Recognize every page" };
/** The import's choices: the court, the cover and the index, the sources, and the marking. */
const WIZARD_KEYS = [...FRONT_KEYS, "sourceMode", "scannedPdfPolicy", "passageMarking"] as const;
/** A book's steps; a court that takes only a table skips the cover and the index. */
const BOOK_STEPS = ["Cover", "Index", "Sources", "Marking"] as const, TABLE_STEPS = ["Sources", "Marking"] as const;

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
function importActions(state: AuthoritiesProduct["state"], profileId: AuthoritiesProfileId, settings: Settings,
  cover: AuthoritiesCover, keys: readonly (keyof Settings)[]): AuthoritiesAction[] {
  const chosen = Object.fromEntries(keys.flatMap((key) => settings[key] === undefined ? [] : [[key, settings[key]]]));
  const saved = savedCover(cover);
  return [...profileId === state.settings.profileId ? [] : [{ type: "set-profile", profileId } as const],
    { type: "set-settings", settings: chosen },
    ...canonicalJson(saved) === canonicalJson(state.cover) ? [] : [{ type: "set-cover", cover: saved } as const]];
}

/** The import: the court and the front of the book, then the sources, then the marking, each beside a
 *  preview of what it makes. The brief is read, and its sources found, while these are chosen. */
export function ImportWizard({ title, host, draft, remembered, jurisdictionOrder, recognitionAvailable, finishing,
  error, onCancel, onFinish }: {
  title?: string; host: AuthoritiesHost; draft?: AuthoritiesProduct; remembered: Remembered;
  jurisdictionOrder: string[]; recognitionAvailable: boolean;
  /** The finish was asked for and waits for the brief to be read. */
  finishing: boolean; error: string;
  onCancel: () => void; onFinish: (actions: (state: AuthoritiesProduct["state"]) => AuthoritiesAction[],
    remembered: Remembered) => void;
}) {
  const [step, setStep] = useState(0);
  const [profileId, setProfileId] = useState(remembered.profileId);
  const [chosen, setChosen] = useState<Partial<Settings>>({});
  const [cover, setCover] = useState<AuthoritiesCover>();
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
    { profileId, sourceMode: settings.sourceMode, passageMarking: settings.passageMarking });
  const busy = finishing;
  const frontActions = draft ? importActions(draft.state, profileId, settings, shownCover, FRONT_KEYS) : [];
  const steps: readonly string[] = book ? BOOK_STEPS : TABLE_STEPS, at = Math.min(step, steps.length - 1), name = steps[at];
  const last = at === steps.length - 1;
  // The court, its own section above the cover (or above the sources, where the court takes no book).
  const court = <section aria-label="Court" className="grid max-w-md gap-1.5">
    <AuthoritiesCourtField value={profileId} preferredKeys={jurisdictionOrder} disabled={busy} onChange={setProfileId} />
    {!book && <p className="text-sm text-gray-600">This court takes a Table of Authorities, not a book.</p>}
  </section>;
  return <Modal open onClose={onCancel} size="2xl" breadcrumbs={title ? ["Import", <span key="title" className="font-normal text-gray-600">{title}</span>] : ["Import"]}
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
    {/* The steps as the workspace's own tabs: one fixed line, so nothing under it moves. */}
    <ol aria-label="Import steps" className="mb-4 grid h-9 shrink-0 auto-cols-fr grid-flow-col border-b border-gray-200 text-sm">
      {steps.map((label, index) => <li key={label} className="min-w-0">
        <button type="button" aria-current={index === at ? "step" : undefined} disabled={busy} onClick={() => setStep(index)}
          className="-mb-px h-full w-full truncate border-b-2 border-transparent px-2 font-medium text-gray-500 outline-none hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-red-600 aria-[current=step]:border-red-700 aria-[current=step]:text-gray-950">
          {label}</button></li>)}
    </ol>
    {name === "Cover" ? <FrontLayout preview={<FrontPreview host={host} draft={draft} actions={frontActions} page={1} label="Cover" />}>
      {court}
      <CoverFields cover={shownCover} profileId={profileId} settings={settings} disabled={busy}
        onCover={(next) => setCover(next)} onSettings={choose} />
    </FrontLayout>
    : name === "Index" ? <FrontLayout preview={<FrontPreview host={host} draft={draft} actions={frontActions} page={2} label="First page of the index" />}>
      <IndexFields settings={settings} profileId={profileId} disabled={busy} onChange={choose} />
    </FrontLayout>
    : name === "Sources" ? <div className="grid content-start gap-5 overflow-y-auto p-1">
      {!book && court}
      <SourceChoices settings={settings} profileId={profileId} recognition={recognitionAvailable} disabled={busy} onChange={choose} />
    </div>
    : <FrontLayout preview={<Preview label="Preview of a marked page"><div className="flex min-h-0 flex-1 p-4"><MarkingSample type={settings.passageMarking} /></div></Preview>}>
      <OptionCards legend="Passage marking" value={settings.passageMarking} options={passageOptions(profileId)}
        disabled={busy} onChange={(passageMarking) => choose({ passageMarking })} />
    </FrontLayout>}
  </Modal>;
}
const EMPTY_COVER: AuthoritiesCover = { courtFileNumber: "", partyGroups: [], applicationUnder: "", title: "" };

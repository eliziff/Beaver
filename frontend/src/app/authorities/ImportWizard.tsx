import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, Search } from "lucide-react";
import { Modal } from "@/app/components/modals/Modal";
import { CourtChoiceModal } from "@/app/components/modals/CourtChoiceModal";
import { PdfCanvas } from "@/app/components/shared/views/PdfCanvas";
import { Button } from "@/app/components/ui/button";
import { cn, errorMessage } from "@/app/lib/utils";
import type { PdfAnnotation } from "../../../../shared/pdf-annotations.mjs";
import { canonicalJson } from "../../../../shared/canonical-json.mjs";
import { OptionCard, OptionCards, type CardOption } from "./OptionCards";
import { AUTHORITIES_PROFILES, authoritiesProfile } from "./profiles";
import { passageOptions } from "./AuthoritiesHighlightEditor";
import { authorityName } from "./authorityPresentation";
import { CoverFields, FRONT_KEYS, FrontLayout, FrontPreview, IndexFields, LEGEND, Preview, savedCover, startedCover,
  useFilingContact, type Settings } from "./BookFront";
import type { AuthoritiesHost } from "./host";
import type { AuthoritiesAction, AuthoritiesBuildSettings, AuthoritiesCover, AuthoritiesProduct,
  AuthoritiesProfileId } from "./types";

export const SOURCE_OPTIONS: ReadonlyArray<CardOption<AuthoritiesBuildSettings["sourceMode"]>> = [
  { value: "automatic", label: "Automatic sources",
    detail: "Original PDFs are used where they exist. The rest are built from their text." },
  { value: "manual-originals", label: "Use available original PDFs and manually add the PDFs myself for the rest",
    detail: "An authority without an original PDF waits for you to upload one." },
  { value: "render", label: "Rebuild all sources from text (where available)",
    detail: "Every source is built from its text, even where an original PDF exists." },
];
export const SCANNED_OPTIONS: ReadonlyArray<CardOption<AuthoritiesBuildSettings["scannedPdfPolicy"]>> = [
  { value: "page-margin", label: "Keep scans as images",
    detail: "No text is recognized. A scanned page's passages are marked in its margin." },
  { value: "cited-pages", label: "Recognize cited pages",
    detail: "The pages the brief cites get searchable text, and their passages are marked." },
  { value: "full", label: "Recognize every page",
    detail: "Every scanned page gets searchable text." },
];
/** The import's choices: the court, the cover and the index, the sources, and the marking. */
const WIZARD_KEYS = [...FRONT_KEYS, "sourceMode", "scannedPdfPolicy", "passageMarking"] as const;
const STEPS = ["Court and front of book", "Sources", "Marking"] as const;

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
  const saved = savedCover(cover, profileId);
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
  const shownCover = startedCover(cover ?? draft?.state.cover ?? EMPTY_COVER, profileId);
  const changeCover = (change: (cover: AuthoritiesCover) => AuthoritiesCover) =>
    setCover((current) => change(startedCover(current ?? draft?.state.cover ?? EMPTY_COVER, profileId)));
  useFilingContact(host, shownCover, profileId, changeCover);
  const settings = wizardSettings(profileId, chosen, remembered);
  const choose = (patch: Partial<Settings>) => setChosen((current) => ({ ...current, ...patch }));
  const profile = authoritiesProfile(profileId);
  const book = (profile.locked?.outputMode ?? profile.defaults.outputMode) !== "table";
  const court = profileId === "general" ? "" : `${profile.label} `;
  const finish = () => onFinish((state) => importActions(state, profileId, settings, shownCover, WIZARD_KEYS),
    { profileId, sourceMode: settings.sourceMode, passageMarking: settings.passageMarking });
  const busy = finishing;
  const frontActions = draft ? importActions(draft.state, profileId, settings, shownCover, FRONT_KEYS) : [];
  return <Modal open onClose={onCancel} size="2xl" breadcrumbs={["Import"]}
    className="h-[min(54rem,calc(100dvh-2rem))] max-w-6xl" bodyClassName="pb-4 lg:overflow-hidden"
    footerStatus={<div className="mr-auto flex min-w-0 items-center gap-3">
      <Button type="button" variant="outline" className={cn("border-gray-400", !step && "invisible")}
        aria-hidden={!step || undefined} tabIndex={step ? undefined : -1} disabled={busy} onClick={() => setStep(step - 1)}>
        <ChevronLeft /> Back</Button>
      <span role="status" className={cn("min-w-0 truncate text-sm", error ? "text-red-800" : "text-gray-600")}>
        {error || (finishing ? <span className="inline-flex items-center gap-2"><Loader2 className="size-4 motion-safe:animate-spin" />
          Finding citations</span> : "")}</span>
    </div>}
    secondaryAction={step < STEPS.length - 1 ? { label: <>Next <ChevronRight /></>, disabled: busy, onClick: () => setStep(step + 1) } : undefined}
    primaryAction={{ label: step < STEPS.length - 1 ? `Import with ${court}defaults` : "Import",
      disabled: busy || !!error, onClick: finish }}>
    <div className="mb-4 flex shrink-0 flex-wrap items-center gap-x-5 gap-y-1">
    <ol aria-label="Import steps" className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
      {STEPS.map((label, index) => <li key={label}>
        <button type="button" aria-current={index === step ? "step" : undefined} disabled={busy} onClick={() => setStep(index)}
          className="flex min-h-8 items-center gap-2 rounded-md pr-1 text-gray-600 outline-none hover:text-gray-950 focus-visible:ring-2 focus-visible:ring-red-600 aria-[current=step]:font-semibold aria-[current=step]:text-gray-950">
          <span className={cn("grid size-6 place-items-center rounded-full border text-xs tabular-nums",
            index === step ? "border-red-700 bg-red-700 text-white" : "border-gray-400 bg-white")}>{index + 1}</span>
          <span className={cn(index !== step && "max-sm:sr-only")}>{label}</span></button></li>)}
    </ol>
    <p className="ml-auto hidden min-w-0 max-w-full truncate text-sm text-gray-500 sm:block" title={title}>{title}</p>
    </div>
    {step === 0 ? <FrontLayout preview={book ? <FrontPreview host={host} draft={draft} actions={frontActions} />
      : <Preview label="Preview"><p className="m-auto p-6 text-center text-sm text-gray-600">This court takes a Table of Authorities, not a book.</p></Preview>}>
      <CourtPicker value={profileId} remembered={remembered.profileId} preferred={jurisdictionOrder} disabled={busy}
        onChange={setProfileId} />
      {book && <CoverFields cover={shownCover} profileId={profileId} settings={settings} disabled={busy}
        onCover={(next) => setCover(next)} onSettings={choose} />}
      {book && <IndexFields settings={settings} profileId={profileId} disabled={busy} onChange={choose} />}
    </FrontLayout>
    : step === 1 ? <FrontLayout preview={<SourcePreview host={host} draft={draft} />}>
      <OptionCards legend="Source handling" value={settings.sourceMode} options={SOURCE_OPTIONS} disabled={busy}
        onChange={(sourceMode) => choose({ sourceMode })} />
      {recognitionAvailable && <OptionCards legend="Scanned PDFs" value={settings.scannedPdfPolicy} options={SCANNED_OPTIONS}
        disabled={busy} onChange={(scannedPdfPolicy) => choose({ scannedPdfPolicy })} />}
    </FrontLayout>
    : <FrontLayout preview={<MarkedPreview host={host} draft={draft} passageMarking={settings.passageMarking} />}>
      <OptionCards legend="Passage marking" value={settings.passageMarking} options={passageOptions(profileId)}
        disabled={busy} onChange={(passageMarking) => choose({ passageMarking })} />
    </FrontLayout>}
  </Modal>;
}
const EMPTY_COVER: AuthoritiesCover = { courtFileNumber: "", partyGroups: [], applicationUnder: "", title: "" };

/** The courts at hand, the last one used first, and every other behind Other court. */
function CourtPicker({ value, remembered, preferred, disabled, onChange }: {
  value: AuthoritiesProfileId; remembered: AuthoritiesProfileId; preferred: string[]; disabled?: boolean;
  onChange: (value: AuthoritiesProfileId) => void;
}) {
  const [open, setOpen] = useState(false);
  const [quick] = useState(() => {
    const rank = (jurisdiction: string) => { const index = preferred.indexOf(jurisdiction); return index < 0 ? preferred.length : index; };
    const others = AUTHORITIES_PROFILES.filter(({ id }) => id !== remembered && id !== "general")
      .sort((left, right) => rank(left.jurisdiction.id) - rank(right.jurisdiction.id)).map(({ id }) => id);
    return [...new Set([remembered, "general" as AuthoritiesProfileId, ...others])].slice(0, 4);
  });
  // A court chosen from the others takes the last place, so the row never grows.
  const shown = quick.includes(value) ? quick : [...quick.slice(0, -1), value];
  return <fieldset className="min-w-0" disabled={disabled}>
    <legend className={LEGEND}>Court</legend>
    <div className="grid gap-2 @min-[26rem]/front:grid-cols-2">
      {shown.map((id) => <OptionCard key={id} name="authorities-court" checked={id === value} onChange={() => onChange(id)}
        className="min-h-11 py-2" label={authoritiesProfile(id).label} />)}
      <Button type="button" variant="outline" className="h-auto min-h-11 justify-start gap-3 rounded-lg border-gray-300 px-3 font-semibold text-gray-950"
        onClick={() => setOpen(true)}><Search className="text-gray-500" /> Other court</Button>
    </div>
    <CourtChoiceModal open={open} title="Choose court" searchLabel="Search courts" value={value} preferredKeys={preferred}
      options={AUTHORITIES_PROFILES.map(({ id, label, court, jurisdiction }) => ({ value: id, label,
        jurisdictionId: jurisdiction.id, keywords: court.abbreviation }))}
      onChange={(id) => { onChange(id as AuthoritiesProfileId); setOpen(false); }} onClose={() => setOpen(false)} />
  </fieldset>;
}

/** The first source PDF the brief's citations have brought, as it will go in the book. */
function SourcePreview({ host, draft }: { host: AuthoritiesHost; draft?: AuthoritiesProduct }) {
  const source = draft && firstSource(draft);
  const [shown, setShown] = useState<{ role: string; bytes?: Uint8Array; error?: string }>();
  useEffect(() => {
    if (!draft || !source || !host.readSource || shown?.role === source.role) return;
    let active = true;
    void host.readSource(draft, source.role).then((blob) => blob.arrayBuffer())
      .then((buffer) => active && setShown({ role: source.role, bytes: new Uint8Array(buffer) }))
      .catch((caught) => active && setShown({ role: source.role, error: errorMessage(caught, "This PDF could not be opened.") }));
    return () => { active = false; };
  }, [draft, source?.role]); // eslint-disable-line react-hooks/exhaustive-deps
  return <Preview label="Preview of a source">
    {source ? <>
      <p className="truncate border-b border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-950" title={source.name}>{source.name}</p>
      <PdfCanvas bytes={shown?.bytes} loading={!shown} error={shown?.error} ariaLabel="Source preview" rounded={false} />
    </> : <p role="status" className="m-auto p-6 text-center text-sm text-gray-600">
      {draft ? "No source PDF has arrived yet." : "Reading the brief"}</p>}
  </Preview>;
}

/** A cited page of the first source with a pinpoint, marked as the choice marks it. */
function MarkedPreview({ host, draft, passageMarking }: { host: AuthoritiesHost; draft?: AuthoritiesProduct;
  passageMarking: Settings["passageMarking"] }) {
  const source = draft && firstSource(draft, true);
  const key = source ? `${source.role}\0${passageMarking}` : "";
  const [shown, setShown] = useState<{ key: string; bytes?: Uint8Array; marks?: PdfAnnotation[]; error?: string }>();
  useEffect(() => {
    if (!draft || !source || !host.readSource || !host.prepareAnnotations) return;
    let active = true;
    const product = { ...draft, state: { ...draft.state, settings: { ...draft.state.settings, passageMarking } } };
    void host.readSource(draft, source.role).then(async (blob) => {
      const [buffer, { annotations }] = await Promise.all([blob.arrayBuffer(),
        host.prepareAnnotations!(product, source.authorityId, source.role, blob)]);
      if (active) setShown({ key, bytes: new Uint8Array(buffer), marks: annotations.marks });
    }).catch((caught) => active && setShown({ key, error: errorMessage(caught, "This PDF could not be marked.") }));
    return () => { active = false; };
  }, [key, draft?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const marks = shown?.marks ?? [];
  return <Preview label="Preview of a marked page">
    {source ? <>
      <p className="truncate border-b border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-950" title={source.name}>{source.name}</p>
      <PdfCanvas bytes={shown?.bytes} loading={shown?.key !== key && !shown?.bytes} error={shown?.error}
        ariaLabel="Marked page preview" rounded={false}
        annotationEditor={{ marks, selectedId: null, tool: "select", disabled: true,
          focus: marks[0] ? { id: marks[0].id, request: 1 } : undefined, onSelect: () => {}, onCreate: () => {} }} />
    </> : <p role="status" className="m-auto p-6 text-center text-sm text-gray-600">
      {draft ? "No cited source PDF has arrived yet." : "Reading the brief"}</p>}
  </Preview>;
}

/** The first authority, in the brief's order, whose PDF has arrived; with a pinpoint, where `cited`. */
function firstSource({ state }: AuthoritiesProduct, cited = false) {
  for (const id of state.authorityOrder) {
    const authority = state.authorities[id];
    if (authority.excluded || authority.source.kind !== "attached") continue;
    if (cited && !Object.values(state.occurrences).some((item) => item.authorityId === id && item.pinpoints.length)) continue;
    const role = authority.source.sources[0]?.bindingRole;
    if (role) return { role, authorityId: id, name: authorityName(authority) };
  }
}

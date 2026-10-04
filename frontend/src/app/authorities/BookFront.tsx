import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Plus, Scale, X } from "lucide-react";
import { Modal } from "@/app/components/modals/Modal";
import { ModalSelect } from "@/app/components/modals/ModalSelect";
import { ChoiceModalButton } from "@/app/components/modals/ChoiceModalButton";
import { CourtChoiceModal } from "@/app/components/modals/CourtChoiceModal";
import { Input } from "@/app/components/ui/input";
import { cn, errorMessage } from "@/app/lib/utils";
import { getPdfJs, openPdfDocument, PDF_DOCUMENT_OPTIONS } from "@/app/lib/pdfJs";
import { OptionCard, OptionCards } from "./OptionCards";
import { AUTHORITIES_PROFILES, authoritiesProfile } from "./profiles";
import type { AuthoritiesHost } from "./host";
import { canonicalJson } from "../../../../shared/canonical-json.mjs";
import type { AuthoritiesAction, AuthoritiesCover, AuthoritiesDraft, AuthoritiesProduct, AuthoritiesProfileId } from "./types";
import previewState from "./previewBook.json";
import { courtChange, courtState } from "./courtChange";

export type Settings = AuthoritiesProduct["state"]["settings"];
/** The settings the cover and the index are drawn from. */
export const FRONT_KEYS = ["filingMedium", "bookRole", "indexShows", "tabPages", "rightHandStarts", "grouping",
  "tableOrder"] as const;
export const LEGEND = "mb-2 text-sm font-semibold text-gray-950";
const FIELD = "mt-1 h-9 border-gray-300 text-sm md:text-sm";
const AREA = "mt-1 min-h-14 w-full resize-y rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-950 outline-none focus-visible:ring-2 focus-visible:ring-red-600";
const LABEL = "block min-w-0 text-sm font-medium text-gray-800";
type Contact = NonNullable<AuthoritiesCover["contact"]>;
const EMPTY_CONTACT: Contact = { name: "", address: "", phone: "", fax: "", email: "" };
const CONTACT = [["name", "Name"], ["email", "Email"], ["address", "Address"], ["phone", "Phone"], ["fax", "Fax"]] as const;
/** The contact as the form lays it out: the short fields two to a line, the address under them. */
const CONTACT_ORDER = [CONTACT[0], CONTACT[1], CONTACT[3], CONTACT[4], CONTACT[2]] as const;

/** The court: a button naming it, which opens the court chooser the court records share. */
export function AuthoritiesCourtField({ value, disabled, preferredKeys, onChange, className,
  bookOnly = false }: {
  value: AuthoritiesProfileId; disabled?: boolean; preferredKeys: string[];
  onChange: (value: AuthoritiesProfileId) => void; className?: string; bookOnly?: boolean;
}) {
  const current = authoritiesProfile(value);
  const [open, setOpen] = useState(false);
  const available = AUTHORITIES_PROFILES
    .filter((item) => !bookOnly || item.locked?.outputMode !== "table");

  return <div className={className}>
    <ChoiceModalButton icon={<Scale aria-hidden="true" className="h-4 w-4 shrink-0 text-gray-500" />}
      label="Court" value={current.label} disabled={disabled} className="w-full"
      onClick={() => setOpen(true)} />
    <CourtChoiceModal open={open} title="Choose court" searchLabel="Search courts"
      value={value} preferredKeys={preferredKeys}
      options={available.map(({ id, label, court, jurisdiction }) => ({ value: id, label,
        jurisdictionId: jurisdiction.id, keywords: court.abbreviation }))}
      onChange={(id) => onChange(id as AuthoritiesProfileId)} onClose={() => setOpen(false)} />
  </div>;
}

/** The cover the court files a book under: the Federal Court's Form 66, King's Bench's Alberta cover,
 *  or the plain one every other book has. */
export function coverForm(profileId: AuthoritiesProfileId) {
  const { requirements } = authoritiesProfile(profileId);
  return requirements?.federalFormatting ? "federal" : requirements?.albertaCover ? "alberta" : "plain";
}
/** The cover as it is saved: trimmed, and empty party lines dropped. */
export function savedCover(cover: AuthoritiesCover): AuthoritiesCover {
  return { ...cover, courtFileNumber: cover.courtFileNumber.trim(), applicationUnder: cover.applicationUnder.trim(),
    title: cover.title.trim(),
    partyGroups: cover.partyGroups.map(({ role, parties }) => ({ role: role.trim(),
      parties: parties.map((party) => party.trim()).filter(Boolean) }))
      .filter(({ role, parties }) => role || parties.length),
    ...cover.judicialCentre !== undefined && { judicialCentre: cover.judicialCentre.trim() },
    ...cover.contact && { contact: Object.fromEntries(CONTACT.map(([key]) => [key, cover.contact?.[key]?.trim() ?? ""])) as Contact } };
}
/** The cover a Federal Form 66 needs before the book can be built. */
export const completeFederalCover = (cover: AuthoritiesCover) => !!cover.courtFileNumber.trim() &&
  cover.partyGroups.length >= 2 && cover.partyGroups.every(({ role, parties }) =>
    !!role.trim() && parties.some((party) => !!party.trim()));

/** The cover's details as the court's cover asks for them, with who files where the court asks. */
export function CoverFields({ cover, profileId, settings, disabled, court, onCover, onSettings }: {
  cover: AuthoritiesCover; profileId: AuthoritiesProfileId; settings: Settings; disabled?: boolean; court?: ReactNode;
  onCover: (cover: AuthoritiesCover) => void; onSettings: (patch: Partial<Settings>) => void;
}) {
  const form = coverForm(profileId), options = authoritiesProfile(profileId).options;
  const group = (index: number, patch: Partial<AuthoritiesCover["partyGroups"][number]>) =>
    onCover({ ...cover, partyGroups: cover.partyGroups.map((item, position) => position === index ? { ...item, ...patch } : item) });
  const text = (label: ReactNode, value: string, change: (value: string) => void, className?: string, placeholder?: string) =>
    <label className={cn(LABEL, className)}>{label}
      <Input value={value} placeholder={placeholder} disabled={disabled} onChange={(event) => change(event.target.value)}
        className={FIELD} /></label>;
  const optional = <span className="font-normal text-gray-500">(optional)</span>;
  const title = (className?: string) => text(<>Title {optional}</>, cover.title, (title) => onCover({ ...cover, title }), className,
    form === "alberta" ? "Book of Authorities of the Applicant" : form === "plain" ? "Book of Authorities" : undefined);
  // Two to a line: the court beside its file number, a short field beside another; only the title of a
  // Federal cover and the parties take the width.
  return <fieldset className="grid min-w-0 gap-4" disabled={disabled}>
    <legend className="sr-only">Cover</legend>
    <div className="grid grid-cols-2 gap-x-3 gap-y-3">
      {court}
      {form === "plain" ? title()
        : text("Court file number", cover.courtFileNumber, (courtFileNumber) => onCover({ ...cover, courtFileNumber }))}
      {form === "alberta" && text("Judicial centre", cover.judicialCentre ?? "", (judicialCentre) => onCover({ ...cover, judicialCentre }))}
      {form === "alberta" && title()}
      {form !== "plain" && options?.filingMedium && options.bookRole && <>
        <Choice label="Filing" value={settings.filingMedium ?? "electronic"} options={options.filingMedium} disabled={disabled}
          onChange={(filingMedium) => onSettings({ filingMedium })} />
        <Choice label="Filed by" value={settings.bookRole ?? ""} options={options.bookRole} disabled={disabled}
          placeholder={settings.bookRole ? null : "Choose filing party"} onChange={(bookRole) => onSettings({ bookRole })} />
      </>}
      {form === "federal" && title("col-span-2")}
    </div>
    {/* The parties as a table: each role beside its parties, one per line. */}
    {form !== "plain" && <div role="group" aria-label="Parties" className="grid grid-cols-[9rem_minmax(0,1fr)_1.75rem] items-start gap-x-2 gap-y-1.5 border-t border-gray-200 pt-3">
      <span className={LABEL}>Role</span>
      <span className={LABEL}>Parties <span className="font-normal text-gray-500">(one per line)</span></span><span />
      {cover.partyGroups.map(({ role, parties }, index) => <Fragment key={index}>
        <Input aria-label={`Role ${index + 1}`} value={role} disabled={disabled} onChange={(event) => group(index, { role: event.target.value })}
          className="h-8 border-gray-300 text-sm md:text-sm" />
        <textarea aria-label={`Parties for ${role || `role ${index + 1}`}`} rows={Math.max(1, parties.length)} value={parties.join("\n")}
          disabled={disabled} onChange={(event) => group(index, { parties: event.target.value.split(/\r?\n/u) })}
          className="min-h-8 w-full resize-none rounded-md border border-gray-300 bg-white px-2.5 py-1 text-sm leading-5 text-gray-950 outline-none focus-visible:ring-2 focus-visible:ring-red-600" />
        <button type="button" aria-label={`Remove ${role || `role ${index + 1}`}`} disabled={disabled || cover.partyGroups.length <= 2}
          title="Remove this role" onClick={() => onCover({ ...cover, partyGroups: cover.partyGroups.filter((_, position) => position !== index) })}
          className="grid size-8 place-items-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-900 disabled:invisible"><X className="size-4" /></button>
      </Fragment>)}
      <button type="button" disabled={disabled} className="col-span-2 inline-flex h-7 w-fit items-center gap-1 rounded-md px-1.5 text-[0.8125rem] font-medium text-gray-700 hover:bg-gray-100"
        onClick={() => onCover({ ...cover, partyGroups: [...cover.partyGroups, { role: "", parties: [""] }] })}>
        <Plus className="size-3.5" /> Add role</button>
    </div>}
    {form === "federal" && text(<>Application under {optional}</>, cover.applicationUnder,
      (applicationUnder) => onCover({ ...cover, applicationUnder }))}
    {form === "alberta" && <div className="border-t border-gray-200 pt-3"><fieldset className="grid grid-cols-2 gap-x-3 gap-y-3">
      <legend className="mb-2 text-sm font-semibold text-gray-950">Address for service and contact information</legend>
      {CONTACT_ORDER.map(([key, label]) => key === "address"
        ? <label key={key} className={cn(LABEL, "col-span-2")}>{label}
          <textarea rows={2} value={cover.contact?.address ?? ""} className={AREA}
            onChange={(event) => onCover({ ...cover, contact: { ...EMPTY_CONTACT, ...cover.contact, address: event.target.value } })} /></label>
        : <label key={key} className={LABEL}>{label}
          <Input value={cover.contact?.[key] ?? ""} type={key === "email" ? "email" : "text"} className={FIELD}
            onChange={(event) => onCover({ ...cover, contact: { ...EMPTY_CONTACT, ...cover.contact, [key]: event.target.value } })} /></label>)}
    </fieldset></div>}
  </fieldset>;
}

/** What the index gives, how it groups and orders the authorities, and how each tab opens. */
export function IndexFields({ settings, profileId, disabled, onChange }: {
  settings: Settings; profileId: AuthoritiesProfileId; disabled?: boolean; onChange: (patch: Partial<Settings>) => void;
}) {
  const profile = authoritiesProfile(profileId), federal = !!profile.requirements?.federalFormatting;
  const electronic = settings.filingMedium === "electronic";
  const tabPages = settings.tabPages ?? true;
  const rightHand = !electronic && (settings.rightHandStarts ?? settings.filingMedium === "paper");
  return <fieldset className="grid min-w-0 gap-3" disabled={disabled}>
    <legend className="sr-only">Index</legend>
    <OptionCards legend="Beside each authority" value={settings.indexShows ?? (federal ? "tabs-and-pages" : "tabs")}
      columns disabled={disabled} options={[{ value: "tabs", label: "Its tab", detail: "The index gives each authority's tab." },
        { value: "tabs-and-pages", label: "Its tab and pages", detail: "The index also gives the book pages each authority fills." }]}
      onChange={(indexShows) => onChange({ indexShows })} />
    <div className="grid gap-2">
      <OptionCard type="checkbox" checked={tabPages} onChange={() => onChange({ tabPages: !tabPages })}
        label="A TAB page before each authority" detail="Where the index's link and the bookmark for each authority land." />
      <OptionCard type="checkbox" checked={rightHand} disabled={electronic} onChange={() => onChange({ rightHandStarts: !rightHand })}
        label="Start each on a right-hand page"
        detail={electronic ? "For a book printed on both sides. An electronic filing has no blank pages."
          : "For a book printed on both sides: a blank page is added where one is needed."} />
    </div>
  </fieldset>;
}

function Choice<T extends string>({ label, value, options, onChange, disabled, placeholder = null }: {
  label: string; value: T | ""; options: ReadonlyArray<{ value: T; label: string }>; onChange: (value: T) => void;
  disabled?: boolean; placeholder?: string | null;
}) {
  return <label className={LABEL}>{label}
    <ModalSelect id={`authorities-${label.toLowerCase().replaceAll(" ", "-")}`} value={value} disabled={disabled}
      placeholder={placeholder} className="mt-1" options={options} onChange={(next) => next && onChange(next as T)} />
  </label>;
}

/** The changes to the draft that the cover and settings chosen here make, in the order they apply. */
export function frontActions(state: AuthoritiesProduct["state"], cover: AuthoritiesCover,
  settings: Partial<Settings>): AuthoritiesAction[] {
  const locked = authoritiesProfile(state.settings.profileId).locked?.settings ?? {};
  const changed = Object.fromEntries(Object.entries(settings).filter(([key, value]) => value !== undefined &&
    !(key in locked) && canonicalJson(state.settings[key as keyof Settings]) !== canonicalJson(value)));
  const saved = savedCover(cover);
  return [...Object.keys(changed).length ? [{ type: "set-settings", settings: changed } as const] : [],
    ...canonicalJson(saved) !== canonicalJson(state.cover)
      ? [{ type: "set-cover", cover: saved } as const] : []];
}

/** The book the cover and index previews are drawn from: seven made-up authorities in three groups,
 *  so the index shows every kind of entry whatever the brief cites, and nothing waits for the brief. The
 *  Beaver server draws only a saved draft's front, so there the preview is the draft's own. */
const PREVIEW_BOOK: AuthoritiesProduct = { id: "preview", kind: "authorities", title: "Book of Authorities",
  projectId: null, revision: 0, state: previewState as unknown as AuthoritiesDraft, outputs: {}, createdAt: "", updatedAt: "" };
export const previewBook = (host: AuthoritiesHost, draft?: AuthoritiesProduct) =>
  host.mode === "standalone" ? PREVIEW_BOOK : draft;
/** The changes that make the preview book's front the one chosen: the court, the settings named, the cover. */
export function previewActions(state: AuthoritiesProduct["state"], profileId: AuthoritiesProfileId, settings: Settings,
  cover: AuthoritiesCover, keys: readonly (keyof Settings)[]): AuthoritiesAction[] {
  const chosen = Object.fromEntries(keys.flatMap((key) => settings[key] === undefined ? [] : [[key, settings[key]]]));
  const saved = savedCover(cover);
  return [...profileId === state.settings.profileId ? [] : [{ type: "set-profile", profileId } as const],
    { type: "set-settings", settings: chosen },
    ...canonicalJson(saved) === canonicalJson(state.cover) ? [] : [{ type: "set-cover", cover: saved } as const]];
}

/** The book's cover and the first page of its index, drawn by the book's own renderer from the draft
 *  with the changes not yet made to it. One drawing is asked for at a time, a moment after a change,
 *  and the next once it is back, so a draft that keeps changing (its sources arriving) never holds the
 *  preview back. */
export function FrontPreview({ host, draft, actions, page, label, className }: {
  host: AuthoritiesHost; draft?: AuthoritiesProduct; actions: AuthoritiesAction[]; page: number; label: string; className?: string;
}) {
  const key = draft ? JSON.stringify([draft.id, draft.revision, actions]) : "";
  const [shown, setShown] = useState<{ bytes?: Uint8Array; error?: string }>();
  const latest = useRef({ key, draft, actions }), [again, setAgain] = useState(0);
  latest.current = { key, draft, actions };
  const asking = useRef<{ timer?: number; running: boolean; drawn: string; stop: AbortController }>(
    { running: false, drawn: "", stop: new AbortController() });
  useEffect(() => {
    const state = asking.current, stop = new AbortController();
    state.stop = stop;
    return () => { clearTimeout(state.timer); state.timer = undefined; stop.abort(); };
  }, []);
  useEffect(() => {
    const state = asking.current;
    if (!draft || !host.bookFront || state.running || state.timer || key === state.drawn) return;
    state.timer = window.setTimeout(() => {
      const asked = latest.current;
      state.timer = undefined; state.running = true;
      void host.bookFront!(asked.draft!, asked.actions, state.stop.signal)
        .then((blob) => blob.arrayBuffer()).then((buffer) => setShown({ bytes: new Uint8Array(buffer) }))
        .catch((error) => { if (!state.stop.signal.aborted) setShown((current) => ({ ...current,
          error: errorMessage(error, "The preview could not be drawn.") })); })
        .finally(() => { state.running = false; state.drawn = asked.key;
          if (!state.stop.signal.aborted && latest.current.key !== asked.key) setAgain((value) => value + 1); });
    }, 300);
  }, [key, again]); // eslint-disable-line react-hooks/exhaustive-deps
  return <Preview className={className} label={`Preview: ${label}`}>
    {shown?.error && !shown.bytes ? <p role="alert" className="m-auto p-6 text-center text-sm text-red-800">{shown.error}</p>
      : <div className="flex min-h-0 flex-1 p-4"><PagePreview bytes={shown?.bytes} page={page} label={label} /></div>}
  </Preview>;
}

/** One page of a PDF drawn whole in a still frame: the last drawing stays until the next is ready, so
 *  nothing moves. */
export function PagePreview({ bytes, page, label }: { bytes?: Uint8Array; page: number; label: string }) {
  const [drawn, setDrawn] = useState<{ url: string; width: number; height: number; page: number }>();
  useEffect(() => {
    if (!bytes) return;
    let active = true;
    void (async () => {
      const task = openPdfDocument(await getPdfJs(), { data: bytes.slice() }, PDF_DOCUMENT_OPTIONS);
      try {
        const document = await task.promise, at = Math.min(page, document.numPages), pdfPage = await document.getPage(at);
        const { width, height } = pdfPage.getViewport({ scale: 1 }), viewport = pdfPage.getViewport({ scale: 2 });
        const canvas = window.document.createElement("canvas");
        canvas.width = viewport.width; canvas.height = viewport.height;
        await pdfPage.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport }).promise;
        if (active) setDrawn({ url: canvas.toDataURL("image/png"), width, height, page: at });
      } finally { await task.destroy(); }
    })().catch(() => {});
    return () => { active = false; };
  }, [bytes, page]);
  return <figure className="m-0 flex min-h-0 min-w-0 flex-1 flex-col items-center gap-1.5">
    {/* The page fits the frame whole, centred, at the page's own proportions. */}
    <div className="relative min-h-0 w-full flex-1">
      {drawn ? <svg role="img" aria-label={label} viewBox={`0 0 ${drawn.width} ${drawn.height}`}
        style={{ aspectRatio: `${drawn.width} / ${drawn.height}` }}
        className="absolute inset-0 m-auto h-full max-h-full w-auto max-w-full bg-white shadow-[0_1px_3px_rgb(0_0_0/.15)]">
        <image href={drawn.url} width={drawn.width} height={drawn.height} />
      </svg> : <div aria-hidden="true" className="absolute inset-0 m-auto aspect-[8.5/11] h-full max-w-full animate-pulse bg-white/70" />}
    </div>
    <figcaption className="text-xs text-gray-600">{label}</figcaption>
  </figure>;
}

/** The preview pane beside the options: a framed, full-height area. */
export function Preview({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return <section aria-label={label} className={cn("flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-gray-300 bg-gray-100", className)}>
    {children}
  </section>;
}

/** The steps as the workspace's own tabs: one fixed line, so nothing under it moves. */
export function StepTabs({ steps, at, disabled, onStep }: {
  steps: readonly string[]; at: number; disabled?: boolean; onStep: (index: number) => void;
}) {
  return <ol aria-label="Steps" className="mb-4 grid h-9 shrink-0 auto-cols-fr grid-flow-col border-b border-gray-200 text-sm">
    {steps.map((label, index) => <li key={label} className="min-w-0">
      <button type="button" aria-current={index === at ? "step" : undefined} disabled={disabled} onClick={() => onStep(index)}
        className="-mb-px h-full w-full truncate border-b-2 border-transparent px-2 font-medium text-gray-500 outline-none hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-red-600 aria-[current=step]:border-red-700 aria-[current=step]:text-gray-950">
        {label}</button></li>)}
  </ol>;
}

export const FRONT_STEPS = ["Cover", "Index"] as const;
/** The court, the cover and the index at Build: the import's own Cover and Index steps, the book's front
 *  beside them, saved together. The footer says what a new court changes. */
export function BookFrontModal({ host, draft, busy, step: first, jurisdictionOrder, onClose, onActions }: {
  host: AuthoritiesHost; draft: AuthoritiesProduct; busy: boolean; step: typeof FRONT_STEPS[number];
  jurisdictionOrder: string[]; onClose: () => void; onActions: (actions: AuthoritiesAction[]) => void;
}) {
  const before = draft.state, manual = before.import.kind === "manual";
  const [at, setAt] = useState<number>(FRONT_STEPS.indexOf(first));
  const [profileId, setProfileId] = useState(before.settings.profileId);
  const [edited, setEdited] = useState<AuthoritiesCover>();
  const [settings, setSettings] = useState<Partial<Settings>>({});
  // The draft as the court chosen here leaves it, then the cover and settings changed here.
  const court = courtState(before, profileId);
  const cover = edited ?? court.cover;
  useFilingContact(host, cover, profileId, (change) => setEdited((current) => change(current ?? courtState(before, profileId).cover)));
  const shown = { ...court.settings, ...settings };
  const actions: AuthoritiesAction[] = [...profileId === before.settings.profileId ? [] : [{ type: "set-profile", profileId } as const],
    ...frontActions(court, cover, settings)];
  const front = previewBook(host, draft);
  const preview = front ? previewActions(front.state, profileId, shown, cover, FRONT_KEYS) : [];
  const save = () => {
    onActions(actions); onClose();
    if (coverForm(profileId) === "alberta" && cover.contact) void host.filingContact?.save(savedCover(cover).contact!)
      .catch(() => undefined);
  };
  const step = FRONT_STEPS[at];
  return <Modal open onClose={onClose} breadcrumbs={["Book"]} size="2xl"
    className="h-[min(54rem,calc(100dvh-2rem))] max-w-6xl" bodyClassName="pb-4 lg:overflow-hidden"
    footerStatus={<p role="status" className="mr-auto min-w-0 flex-1 text-sm text-gray-700">
      {profileId === before.settings.profileId ? "" : courtChange(before, court)}</p>}
    secondaryAction={{ label: "Cancel", onClick: onClose }}
    primaryAction={{ label: "Save", disabled: busy || !actions.length, onClick: save }}>
    <StepTabs steps={FRONT_STEPS} at={at} disabled={busy} onStep={setAt} />
    {step === "Cover" ? <FrontLayout preview={<FrontPreview host={host} draft={front} actions={preview} page={1} label="Cover" />}>
      <CoverFields cover={cover} profileId={profileId} settings={shown} disabled={busy} onCover={setEdited}
        court={<AuthoritiesCourtField value={profileId} preferredKeys={jurisdictionOrder} disabled={busy} bookOnly={manual}
          onChange={(next) => { setProfileId(next); setSettings({}); }} />}
        onSettings={(patch) => setSettings((current) => ({ ...current, ...patch }))} />
    </FrontLayout>
    : <FrontLayout preview={<FrontPreview host={host} draft={front} actions={preview} page={2} label="First page of the index" />}>
      <IndexFields settings={shown} profileId={profileId} disabled={busy}
        onChange={(patch) => setSettings((current) => ({ ...current, ...patch }))} />
    </FrontLayout>}
  </Modal>;
}

/** Options on the left, each in its own scroll, and the preview on the right; one above the other
 *  where the window is narrow. */
export function FrontLayout({ preview, children }: { preview: ReactNode; children: ReactNode }) {
  return <div className="grid min-h-0 flex-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
    <div className="@container/front grid min-w-0 content-start gap-5 p-1 lg:min-h-0 lg:overflow-y-auto">{children}</div>
    <div className="h-[28rem] min-w-0 lg:h-auto lg:min-h-0 [&>section]:h-full">{preview}</div>
  </div>;
}

/** An Alberta cover without a contact starts from the one kept for the user. */
export function useFilingContact(host: AuthoritiesHost, cover: AuthoritiesCover, profileId: AuthoritiesProfileId,
  setCover: (change: (cover: AuthoritiesCover) => AuthoritiesCover) => void) {
  const alberta = coverForm(profileId) === "alberta";
  const blank = !Object.values(cover.contact ?? {}).some((value) => value.trim());
  useEffect(() => {
    if (!alberta || !blank || !host.filingContact) return;
    let active = true;
    void host.filingContact.get().then((contact) => {
      if (active && Object.values(contact).some((value) => value.trim()))
        setCover((current) => Object.values(current.contact ?? {}).some((value) => value.trim()) ? current : { ...current, contact });
    }).catch(() => undefined);
    return () => { active = false; };
  }, [alberta, host]); // eslint-disable-line react-hooks/exhaustive-deps
}

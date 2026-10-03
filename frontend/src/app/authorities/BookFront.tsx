import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Plus } from "lucide-react";
import { ModalSelect } from "@/app/components/modals/ModalSelect";
import { PdfCanvas } from "@/app/components/shared/views/PdfCanvas";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { cn, errorMessage } from "@/app/lib/utils";
import { OptionCard, OptionCards } from "./OptionCards";
import { AUTHORITIES_PROFILES, authoritiesProfile } from "./profiles";
import type { AuthoritiesHost } from "./host";
import { canonicalJson } from "../../../../shared/canonical-json.mjs";
import type { AuthoritiesAction, AuthoritiesCover, AuthoritiesProduct, AuthoritiesProfileId } from "./types";

export type Settings = AuthoritiesProduct["state"]["settings"];
/** The settings the cover and the index are drawn from. */
export const FRONT_KEYS = ["filingMedium", "bookRole", "indexShows", "tabPages", "rightHandStarts", "grouping",
  "tableOrder"] as const;
/** A part of the book's front: the cover, the index. */
export const SECTION = "mb-3 w-full border-b border-gray-200 pb-1.5 text-base font-semibold text-gray-950";
const FIELD = "mt-1.5 h-10 border-gray-400 md:text-base";
const AREA = "mt-1.5 min-h-20 w-full resize-y rounded-md border border-gray-400 bg-white px-3 py-2 text-base text-gray-950 outline-none focus-visible:ring-2 focus-visible:ring-red-600";
const LABEL = "block min-w-0 text-sm font-medium text-gray-700";
const GROUPINGS = [{ value: "cases-first", label: "Cases first" }, { value: "legislation-first", label: "Legislation first" },
  { value: "none", label: "None" }] as const;
const ORDERS = [{ value: "alphabetical", label: "Alphabetical" }, { value: "first-reference", label: "First cited" },
  { value: "custom", label: "As arranged" }] as const;
type Contact = NonNullable<AuthoritiesCover["contact"]>;
const EMPTY_CONTACT: Contact = { name: "", address: "", phone: "", fax: "", email: "" };
const CONTACT = [["name", "Name"], ["email", "Email"], ["address", "Address"], ["phone", "Phone"], ["fax", "Fax"]] as const;

/** The court, in one control the height of a text box: its jurisdiction, then the court there. A
 *  jurisdiction brings its first court; with no court preset the jurisdiction takes the whole box. */
export function CourtSelect({ value, preferred = [], disabled, bookOnly = false, onChange, className }: {
  value: AuthoritiesProfileId; preferred?: readonly string[]; disabled?: boolean; className?: string;
  /** Only the courts a book is filed in. */
  bookOnly?: boolean; onChange: (value: AuthoritiesProfileId) => void;
}) {
  const profiles = AUTHORITIES_PROFILES.filter((item) => !bookOnly || item.locked?.outputMode !== "table");
  // The user's own jurisdictions first, then the rest, and no court preset last.
  const rank = ({ id, preferenceKey }: { id: string; preferenceKey?: string }) => {
    const index = preferred.indexOf(preferenceKey ?? id);
    return id === "general" ? preferred.length + 1 : index < 0 ? preferred.length : index;
  };
  const jurisdictions = [...new Map(profiles.map(({ jurisdiction }) => [jurisdiction.id, jurisdiction])).values()]
    .sort((left, right) => rank(left) - rank(right) || left.order - right.order);
  const current = authoritiesProfile(value);
  const courts = profiles.filter(({ jurisdiction }) => jurisdiction.id === current.jurisdiction.id);
  return <div role="group" aria-label="Court" className={cn("grid h-9 min-w-0 rounded-md border border-gray-300 bg-white hover:border-gray-500",
    value === "general" ? "grid-cols-1" : "grid-cols-[minmax(0,2fr)_minmax(0,3fr)]", className)}>
    <Segment label="Jurisdiction" value={current.jurisdiction.id} disabled={disabled}
      options={jurisdictions.map(({ id, label }) => ({ value: id, label }))}
      onChange={(id) => onChange(profiles.find(({ jurisdiction }) => jurisdiction.id === id)!.id)} />
    {value !== "general" && <Segment label="Court" value={value} disabled={disabled} className="border-l border-gray-300"
      options={courts.map(({ id, label }) => ({ value: id, label }))} onChange={(id) => onChange(id as AuthoritiesProfileId)} />}
  </div>;
}
function Segment({ label, value, options, disabled, className, onChange }: { label: string; value: string;
  options: ReadonlyArray<{ value: string; label: string }>; disabled?: boolean; className?: string; onChange: (value: string) => void }) {
  return <span className={cn("relative min-w-0", className)}>
    <select aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}
      title={options.find((option) => option.value === value)?.label}
      className="h-full w-full appearance-none truncate rounded-md bg-transparent pl-3 pr-8 text-sm text-gray-950 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-red-600 disabled:cursor-default disabled:opacity-60">
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
    <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-gray-500" />
  </span>;
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
/** A Federal Form 66 the book makes needs the court file number, the parties and who files before
 *  the book can be built. */
export const coverNeedsDetails = ({ settings, outputMode, bookParts, cover }: AuthoritiesProduct["state"]) =>
  outputMode !== "table" && coverForm(settings.profileId) === "federal" && !bookParts.cover && !(!!settings.bookRole &&
    !!cover.courtFileNumber.trim() && cover.partyGroups.length >= 2 && cover.partyGroups.every(({ role, parties }) =>
      !!role.trim() && parties.some((party) => !!party.trim())));

/** The cover's details as the court's cover asks for them, with who files where the court asks. */
export function CoverFields({ cover, profileId, settings, disabled, headless, onCover, onSettings }: {
  cover: AuthoritiesCover; profileId: AuthoritiesProfileId; settings: Settings; disabled?: boolean;
  /** Under a row that already names it. */
  headless?: boolean;
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
  return <fieldset className="grid min-w-0 gap-4" disabled={disabled}>
    <legend className={headless ? "sr-only" : SECTION}>Cover</legend>
    {form === "plain" ? text(<>Title {optional}</>, cover.title, (title) => onCover({ ...cover, title }), undefined, "Book of Authorities")
      : <div className="grid gap-3 @min-[34rem]/front:grid-cols-2">
        {text("Court file number", cover.courtFileNumber, (courtFileNumber) => onCover({ ...cover, courtFileNumber }))}
        {form === "alberta" && text("Judicial centre", cover.judicialCentre ?? "", (judicialCentre) => onCover({ ...cover, judicialCentre }))}
        {text(<>Title {optional}</>, cover.title, (title) => onCover({ ...cover, title }),
          form === "alberta" ? "@min-[34rem]/front:col-span-2" : undefined,
          form === "alberta" ? "Book of Authorities of the Applicant" : undefined)}
      </div>}
    {form !== "plain" && options?.filingMedium && options.bookRole && <div className="grid gap-3 @min-[34rem]/front:grid-cols-2">
      <Choice label="Filing" value={settings.filingMedium ?? "electronic"} options={options.filingMedium} disabled={disabled}
        onChange={(filingMedium) => onSettings({ filingMedium })} />
      <Choice label="Filed by" value={settings.bookRole ?? ""} options={options.bookRole} disabled={disabled}
        placeholder={settings.bookRole ? null : "Choose filing party"} onChange={(bookRole) => onSettings({ bookRole })} />
    </div>}
    {form !== "plain" && <div className="grid gap-3 @min-[34rem]/front:grid-cols-2">
      {cover.partyGroups.map(({ role, parties }, index) => <section key={index} aria-label={`Party group ${index + 1}`}
        className="rounded-lg border border-gray-200 bg-gray-50 p-3">
        <label className={LABEL}>Role
          <Input value={role} disabled={disabled} onChange={(event) => group(index, { role: event.target.value })}
            className="mt-1 h-9 border-gray-400 bg-white md:text-base" /></label>
        <label className={cn(LABEL, "mt-3")}>Party names <span className="font-normal text-gray-500">(one per line)</span>
          <textarea rows={2} value={parties.join("\n")} disabled={disabled}
            onChange={(event) => group(index, { parties: event.target.value.split(/\r?\n/u) })} className={AREA} /></label>
        {cover.partyGroups.length > 2 && <Button type="button" variant="ghost" className="mt-1 h-8 px-2 text-xs"
          onClick={() => onCover({ ...cover, partyGroups: cover.partyGroups.filter((_, position) => position !== index) })}>
          Remove role</Button>}
      </section>)}
      <Button type="button" variant="outline" className="h-9 w-fit border-gray-400" disabled={disabled}
        onClick={() => onCover({ ...cover, partyGroups: [...cover.partyGroups, { role: "", parties: [""] }] })}>
        <Plus /> Add role</Button>
    </div>}
    {form === "federal" && text(<>Application under {optional}</>, cover.applicationUnder,
      (applicationUnder) => onCover({ ...cover, applicationUnder }))}
    {form === "alberta" && <fieldset className="grid gap-3 @min-[34rem]/front:grid-cols-2">
      <legend className="mb-2 text-sm font-medium text-gray-800">Address for service and contact information</legend>
      {CONTACT.map(([key, label]) => key === "address"
        ? <label key={key} className={cn(LABEL, "@min-[34rem]/front:col-span-2")}>{label}
          <textarea rows={3} value={cover.contact?.address ?? ""} className={AREA}
            onChange={(event) => onCover({ ...cover, contact: { ...EMPTY_CONTACT, ...cover.contact, address: event.target.value } })} /></label>
        : <label key={key} className={LABEL}>{label}
          <Input value={cover.contact?.[key] ?? ""} type={key === "email" ? "email" : "text"} className={FIELD}
            onChange={(event) => onCover({ ...cover, contact: { ...EMPTY_CONTACT, ...cover.contact, [key]: event.target.value } })} /></label>)}
    </fieldset>}
  </fieldset>;
}

/** What the index gives, how it groups and orders the authorities, and how each tab opens. */
export function IndexFields({ settings, profileId, disabled, headless, onChange }: {
  settings: Settings; profileId: AuthoritiesProfileId; disabled?: boolean; headless?: boolean;
  onChange: (patch: Partial<Settings>) => void;
}) {
  const profile = authoritiesProfile(profileId), federal = !!profile.requirements?.federalFormatting;
  const electronic = settings.filingMedium === "electronic";
  const tabPages = settings.tabPages ?? !federal;
  const rightHand = !electronic && (settings.rightHandStarts ?? settings.filingMedium === "paper");
  return <fieldset className="grid min-w-0 gap-4" disabled={disabled}>
    <legend className={headless ? "sr-only" : SECTION}>Index</legend>
    <OptionCards legend="Beside each authority" value={settings.indexShows ?? (federal ? "tabs-and-pages" : "tabs")}
      columns disabled={disabled} options={[{ value: "tabs", label: "Its tab", detail: "The index lists the tab of each authority." },
        { value: "tabs-and-pages", label: "Its tab and pages", detail: "The index lists the tab of each authority and the book pages it fills." }]}
      onChange={(indexShows) => onChange({ indexShows })} />
    <div className="grid gap-3 @min-[34rem]/front:grid-cols-2">
      <Choice label="Group" value={settings.grouping ?? (settings.tableOrder === "first-reference" ? "none" : "cases-first")}
        options={GROUPINGS} disabled={disabled || !!profile.locked?.settings?.grouping} onChange={(grouping) => onChange({ grouping })} />
      <Choice label="Order" value={settings.tableOrder} disabled={disabled || !!profile.locked?.settings?.tableOrder}
        options={settings.tableOrder === "custom" ? ORDERS : ORDERS.filter(({ value }) => value !== "custom")}
        onChange={(tableOrder) => onChange({ tableOrder })} />
    </div>
    <div className="grid gap-2">
      <OptionCard type="checkbox" checked={tabPages} onChange={() => onChange({ tabPages: !tabPages })}
        label="A TAB page before each authority" detail="Adds a page reading TAB and its number before each authority. The index links and bookmarks go to it." />
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
      placeholder={placeholder} className="mt-1.5" options={options} onChange={(next) => next && onChange(next as T)} />
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

/** The book's cover and the first page of its index, drawn by the book's own renderer from the draft
 *  with the changes not yet made to it, a moment after the last of them. */
export function FrontPreview({ host, draft, actions, className }: {
  host: AuthoritiesHost; draft?: AuthoritiesProduct; actions: AuthoritiesAction[]; className?: string;
}) {
  const key = draft ? JSON.stringify([draft.id, draft.revision, actions]) : "";
  const [shown, setShown] = useState<{ bytes?: Uint8Array; error?: string }>();
  useEffect(() => {
    if (!draft || !host.bookFront) return;
    const abort = new AbortController();
    const timer = setTimeout(() => void host.bookFront!(draft, actions, abort.signal)
      .then((blob) => blob.arrayBuffer()).then((buffer) => setShown({ bytes: new Uint8Array(buffer) }))
      .catch((error) => { if (!abort.signal.aborted) setShown((current) => ({ ...current,
        error: errorMessage(error, "The preview could not be drawn.") })); }), 300);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return <Preview className={className} label="Preview of the cover and index">
    <PdfCanvas bytes={shown?.bytes} loading={!shown?.bytes && !shown?.error} error={shown?.bytes ? undefined : shown?.error}
      ariaLabel="Cover and index preview" />
  </Preview>;
}

/** The preview pane beside the options: a framed, full-height area. */
export function Preview({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return <section aria-label={label} className={cn("flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-gray-300 bg-gray-100", className)}>
    {children}
  </section>;
}

/** The cover at Build: its details as at import, kept here as they are typed and saved when the cover
 *  is left or closed, with the book's front drawn beside them as typed. `file` is the cover's PDF line. */
export function CoverEditor({ host, draft, busy, file, onActions }: { host: AuthoritiesHost; draft: AuthoritiesProduct;
  busy: boolean; file: ReactNode; onActions: (actions: AuthoritiesAction[]) => void }) {
  const { profileId } = draft.state.settings;
  const [cover, setCover] = useState(draft.state.cover);
  useFilingContact(host, draft.state.cover, profileId, setCover);
  const latest = useRef({ cover, state: draft.state, onActions });
  latest.current = { cover, state: draft.state, onActions };
  const save = () => {
    const { cover, state, onActions } = latest.current, actions = frontActions(state, cover, {});
    if (!actions.length) return;
    onActions(actions);
    if (coverForm(state.settings.profileId) === "alberta" && cover.contact)
      void host.filingContact?.save(savedCover(cover).contact!).catch(() => undefined);
  };
  useEffect(() => save, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <FrontColumns preview={<FrontPreview host={host} draft={draft} actions={frontActions(draft.state, cover, {})} />}>
    {file}
    <div onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) save(); }}>
      <CoverFields cover={cover} profileId={profileId} settings={draft.state.settings} disabled={busy} headless
        onCover={setCover} onSettings={(patch) => onActions(frontActions(draft.state, cover, patch))} />
    </div>
  </FrontColumns>;
}

/** The index at Build: its choices as at import, each made as it is chosen, with the book's front beside. */
export function IndexEditor({ host, draft, busy, file, onActions }: { host: AuthoritiesHost; draft: AuthoritiesProduct;
  busy: boolean; file: ReactNode; onActions: (actions: AuthoritiesAction[]) => void }) {
  return <FrontColumns preview={<FrontPreview host={host} draft={draft} actions={[]} />}>
    {file}
    <IndexFields settings={draft.state.settings} profileId={draft.state.settings.profileId} disabled={busy} headless
      onChange={(patch) => onActions(frontActions(draft.state, draft.state.cover, patch))} />
  </FrontColumns>;
}

/** Options on the left at their own height, the preview on the right, kept in view as they scroll. */
function FrontColumns({ preview, children }: { preview: ReactNode; children: ReactNode }) {
  return <div className="grid gap-5 lg:grid-cols-2">
    <div className="@container/front grid min-w-0 content-start gap-5">{children}</div>
    <div className="h-[30rem] min-w-0 lg:sticky lg:top-4 lg:self-start [&>section]:h-full">{preview}</div>
  </div>;
}

/** Options on the left, each in its own scroll, and the preview on the right; one above the other
 *  where the window is narrow. */
export function FrontLayout({ preview, children }: { preview: ReactNode; children: ReactNode }) {
  return <div className="grid min-h-0 flex-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
    <div className="@container/front grid min-w-0 content-start gap-6 pr-1 lg:min-h-0 lg:overflow-y-auto">{children}</div>
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

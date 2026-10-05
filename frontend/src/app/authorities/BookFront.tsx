import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { FolderSearch, Plus, Scale, Upload, X } from "lucide-react";
import { Modal } from "@/app/components/modals/Modal";
import { ModalSelect } from "@/app/components/modals/ModalSelect";
import { ChoiceModalButton } from "@/app/components/modals/ChoiceModalButton";
import { CourtChoiceModal } from "@/app/components/modals/CourtChoiceModal";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { cn, errorMessage } from "@/app/lib/utils";
import { getPdfJs, openPdfDocument, PDF_DOCUMENT_OPTIONS } from "@/app/lib/pdfJs";
import { FileCard, OptionCard, OptionCards } from "./OptionCards";
import { FileInputButton } from "./FileInputButton";
import { AUTHORITIES_PROFILES, authoritiesProfile } from "./profiles";
import type { AuthoritiesFile, AuthoritiesHost } from "./host";
import { canonicalJson } from "../../../../shared/canonical-json.mjs";
import type { AuthoritiesAction, AuthoritiesCover, AuthoritiesDraft, AuthoritiesProduct, AuthoritiesProfileId } from "./types";
import previewState from "./previewBook.json";
import { courtChange, courtState } from "./courtChange";

export type Settings = AuthoritiesProduct["state"]["settings"];
/** The settings the cover and the index are drawn from. */
export const FRONT_KEYS = ["filingMedium", "bookRole", "indexShows", "bookmarks", "tabPages", "rightHandStarts", "grouping",
  "tableOrder"] as const;
/** The settings the cover and the index are drawn from: the bookmarks change neither. */
export const PREVIEW_KEYS = FRONT_KEYS.filter((key) => key !== "bookmarks");
export const LEGEND = "mb-2 text-sm font-semibold text-gray-950";
const FIELD = "mt-1 h-9 border-gray-300 text-sm md:text-sm";
const AREA = "mt-1 min-h-14 w-full resize-y rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-950 outline-none focus-visible:ring-2 focus-visible:ring-accent-600";
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
  return <div className={className}>
    <ChoiceModalButton icon={<Scale aria-hidden="true" className="h-4 w-4 shrink-0 text-gray-500" />}
      label="Court" value={current.label} disabled={disabled} className="w-full"
      onClick={() => setOpen(true)} />
    <CourtPicker open={open} value={value} preferredKeys={preferredKeys} bookOnly={bookOnly}
      onChange={onChange} onClose={() => setOpen(false)} />
  </div>;
}

/** The court chooser itself: jurisdictions, then their courts, in one dialog. */
export function CourtPicker({ open, value, preferredKeys, bookOnly = false, onChange, onClose }: {
  open: boolean; value: AuthoritiesProfileId; preferredKeys: string[]; bookOnly?: boolean;
  onChange: (value: AuthoritiesProfileId) => void; onClose: () => void;
}) {
  const available = AUTHORITIES_PROFILES.filter((item) => !bookOnly || item.locked?.outputMode !== "table");
  return <CourtChoiceModal open={open} title="Choose court" searchLabel="Search courts"
    value={value} preferredKeys={preferredKeys}
    options={available.map(({ id, label, court, jurisdiction }) => ({ value: id, label,
      jurisdictionId: jurisdiction.id, keywords: court.abbreviation }))}
    onChange={(id) => onChange(id as AuthoritiesProfileId)} onClose={onClose} />;
}
/** The changes a new court makes to a draft, as Build's Book dialog saves them. */
export function courtActions(state: AuthoritiesProduct["state"], profileId: AuthoritiesProfileId): AuthoritiesAction[] {
  if (profileId === state.settings.profileId) return [];
  const court = courtState(state, profileId);
  return [{ type: "set-profile", profileId }, ...frontActions(court, court.cover, {})];
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
  const longCourt = !!court && authoritiesProfile(profileId).label.length > 22;
  // Two to a line: the court beside its file number, a short field beside another; only the title of a
  // Federal cover and the parties take the width.
  return <fieldset className="grid min-w-0 gap-4" disabled={disabled}>
    <legend className="sr-only">Cover</legend>
    <div className="grid grid-cols-2 gap-x-3 gap-y-3">
      {/* A court whose name would not fit half the width takes the whole line, so it is never cut. */}
      {court && <div className={cn("min-w-0", longCourt && "col-span-2")}>{court}</div>}
      {form === "plain" ? title(longCourt ? "col-span-2" : undefined)
        : text("Court file number", cover.courtFileNumber, (courtFileNumber) => onCover({ ...cover, courtFileNumber }))}
      {form === "alberta" && text("Judicial centre", cover.judicialCentre ?? "", (judicialCentre) => onCover({ ...cover, judicialCentre }))}
      {form === "alberta" && title("col-span-2")}
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
        {/* As tall as its parties, a long name's wrapped lines included, so no line is cut off. */}
        <textarea aria-label={`Parties for ${role || `role ${index + 1}`}`} rows={1} value={parties.join("\n")}
          disabled={disabled} onChange={(event) => group(index, { parties: event.target.value.split(/\r?\n/u) })}
          className="min-h-8 w-full resize-none overflow-hidden rounded-md border border-gray-300 bg-white px-2.5 py-1 text-sm leading-5 text-gray-950 outline-none [field-sizing:content] focus-visible:ring-2 focus-visible:ring-accent-600" />
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
export function IndexFields({ settings, disabled, onChange, own = false }: {
  settings: Settings; disabled?: boolean; onChange: (patch: Partial<Settings>) => void;
  /** The index is the user's own PDF: only how each tab opens is asked. */
  own?: boolean;
}) {
  const tabPages = settings.tabPages ?? true;
  const rightHand = settings.rightHandStarts ?? true;
  return <fieldset className="grid min-w-0 gap-3" disabled={disabled}>
    <legend className="sr-only">Index</legend>
    {!own && <OptionCards legend="Beside each authority" value={settings.indexShows ?? "tabs"}
      columns disabled={disabled} options={[{ value: "tabs", label: "Its tab", detail: "The index gives each authority's tab." },
        { value: "tabs-and-pages", label: "Its tab and pages", detail: "The index also gives the book pages each authority fills." }]}
      onChange={(indexShows) => onChange({ indexShows })} />}
    <OptionCards legend="Bookmarks under each tab" value={settings.bookmarks ?? "highlights"} columns disabled={disabled}
      options={[{ value: "highlights", label: "Highlighted passages", detail: "Each tab's bookmarks go to the passages highlighted in it." },
        { value: "headings", label: "The source's own headings", detail: "Each tab's bookmarks follow the headings of the source itself." }]}
      onChange={(bookmarks) => onChange({ bookmarks })} />
    <div className="grid gap-2">
      <OptionCard type="checkbox" checked={tabPages} onChange={() => onChange({ tabPages: !tabPages })}
        label="A TAB page before each authority" detail="Where the index's link and the bookmark for each authority land." />
      <OptionCard type="checkbox" checked={rightHand} onChange={() => onChange({ rightHandStarts: !rightHand })}
        label="Start each on a right-hand page" detail="For a book printed on both sides: a blank page is added where one is needed." />
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

/** The front drawings the runtime made, by what they were drawn from, so a step opened again has its
 *  drawing at once. */
const fronts = new Map<string, Uint8Array>();
/** Drawings asked for and not back yet, by what they are drawn from: a second ask waits for the first. */
const drawing = new Map<string, Promise<Uint8Array>>();
const frontKey = (draft: AuthoritiesProduct, actions: AuthoritiesAction[]) => JSON.stringify([draft.id, draft.revision, actions]);
function drawFront(host: AuthoritiesHost, draft: AuthoritiesProduct, actions: AuthoritiesAction[], signal?: AbortSignal) {
  const key = frontKey(draft, actions), kept = fronts.get(key);
  if (kept) return Promise.resolve(kept);
  let asked = drawing.get(key);
  if (!asked) {
    asked = host.bookFront!(draft, actions, signal).then((blob) => blob.arrayBuffer()).then((buffer) => {
      const bytes = new Uint8Array(buffer);
      fronts.delete(key); fronts.set(key, bytes);
      for (const old of [...fronts.keys()].slice(0, -8)) fronts.delete(old);
      return bytes;
    }).finally(() => drawing.delete(key));
    drawing.set(key, asked);
  }
  return asked;
}
/** Draws a draft's cover and index as its Book dialog first shows them, while the page is idle, so that
 *  dialog opens with them drawn. */
export function prefetchFront(host: AuthoritiesHost, draft: AuthoritiesProduct) {
  if (!host.bookFront || draft.state.import.kind === "manual" && !draft.state.authorityOrder.length) return () => {};
  const actions = previewActions(draft.state, draft.state.settings.profileId, draft.state.settings, draft.state.cover, PREVIEW_KEYS);
  if (fronts.has(frontKey(draft, actions))) return () => {};
  const idle = window.requestIdleCallback(() => void drawFront(host, draft, actions).catch(() => undefined), { timeout: 2000 });
  return () => window.cancelIdleCallback(idle);
}
let warmed = false;
/** Draws the preview book's front once while the page is idle, so the runtime that draws previews is
 *  ready before the first one is wanted. */
export function warmFrontPreviews(host: AuthoritiesHost) {
  if (warmed || host.mode !== "standalone" || !host.bookFront) return;
  warmed = true;
  const draw = () => void host.bookFront!(PREVIEW_BOOK, []).catch(() => undefined);
  if ("requestIdleCallback" in window) window.requestIdleCallback(draw, { timeout: 3000 }); else setTimeout(draw, 1000);
}
/** The book's cover, or the whole of its index, drawn by the book's own renderer from the draft with the
 *  changes not yet made to it. A drawing is asked for as soon as a change is made, one at a time; a
 *  change made meanwhile is asked for once the drawing is back, so a draft that keeps changing (its
 *  sources arriving, a field typed in) never holds the preview back. */
export function FrontPreview({ host, draft, actions, part, label, className }: {
  host: AuthoritiesHost; draft?: AuthoritiesProduct; actions: AuthoritiesAction[]; part: FrontSlot; label: string; className?: string;
}) {
  const key = draft ? frontKey(draft, actions) : "";
  const [shown, setShown] = useState<{ bytes?: Uint8Array; error?: string }>(() => ({ bytes: fronts.get(key) }));
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
    const kept = fronts.get(key);
    if (kept) { state.drawn = key; setShown({ bytes: kept }); return; }
    state.timer = window.setTimeout(() => {
      const asked = latest.current;
      state.timer = undefined; state.running = true;
      void drawFront(host, asked.draft!, asked.actions, state.stop.signal).then((bytes) => setShown({ bytes }))
        .catch((error) => { if (!state.stop.signal.aborted) setShown((current) => ({ ...current,
          error: errorMessage(error, "The preview could not be drawn.") })); })
        .finally(() => { state.running = false; state.drawn = asked.key;
          if (!state.stop.signal.aborted && latest.current.key !== asked.key) setAgain((value) => value + 1); });
    }, 0);
  }, [key, again]); // eslint-disable-line react-hooks/exhaustive-deps
  return <Preview className={className} label={`Preview: ${label}`}>
    {shown?.error && !shown.bytes ? <p role="alert" className="m-auto p-6 text-center text-sm text-red-800">{shown.error}</p>
      : <PagesPreview bytes={shown?.bytes} pages={part === "cover" ? "first" : "after-first"} label={label} keep={`front:${draft?.id}:${part}`} />}
  </Preview>;
}

// Each page kept as the bitmap it was drawn into: shown as it is, never encoded as an image file.
type DrawnPage = { bitmap: ImageBitmap; width: number; height: number };
const sameBytes = (a: Uint8Array, b: Uint8Array) => a === b || a.length === b.length && a.every((byte, index) => byte === b[index]);
/** The pages each pane drew last, with what they were drawn from, so a pane opened again shows them at
 *  once and draws again only what changed. */
const drawings = new Map<string, { bytes: Uint8Array; width: number; pages: DrawnPage[] }>();
/** A PDF's pages as wide as the pane, crisp at the screen's own resolution, one under another in a box
 *  that scrolls inside itself. The last drawing stays until each new page is ready, page by page, so
 *  nothing blinks and nothing outside the box moves. */
export function PagesPreview({ bytes, pages, label, keep }: {
  bytes?: Uint8Array; pages: "first" | "after-first" | "all"; label: string;
  /** What the pane shows, so its last drawing is found again. */
  keep: string;
}) {
  const sheet = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [drawn, setDrawn] = useState(() => drawings.get(keep)?.pages);
  useEffect(() => {
    const element = sheet.current;
    if (!element) return;
    // Drawn again only for a change of a tenth of the width or more.
    const measure = () => setWidth((current) => Math.abs(element.clientWidth - current) > element.clientWidth / 10
      ? element.clientWidth : current);
    measure();
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const kept = drawings.get(keep);
    // The same PDF drawn again (a pane opened anew, a front unchanged) keeps its pages as drawn.
    if (!bytes || !width || kept && kept.width === width && sameBytes(kept.bytes, bytes)) {
      if (kept && bytes && kept.bytes !== bytes) kept.bytes = bytes;
      return;
    }
    let active = true;
    void (async () => {
      const task = openPdfDocument(await getPdfJs(), { data: bytes.slice() }, PDF_DOCUMENT_OPTIONS);
      const made: DrawnPage[] = [];
      try {
        const document = await task.promise;
        const numbers = [...Array(document.numPages).keys()].map((index) => index + 1)
          .filter((number) => pages === "all" || (pages === "first" ? number === 1 : number > 1 || document.numPages === 1));
        for (const number of numbers) {
          const page = await document.getPage(number), base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: width * window.devicePixelRatio / base.width });
          const canvas = window.document.createElement("canvas");
          canvas.width = Math.round(viewport.width); canvas.height = Math.round(viewport.height);
          await page.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport }).promise;
          const bitmap = await createImageBitmap(canvas);
          if (!active) return;
          made.push({ bitmap, width: base.width, height: base.height });
          // Each page takes its place as it is ready; the rest of the last drawing stays until then.
          setDrawn((current) => [...made, ...(current ?? []).slice(made.length)]);
        }
        const old = drawings.get(keep);
        drawings.set(keep, { bytes, width, pages: made });
        setDrawn(made);
        if (old) setTimeout(() => old.pages.forEach(({ bitmap }) => { if (!made.some((page) => page.bitmap === bitmap)) bitmap.close(); }), 1000);
      } finally { await task.destroy(); }
    })().catch(() => {});
    return () => { active = false; };
  }, [bytes, pages, width, keep]);
  return <div className="min-h-0 flex-1 overflow-y-auto p-3">
    <div ref={sheet} className="grid gap-3">
      {drawn?.length ? drawn.map((page, index) => <DrawnPageView key={index} page={page}
        label={drawn.length > 1 ? `${label}, page ${index + 1}` : label} />)
        : <div aria-hidden="true" className="aspect-[8.5/11] w-full animate-pulse bg-white/70" />}
    </div>
  </div>;
}

/** A drawn page, its bitmap copied onto a canvas of its own (a bitmap is drawn by the GPU, not decoded). */
function DrawnPageView({ page, label }: { page: DrawnPage; label: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const element = canvas.current;
    if (!element) return;
    element.width = page.bitmap.width; element.height = page.bitmap.height;
    element.getContext("2d")?.drawImage(page.bitmap, 0, 0);
  }, [page.bitmap]);
  return <canvas ref={canvas} role="img" aria-label={label} style={{ aspectRatio: `${page.width} / ${page.height}` }}
    className="block h-auto w-full bg-white shadow-[0_1px_3px_rgb(0_0_0/.15)]" />;
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
        className="-mb-px h-full w-full truncate border-b-2 border-transparent px-2 font-medium text-gray-500 outline-none hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-600 aria-[current=step]:border-accent-700 aria-[current=step]:text-gray-950">
        {label}</button></li>)}
  </ol>;
}

export const FRONT_STEPS = ["Cover", "Index"] as const;
const FRONT_SLOTS = ["cover", "index"] as const;
/** The court, the cover and the index at Build: the import's own Cover and Index steps, the book's front
 *  beside them, saved together. The footer says what a new court changes. */
export function BookFrontModal({ host, draft, busy, step: first, jurisdictionOrder, pdfs, onClose, onActions, onOwn }: {
  host: AuthoritiesHost; draft: AuthoritiesProduct; busy: boolean; step: typeof FRONT_STEPS[number];
  jurisdictionOrder: string[]; pdfs: OwnPdfs; onClose: () => void; onActions: (actions: AuthoritiesAction[]) => void;
  /** Adds a PDF chosen here as the cover or the index, once the other changes are saved. */
  onOwn: (slot: FrontSlot, chosen: AuthoritiesFile) => void;
}) {
  const before = draft.state, manual = before.import.kind === "manual";
  const [at, setAt] = useState<number>(FRONT_STEPS.indexOf(first));
  const [profileId, setProfileId] = useState(before.settings.profileId);
  const [edited, setEdited] = useState<AuthoritiesCover>();
  const [settings, setSettings] = useState<Partial<Settings>>({});
  // Each page as the draft has it, generated or the user's own, until chosen otherwise here.
  const [own, setOwn] = useState<Record<FrontSlot, OwnFront>>(() =>
    ({ cover: { own: !!before.bookParts.cover }, index: { own: !!before.bookParts.index } }));
  // The draft as the court chosen here leaves it, then the cover and settings changed here.
  const court = courtState(before, profileId);
  const cover = edited ?? court.cover;
  useFilingContact(host, cover, profileId, (change) => setEdited((current) => change(current ?? courtState(before, profileId).cover)));
  const shown = { ...court.settings, ...settings };
  const chosen = FRONT_SLOTS.flatMap((slot) => own[slot].own && own[slot].chosen ? [[slot, own[slot].chosen!] as const] : []);
  const actions: AuthoritiesAction[] = [...profileId === before.settings.profileId ? [] : [{ type: "set-profile", profileId } as const],
    ...frontActions(court, cover, settings),
    // A page set back to Generated lets its own PDF go.
    ...FRONT_SLOTS.flatMap((slot) => !own[slot].own && before.bookParts[slot] ? [{ type: "clear-book-part", slot } as const] : [])];
  // At Build the draft's authorities are known, so its own index is drawn, every page of it.
  const front = draft;
  const preview = previewActions(front.state, profileId, shown, cover, PREVIEW_KEYS);
  const save = () => {
    onActions(actions); chosen.forEach(([slot, file]) => onOwn(slot, file)); onClose();
    if (coverForm(profileId) === "alberta" && cover.contact) void host.filingContact?.save(savedCover(cover).contact!)
      .catch(() => undefined);
  };
  const step = FRONT_STEPS[at];
  const courtField = <AuthoritiesCourtField value={profileId} preferredKeys={jurisdictionOrder} disabled={busy} bookOnly={manual}
    onChange={(next) => { setProfileId(next); setSettings({}); }} />;
  return <Modal open onClose={onClose} breadcrumbs={["Book"]} size="2xl"
    className="h-[min(54rem,calc(100dvh-2rem))] max-w-6xl" bodyClassName="pb-4 lg:overflow-hidden"
    footerStatus={<p role="status" className="mr-auto min-w-0 flex-1 text-sm text-gray-700">
      {profileId === before.settings.profileId ? "" : courtChange(before, court)}</p>}
    secondaryAction={{ label: "Cancel", onClick: onClose }}
    primaryAction={{ label: "Save", disabled: busy || !actions.length && !chosen.length, onClick: save }}>
    <StepTabs steps={FRONT_STEPS} at={at} disabled={busy} onStep={setAt} />
    {step === "Cover" ? <FrontLayout preview={<FrontSourcePreview slot="cover" value={own.cover} pdfs={pdfs}
      generated={<FrontPreview host={host} draft={front} actions={preview} part="cover" label="Cover" />} />}>
      <FrontSource slot="cover" value={own.cover} pdfs={pdfs} disabled={busy} onChange={(cover) => setOwn((current) => ({ ...current, cover }))}
        own={<div className="grid grid-cols-2 gap-3"><div className="min-w-0">{courtField}</div></div>}>
        <CoverFields cover={cover} profileId={profileId} settings={shown} disabled={busy} onCover={setEdited} court={courtField}
          onSettings={(patch) => setSettings((current) => ({ ...current, ...patch }))} />
      </FrontSource>
    </FrontLayout>
    : <FrontLayout preview={<FrontSourcePreview slot="index" value={own.index} pdfs={pdfs}
      generated={<FrontPreview host={host} draft={front} actions={preview} part="index" label="Index" />} />}>
      <FrontSource slot="index" value={own.index} pdfs={pdfs} disabled={busy} onChange={(index) => setOwn((current) => ({ ...current, index }))}
        own={<IndexFields own settings={shown} disabled={busy}
          onChange={(patch) => setSettings((current) => ({ ...current, ...patch }))} />}>
        <IndexFields settings={shown} disabled={busy}
          onChange={(patch) => setSettings((current) => ({ ...current, ...patch }))} />
      </FrontSource>
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

export type FrontSlot = "cover" | "index";
/** Whether a step's page is the user's own PDF, and the PDF chosen here that the draft takes on saving. */
export type OwnFront = { own: boolean; chosen?: AuthoritiesFile };
/** How a step reaches the user's own PDFs: the picker, the Library, and the PDF the draft keeps. */
export type OwnPdfs = {
  /** Whether a PDF of the user's own can be added here at all; without it, the step is the generated page alone. */
  attach: boolean;
  /** Asks for one PDF; without it, a file input does. */
  choose?: () => Promise<AuthoritiesFile | undefined>;
  library?: { label: string; open: (slot: FrontSlot) => void };
  kept?: (slot: FrontSlot) => KeptPdf | undefined;
  /** The kept PDF's bytes, for the preview. */
  read?: (role: string) => Promise<Blob>;
  relink?: (role: string) => void;
};
export type KeptPdf = { filename: string; role: string; issue?: "denied" | "unavailable" };
const NAME: Record<FrontSlot, string> = { cover: "cover", index: "index" };

/** A step's first choice: the page made here, or a PDF of the user's own in its place. The own PDF's
 *  card holds what the step's menu used to: its upload, the Library, and access to it again. */
export function FrontSource({ slot, value, pdfs, disabled, onChange, children, own }: {
  slot: FrontSlot; value: OwnFront; pdfs: OwnPdfs; disabled?: boolean; onChange: (value: OwnFront) => void;
  /** The step's fields for a generated page. */
  children: ReactNode;
  /** What the step still asks with a PDF of the user's own. */
  own?: ReactNode;
}) {
  const kept = pdfs.kept?.(slot), name = NAME[slot];
  const choose = async () => { const chosen = await pdfs.choose?.(); if (chosen) onChange({ own: true, chosen }); };
  if (!pdfs.attach && !kept) return children;
  const label = value.chosen ? "Replace" : kept ? "Replace" : "Upload";
  const control = "h-8 shrink-0 gap-1.5 border-gray-300 px-2.5 text-[0.8125rem] font-medium text-gray-800 [&_svg]:size-3.5";
  const detail = value.chosen ? "Added to the book when you save."
    : kept?.issue === "denied" ? "File access was denied. Allow access to use it."
    : kept?.issue === "unavailable" ? "This PDF is unavailable. Upload it again."
    : kept ? `The book's ${name} now.` : `Upload the ${name} as a PDF.`;
  return <>
    <OptionCards legend={slot === "cover" ? "Cover" : "Index"} columns value={value.own ? "own" : "generated"} disabled={disabled}
      options={[{ value: "generated", label: "Generated", detail: slot === "cover" ? "Made from the details below." : "Made from the choices below." },
        { value: "own", label: "Your own PDF", detail: `Use ${slot === "cover" ? "a cover" : "an index"} you made yourself.` }]}
      onChange={(choice) => onChange({ ...value, own: choice === "own" })} />
    {value.own ? <>
      <FileCard disabled={disabled}
        label={value.chosen?.file.name ?? kept?.filename ?? "Not added yet"} detail={detail}
        action={<span className="flex items-center gap-1.5">
          {kept?.issue === "denied" && !value.chosen && pdfs.relink && <Button type="button" variant="outline" className={control}
            disabled={disabled} onClick={() => pdfs.relink!(kept.role)}>Allow file access</Button>}
          {pdfs.choose ? <Button type="button" variant="outline" className={control} disabled={disabled}
            aria-label={`${label} the ${name} PDF`} onClick={() => void choose()}><Upload />{label}</Button>
            : <FileInputButton multiple={false} disabled={!!disabled} label={label} ariaLabel={`${label} the ${name} PDF`}
              accept=".pdf,application/pdf" variant="outline" compact icon={<Upload />} className={control}
              onFiles={([file]) => file && onChange({ own: true, chosen: { file } })} />}
          {pdfs.library && <Button type="button" variant="outline" className={control} disabled={disabled}
            onClick={() => pdfs.library!.open(slot)}><FolderSearch />{pdfs.library.label}</Button>}
        </span>} />
      {own}
    </> : children}
  </>;
}

/** The preview beside a step: the page made here, or the first page of the user's own PDF. */
export function FrontSourcePreview({ slot, value, pdfs, generated }: {
  slot: FrontSlot; value: OwnFront; pdfs: OwnPdfs; generated: ReactNode;
}) {
  const kept = pdfs.kept?.(slot), source = value.chosen?.file ?? (kept && !kept.issue ? kept.role : undefined);
  const [bytes, setBytes] = useState<{ source: File | string; bytes: Uint8Array }>();
  useEffect(() => {
    if (!value.own || !source || bytes?.source === source) return;
    let active = true;
    void (typeof source === "string" ? pdfs.read?.(source) : Promise.resolve(source))?.then((blob) => blob.arrayBuffer())
      .then((buffer) => { if (active) setBytes({ source, bytes: new Uint8Array(buffer) }); }).catch(() => undefined);
    return () => { active = false; };
  }, [value.own, source]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!value.own) return generated;
  const label = `Your ${NAME[slot]}`;
  return <Preview label={`Preview: ${label}`}>
    {source ? <PagesPreview bytes={bytes?.source === source ? bytes.bytes : undefined} pages={slot === "cover" ? "first" : "all"}
      label={label} keep={`own:${slot}`} />
      : <p className="m-auto p-6 text-center text-sm text-gray-600">Your PDF shows here.</p>}
  </Preview>;
}

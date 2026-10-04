import { courtCover } from "../../../../shared/authorities-cover.mjs";
import { authoritiesProfile } from "./profiles";
import type { AuthoritiesProduct } from "./types";

type State = AuthoritiesProduct["state"];
type Settings = State["settings"];
const ON_OFF = (value: unknown) => value ? "on" : "off";
/** Each setting a court can set, in plain words: its name and how a value reads. */
const WORDS: Partial<Record<keyof Settings, [string, (value: never) => string]>> = {
  sourceMode: ["Source handling", (value: Settings["sourceMode"]) => ({ automatic: "automatic sources",
    "manual-originals": "originals, the rest added by you", render: "rebuilt from text" })[value]],
  passageMarking: ["Passage marking", (value: Settings["passageMarking"]) => ({ margin: "red line and quote highlight",
    sidelined: "black line", paragraph: "paragraph highlight", text: "quote highlight", none: "none" })[value]],
  scannedPdfPolicy: ["Scanned PDFs", (value: Settings["scannedPdfPolicy"]) => ({ "page-margin": "kept as images",
    "cited-pages": "cited pages recognized", full: "every page recognized" })[value]],
  indexShows: ["Index", (value: Settings["indexShows"]) => value === "tabs-and-pages" ? "tabs and pages" : "tabs"],
  tabPages: ["TAB pages", ON_OFF],
  rightHandStarts: ["Right-hand starts", ON_OFF],
  grouping: ["Group", (value: Settings["grouping"]) => ({ "cases-first": "cases first",
    "legislation-first": "legislation first", none: "none" })[value ?? "cases-first"]],
  tableOrder: ["Order", (value: Settings["tableOrder"]) => ({ alphabetical: "alphabetical",
    "first-reference": "first cited", custom: "as arranged" })[value]],
  missingSourcePolicy: ["Missing sources", (value: Settings["missingSourcePolicy"]) =>
    value === "omit" ? "left out of the book" : "keep their tabs"],
  tableDelivery: ["Table", (value: Settings["tableDelivery"]) => ({ "native-append": "Word's table",
    "linked-append": "linked table", "native-marks": "marked citations only" })[value]],
  tableLocation: ["Table locations", (value: Settings["tableLocation"]) => ({ pages: "pages",
    pinpoints: "pinpoints", combined: "pages and pinpoints" })[value]],
  filingMedium: ["Filing", (value: Settings["filingMedium"]) => value === "paper" ? "paper" : "electronic"],
  bookRole: ["Filed by", (value: Settings["bookRole"]) => value ? value.replaceAll("-", " ") : "not chosen"],
};

/** What choosing a court changes, said exactly: each setting it sets, and the outputs, from the
 *  draft before and after. */
export function courtChange(before: State, after: State) {
  const changes = (Object.keys(WORDS) as Array<keyof Settings>).flatMap((key) => {
    if (JSON.stringify(before.settings[key]) === JSON.stringify(after.settings[key])) return [];
    const [name, read] = WORDS[key]!;
    return [`${name}: ${read(after.settings[key] as never)}`];
  });
  if (before.outputMode !== after.outputMode) changes.unshift(`Outputs: ${({ book: "the book",
    table: "the table", both: "the book and the table" })[after.outputMode]}`);
  const roles = (state: State) => state.cover.partyGroups.map(({ role }) => role).join(", ");
  if (roles(before) !== roles(after)) changes.push(`Cover roles: ${roles(after) || "none"}`);
  if (before.insertIntoDocument !== after.insertIntoDocument)
    changes.push(`Filing PDF: ${after.insertIntoDocument ? "made" : "not made"}`);
  const court = authoritiesProfile(after.settings.profileId).label;
  return changes.length ? `Saving with ${court} also changes ${changes.join("; ")}.` : `${court} changes no other setting.`;
}

/** The draft as choosing a court leaves it, as the draft's own court change makes it: a setting still at
 *  the outgoing court's default takes the new court's, one the user chose stays unless the new court
 *  locks it or does not offer it; the outputs and the cover's party roles follow the court the same way. */
export function courtState(state: State, profileId: Settings["profileId"]): State {
  if (profileId === state.settings.profileId) return state;
  const profile = authoritiesProfile(profileId), previous = authoritiesProfile(state.settings.profileId);
  const defaults: Partial<Settings> = previous.defaults.settings;
  const offered = profile.options as Partial<Record<string, ReadonlyArray<{ value: unknown }>>> | undefined;
  const chosen = Object.entries(state.settings).filter(([key, value]) => key !== "profileId" &&
    !(Object.hasOwn(defaults, key) && JSON.stringify(defaults[key as keyof Settings]) === JSON.stringify(value)) &&
    (key !== "filingMedium" && key !== "bookRole" || !!offered?.[key]?.some((option) => option.value === value)));
  const settings = { profileId, ...profile.defaults.settings, ...Object.fromEntries(chosen),
    ...profile.locked?.settings } as Settings;
  if (profile.requirements?.markedPassages && settings.passageMarking === "none")
    settings.passageMarking = profile.defaults.settings.passageMarking;
  const outputMode = state.import.kind === "manual" ? "book" : profile.locked?.outputMode ??
    (state.outputMode === previous.defaults.outputMode ? profile.defaults.outputMode : state.outputMode);
  const insertIntoDocument = state.import.kind === "document" && state.import.fileType === "pdf" &&
    state.insertIntoDocument === !!previous.requirements?.documentOutputDefault
    ? !!profile.requirements?.documentOutputDefault : state.insertIntoDocument;
  return { ...state, settings, outputMode, insertIntoDocument, cover: courtCover(state.cover, previous.id, profileId) };
}

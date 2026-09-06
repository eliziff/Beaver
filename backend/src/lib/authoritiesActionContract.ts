import { decodeAnnotationSet } from "mike/shared/pdf-annotations.mjs";
import { reject } from "./applicationError";
import { AUTHORITIES_BOOK_ROLES, authoritiesProfileIds, type AuthorityOccurrence,
  type AuthoritiesBuildSettings, type AuthoritiesCover, type AuthoritiesDiscrepancyAction,
  type AuthoritiesProfileId } from "./authoritiesDomain";
import type { AuthoritiesInitialSettings, AuthoritiesUserAction } from
  "./authoritiesWorkspaceApplication";
import { isJsonRecord } from "./value";

const bad = (): never => reject(400, "Invalid Authorities request");
const object = (value: unknown) => isJsonRecord(value) ? value : bad();
function text(value: unknown, max = 500) {
  if (typeof value !== "string") return bad();
  const result = value.trim();
  return result && result.length <= max ? result : bad();
}
const nullableText = (value: unknown, max = 500) =>
  value === null ? null : text(value, max);
const plain = (value: unknown, max = 500) => {
  if (typeof value !== "string" || value.length > max ||
      /[\u0000-\u001f\u007f]/u.test(value)) return bad();
  return value.trim();
};
function integer(value: unknown, min = 0) {
  if (!Number.isSafeInteger(value) || Number(value) < min) return bad();
  return Number(value);
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  return typeof value === "string" && choices.includes(value as T) ? value as T : bad();
}
const authorityKinds = ["case", "legislation", "commentary", "other"] as const;
export const AUTHORITIES_SETTINGS_CHOICES = {
  sourceMode: ["automatic", "manual-originals", "render"], tabStyle: ["numeric", "alpha"],
  tableOrder: ["first-reference", "alphabetical"],
  tableDelivery: ["native-marks", "native-append", "linked-append"],
  tableLocation: ["pages", "pinpoints", "combined"],
  passageMarking: ["none", "margin", "paragraph", "text", "sidelined"],
  scannedPdfPolicy: ["page-margin", "cited-pages", "full"],
  missingSourcePolicy: ["placeholder", "omit"],
  filingMedium: ["electronic", "paper"],
  bookRole: AUTHORITIES_BOOK_ROLES,
} as const satisfies { [K in keyof AuthoritiesBuildSettings]: readonly AuthoritiesBuildSettings[K][] };

export function decodeAuthoritiesInitialSettings(value: unknown): AuthoritiesInitialSettings {
  return settings(value, true);
}
function settings(value: unknown, initial: true): AuthoritiesInitialSettings;
function settings(value: unknown, initial?: false): Partial<AuthoritiesBuildSettings>;
function settings(value: unknown, initial = false) {
  const item = object(value), allowed = new Set([
    ...Object.keys(AUTHORITIES_SETTINGS_CHOICES), ...(initial
      ? ["profileId", "outputMode", "insertIntoDocument"] : []),
  ]);
  if (Object.keys(item).some((key) => !allowed.has(key))) return bad();
  const result: Record<string, unknown> = {};
  for (const [key, values] of Object.entries(AUTHORITIES_SETTINGS_CHOICES)) if (item[key] !== undefined) {
    result[key] = choice(item[key], values);
  }
  if (initial && item.profileId !== undefined) result.profileId = choice(
    item.profileId, authoritiesProfileIds) as AuthoritiesProfileId;
  if (initial && item.outputMode !== undefined) result.outputMode = choice(
    item.outputMode, ["table", "book", "both"] as const);
  if (initial && item.insertIntoDocument !== undefined) result.insertIntoDocument =
    typeof item.insertIntoDocument === "boolean" ? item.insertIntoDocument : bad();
  if (!Object.keys(result).length) return bad();
  return result as AuthoritiesInitialSettings;
}

function reference(value: unknown): AuthorityOccurrence["reference"] {
  if (value === null) return null;
  const item = object(value);
  return { kind: choice(item.kind, ["supra", "ibid"] as const),
    targetAuthorityId: text(item.targetAuthorityId) };
}

function cover(value: unknown): AuthoritiesCover {
  const item = object(value), keys = ["courtFileNumber", "partyGroups", "applicationUnder", "title"];
  if (Object.keys(item).some((key) => !keys.includes(key)) ||
      !Array.isArray(item.partyGroups) || item.partyGroups.length > 50) return bad();
  return { courtFileNumber: plain(item.courtFileNumber, 100),
    applicationUnder: plain(item.applicationUnder, 2_000), title: plain(item.title),
    partyGroups: item.partyGroups.map((value) => {
      const group = object(value);
      if (Object.keys(group).some((key) => !["role", "parties"].includes(key)) ||
          !Array.isArray(group.parties) || group.parties.length > 50) return bad();
      return { role: plain(group.role, 100),
        parties: group.parties.map((party) => plain(party)) };
    }) };
}

export function decodeAuthoritiesUserAction(value: unknown): AuthoritiesUserAction {
  const item = object(value), type = text(item.type, 60);
  switch (type) {
    case "add-authority": {
      if (item.authority !== undefined) return bad();
      return { type, kind: choice(item.kind, authorityKinds),
      citation: text(item.citation, 2_000),
      ...(item.name === undefined ? {} : {
        name: item.name === null ? null : text(item.name, 2_000),
      }) };
    }
    case "remove-authority": return { type, authorityId: text(item.authorityId) };
    case "exclude-authority": return { type, authorityId: text(item.authorityId),
      excluded: typeof item.excluded === "boolean" ? item.excluded : bad() };
    case "set-annotations": {
      if (!Array.isArray(item.entries) || !item.entries.length || item.entries.length > 2_000) return bad();
      return { type, entries: item.entries.map(value => {
        const entry = object(value);
        try { return { authorityId: text(entry.authorityId), bindingRole: text(entry.bindingRole, 300),
          annotations: decodeAnnotationSet(entry.annotations) }; } catch { return bad(); }
      }) };
    }
    case "set-highlight-exclusion": {
      const locator = object(item.locator);
      return { type, authorityId: text(item.authorityId),
        locator: { kind: choice(locator.kind, ["paragraph", "section", "page"] as const),
          label: text(locator.label, 500) },
        excluded: typeof item.excluded === "boolean" ? item.excluded : bad() };
    }
    case "edit-authority": return { type, authorityId: text(item.authorityId),
      kind: choice(item.kind, authorityKinds), citation: text(item.citation, 2_000),
      name: nullableText(item.name, 2_000) };
    case "rename-authority": return { type, authorityId: text(item.authorityId),
      displayName: nullableText(item.displayName, 2_000) };
    case "split-occurrence": return { type, occurrenceId: text(item.occurrenceId),
      cursor: integer(item.cursor, 1) };
    case "merge-occurrence": return { type, occurrenceId: text(item.occurrenceId) };
    case "remove-occurrence": return { type, occurrenceId: text(item.occurrenceId) };
    case "set-authority-span":
    case "set-pinpoint-span": return { type, occurrenceId: text(item.occurrenceId),
      start: integer(item.start), end: integer(item.end, 1) };
    case "relink-occurrence": return { type, occurrenceId: text(item.occurrenceId),
      authorityId: item.authorityId === null ? null : text(item.authorityId) };
    case "set-reviewed": return { type, occurrenceId: text(item.occurrenceId),
      reviewed: typeof item.reviewed === "boolean" ? item.reviewed : bad() };
    case "set-reference": return { type, occurrenceId: text(item.occurrenceId),
      reference: reference(item.reference) };
    case "begin-canlii-handoff": {
      if (item.pageUrl !== undefined) return bad();
      return { type, authorityId: text(item.authorityId) };
    }
    case "clear-authority-source": return { type, authorityId: text(item.authorityId) };
    case "clear-book-part": return { type,
      slot: choice(item.slot, ["cover", "index"] as const) };
    case "remove-book-supplement": return { type, id: text(item.id) };
    case "set-cover": return { type, cover: cover(item.cover) };
    case "set-profile": return { type,
      profileId: choice(item.profileId, authoritiesProfileIds) };
    case "set-settings": return { type, settings: settings(item.settings) };
    case "set-output-mode": return { type,
      outputMode: choice(item.outputMode, ["table", "book", "both"] as const) };
    case "set-document-output": return { type,
      enabled: typeof item.enabled === "boolean" ? item.enabled : bad() };
    default: return bad();
  }
}

export function decodeAuthoritiesDiscrepancyAction(value: unknown): {
  id: string; action: AuthoritiesDiscrepancyAction; revision: number;
} {
  const item = object(value);
  if (Object.keys(item).sort().join(",") !== "action,id,revision") return bad();
  return { id: text(item.id, 64), action: choice(item.action,
    ["ignore", "pinpoint", "quote_exact", "quote_editorial"] as const),
  revision: integer(item.revision, 1) };
}


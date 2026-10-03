import type { AuthoritySourceDecision } from "./authorities-sources.mjs";

export type AuthorityTabStyle ="numeric" | "alpha" | "lower-alpha" | "roman" | "lower-roman";
export type AuthorityTabFormat = {
  tabStart?: number;
  tabPrefix?: string;
  /** Exact labels by slot; a blank entry uses the generated label. */
  tabLabels?: string[];
};

export type ProceduralAuthority = {
  id: string;
  kind: "case" | "legislation" | "commentary" | "other";
  citation: string;
  sortLabel: string;
  excluded: boolean;
  reproduced: boolean;
};

export function deriveAuthorityProcedure(input: AuthorityTabFormat & {
  authorities: ProceduralAuthority[];
  units: Array<{ id: string; ordinal: number; occurrenceIds: string[] }>;
  occurrences: Record<string, { authorityId: string | null }>;
  manual: boolean;
  purpose: "table" | "book";
  tableOrder: AuthorityOrder;
  grouping: AuthorityGrouping;
  tabStyle: AuthorityTabStyle;
}): Array<{ id: string; tab: string; group: string }>;

/** Within each group: alphabetical, as the brief first cites them, or as the user arranged them. */
export type AuthorityOrder = "first-reference" | "alphabetical" | "custom";
/** Groups by kind, cases or legislation first, or one list. */
export type AuthorityGrouping = "none" | "cases-first" | "legislation-first";
export function authorityGrouping(settings: { grouping?: AuthorityGrouping;
  tableOrder: AuthorityOrder }): AuthorityGrouping;

/** The stored draft state both the server and the browser plan a book from. */
export type BookDraftState = {
  authorityOrder: readonly string[];
  authorities: Readonly<Record<string, {
    kind: ProceduralAuthority["kind"];
    citation: string;
    displayName?: string | null;
    name?: string | null;
    excluded: boolean;
    source: AuthoritySourceDecision;
    sourceIdentity?: { externalUrl?: string | null } | null;
  }>>;
  units: ReadonlyArray<{ id: string; ordinal: number; occurrenceIds: string[] }>;
  occurrences: Readonly<Record<string, { authorityId: string | null }>>;
  import: { kind: "manual" } | { kind: "document"; fileType: "pdf" | "docx" };
  outputMode: "table" | "book" | "both";
  insertIntoDocument: boolean;
  settings: AuthorityTabFormat & {
    tableOrder: AuthorityOrder;
    grouping?: AuthorityGrouping;
    tabStyle: AuthorityTabStyle;
    allowIncomplete?: boolean;
    missingSourcePolicy: "placeholder" | "omit";
  };
};

export function authorityProcedureInput(
  state: BookDraftState,
  options: { purpose: "table" | "book" },
): Parameters<typeof deriveAuthorityProcedure>[0];

export function tabLabel(index: number, style?: AuthorityTabStyle, format?: AuthorityTabFormat): string;

export type TabReferenceSettings = Pick<AuthorityTabFormat, "tabPrefix"> & {
  citationSuffix?: "none" | "tab" | "custom";
  /** The words before the tab's number, trimmed. */
  citationSuffixLabel?: string;
};
export function tabReference(settings: TabReferenceSettings, tab: string): string | null;
export function currentTabReference<T extends object>(settings: T): T;

/** An authority as every output and the interface cite it: as the brief first cites it in full, led
 *  by its style of cause or title, then each other citation of it. `lead` is that lead's length, and
 *  `italic` the same for a case or an enactment, whose lead is italic. */
export function authorityCitation(
  draft: { units: ReadonlyArray<{ id: string; text: string; occurrenceIds: readonly string[] }>;
    occurrences: Record<string, { authorityId: string | null; unitId: string; kind: string;
      authoritySpan: { start: number; end: number; text: string }; coreSpan: { start: number; text: string } } | undefined> },
  authority: { id: string; kind: string; citation: string; name?: string | null; displayName?: string | null;
    sourceIdentity?: { citationForms?: string[] } | null },
): { text: string; italic: number; lead: number };

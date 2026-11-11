import type { AuthoritySourceDecision } from "./authorities-sources.mjs";

export type AuthorityTabStyle ="numeric" | "alpha" | "lower-alpha" | "roman" | "lower-roman";
export type AuthorityTabFormat = {
  tabStart?: number;
  tabPrefix?: string;
  /** Exact labels by slot; a blank entry uses the generated label. */
  tabLabels?: string[];
};

/** Within each group: alphabetical, as the brief first cites them, or as the user arranged them. */
export type AuthorityOrder = "first-reference" | "alphabetical" | "custom";
/** Groups by kind, cases or legislation first, or one list. */
export type AuthorityGrouping = "none" | "cases-first" | "legislation-first";

/** The stored draft state both the server and the browser plan a book from. */
export type BookDraftState = {
  authorityOrder: readonly string[];
  authorities: Readonly<Record<string, {
    id: string;
    kind: "case" | "legislation" | "commentary" | "other";
    citation: string;
    displayName?: string | null;
    name?: string | null;
    excluded: boolean;
    source: AuthoritySourceDecision;
    historyOf?: string;
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
    subsequentHistory?: "omit" | "include";
  };
};

export function authorityProcedure(draft: BookDraftState): Array<{ id: string; tab: string; group: string }>;

export function tabLabel(index: number, style?: AuthorityTabStyle, format?: AuthorityTabFormat): string;

export type TabReferenceSettings = Pick<AuthorityTabFormat, "tabPrefix"> & {
  citationSuffix?: "none" | "tab" | "custom";
  /** The words before the tab's number, trimmed. */
  citationSuffixLabel?: string;
};
export function tabReference(settings: TabReferenceSettings, tab: string): string | null;
export function tabNumber(settings: Pick<AuthorityTabFormat, "tabPrefix">, tab: string): string;

/** An authority as every output and the interface cite it: as the brief first cites it in full, led
 *  by its style of cause or title, then each other citation of it. `lead` is that lead's length, and
 *  `italic` the same for a case or an enactment, whose lead is italic. */
export function authorityCitation(
  draft: { units: ReadonlyArray<{ id: string; text: string; occurrenceIds: readonly string[] }>;
    occurrences: Record<string, { authorityId: string | null; unitId: string; kind: string;
      authoritySpan: { start: number; end: number; text: string }; coreSpan: { start: number; text: string } } | undefined> },
  authority: { id: string; kind: string; citation: string; name?: string | null; displayName?: string | null;
    sourceIdentity?: { citationForms?: string[] } | null },
): { text: string; italic: number; lead: number; cited: number };

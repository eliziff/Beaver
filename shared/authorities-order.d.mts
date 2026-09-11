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
  tableOrder: "first-reference" | "alphabetical";
  tabStyle: AuthorityTabStyle;
}): Array<{ id: string; tab: string; group: string }>;

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
    tableOrder: "first-reference" | "alphabetical";
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

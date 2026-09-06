export type AuthorityTabStyle = "numeric" | "alpha" | "lower-alpha" | "roman" | "lower-roman";
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

export function tabLabel(index: number, style?: AuthorityTabStyle, format?: AuthorityTabFormat): string;

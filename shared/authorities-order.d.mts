export type ProceduralAuthority = {
  id: string;
  kind: "case" | "legislation" | "commentary" | "other";
  citation: string;
  sortLabel: string;
  excluded: boolean;
  reproduced: boolean;
};

export function deriveAuthorityProcedure(input: {
  authorities: ProceduralAuthority[];
  units: Array<{ id: string; ordinal: number; occurrenceIds: string[] }>;
  occurrences: Record<string, { authorityId: string | null }>;
  manual: boolean;
  purpose: "table" | "book";
  tableOrder: "first-reference" | "alphabetical";
  tabStyle: "numeric" | "alpha";
}): Array<{ id: string; tab: string; group: string }>;

export function tabLabel(index: number, style: "numeric" | "alpha"): string;

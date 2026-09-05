export type SourcePartyGroup = { role: string; roleBelow?: string; parties: string[] };
export type SourceDocumentFields = {
  cover: Record<string, string>;
  partyStyleId?: string;
  partyGroups?: SourcePartyGroup[];
  exhibitLabels: string[];
  exhibitMentions?: Record<string, string[]>;
  explicitExhibitLabel?: string;
  entryTitle?: string;
  entryDate?: string;
};
export function sourceDocumentFields(pages: string[]): SourceDocumentFields | undefined;

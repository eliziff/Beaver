export type SourceDocumentFields = {
  cover: Record<string, string>;
  exhibitLabels: string[];
  exhibitMentions?: Record<string, string[]>;
  explicitExhibitLabel?: string;
  entryTitle?: string;
  entryDate?: string;
};
export function sourceDocumentFields(pages: string[]): SourceDocumentFields | undefined;

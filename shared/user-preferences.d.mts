export const DRAFTING_STYLE_VERSION: 1;
export const DRAFTING_DOCUMENT_TYPES: readonly ["memo", "factum", "letter", "other"];
export const CITATION_PLACEMENTS: readonly ["footnotes", "inline", "after-paragraph", "none"];
export type DraftingDocumentType = typeof DRAFTING_DOCUMENT_TYPES[number];
export type CitationPlacement = typeof CITATION_PLACEMENTS[number];
export type HeadingNumbering = boolean | "auto";

export type DraftingDocumentStyle = {
  citationPlacement: CitationPlacement;
  citationHyperlinks: boolean;
  numberHeadings: HeadingNumbering;
};

export type DraftingStyleSettings = {
  version: typeof DRAFTING_STYLE_VERSION;
  documents: Record<DraftingDocumentType, DraftingDocumentStyle>;
  memoHeader: {
    to: string;
    from: string;
  };
};

export type FeaturePreferences = {
  authorities: boolean;
};

export type WorkflowFileTarget =
  | { kind: "library"; folderId: string }
  | { kind: "project"; projectId: string; folderId: string };

export type WorkflowFileTargets = {
  "court-records": WorkflowFileTarget | null;
  authorities: WorkflowFileTarget | null;
};

export type FilingContact = {
  name: string;
  address: string;
  phone: string;
  fax: string;
  email: string;
};

export type UserPreferences = {
  displayName: string | null;
  organisation: string | null;
  practiceSetting: string | null;
  professionalTitle: string | null;
  practiceAreas: string[];
  jurisdictionPreference: { mode: "ask" | "presume"; jurisdictions: string[] };
  onboardingCompleted: boolean;
  titleModel: string | null;
  tabularModel: string | null;
  lastSelectedChatModel: string | null;
  lastSelectedReasoningEffort: string | null;
  legalResearchUs: boolean;
  features: FeaturePreferences;
  workflowFileTargets: WorkflowFileTargets;
  filingContact: FilingContact;
  draftingStyle: DraftingStyleSettings;
};

export type UserPreferencesPatch = Partial<UserPreferences>;

export const DEFAULT_DRAFTING_STYLE: DraftingStyleSettings;
export const DEFAULT_USER_PREFERENCES: UserPreferences;

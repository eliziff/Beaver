export const DRAFTING_STYLE_VERSION = 1;
export const DRAFTING_DOCUMENT_TYPES = ["memo", "factum", "letter", "other"];
export const CITATION_PLACEMENTS = ["footnotes", "inline", "after-paragraph", "none"];

export const DEFAULT_DRAFTING_STYLE = {
  version: DRAFTING_STYLE_VERSION,
  documents: {
    memo: { citationPlacement: "footnotes", citationHyperlinks: true, numberHeadings: false },
    factum: { citationPlacement: "inline", citationHyperlinks: true, numberHeadings: true },
    letter: { citationPlacement: "footnotes", citationHyperlinks: true, numberHeadings: false },
    other: { citationPlacement: "inline", citationHyperlinks: true, numberHeadings: "auto" },
  },
  memoHeader: { to: "File", from: "AI Assistant" },
};

export const DEFAULT_USER_PREFERENCES = {
  displayName: null,
  organisation: null,
  practiceSetting: null,
  professionalTitle: null,
  practiceAreas: [],
  jurisdictionPreference: { mode: "ask", jurisdictions: [] },
  onboardingCompleted: false,
  titleModel: null,
  tabularModel: null,
  lastSelectedChatModel: null,
  lastSelectedReasoningEffort: null,
  legalResearchUs: true,
  features: { authorities: true },
  workflowFileTargets: { "court-records": null, authorities: null },
  filingContact: { name: "", address: "", phone: "", fax: "", email: "" },
  draftingStyle: DEFAULT_DRAFTING_STYLE,
};

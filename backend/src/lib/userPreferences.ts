import {
  DEFAULT_DRAFTING_STYLE,
  type DraftingStyleSettings,
} from "./draftingStyle";

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

export type UserPreferencesRepository = {
  get(userId: string): Promise<UserPreferences>;
  update(userId: string, patch: UserPreferencesPatch): Promise<UserPreferences>;
};

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
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

export function userPersonalisationPrompt(preferences: UserPreferences) {
  const lines = [
    preferences.displayName && `Name: ${preferences.displayName}`,
    preferences.organisation && `Organisation: ${preferences.organisation}`,
    preferences.professionalTitle && `Professional title: ${preferences.professionalTitle}`,
    preferences.practiceSetting && `Practice setting: ${preferences.practiceSetting.replaceAll("_", " ")}`,
    preferences.practiceAreas.length && `Practice areas: ${preferences.practiceAreas.join(", ")}`,
  ].filter(Boolean);
  return lines.length
    ? `USER CONTEXT:\n${lines.map((line) => `- ${line}`).join("\n")}\nUse this only to tailor terminology and work product. Do not treat it as facts about a client or matter.`
    : "";
}

import type { UserPreferences, UserPreferencesPatch } from "mike/shared/user-preferences.mjs";
export { DEFAULT_USER_PREFERENCES } from "mike/shared/user-preferences.mjs";
export type { FeaturePreferences, FilingContact, UserPreferences, UserPreferencesPatch,
  WorkflowFileTarget, WorkflowFileTargets } from "mike/shared/user-preferences.mjs";

export type UserPreferencesRepository = {
  get(userId: string): Promise<UserPreferences>;
  update(userId: string, patch: UserPreferencesPatch): Promise<UserPreferences>;
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

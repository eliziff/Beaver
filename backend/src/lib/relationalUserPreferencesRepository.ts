import {
  decodeJson,
  encodeJson,
  sql,
  type RelationalDatabase,
  type SqlValue,
} from "./relationalDatabase";
import { DEFAULT_DRAFTING_STYLE, normalizeDraftingStyleSettings } from "./draftingStyle";
import {
  DEFAULT_USER_PREFERENCES,
  type UserPreferences,
  type UserPreferencesPatch,
  type UserPreferencesRepository,
  type WorkflowFileTarget,
} from "./userPreferences";

const text = (value: unknown) => typeof value === "string" && value.trim()
  ? value.trim() : null;
const strings = (value: unknown) => decodeJson<unknown[]>(value, [])
  .filter((item): item is string => typeof item === "string")
  .map((item) => item.trim()).filter(Boolean);
const features = (value: unknown): UserPreferences["features"] => {
  const stored = decodeJson<Record<string, unknown>>(value, {});
  return { authorities: stored.authorities !== false };
};
const target = (value: unknown): WorkflowFileTarget | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const stored = value as Record<string, unknown>, folderId = text(stored.folderId);
  if (!folderId) return null;
  if (stored.kind === "library") return { kind: "library", folderId };
  const projectId = text(stored.projectId);
  return stored.kind === "project" && projectId
    ? { kind: "project", projectId, folderId } : null;
};
const workflowFileTargets = (value: unknown): UserPreferences["workflowFileTargets"] => {
  const stored = decodeJson<Record<string, unknown>>(value, {});
  return {
    "court-records": target(stored["court-records"]),
    authorities: target(stored.authorities),
  };
};
const filingContact = (value: unknown): UserPreferences["filingContact"] => {
  const stored = decodeJson<Record<string, unknown>>(value, {});
  return { name: text(stored.name) ?? "", address: text(stored.address) ?? "",
    phone: text(stored.phone) ?? "", fax: text(stored.fax) ?? "",
    email: text(stored.email) ?? "" };
};

export function createUserPreferencesRepository(
  database: RelationalDatabase,
): UserPreferencesRepository {
  const get = async (userId: string): Promise<UserPreferences> => {
    const row = (await database.query<Record<string, unknown>>(sql`
      SELECT * FROM user_preferences WHERE user_id=${userId}`)).rows[0];
    if (!row) return DEFAULT_USER_PREFERENCES;
    return {
      displayName: text(row.display_name),
      organisation: text(row.organisation),
      practiceSetting: text(row.practice_setting),
      professionalTitle: text(row.professional_title),
      practiceAreas: strings(row.practice_areas),
      jurisdictionPreference: {
        mode: row.jurisdiction_mode === "presume" ? "presume" : "ask",
        jurisdictions: strings(row.jurisdictions),
      },
      onboardingCompleted: Number(row.onboarding_completed) === 1,
      titleModel: text(row.title_model),
      tabularModel: text(row.tabular_model),
      lastSelectedChatModel: text(row.last_selected_chat_model),
      lastSelectedReasoningEffort: text(row.last_selected_reasoning_effort),
      legalResearchUs: Number(row.legal_research_us) !== 0,
      libraryLabelsId: text(row.library_labels_id),
      features: features(row.features),
      workflowFileTargets: workflowFileTargets(row.workflow_file_targets),
      filingContact: filingContact(row.filing_contact),
      draftingStyle: normalizeDraftingStyleSettings(
        decodeJson(row.drafting_style, DEFAULT_DRAFTING_STYLE),
      ),
    };
  };
  return {
    get,
    async update(userId: string, patch: UserPreferencesPatch) {
      const fields: [string, SqlValue][] = [];
      const add = (key: keyof UserPreferencesPatch, column: string, value: SqlValue) => {
        if (Object.hasOwn(patch, key)) fields.push([column, value]);
      };
      add("displayName", "display_name", patch.displayName?.trim() || null);
      add("organisation", "organisation", patch.organisation?.trim() || null);
      add("practiceSetting", "practice_setting", patch.practiceSetting?.trim() || null);
      add("professionalTitle", "professional_title", patch.professionalTitle?.trim() || null);
      add("practiceAreas", "practice_areas", encodeJson(patch.practiceAreas ?? []));
      if (Object.hasOwn(patch, "jurisdictionPreference")) fields.push(
        ["jurisdiction_mode", patch.jurisdictionPreference?.mode === "presume" ? "presume" : "ask"],
        ["jurisdictions", encodeJson(patch.jurisdictionPreference?.jurisdictions ?? [])],
      );
      add("onboardingCompleted", "onboarding_completed", patch.onboardingCompleted ? 1 : 0);
      add("titleModel", "title_model", patch.titleModel?.trim() || null);
      add("tabularModel", "tabular_model", patch.tabularModel?.trim() || null);
      add("lastSelectedChatModel", "last_selected_chat_model",
        patch.lastSelectedChatModel?.trim() || null);
      add("lastSelectedReasoningEffort", "last_selected_reasoning_effort",
        patch.lastSelectedReasoningEffort?.trim() || null);
      add("legalResearchUs", "legal_research_us", patch.legalResearchUs === false ? 0 : 1);
      add("libraryLabelsId", "library_labels_id", patch.libraryLabelsId?.trim() || null);
      add("features", "features", encodeJson({
        ...DEFAULT_USER_PREFERENCES.features,
        ...patch.features,
      }));
      add("workflowFileTargets", "workflow_file_targets", encodeJson(
        patch.workflowFileTargets ?? DEFAULT_USER_PREFERENCES.workflowFileTargets,
      ));
      add("filingContact", "filing_contact", encodeJson(
        filingContact(patch.filingContact ?? DEFAULT_USER_PREFERENCES.filingContact),
      ));
      add("draftingStyle", "drafting_style", encodeJson(
        normalizeDraftingStyleSettings(patch.draftingStyle),
      ));
      fields.push(["updated_at", new Date().toISOString()]);
      await database.query(sql`INSERT INTO user_preferences(
        ${sql.join([sql.raw("user_id"), ...fields.map(([column]) => sql.raw(column))])}
      ) VALUES(${sql.join([userId, ...fields.map(([, value]) => value)])})
      ON CONFLICT(user_id) DO UPDATE SET ${sql.join(fields.map(([column]) =>
        sql.raw(`${column}=excluded.${column}`)))}`);
      return get(userId);
    },
  };
}

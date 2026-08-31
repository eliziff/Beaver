import { ApplicationError, reject, type ApplicationScope } from "./applicationError";
import {
  CLAUDE_LOW_MODELS, CLAUDE_MID_MODELS, DEEPSEEK_MAIN_MODELS,
  DEFAULT_TABULAR_MODEL, DEFAULT_TITLE_MODEL, OPENAI_LOW_MODELS,
  resolveModel, type UserApiKeys,
} from "./llm";
import type {
  ApiKeyProvider, UserCredentials,
} from "./userCredentials";
import type {
  UserPreferences, UserPreferencesPatch, UserPreferencesRepository,
} from "./userPreferences";

export type UserProfileState = { mfaOnLogin: boolean };
export type UserExportKind = "account" | "chats" | "tabular-reviews";
export type UserResourceKind = "chats" | "projects" | "tabular-reviews";
export type UserConnectors = ReturnType<typeof import("./mcp/servers").createMcpApplication>;

export type CloudUserAccount = {
  profile(userId: string): Promise<UserProfileState>;
  lookup(email: string): Promise<{ email: string; display_name: string | null } | null>;
  setMfaOnLogin(userId: string, enabled: boolean): Promise<void>;
  delete(scope: ApplicationScope): Promise<void>;
  exportData(kind: UserExportKind, scope: ApplicationScope): Promise<{
    filename: string; data: unknown;
  }>;
};

type Dependencies = {
  preferences: () => Promise<UserPreferencesRepository>;
  credentials: UserCredentials;
  cloud?: CloudUserAccount;
  connectors?: () => Promise<UserConnectors>;
  deleteAll(kind: UserResourceKind, scope: ApplicationScope): Promise<unknown>;
  recordExport?(kind: UserExportKind, scope: ApplicationScope): void;
};

function availableModel(
  keys: Partial<Record<"gemini" | "openai" | "deepseek" | "claude", unknown>>,
  tabular = false,
) {
  if (keys.gemini) return tabular ? DEFAULT_TABULAR_MODEL : DEFAULT_TITLE_MODEL;
  if (keys.openai) return OPENAI_LOW_MODELS[0];
  if (keys.deepseek) return DEEPSEEK_MAIN_MODELS[0];
  if (keys.claude) return tabular ? CLAUDE_MID_MODELS[0] : CLAUDE_LOW_MODELS[0];
  return tabular ? DEFAULT_TABULAR_MODEL : DEFAULT_TITLE_MODEL;
}

const resolveSettings = (
  preferences: UserPreferences, api_keys: UserApiKeys,
) => ({
  title_model: resolveModel(preferences.titleModel, availableModel(api_keys)),
  tabular_model: resolveModel(preferences.tabularModel, availableModel(api_keys, true)),
  api_keys,
});
export type UserModelSettings = ReturnType<typeof resolveSettings>;

export function createUserApplication(dependencies: Dependencies) {
  const cloud = () => dependencies.cloud ?? reject(
    501, "This account feature is unavailable in account-free local mode.",
  );
  const connectors = async () => dependencies.connectors?.() ?? reject(404, "Not found");
  const present = async (scope: ApplicationScope, stored?: UserPreferences) => {
    const [state, preferences, apiKeyStatus] = await Promise.all([
      dependencies.cloud?.profile(scope.userId) ?? { mfaOnLogin: false },
      stored ?? dependencies.preferences().then((value) => value.get(scope.userId)),
      dependencies.credentials.status(scope.userId),
    ]);
    return {
      ...preferences, ...state,
      titleModel: resolveModel(preferences.titleModel, availableModel(apiKeyStatus)),
      tabularModel: resolveModel(preferences.tabularModel, availableModel(apiKeyStatus, true)),
      apiKeyStatus,
    };
  };
  const settings = async (userId: string) => {
    const [preferences, keys] = await Promise.all([
      dependencies.preferences().then((value) => value.get(userId)),
      dependencies.credentials.keys(userId),
    ]);
    return { preferences, models: resolveSettings(preferences, keys) };
  };

  return {
    profile: (scope: ApplicationScope) => present(scope),
    async updateProfile(scope: ApplicationScope, patch: UserPreferencesPatch) {
      const preferences = await dependencies.preferences();
      return present(scope, await preferences.update(scope.userId, patch));
    },
    settings,
    modelSettings: (userId: string) => settings(userId).then(({ models }) => models),
    apiKeys: (scope: ApplicationScope) => dependencies.credentials.status(scope.userId),
    async saveApiKey(scope: ApplicationScope, provider: ApiKeyProvider, value: string | null) {
      const save = dependencies.credentials.save;
      if (!save) throw new ApplicationError(501,
        "API-key editing is unavailable in account-free local mode.");
      if (dependencies.credentials.environmentConfigured(provider)) throw new ApplicationError(
        409,
        "This provider is configured by the server environment and cannot be changed from the browser.",
      );
      await save(scope.userId, provider, value);
      return dependencies.credentials.status(scope.userId);
    },
    async lookup(email: string) {
      const user = await cloud().lookup(email);
      return { exists: !!user, email: user?.email ?? email.toLowerCase(),
        display_name: user?.display_name ?? null };
    },
    async setMfaOnLogin(scope: ApplicationScope, enabled: boolean) {
      await cloud().setMfaOnLogin(scope.userId, enabled);
      return present(scope);
    },
    deleteAccount: (scope: ApplicationScope) => cloud().delete(scope),
    deleteResource: (scope: ApplicationScope, kind: UserResourceKind) =>
      dependencies.deleteAll(kind, scope),
    async exportData(scope: ApplicationScope, kind: UserExportKind) {
      const result = await cloud().exportData(kind, scope);
      dependencies.recordExport?.(kind, scope);
      return result;
    },
    connectors,
  };
}

export type UserApplication = ReturnType<typeof createUserApplication>;

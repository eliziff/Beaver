import { ApplicationError } from "./applicationError";
import type { DocumentStore } from "./documentStore";
import type { createServerSupabase } from "./supabase";
import type { CloudUserAccount } from "./userApplication";
import { deleteUserAccountData } from "./userDataCleanup";
import {
  buildUserAccountExport,
  buildUserChatsExport,
  buildUserTabularReviewsExport,
  userExportFilename,
} from "./userDataExport";
import { findProfileUserByEmail } from "./userLookup";
import type { UserPreferencesRepository } from "./userPreferences";

type Db = ReturnType<typeof createServerSupabase>;
export function createSupabaseUserAccount(
  db: Db,
  documents: () => Promise<DocumentStore>,
  preferences: () => Promise<UserPreferencesRepository>,
): CloudUserAccount {
  async function profile(userId: string) {
    const { data, error } = await db.from("user_profiles")
      .select("mfa_on_login").eq("user_id", userId).single();
    if (error || !data) throw error ?? new Error("Profile not found");
    const row = data as { mfa_on_login: boolean | null };
    return { mfaOnLogin: row.mfa_on_login === true };
  }

  return {
    profile,
    lookup: async (email) => findProfileUserByEmail(db, email, await preferences()),
    async setMfaOnLogin(userId, enabled) {
      if (enabled) {
        const { data, error } = await db.auth.admin.getUserById(userId);
        if (error) throw error;
        if (!(data.user?.factors ?? []).some((factor) =>
          factor.factor_type === "totp" && factor.status === "verified")) {
          throw new ApplicationError(
            400,
            "Set up an authenticator app before requiring verification on login.",
          );
        }
      }
      const { error } = await db.from("user_profiles").upsert({
        user_id: userId,
        mfa_on_login: enabled,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });
      if (error) throw error;
    },
    async delete(scope) {
      await deleteUserAccountData(db, await documents(), scope.userId, scope.userEmail);
      const { error } = await db.auth.admin.deleteUser(scope.userId);
      if (error) throw error;
    },
    async exportData(kind, scope) {
      const build = {
        account: buildUserAccountExport,
        chats: buildUserChatsExport,
        "tabular-reviews": buildUserTabularReviewsExport,
      }[kind];
      return {
        filename: userExportFilename(kind, scope.userId),
        data: await build(db, scope.userId, scope.userEmail),
      };
    },
  };
}

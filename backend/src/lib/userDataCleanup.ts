import { createServerSupabase } from "./supabase";
import type { DocumentStore } from "./documentStore";

type Db = ReturnType<typeof createServerSupabase>;

function throwIfError<T extends { message?: string } | null>(
    error: T,
    context: string,
) {
    if (error) throw new Error(`${context}: ${error.message ?? "unknown error"}`);
}

async function removeEmailFromSharedWith(
    db: Db,
    table: "projects" | "tabular_reviews",
    email: string | null | undefined,
) {
    const normalizedEmail = email?.trim().toLowerCase();
    if (!normalizedEmail) return;

    const { data, error } = await db
        .from(table)
        .select("id, shared_with")
        .filter("shared_with", "cs", JSON.stringify([normalizedEmail]));
    throwIfError(error, `Failed to load shared ${table}`);

    const updates = (data ?? [])
        .map((row) => {
            const sharedWith = Array.isArray(row.shared_with)
                ? row.shared_with.filter(
                      (value) =>
                          typeof value !== "string" ||
                          value.trim().toLowerCase() !== normalizedEmail,
                  )
                : [];
            return { id: row.id as string, sharedWith };
        })
        .filter((row) => row.id);

    await Promise.all(
        updates.map(async ({ id, sharedWith }) => {
            const { error: updateError } = await db
                .from(table)
                .update({ shared_with: sharedWith })
                .eq("id", id)
                .filter("shared_with", "cs", JSON.stringify([normalizedEmail]));
            throwIfError(updateError, `Failed to update shared ${table}`);
        }),
    );
}

export async function deleteUserAccountData(
    db: Db,
    documents: DocumentStore,
    userId: string,
    userEmail?: string | null,
) {
    const { data: ownedProjects, error: ownedProjectsError } = await db
        .from("projects").select("id").eq("user_id", userId);
    throwIfError(ownedProjectsError, "Failed to load user projects");
    const ownedProjectIds = (ownedProjects ?? [])
        .flatMap((row) => typeof row.id === "string" ? [row.id] : []);

    await Promise.all([
        removeEmailFromSharedWith(db, "projects", userEmail),
        removeEmailFromSharedWith(db, "tabular_reviews", userEmail),
    ]);
    await documents.deleteUserDocuments(
        { userId, userEmail: userEmail ?? undefined },
        { projectIds: ownedProjectIds, includeOwned: true },
    );

    const owned = (table: string, column = "user_id", value = userId) =>
        db.from(table).delete().eq(column, value);
    const results = await Promise.all([
        owned("tabular_reviews"),
        owned("chats"),
        owned("project_subfolders"),
        owned("workflow_open_source_submissions", "submitted_by_user_id"),
        owned("workflow_shares", "shared_by_user_id"),
        userEmail
            ? owned("workflow_shares", "shared_with_email", userEmail.trim().toLowerCase())
            : Promise.resolve({ error: null }),
        owned("workflows"),
        owned("work_products"),
        owned("audit_events"),
        owned("user_preferences"),
        owned("projects"),
    ]);
    for (const result of results) {
        throwIfError(result.error, "Failed to delete account data");
    }
}

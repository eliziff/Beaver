import { createServerSupabase } from "./supabase";
import type { DocumentStore } from "./documentStore";

type Db = ReturnType<typeof createServerSupabase>;

async function throwIfError<T extends { message?: string } | null>(
    error: T,
    context: string,
) {
    if (error) throw new Error(`${context}: ${error.message ?? "unknown error"}`);
}

async function getOwnedProjectIds(db: Db, userId: string): Promise<string[]> {
    const { data, error } = await db
        .from("projects")
        .select("id")
        .eq("user_id", userId);
    await throwIfError(error, "Failed to load user projects");
    return (data ?? []).flatMap((row) => typeof row.id === "string" ? [row.id] : []);
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
    await throwIfError(error, `Failed to load shared ${table}`);

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
                .eq("id", id);
            await throwIfError(updateError, `Failed to update shared ${table}`);
        }),
    );
}

export async function deleteUserAccountData(
    db: Db,
    documents: DocumentStore,
    userId: string,
    userEmail?: string | null,
) {
    const ownedProjectIds = await getOwnedProjectIds(db, userId);

    await Promise.all([
        removeEmailFromSharedWith(db, "projects", userEmail),
        removeEmailFromSharedWith(db, "tabular_reviews", userEmail),
    ]);
    await documents.deleteUserDocuments(
        { userId, userEmail: userEmail ?? undefined },
        { projectIds: ownedProjectIds, includeOwned: true, purgeObjects: true },
    );

    const deletions = [
        db.from("tabular_reviews").delete().eq("user_id", userId),
        db.from("chats").delete().eq("user_id", userId),
        db.from("project_subfolders").delete().eq("user_id", userId),
        db.from("hidden_workflows").delete().eq("user_id", userId),
        db
            .from("workflow_open_source_submissions")
            .delete()
            .eq("submitted_by_user_id", userId),
        db.from("workflow_shares").delete().eq("shared_by_user_id", userId),
        userEmail
            ? db
                  .from("workflow_shares")
                  .delete()
                  .eq("shared_with_email", userEmail.trim().toLowerCase())
            : Promise.resolve({ error: null }),
        db.from("workflows").delete().eq("user_id", userId),
        db.from("audit_events").delete().eq("user_id", userId),
        db.from("object_cleanup").delete().eq("user_id", userId),
        db.from("projects").delete().eq("user_id", userId),
    ];

    const results = await Promise.all(deletions);
    for (const result of results) {
        await throwIfError(result.error, "Failed to delete account data");
    }
}

/** Central owner-or-shared access checks; `isOwner` gates mutations. */

import type { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

export type ProjectAccess =
    | {
          ok: true;
          isOwner: boolean;
          project: {
              id: string;
              user_id: string;
              shared_with: string[] | null;
          };
      }
    | { ok: false };

export async function checkProjectAccess(
    projectId: string,
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<ProjectAccess> {
    const { data: project } = await db
        .from("projects")
        .select("id, user_id, shared_with")
        .eq("id", projectId)
        .single();
    if (!project) return { ok: false };
    const proj = project as {
        id: string;
        user_id: string;
        shared_with: string[] | null;
    };
    if (proj.user_id === userId) {
        return { ok: true, isOwner: true, project: proj };
    }
    const sharedWith = Array.isArray(proj.shared_with) ? proj.shared_with : [];
    const email = (userEmail ?? "").toLowerCase();
    if (
        email &&
        sharedWith.some((e) => (e ?? "").toLowerCase() === email)
    ) {
        return { ok: true, isOwner: false, project: proj };
    }
    return { ok: false };
}

export async function ensureDocAccess(
    doc: { user_id: string; project_id: string | null },
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<{ ok: true; isOwner: boolean } | { ok: false }> {
    if (doc.user_id === userId) return { ok: true, isOwner: true };
    if (!doc.project_id) return { ok: false };
    const access = await checkProjectAccess(
        doc.project_id,
        userId,
        userEmail,
        db,
    );
    if (access.ok) return { ok: true, isOwner: false };
    return { ok: false };
}

/** Reviews inherit project access and may also grant direct email access. */
export async function ensureReviewAccess(
    review: {
        user_id: string;
        project_id: string | null;
        shared_with?: string[] | null;
    },
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<{ ok: true; isOwner: boolean } | { ok: false }> {
    if (review.user_id === userId) return { ok: true, isOwner: true };
    const email = (userEmail ?? "").toLowerCase();
    if (email && Array.isArray(review.shared_with)) {
        if (review.shared_with.some((e) => (e ?? "").toLowerCase() === email)) {
            return { ok: true, isOwner: false };
        }
    }
    if (!review.project_id) return { ok: false };
    const access = await checkProjectAccess(
        review.project_id,
        userId,
        userEmail,
        db,
    );
    if (access.ok) return { ok: true, isOwner: false };
    return { ok: false };
}

/** Prevent request-supplied IDs from attaching inaccessible documents. */
export async function filterAccessibleDocumentIds(
    documentIds: string[],
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<string[]> {
    if (documentIds.length === 0) return [];
    const { data: docs } = await db
        .from("documents")
        .select("id, user_id, project_id")
        .in("id", documentIds);
    const rows = (docs ?? []) as {
        id: string;
        user_id: string;
        project_id: string | null;
    }[];
    if (rows.length === 0) return [];

    const accessibleProjectIds = new Set(
        await listAccessibleProjectIds(userId, userEmail, db),
    );
    const allowed: string[] = [];
    for (const doc of rows) {
        if (doc.user_id === userId) {
            allowed.push(doc.id);
        } else if (
            doc.project_id &&
            accessibleProjectIds.has(doc.project_id)
        ) {
            allowed.push(doc.id);
        }
    }
    return allowed;
}

export async function listAccessibleProjectIds(
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<string[]> {
    const [{ data: own }, { data: shared }] = await Promise.all([
        db.from("projects").select("id").eq("user_id", userId),
        userEmail
            ? db
                  .from("projects")
                  .select("id")
                  .filter("shared_with", "cs", JSON.stringify([userEmail]))
                  .neq("user_id", userId)
            : Promise.resolve({ data: [] as { id: string }[] }),
    ]);
    const ids = new Set<string>();
    for (const p of (own ?? []) as { id: string }[]) ids.add(p.id);
    for (const p of (shared ?? []) as { id: string }[]) ids.add(p.id);
    return [...ids];
}

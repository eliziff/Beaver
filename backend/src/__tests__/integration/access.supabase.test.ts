import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { CloudScope } from "../../lib/access";

const url = process.env.SUPABASE_TEST_URL;
const serviceKey = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;
const maybeDescribe = url && serviceKey ? describe : describe.skip;

maybeDescribe("Supabase CloudScope integration", () => {
  it("enforces owner, share, not-found, and immediate revocation semantics", async () => {
    const admin = createClient(url!, serviceKey!, { auth: { persistSession: false } });
    const ownerId = crypto.randomUUID(), reviewerId = crypto.randomUUID();
    const strangerId = crypto.randomUUID(), projectId = crypto.randomUUID();
    const documentId = crypto.randomUUID(), reviewId = crypto.randomUUID();
    const chatId = crypto.randomUUID(), reviewerEmail = `reviewer-${reviewerId}@example.com`;
    const timestamp = new Date().toISOString();
    const ids = { projectId, documentId, reviewId, chatId };
    try {
      const project = await admin.from("projects").insert({ id: projectId,
        user_id: ownerId, name: "scope-integration", shared_with: [reviewerEmail],
        created_at: timestamp, updated_at: timestamp });
      if (project.error) throw project.error;
      const document = await admin.from("documents").insert({ id: documentId,
        user_id: ownerId, project_id: projectId, filename: "record.pdf",
        created_at: timestamp, updated_at: timestamp });
      if (document.error) throw document.error;
      const review = await admin.from("tabular_reviews").insert({ id: reviewId,
        user_id: ownerId, project_id: projectId, document_ids: [documentId], shared_with: [],
        created_at: timestamp, updated_at: timestamp });
      if (review.error) throw review.error;
      const chat = await admin.from("chats").insert({ id: chatId, user_id: ownerId,
        project_id: projectId, created_at: timestamp, updated_at: timestamp });
      if (chat.error) throw chat.error;

      const owner = new CloudScope({ userId: ownerId }, admin as any);
      await expect(owner.project(projectId)).resolves.toMatchObject({ isOwner: true });
      await expect(owner.document(documentId)).resolves.toMatchObject({ isOwner: true });
      await expect(owner.review(reviewId)).resolves.toMatchObject({ isOwner: true });
      await expect(owner.chat(chatId)).resolves.toMatchObject({ isOwner: true });

      const reviewer = new CloudScope({ userId: reviewerId,
        userEmail: reviewerEmail.toUpperCase() }, admin as any);
      await expect(reviewer.project(projectId)).resolves.toMatchObject({ isOwner: false });
      await expect(reviewer.document(documentId)).resolves.toMatchObject({ isOwner: false });
      await expect(reviewer.review(reviewId)).resolves.toMatchObject({ isOwner: false });
      await expect(reviewer.chat(chatId)).resolves.toMatchObject({ isOwner: false });

      const stranger = new CloudScope({ userId: strangerId,
        userEmail: `stranger-${strangerId}@example.com` }, admin as any);
      for (const id of [documentId, crypto.randomUUID()]) {
        await expect(stranger.document(id)).resolves.toBeNull();
      }

      const revoke = await admin.from("projects").update({ shared_with: [] }).eq("id", projectId);
      if (revoke.error) throw revoke.error;
      await expect(reviewer.project(projectId)).resolves.toBeNull();
      await expect(reviewer.document(documentId)).resolves.toBeNull();
      await expect(reviewer.review(reviewId)).resolves.toBeNull();
      await expect(reviewer.chat(chatId)).resolves.toBeNull();
    } finally {
      await admin.from("chats").delete().eq("id", ids.chatId);
      await admin.from("tabular_reviews").delete().eq("id", ids.reviewId);
      await admin.from("documents").delete().eq("id", ids.documentId);
      await admin.from("projects").delete().eq("id", ids.projectId);
    }
  });
});

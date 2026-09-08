import { randomUUID } from "node:crypto";
import { test as base, expect, type APIResponse, type Page } from "@playwright/test";

type Created = { chats: string[]; projects: string[] };

async function json(response: APIResponse) {
    await expect(response).toBeOK();
    return response.json();
}

async function purgeChat(page: Page, id: string) {
    const trashed = await page.request.delete(`/api/chat/${id}`);
    expect([204, 404]).toContain(trashed.status()); // The deletion test already trashed it.
    await expect(await page.request.delete(`/api/chat/${id}/permanent`)).toBeOK();
}

const test = base.extend<{ created: Created }>({
    created: async ({ page }, use) => {
        const created: Created = { chats: [], projects: [] };
        try {
            await use(created);
        } finally {
            // Only remove this test's records; attempt every cleanup even after a failure.
            const results = await Promise.allSettled(created.chats.map((id) => purgeChat(page, id)));
            results.push(...await Promise.allSettled(created.projects.map(async (id) => {
                await expect(await page.request.delete(`/api/projects/${id}`)).toBeOK();
            })));
            const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
            if (errors.length) throw new AggregateError(errors, "Could not clean up chat test records");
        }
    },
});

async function savedChat(page: Page, created: Created) {
    const { id } = await json(await page.request.post("/api/chat/create", { data: {} }));
    created.chats.push(id);
    const draft = `Saved question for ${id}`;
    // History intentionally omits chats that have neither messages nor a saved draft.
    const { title } = await json(await page.request.patch(`/api/chat/${id}`, {
        data: { draft: { role: "user", content: draft } },
    }));
    return { id: id as string, title, draft };
}

async function openHistory(page: Page) {
    const history = page.getByRole("region", { name: "Assistant conversations" });
    const opener = page.getByRole("button", { name: "Open sidebar", exact: true });
    await expect(history.or(opener).first()).toBeVisible();
    if (!(await history.isVisible())) await opener.click();
    await expect(history).toBeVisible();
}

const chatRow = (page: Page, id: string) => page.locator(`[data-chat-id="${id}"]`);

test("cold-load restores a real chat's saved draft", async ({ page, created }) => {
    const chat = await savedChat(page, created);
    await page.goto(`/assistant/chat/${chat.id}`);
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue(chat.draft);
    await expect(page).toHaveURL(new RegExp(`/assistant/chat/${chat.id}$`));
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue(chat.draft);
});

test("rename persists the trimmed title beyond the optimistic sidebar update", async ({ page, created }) => {
    const chat = await savedChat(page, created), title = `${chat.title} renamed`;
    await page.goto("/assistant");
    await openHistory(page);
    const row = chatRow(page, chat.id);
    await row.hover();
    await row.getByRole("button", { name: `Rename ${chat.title}`, exact: true }).click();
    const input = row.getByRole("textbox", { name: "Chat title", exact: true });
    await input.fill(`  ${title}  `);
    await input.press("Enter");
    await expect.poll(async () => (await json(await page.request.get(`/api/chat/${chat.id}`))).chat.title)
        .toBe(title);
    await page.reload();
    await openHistory(page);
    await expect(row.getByRole("link", { name: title, exact: true })).toBeVisible();
});

test("delete requires confirmation and persists in the recycling bin", async ({ page, created }) => {
    const survivor = await savedChat(page, created), chat = await savedChat(page, created);
    await page.goto("/assistant");
    await openHistory(page);
    const row = chatRow(page, chat.id);
    await row.hover();
    await row.getByRole("button", { name: `Delete ${chat.title}`, exact: true }).click();
    const confirmation = page.getByRole("alertdialog", { name: "Move chat to Recycling bin?", exact: true });
    await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(row).toBeVisible();
    expect((await json(await page.request.get(`/api/chat/${chat.id}`))).chat.id).toBe(chat.id);
    await row.hover();
    await row.getByRole("button", { name: `Delete ${chat.title}`, exact: true }).click();
    await confirmation.getByRole("button", { name: "Move", exact: true }).click();
    await expect(row).toHaveCount(0);
    await expect.poll(async () => (await json(await page.request.get("/api/chat/recycling-bin")))
        .map(({ id }: { id: string }) => id)).toContain(chat.id);
    expect((await page.request.get(`/api/chat/${chat.id}`)).status()).toBe(404);
    await page.reload();
    await openHistory(page);
    // A surviving record proves history has loaded before asserting the target's absence.
    await expect(chatRow(page, survivor.id)).toBeVisible();
    await expect(row).toHaveCount(0);
});

test("Create chat persists the project association and opens its composer", async ({ page, created }) => {
    const project = await json(await page.request.post("/api/projects", {
        data: { name: `Chat project ${randomUUID()}` },
    }));
    created.projects.push(project.id);
    await page.goto(`/projects/${project.id}/assistant`);
    const [response] = await Promise.all([
        page.waitForResponse((response) => new URL(response.url()).pathname === "/api/chat/create" &&
            response.request().method() === "POST"),
        page.getByRole("button", { name: "Create chat", exact: true }).click(),
    ]);
    expect(response.ok()).toBe(true);
    const { id } = await response.json();
    created.chats.push(id);
    await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/assistant/chat/${id}$`));
    expect((await json(await page.request.get(`/api/chat/${id}`))).chat)
        .toMatchObject({ id, project_id: project.id });
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeEditable();
});

test("a missing chat redirects to the assistant landing page", async ({ page }) => {
    const id = randomUUID();
    const [response] = await Promise.all([
        page.waitForResponse((response) => new URL(response.url()).pathname === `/api/chat/${id}` &&
            response.request().method() === "GET"),
        page.goto(`/assistant/chat/${id}`),
    ]);
    expect(response.status()).toBe(404);
    await expect(page).toHaveURL(/\/assistant$/);
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeEditable();
});

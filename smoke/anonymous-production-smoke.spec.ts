import fs from "node:fs";
import path from "node:path";
import {
    expect,
    test,
    type APIRequestContext,
    type Response,
} from "@playwright/test";

const API = "http://127.0.0.1:3001";
const AUTHORITIES = "http://127.0.0.1:8765";
const PDF_FIXTURE = path.join(__dirname, "..", "e2e", "fixtures", "test.pdf");

type CatalogModel = {
    slug: string;
    displayName: string;
    defaultReasoningLevel?: string;
    supportedReasoningLevels: { effort: string }[];
    visibility?: string;
};

function responsePath(response: Response, pathname: string) {
    return (
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === pathname
    );
}

async function responseId(response: Response | undefined) {
    if (!response?.ok()) return undefined;
    try {
        const body = (await response.json()) as { id?: unknown };
        return typeof body.id === "string" ? body.id : undefined;
    } catch {
        return undefined;
    }
}

async function removeCreated(
    request: APIRequestContext,
    label: string,
    url: string,
) {
    const response = await request.delete(url);
    expect
        .soft(
            response.ok() || response.status() === 404,
            `${label} cleanup failed: HTTP ${response.status()}`,
        )
        .toBeTruthy();
}

test("anonymous production stack completes its release path", async ({
    page,
    request,
}) => {
    const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const fixtureName = `beaver-smoke-${runId}.pdf`;
    const responseToken = `BEAVER_SMOKE_${runId.replaceAll("-", "_")}`;
    let documentId: string | undefined;
    let chatId: string | undefined;
    let uploadStarted = false;
    let chatStarted = false;
    let uploadResponsePromise: Promise<Response> | undefined;
    let chatCreateResponsePromise: Promise<Response> | undefined;
    const existingChatIds = new Set<string>();
    const existingDocumentIds = new Set<string>();

    try {
        const healthResponse = await request.get(`${API}/health`);
        expect(healthResponse.ok()).toBeTruthy();
        expect(await healthResponse.json()).toMatchObject({
            ok: true,
            runtime: { mode: "anonymous-local" },
        });

        const chatsBeforeResponse = await request.get(`${API}/chat?limit=100`);
        expect(chatsBeforeResponse.ok()).toBeTruthy();
        for (const chat of (await chatsBeforeResponse.json()) as {
            id?: unknown;
        }[]) {
            if (typeof chat.id === "string") existingChatIds.add(chat.id);
        }
        const libraryBeforeResponse = await request.get(`${API}/library/files`);
        expect(libraryBeforeResponse.ok()).toBeTruthy();
        const libraryBefore = (await libraryBeforeResponse.json()) as {
            documents?: { id?: unknown }[];
        };
        for (const document of libraryBefore.documents ?? []) {
            if (typeof document.id === "string") {
                existingDocumentIds.add(document.id);
            }
        }

        await page.goto("/assistant");
        await expect(page).toHaveTitle(/Beaver/i);
        await expect(page).toHaveURL(/\/assistant$/);
        await expect(page.getByPlaceholder("How can I help?")).toBeVisible();

        await page.goto("/library");
        const chooserPromise = page.waitForEvent("filechooser");
        uploadResponsePromise = page.waitForResponse((response) =>
            responsePath(response, "/library/files/documents"),
        );
        await page.locator('button[title="Add Files"]:visible').click();
        const chooser = await chooserPromise;
        uploadStarted = true;
        await chooser.setFiles({
            name: fixtureName,
            mimeType: "application/pdf",
            buffer: fs.readFileSync(PDF_FIXTURE),
        });
        const uploadResponse = await uploadResponsePromise;
        expect(uploadResponse.ok()).toBeTruthy();
        documentId = await responseId(uploadResponse);
        expect(documentId).toBeTruthy();
        await expect(
            page.getByText(fixtureName, { exact: true }).first(),
        ).toBeVisible();

        const catalogResponse = await request.get(`${API}/codex/models`);
        expect(catalogResponse.ok()).toBeTruthy();
        const catalog = (await catalogResponse.json()) as {
            source?: string;
            models?: CatalogModel[];
        };
        expect(catalog.source).toBe("live");
        const model = catalog.models?.find(
            (candidate) =>
                candidate.supportedReasoningLevels.length > 1 &&
                !["hide", "hidden"].includes(
                    candidate.visibility?.toLowerCase() ?? "",
                ),
        );
        expect(
            model,
            "The live Codex catalog has no visible model with selectable effort levels.",
        ).toBeTruthy();
        const selectedModel = model as CatalogModel;
        const effort =
            selectedModel.supportedReasoningLevels.find(
                (level) =>
                    level.effort !== selectedModel.defaultReasoningLevel,
            )?.effort ?? selectedModel.supportedReasoningLevels[0].effort;

        await page.goto("/assistant");
        const modelButton = page.getByRole("button", { name: /^Model:/ });
        await expect(modelButton).toBeVisible();
        await modelButton.click();
        await page
            .getByRole("menuitem", {
                name: selectedModel.displayName,
                exact: true,
            })
            .click();
        await expect(
            page.getByRole("button", {
                name: `Model: ${selectedModel.displayName}`,
                exact: true,
            }),
        ).toBeVisible();

        const effortButton = page.getByRole("button", {
            name: /^Reasoning effort:/,
        });
        await expect(effortButton).toBeVisible();
        await effortButton.click();
        await page
            .getByRole("menuitem", {
                name: effort,
                exact: true,
            })
            .click();
        await expect(effortButton).toHaveAttribute(
            "aria-label",
            `Reasoning effort: ${effort}`,
        );

        chatCreateResponsePromise = page.waitForResponse((response) =>
            responsePath(response, "/chat/create"),
        );
        const turnResponsePromise = page.waitForResponse((response) =>
            responsePath(response, "/chat"),
        );
        const input = page.getByPlaceholder("How can I help?");
        await input.fill(
            `Reply with this exact token and nothing else: ${responseToken}`,
        );
        chatStarted = true;
        await input.press("Enter");

        const createResponse = await chatCreateResponsePromise;
        expect(createResponse.ok()).toBeTruthy();
        chatId = await responseId(createResponse);
        expect(chatId).toBeTruthy();

        const turnResponse = await turnResponsePromise;
        const turn = turnResponse.request().postDataJSON() as {
            model?: unknown;
            reasoning_effort?: unknown;
        };
        expect(turn.model).toBe(`codex:${selectedModel.slug}`);
        expect(turn.reasoning_effort).toBe(effort);
        expect(turnResponse.ok()).toBeTruthy();
        expect(await turnResponse.finished()).toBeNull();
        await expect(
            page.locator("div.prose.font-serif").last(),
        ).toContainText(responseToken, { timeout: 120_000 });

        const launchResponsePromise = page.waitForResponse((response) =>
            responsePath(response, "/table-of-authorities/launch"),
        );
        await page.goto("/table-of-authorities");
        const launchResponse = await launchResponsePromise;
        expect(launchResponse.ok()).toBeTruthy();
        expect(await launchResponse.json()).toMatchObject({ ok: true });

        const authoritiesFrame = page.locator(
            'iframe[title="Table of Authorities"]',
        );
        await expect(authoritiesFrame).toBeVisible();
        const frameUrl = new URL((await authoritiesFrame.getAttribute("src"))!);
        expect(frameUrl.origin).toBe(AUTHORITIES);
        await expect(
            page
                .frameLocator('iframe[title="Table of Authorities"]')
                .getByRole("heading", {
                    name: "Table of Authorities",
                    exact: true,
                    level: 1,
                }),
        ).toBeVisible();

        const statusResponse = await request.get(`${AUTHORITIES}/api/status`);
        expect(statusResponse.ok()).toBeTruthy();
        expect(await statusResponse.json()).toMatchObject({
            ok: true,
            service: "table-of-authorities",
        });
    } finally {
        if (!chatId && chatStarted && chatCreateResponsePromise) {
            chatId = await responseId(
                await chatCreateResponsePromise.catch(() => undefined),
            );
        }
        if (!documentId && uploadStarted && uploadResponsePromise) {
            documentId = await responseId(
                await uploadResponsePromise.catch(() => undefined),
            );
        }
        const createdChatIds = new Set(chatId ? [chatId] : []);
        const chatsAfterResponse = await request.get(`${API}/chat?limit=100`);
        expect
            .soft(
                chatsAfterResponse.ok(),
                `Chat recovery failed: HTTP ${chatsAfterResponse.status()}`,
            )
            .toBeTruthy();
        if (chatsAfterResponse.ok()) {
            const chatsAfter = (await chatsAfterResponse.json()) as {
                id?: unknown;
                title?: unknown;
            }[];
            for (const chat of chatsAfter) {
                if (
                    typeof chat.id !== "string" ||
                    existingChatIds.has(chat.id)
                ) {
                    continue;
                }
                const detailResponse = await request.get(
                    `${API}/chat/${encodeURIComponent(chat.id)}`,
                );
                if (!detailResponse.ok()) continue;
                const detail = (await detailResponse.json()) as {
                    messages?: {
                        role?: unknown;
                        content?: unknown;
                    }[];
                };
                const matchesRun =
                    (typeof chat.title === "string" &&
                        chat.title.includes(responseToken)) ||
                    (detail.messages ?? []).some(
                        (message) =>
                            message.role === "user" &&
                            typeof message.content === "string" &&
                            message.content.includes(responseToken),
                    );
                if (matchesRun) createdChatIds.add(chat.id);
            }
        }
        for (const createdChatId of createdChatIds) {
            await removeCreated(
                request,
                "Chat",
                `${API}/chat/${encodeURIComponent(createdChatId)}`,
            );
        }

        const createdDocumentIds = new Set(documentId ? [documentId] : []);
        const libraryAfterResponse = await request.get(`${API}/library/files`);
        expect
            .soft(
                libraryAfterResponse.ok(),
                `Library recovery failed: HTTP ${libraryAfterResponse.status()}`,
            )
            .toBeTruthy();
        if (libraryAfterResponse.ok()) {
            const libraryAfter = (await libraryAfterResponse.json()) as {
                documents?: {
                    id?: unknown;
                    filename?: unknown;
                }[];
            };
            for (const document of libraryAfter.documents ?? []) {
                if (
                    typeof document.id === "string" &&
                    !existingDocumentIds.has(document.id) &&
                    document.filename === fixtureName
                ) {
                    createdDocumentIds.add(document.id);
                }
            }
        }
        for (const createdDocumentId of createdDocumentIds) {
            await removeCreated(
                request,
                "Library document",
                `${API}/single-documents/${encodeURIComponent(createdDocumentId)}`,
            );
        }
    }
});

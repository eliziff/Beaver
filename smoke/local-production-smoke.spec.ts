import fs from "node:fs";
import path from "node:path";
import { expect, test, type APIRequestContext, type Response } from "@playwright/test";

const API = "http://127.0.0.1:3000/api";
const PDF_FIXTURE = path.join(__dirname, "..", "e2e", "fixtures", "test.pdf");

function isUpload(response: Response) {
    return response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/library/files/documents";
}

async function removeCreated(request: APIRequestContext, documentId?: string) {
    if (!documentId) return;
    const response = await request.delete(
        `${API}/single-documents/${encodeURIComponent(documentId)}`,
    );
    expect.soft(response.ok() || response.status() === 404).toBeTruthy();
}

test("local production renders a reopened PDF in the document dock", async ({
    page,
    request,
}, testInfo) => {
    const fixtureName = `beaver-full-sweep-${Date.now()}.pdf`;
    let documentId: string | undefined;
    let pdfRequests = 0;
    page.on("request", (next) => {
        const url = new URL(next.url());
        if (url.pathname.includes("/api/single-documents/") &&
            url.pathname.endsWith("/file") && url.searchParams.get("rendition") === "pdf") {
            pdfRequests += 1;
        }
    });

    try {
        const health = await request.get(`${API}/health`);
        expect(health.ok()).toBeTruthy();
        expect(await health.json()).toMatchObject({
            ok: true,
            runtime: { mode: "local" },
        });

        await page.goto("/assistant");
        await expect(page).toHaveTitle(/Beaver/i);
        await expect(page.getByPlaceholder("How can I help?")).toBeVisible();

        await page.goto("/library");
        const chooserPromise = page.waitForEvent("filechooser");
        const uploadPromise = page.waitForResponse(isUpload);
        await page.getByTitle("Upload").click();
        const chooser = await chooserPromise;
        await chooser.setFiles({
            name: fixtureName,
            mimeType: "application/pdf",
            buffer: fs.readFileSync(PDF_FIXTURE),
        });
        const upload = await uploadPromise;
        expect(upload.ok()).toBeTruthy();
        const body = await upload.json() as { id?: unknown };
        documentId = typeof body.id === "string" ? body.id : undefined;
        expect(documentId).toBeTruthy();
        await expect(page.getByText(fixtureName, { exact: true }).first()).toBeVisible();

        const view = page.getByRole("button", { name: `View ${fixtureName}` });
        await view.click();
        const pdf = page.getByRole("region", { name: "PDF document" });
        await expect(pdf).toBeVisible();
        await expect(pdf.locator("canvas").first()).toBeVisible();
        await expect(pdf.getByText("1/1", { exact: true })).toBeVisible();
        await page.screenshot({
            path: testInfo.outputPath("docked-pdf.png"),
            fullPage: true,
        });

        await page.getByRole("button", { name: "Close", exact: true }).click();
        await expect(pdf).not.toBeVisible();
        await view.click();
        await expect(pdf.locator("canvas").first()).toBeVisible();
        expect(pdfRequests).toBe(1);
    } finally {
        await removeCreated(request, documentId);
    }
});

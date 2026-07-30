import { expect, test } from "@playwright/test";

test("assistant landing reflows and the mobile sidebar behaves modally", async ({
    page,
}, testInfo) => {
    await page.addInitScript(() => {
        try {
            localStorage.removeItem("mike.quickActions.visible");
        } catch {
            // Storage is unavailable on the initial opaque document.
        }
        const state = window as Window & { __beaverCls?: number };
        state.__beaverCls = 0;
        try {
            new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    const shift = entry as PerformanceEntry & {
                        hadRecentInput?: boolean;
                        value?: number;
                    };
                    if (!shift.hadRecentInput) {
                        state.__beaverCls =
                            (state.__beaverCls ?? 0) + (shift.value ?? 0);
                    }
                }
            }).observe({ type: "layout-shift", buffered: true });
        } catch {
            // LayoutShift is unavailable in some browser builds.
        }
    });
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto("/assistant");

    const prompt = page.getByRole("textbox", { name: "Message" });
    await expect(prompt).toBeVisible({ timeout: 10_000 });
    const width320 = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(width320.scrollWidth).toBeLessThanOrEqual(width320.clientWidth);
    await page.screenshot({
        path: testInfo.outputPath("assistant-320x720.png"),
    });

    const opener = page.getByRole("button", { name: "Open sidebar" });
    await opener.click();
    const sidebar = page.getByRole("dialog", { name: "Navigation" });
    await expect(sidebar).toBeVisible();
    await expect(
        sidebar.getByRole("button", { name: "Close sidebar" }),
    ).toBeFocused();
    await expect(page.locator("[inert]")).toHaveCount(1);
    await page.screenshot({
        path: testInfo.outputPath("assistant-sidebar-320x720.png"),
    });

    const first = sidebar.getByRole("link", { name: "Beaver" });
    const last = sidebar.getByRole("button", { name: "Settings" });
    await last.focus();
    await page.keyboard.press("Tab");
    await expect(first).toBeFocused();
    await first.focus();
    await page.keyboard.press("Shift+Tab");
    await expect(last).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(sidebar).toBeHidden();
    await expect(opener).toBeFocused();
    await expect(page.locator("[inert]")).toHaveCount(0);

    await page.setViewportSize({ width: 720, height: 450 });
    const lastQuickAction = page.getByRole("button", {
        name: "Start chat in project",
    });
    await lastQuickAction.scrollIntoViewIfNeeded();
    await expect(lastQuickAction).toBeVisible();
    const width720 = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(width720.scrollWidth).toBeLessThanOrEqual(width720.clientWidth);
    await page.screenshot({
        path: testInfo.outputPath("assistant-720x450.png"),
    });

    const model = page.getByRole("button", { name: /^Model:/ }).first();
    const before = await model.boundingBox();
    await model.click();
    await page.keyboard.press("Escape");
    const after = await model.boundingBox();
    expect(after).toEqual(before);

    const ratios = await page.evaluate(() => {
        function channels(value: string): [number, number, number] {
            const values = value.match(/[\d.]+/gu)?.map(Number) ?? [];
            return [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0];
        }
        function luminance(color: [number, number, number]) {
            return color
                .map((channel) => channel / 255)
                .map((channel) =>
                    channel <= 0.04045
                        ? channel / 12.92
                        : ((channel + 0.055) / 1.055) ** 2.4,
                )
                .reduce(
                    (total, channel, index) =>
                        total + channel * [0.2126, 0.7152, 0.0722][index],
                    0,
                );
        }
        function contrast(foreground: string, background: string) {
            const lighter = Math.max(
                luminance(channels(foreground)),
                luminance(channels(background)),
            );
            const darker = Math.min(
                luminance(channels(foreground)),
                luminance(channels(background)),
            );
            return (lighter + 0.05) / (darker + 0.05);
        }
        function background(element: Element) {
            for (
                let current: Element | null = element;
                current;
                current = current.parentElement
            ) {
                const color = getComputedStyle(current).backgroundColor;
                if (color !== "rgba(0, 0, 0, 0)") return color;
            }
            return "rgb(255, 255, 255)";
        }
        const textarea = document.querySelector("textarea")!;
        const documents = Array.from(document.querySelectorAll("button")).find(
            (button) => button.getAttribute("aria-label") === "Add document",
        )!;
        const workflows = Array.from(document.querySelectorAll("button")).find(
            (button) => button.getAttribute("aria-label") === "Open workflows",
        )!;
        const disclaimer = Array.from(document.querySelectorAll("p")).find(
            (paragraph) =>
                paragraph.textContent ===
                "AI can make mistakes. Answers are not legal advice.",
        )!;
        return {
            placeholder: contrast(
                getComputedStyle(textarea, "::placeholder").color,
                background(textarea),
            ),
            documents: contrast(
                getComputedStyle(documents).color,
                background(documents),
            ),
            workflows: contrast(
                getComputedStyle(workflows).color,
                background(workflows),
            ),
            disclaimer: contrast(
                getComputedStyle(disclaimer).color,
                background(disclaimer),
            ),
        };
    });
    for (const ratio of Object.values(ratios)) {
        expect(ratio).toBeGreaterThanOrEqual(4.5);
    }
    const cls = await page.evaluate(
        () =>
            (window as Window & { __beaverCls?: number }).__beaverCls ?? 0,
    );
    expect(cls).toBeLessThan(0.01);
    await testInfo.attach("interface-metrics", {
        body: JSON.stringify(
            { width320, width720, ratios, cls, modelBefore: before, modelAfter: after },
            null,
            2,
        ),
        contentType: "application/json",
    });
});

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LegalSourcePopout } from "./LegalSourcePopout";
import type { LegalSourceTab } from "./LegalSourceViewer";

vi.mock("./LegalSourceViewer", () => ({
    LegalSourceViewer: () => <p>Reader body</p>,
}));

const tab: LegalSourceTab = { kind: "legal", id: "legal:a2aj:2024-scc-1", citation: "2024 SCC 1",
    name: "Example v Test", dataset: "SCC", docType: "cases", language: "en" };

describe("LegalSourcePopout", () => {
    it("floats the reader in its own window and resizes it from the grip", async () => {
        render(<LegalSourcePopout tab={tab} onClose={vi.fn()} />);
        const reader = await screen.findByRole("region", { name: "Source reader" });
        expect(reader).toBeVisible();
        expect(reader).toHaveTextContent("Reader body");

        const before = Number.parseInt(reader.style.width, 10);
        fireEvent.keyDown(screen.getByRole("separator", { name: "Resize source reader" }), { key: "ArrowRight" });
        expect(Number.parseInt(reader.style.width, 10)).toBeGreaterThan(before);
    });

    it("closes from its own control and from Escape", async () => {
        const onClose = vi.fn();
        render(<LegalSourcePopout tab={tab} onClose={onClose} />);
        fireEvent.click(await screen.findByRole("button", { name: "Close source reader" }));
        expect(onClose).toHaveBeenCalledOnce();
        fireEvent.keyDown(window, { key: "Escape" });
        expect(onClose).toHaveBeenCalledTimes(2);
    });
});

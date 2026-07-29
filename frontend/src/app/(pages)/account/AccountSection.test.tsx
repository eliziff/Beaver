import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AccountSection } from "./AccountSection";

describe("AccountSection", () => {
    it("keeps the heading outside the labelled panel", () => {
        render(
            <AccountSection heading="Security" aria-label="Security settings">
                Content
            </AccountSection>,
        );

        expect(
            screen.getByRole("heading", { level: 2, name: "Security" }),
        ).toBeVisible();
        expect(screen.getByLabelText("Security settings")).toHaveTextContent(
            "Content",
        );
    });
});

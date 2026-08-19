import { describe, expect, it } from "vitest";

import { requiresAccount } from "./authMode";

describe("requiresAccount", () => {
    it("gates account-only routes without blocking local tools", () => {
        expect(requiresAccount("/tabular-reviews/review-1")).toBe(false);
        expect(requiresAccount("/workflows/assistant/workflow-1")).toBe(false);
        expect(
            requiresAccount("/projects/project-1/tabular-reviews/review-1"),
        ).toBe(false);
        expect(requiresAccount("/account/security")).toBe(true);
        expect(requiresAccount("/account/api-keys")).toBe(false);
        expect(requiresAccount("/account/features")).toBe(false);
        expect(requiresAccount("/assistant")).toBe(false);
        expect(requiresAccount("/table-of-authorities")).toBe(false);
    });
});

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TableOfAuthoritiesSkeuoIcon } from "./AppSidebarSkeuoIcons";

describe("AppSidebar symbols", () => {
    it("forces text presentation and stays decorative", () => {
        const { container } = render(<TableOfAuthoritiesSkeuoIcon />);
        const icon = container.querySelector(".app-symbol-icon");

        expect(icon).toHaveTextContent("⚖\uFE0E");
        expect(icon).toHaveAttribute("aria-hidden", "true");
    });
});

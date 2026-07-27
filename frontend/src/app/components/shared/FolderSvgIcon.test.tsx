import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProjectSvgIcon } from "./FolderSvgIcon";

describe("ProjectSvgIcon", () => {
    it("uses distinct text symbols for collapsed and expanded states", () => {
        const { container, rerender } = render(<ProjectSvgIcon />);
        expect(container.querySelector(".app-symbol-icon")).toHaveTextContent(
            "⊞",
        );

        rerender(<ProjectSvgIcon open />);
        expect(container.querySelector(".app-symbol-icon")).toHaveTextContent(
            "⊟",
        );
        expect(container.querySelector(".app-symbol-icon")).toHaveAttribute(
            "aria-hidden",
            "true",
        );
    });
});

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MikeIcon } from "./mike-icon";

describe("MikeIcon", () => {
    it("renders the flat maple leaf and activates its motion class", () => {
        const { container } = render(<MikeIcon spin size={32} />);

        expect(container.querySelector("svg")).toHaveAttribute(
            "viewBox",
            "0 0 64 64",
        );
        expect(container.querySelector("stop")).toBeNull();
        expect(container.firstChild).toHaveClass("maple-leaf-mark--active");
    });
});

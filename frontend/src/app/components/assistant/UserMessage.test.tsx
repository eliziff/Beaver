import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { UserMessage } from "./UserMessage";

describe("UserMessage", () => {
    it("renders user markdown inside the same bubble", () => {
        const { container } = render(
            <UserMessage content={"Please review **section 7**:\n\n- Notice\n- Renewal"} />,
        );

        expect(screen.getByText("section 7").tagName).toBe("STRONG");
        expect(container.querySelectorAll("ul li")).toHaveLength(2);
        expect(container.textContent).not.toContain("**");
        expect(screen.getAllByTestId("user-message-bubble")).toHaveLength(1);
    });
});

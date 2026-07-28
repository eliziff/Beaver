import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NativeActionSelect } from "./native-action-select";

describe("NativeActionSelect", () => {
    it("rejects long collections that need a searchable picker", () => {
        const items = Array.from({ length: 9 }, (_, index) => ({
            label: `Action ${index}`,
            onSelect: () => undefined,
        }));

        expect(() =>
            render(
                <NativeActionSelect label="Actions" items={items}>
                    Actions
                </NativeActionSelect>,
            ),
        ).toThrow(/eight items or fewer/);
    });
});

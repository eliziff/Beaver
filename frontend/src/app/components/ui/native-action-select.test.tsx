import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NativeActionSelect } from "./native-action-select";

describe("NativeActionSelect", () => {
    it("runs the selected action and resets the picker", () => {
        const onSelect = vi.fn();
        render(
            <NativeActionSelect
                label="Actions"
                items={[{ label: "Download", onSelect }]}
            >
                Actions
            </NativeActionSelect>,
        );

        const select = screen.getByRole("combobox", { name: "Actions" });
        fireEvent.change(select, { target: { value: "0" } });

        expect(onSelect).toHaveBeenCalledOnce();
        expect(select).toHaveValue("");
    });

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

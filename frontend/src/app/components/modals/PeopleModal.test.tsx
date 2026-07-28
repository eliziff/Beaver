import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PeopleModal } from "./PeopleModal";

describe("PeopleModal", () => {
    it("removes a member through the fixed native action slot", async () => {
        let finishRemoval!: () => void;
        const onSharedWithChange = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    finishRemoval = resolve;
                }),
        );

        render(
            <PeopleModal
                open
                onClose={() => undefined}
                resource={{
                    id: "project-1",
                    shared_with: ["member@example.test"],
                    owner_email: "owner@example.test",
                }}
                fetchPeople={async () => ({
                    owner: {
                        user_id: "owner-1",
                        email: "owner@example.test",
                        display_name: "Owner",
                    },
                    members: [
                        {
                            email: "member@example.test",
                            display_name: "Member",
                        },
                    ],
                })}
                currentUserEmail="owner@example.test"
                breadcrumb={["Test", "People"]}
                onSharedWithChange={onSharedWithChange}
            />,
        );

        const actions = await screen.findByRole("combobox", {
            name: "Remove access for member@example.test",
        });
        const slot = actions.closest("span.inline-flex.h-6.w-6");
        expect(slot).not.toBeNull();
        expect(
            screen.getByRole("option", { name: "Remove access" }),
        ).toBeInTheDocument();

        fireEvent.change(actions, { target: { value: "0" } });

        expect(onSharedWithChange).toHaveBeenCalledWith([]);
        await waitFor(() =>
            expect(slot?.querySelector("svg.animate-spin")).not.toBeNull(),
        );

        finishRemoval();
        await waitFor(() =>
            expect(slot?.querySelector("svg.animate-spin")).toBeNull(),
        );
    });
});

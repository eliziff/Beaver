import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EditAnnotation } from "@/app/lib/api/documents";

const mocks = vi.hoisted(() => ({ resolveDocumentEdits: vi.fn() }));
vi.mock("@/app/lib/api/documents", () => ({
  resolveDocumentEdits: mocks.resolveDocumentEdits
}));

import { resolveEdit } from "./EditCard";
import { EditCardsSection } from "./message/EditCardsSection";

const edit: EditAnnotation = {
    edit_id: "edit-1",
    document_id: "doc-1",
    version_id: "version-1",
    del_w_id: "delete-1",
    ins_w_id: "insert-1",
    deleted_text: "old",
    inserted_text: "new",
    diff: [
        { kind: "delete", text: "old" },
        { kind: "insert", text: "new" },
    ],
    status: "pending",
};

afterEach(() => {
    document.body.replaceChildren();
    vi.clearAllMocks();
});

describe("tracked change resolution", () => {
    it("reports a failed edit without changing its public state", async () => {
        mocks.resolveDocumentEdits.mockRejectedValue(new Error("API error: 500"));
        const onError = vi.fn();

        await expect(
            resolveEdit(edit, "reject", { onError }),
        ).resolves.toBeNull();
        expect(mocks.resolveDocumentEdits).toHaveBeenCalledWith(
            "doc-1",
            ["edit-1"],
            "reject",
        );
        expect(onError).toHaveBeenCalledWith(
            expect.objectContaining({ documentId: "doc-1" }),
        );
    });

    it("accepts every document in one bulk request", async () => {
        mocks.resolveDocumentEdits.mockResolvedValue({
            status: "accepted", version_id: "version-1", download_url: null,
        });
        const pending = [edit, { ...edit, edit_id: "edit-2" }, {
            ...edit, edit_id: "edit-3", document_id: "doc-2",
        }].map((annotation) => ({ annotation, filename: "Brief.docx" }));
        render(<EditCardsSection pending={pending} documentCount={2}
            cards={[]} resolvedCount={0} />);

        await userEvent.click(screen.getByRole("button", { name: "Accept all" }));
        await waitFor(() => expect(mocks.resolveDocumentEdits).toHaveBeenCalledTimes(2));
        expect(mocks.resolveDocumentEdits).toHaveBeenCalledWith(
            "doc-1", ["edit-1", "edit-2"], "accept",
        );
        expect(mocks.resolveDocumentEdits).toHaveBeenCalledWith(
            "doc-2", ["edit-3"], "accept",
        );
    });
});

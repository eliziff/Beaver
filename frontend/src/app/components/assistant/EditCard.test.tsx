import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditAnnotation } from "../shared/types";

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/app/lib/beaverApi", () => ({ apiFetch: mocks.apiFetch }));

import { applyOptimisticResolution, resolveEdit } from "./EditCard";

const edit: EditAnnotation = {
    edit_id: "edit-1",
    document_id: "doc-1",
    version_id: "version-1",
    change_id: "change-1",
    del_w_id: "delete-1",
    ins_w_id: "insert-1",
    deleted_text: "old",
    inserted_text: "new",
    status: "pending",
};

function mountRedline() {
    document.body.innerHTML = `
        <div data-document-id="doc-1">
            <div class="docx-view-container">
                <del data-w-id="delete-1">old</del>
                <ins data-w-id="insert-1">new</ins>
            </div>
        </div>`;
    return {
        deleted: document.querySelector("del")!,
        inserted: document.querySelector("ins")!,
    };
}

afterEach(() => {
    document.body.replaceChildren();
    vi.clearAllMocks();
});

describe("tracked change resolution", () => {
    it("applies and reverts the preview with CSS classes", () => {
        const { deleted, inserted } = mountRedline();
        const revert = applyOptimisticResolution(edit, "accept");

        expect(inserted).toHaveClass("docx-edit-kept");
        expect(deleted).toHaveClass("docx-edit-hidden");
        revert();
        expect(inserted).not.toHaveClass("docx-edit-kept");
        expect(deleted).not.toHaveClass("docx-edit-hidden");
    });

    it("uses one transaction and restores the preview on failure", async () => {
        const { deleted, inserted } = mountRedline();
        mocks.apiFetch.mockResolvedValue({ ok: false, status: 500 });
        const onError = vi.fn();

        await expect(
            resolveEdit(edit, "reject", { onError }),
        ).resolves.toBeNull();
        expect(mocks.apiFetch).toHaveBeenCalledOnce();
        expect(inserted).not.toHaveClass("docx-edit-hidden");
        expect(deleted).not.toHaveClass("docx-edit-kept");
        expect(onError).toHaveBeenCalledWith(
            expect.objectContaining({ documentId: "doc-1" }),
        );
    });
});

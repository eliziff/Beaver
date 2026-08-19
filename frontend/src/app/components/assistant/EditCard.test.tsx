import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditAnnotation } from "../shared/types";

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/app/lib/beaverApi", () => ({ apiFetch: mocks.apiFetch }));

import { resolveEdit } from "./EditCard";

const edit: EditAnnotation = {
    edit_id: "edit-1",
    document_id: "doc-1",
    version_id: "version-1",
    change_id: "change-1",
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
        mocks.apiFetch.mockResolvedValue({ ok: false, status: 500 });
        const onError = vi.fn();

        await expect(
            resolveEdit(edit, "reject", { onError }),
        ).resolves.toBeNull();
        expect(mocks.apiFetch).toHaveBeenCalledOnce();
        expect(onError).toHaveBeenCalledWith(
            expect.objectContaining({ documentId: "doc-1" }),
        );
    });
});

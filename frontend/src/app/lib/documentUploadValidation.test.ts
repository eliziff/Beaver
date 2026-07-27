import { describe, expect, it } from "vitest";
import {
    formatUnsupportedDocumentWarning,
    isSupportedDocumentFile,
} from "./documentUploadValidation";

describe("image upload validation", () => {
    it("accepts supported images and rejects oversized ones", () => {
        const image = new File(["pixels"], "scan.png", { type: "image/png" });
        const oversized = new File(
            [new Uint8Array(5 * 1024 * 1024 + 1)],
            "large.jpg",
            { type: "image/jpeg" },
        );

        expect(isSupportedDocumentFile(image)).toBe(true);
        expect(isSupportedDocumentFile(oversized)).toBe(false);
        expect(formatUnsupportedDocumentWarning([oversized])).toBe(
            "Images must be 5 MB or smaller.",
        );
    });
});

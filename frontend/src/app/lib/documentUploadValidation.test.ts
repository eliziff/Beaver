import { describe, expect, it } from "vitest";
import {
    filenameExtensionChangeWarning,
    formatUnsupportedDocumentWarning,
    hasFilenameExtensionChange,
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

describe("filename extension changes", () => {
    it("guards real changes and formats the existing extension", () => {
        expect([
            hasFilenameExtensionChange("brief.DOCX", "final.docx"),
            hasFilenameExtensionChange("brief.docx", "brief.pdf"),
            hasFilenameExtensionChange(".env", "settings.txt"),
            hasFilenameExtensionChange("brief.", "brief.pdf"),
            hasFilenameExtensionChange("brief", "brief.pdf"),
            hasFilenameExtensionChange("brief.docx", ".env"),
            hasFilenameExtensionChange("brief.docx", "brief."),
            hasFilenameExtensionChange("brief.docx", "brief"),
        ]).toEqual([false, true, false, false, false, true, true, true]);
        expect(filenameExtensionChangeWarning("brief.DOCX")).toBe(
            "File extensions cannot be changed here. Keep .DOCX at the end of the name.",
        );
        expect(filenameExtensionChangeWarning(".env")).toBe(
            "File extensions cannot be changed here.",
        );
    });
});

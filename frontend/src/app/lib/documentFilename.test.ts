import { describe, expect, it } from "vitest";
import {
    filenameExtensionChangeWarning,
    hasFilenameExtensionChange,
} from "./documentFilename";

describe("filename extension changes", () => {
    it("guards real changes and names the existing extension", () => {
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
        expect(filenameExtensionChangeWarning("brief.DOCX")).toContain(".DOCX");
        expect(filenameExtensionChangeWarning(".env")).toBeTruthy();
    });
});

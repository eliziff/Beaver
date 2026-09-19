// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
    hasFilenameExtensionChange,
} from "./documentFilename";

describe("filename extension changes", () => {
    it("guards real extension changes", () => {
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
    });
});

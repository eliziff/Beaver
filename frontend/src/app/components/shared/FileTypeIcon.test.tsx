import { describe, expect, it } from "vitest";
import { fileTypeKind } from "./FileTypeIcon";

describe("file types", () => {
    it("normalizes extensions, MIME values, and unknown input", () => {
        const cases: Array<
            [string | null | undefined, ReturnType<typeof fileTypeKind>]
        > = [
            ["pdf", "pdf"],
            ["docx", "word"],
            ["doc", "word"],
            ["xlsx", "excel"],
            ["xlsm", "excel"],
            ["xls", "excel"],
            ["pptx", "ppt"],
            ["ppt", "ppt"],
            ["png", "image"],
            ["jpeg", "image"],
            ["webp", "image"],
            ["image/png", "image"],
            ["report.pdf", "pdf"],
            ["Quarterly Deck.PPTX", "ppt"],
            ["model.final.xlsx", "excel"],
            ["Fairness.RESEARCH.md", "research"],
            ["memo.md", "other"],
            ["  PDF ", "pdf"],
            ["DOCX", "word"],
            ["txt", "other"],
            ["", "other"],
            [null, "other"],
            [undefined, "other"],
        ];

        expect(cases.map(([input]) => fileTypeKind(input))).toEqual(
            cases.map(([, expected]) => expected),
        );
    });
});

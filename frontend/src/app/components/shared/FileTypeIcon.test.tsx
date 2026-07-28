import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FileTypeIcon, fileTypeKind } from "./FileTypeIcon";

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

    it("renders a decorative symbol for the normalized kind", () => {
        const { container, rerender } = render(
            <FileTypeIcon fileType="evidence.png" />,
        );
        const icon = container.querySelector("[data-file-kind]");

        expect(icon).toHaveAttribute("data-file-kind", "image");
        expect(icon).toHaveAttribute("aria-hidden", "true");

        rerender(<FileTypeIcon fileType={null} />);
        expect(icon).toHaveAttribute("data-file-kind", "other");
    });
});

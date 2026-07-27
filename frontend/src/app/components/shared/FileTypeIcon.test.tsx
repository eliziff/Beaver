import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FileTypeIcon, fileTypeKind } from "./FileTypeIcon";

describe("fileTypeKind", () => {
    it("maps bare file_type values to a kind", () => {
        expect(fileTypeKind("pdf")).toBe("pdf");
        expect(fileTypeKind("docx")).toBe("word");
        expect(fileTypeKind("doc")).toBe("word");
        expect(fileTypeKind("xlsx")).toBe("excel");
        expect(fileTypeKind("xlsm")).toBe("excel");
        expect(fileTypeKind("xls")).toBe("excel");
        expect(fileTypeKind("pptx")).toBe("ppt");
        expect(fileTypeKind("ppt")).toBe("ppt");
        expect(fileTypeKind("png")).toBe("image");
        expect(fileTypeKind("jpeg")).toBe("image");
        expect(fileTypeKind("webp")).toBe("image");
        expect(fileTypeKind("image/png")).toBe("image");
    });

    it("maps filenames by their extension", () => {
        expect(fileTypeKind("report.pdf")).toBe("pdf");
        expect(fileTypeKind("Quarterly Deck.PPTX")).toBe("ppt");
        expect(fileTypeKind("model.final.xlsx")).toBe("excel");
    });

    it("is case-insensitive and trims whitespace", () => {
        expect(fileTypeKind("  PDF ")).toBe("pdf");
        expect(fileTypeKind("DOCX")).toBe("word");
    });

    it("falls back to other for unknown, empty, or nullish input", () => {
        expect(fileTypeKind("txt")).toBe("other");
        expect(fileTypeKind("")).toBe("other");
        expect(fileTypeKind(null)).toBe("other");
        expect(fileTypeKind(undefined)).toBe("other");
    });
});

describe("FileTypeIcon", () => {
    const iconOf = (container: HTMLElement) =>
        container.querySelector("[data-file-kind]");

    it("renders crisp text symbols for known file kinds", () => {
        const { container } = render(<FileTypeIcon fileType="pdf" />);
        expect(iconOf(container)).toHaveAttribute("data-file-kind", "pdf");
        expect(iconOf(container)).toHaveTextContent("§");
        expect(iconOf(container)).toHaveAttribute("aria-hidden", "true");
    });

    it("keeps a distinct image-file symbol", () => {
        const { container } = render(<FileTypeIcon fileType="evidence.png" />);
        expect(iconOf(container)).toHaveAttribute("data-file-kind", "image");
        expect(iconOf(container)).toHaveTextContent("▧");
    });

    it("renders a neutral symbol for unknown types", () => {
        const { container } = render(<FileTypeIcon fileType={null} />);
        expect(iconOf(container)).toHaveAttribute("data-file-kind", "other");
        expect(iconOf(container)).toHaveTextContent("□");
    });

    it("dims muted symbols", () => {
        const { container } = render(<FileTypeIcon fileType="pdf" muted />);
        expect(iconOf(container)).toHaveClass("opacity-35");
    });

    it("always applies shrink-0 and merges a custom className", () => {
        const { container } = render(
            <FileTypeIcon fileType="pdf" className="h-6 w-6" />,
        );
        const icon = iconOf(container);
        expect(icon).toHaveClass("shrink-0");
        expect(icon).toHaveClass("h-6");
        expect(icon).toHaveClass("w-6");
    });
});

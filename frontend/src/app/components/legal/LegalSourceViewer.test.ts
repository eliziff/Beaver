import { describe, expect, it } from "vitest";
import type { LegalSourceViewerPayload } from "@/app/lib/beaverApi";
import {
    buildLegalSourceViewerSlices,
    legalSourceAnchorId,
    legalSourceKindLabel,
} from "./LegalSourceViewer";

function payload(
    text: string,
    docType: "cases" | "laws",
    blocks: LegalSourceViewerPayload["structure"]["blocks"],
): LegalSourceViewerPayload {
    return {
        schemaVersion: "mike.legal-source.v1",
        provider: "a2aj",
        reference: {
            docType,
            citation: "2099 TEST 1",
            language: "en",
            dataset: "TEST",
        },
        metadata: {
            title: "Viewer fixture",
            citation: "2099 TEST 1",
            alternateCitation: null,
            date: null,
            dataset: "TEST",
            url: null,
            language: "en",
            upstreamLicense: null,
        },
        text,
        structure: {
            status: "usable",
            source: "flat_text",
            blocks,
            counts: {
                paragraph: blocks.filter((block) => block.kind === "paragraph")
                    .length,
                page: blocks.filter((block) => block.kind === "page").length,
                section: blocks.filter((block) => block.kind === "section")
                    .length,
                footnote: blocks.filter((block) => block.kind === "footnote")
                    .length,
            },
        },
        truncated: false,
    };
}

describe("legal source viewer slicing", () => {
    it("uses one source-kind label mapping", () => {
        expect(legalSourceKindLabel("cases")).toBe("Decision");
        expect(legalSourceKindLabel("laws")).toBe("Legislation");
        expect(legalSourceKindLabel("articles")).toBe("Journal article");
    });

    it("keeps case text non-overlapping and preserves co-located anchors", () => {
        const text =
            "Reasons\n[1] The first proposition.\n[2] The second proposition.";
        const paragraphOne = text.indexOf("[1]");
        const paragraphTwo = text.indexOf("[2]");
        const slices = buildLegalSourceViewerSlices(
            payload(text, "cases", [
                {
                    kind: "page",
                    label: "page1",
                    start: paragraphOne,
                    end: text.length,
                },
                {
                    kind: "paragraph",
                    label: "par1",
                    start: paragraphOne,
                    end: paragraphTwo,
                },
                {
                    kind: "paragraph",
                    label: "par2",
                    start: paragraphTwo,
                    end: text.length,
                },
            ]),
        );

        expect(slices.map((slice) => slice.text)).toEqual([
            "Reasons",
            "[1] The first proposition.",
            "[2] The second proposition.",
        ]);
        expect(slices[1].anchors.map((anchor) => anchor.label)).toEqual([
            "page1",
            "par1",
        ]);
        expect(slices[1].primary?.label).toBe("par1");
        expect(
            slices.filter((slice) => slice.text.includes("first proposition")),
        ).toHaveLength(1);
        expect(legalSourceAnchorId("par1")).toBe("legal-par1");
    });

    it("maps nested legislation to stable anchors and increasing depth", () => {
        const text =
            "34 General rule.\n34(1) Specific rule.\n(a) Nested paragraph.";
        const subsection = text.indexOf("34(1)");
        const paragraph = text.indexOf("(a)");
        const slices = buildLegalSourceViewerSlices(
            payload(text, "laws", [
                {
                    kind: "section",
                    label: "sec34",
                    start: 0,
                    end: subsection,
                },
                {
                    kind: "section",
                    label: "sec34(1)",
                    start: subsection,
                    end: paragraph,
                },
                {
                    kind: "section",
                    label: "sec34(1)(a)",
                    start: paragraph,
                    end: text.length,
                },
            ]),
        );

        expect(slices.map((slice) => slice.depth)).toEqual([0, 1, 2]);
        expect(slices.map((slice) => slice.primary?.label)).toEqual([
            "sec34",
            "sec34(1)",
            "sec34(1)(a)",
        ]);
        expect(legalSourceAnchorId("sec34(1)(a)")).toBe(
            "legal-sec34-1-a-",
        );
    });
});

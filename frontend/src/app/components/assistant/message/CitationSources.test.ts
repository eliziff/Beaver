import { expect, it } from "vitest";
import type { Citation } from "../../shared/types";
import { buildCitationAppendix } from "./CitationSources";

it("builds escaped copy formats and abbreviates repeated sources", () => {
    const citations = [
        {
            type: "citation_data",
            ref: 1,
            doc_id: "doc-1",
            filename: "Lease & addendum.docx",
            document_id: "doc-1",
            quotes: [{ page: 1, quote: 'A "quoted" term' }],
        },
        {
            type: "citation_data",
            ref: 2,
            doc_id: "doc-1",
            filename: "Lease & addendum.docx",
            document_id: "doc-1",
            quotes: [{ page: 2, quote: "Another term" }],
        },
    ] satisfies Citation[];

    const appendix = buildCitationAppendix(citations);
    expect(appendix.text).toContain(
        '1 Lease & addendum.docx. "A "quoted" term"',
    );
    expect(appendix.text).toContain('2 Id. "Another term"');
    expect(appendix.html).toContain("Lease &amp; addendum.docx.");
    expect(appendix.html).toContain("&quot;A &quot;quoted&quot; term&quot;");
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchA2AJDocument, searchA2AJ } from "../a2aj";

afterEach(() => vi.unstubAllGlobals());

describe("A2AJ client", () => {
    it("maps a fetched document and bounds returned text", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                results: [
                    {
                        dataset: "SCC",
                        citation_en: "2020 SCC 5",
                        name_en: "Nevsun Resources Ltd. v. Araya",
                        document_date_en: "2020-02-28",
                        url_en: "https://decisions.scc-csc.ca/item/18169",
                        unofficial_text_en: "abcdef",
                    },
                ],
            }),
        });
        vi.stubGlobal("fetch", fetchMock);

        const document = await fetchA2AJDocument({
            citation: "2020 SCC 5",
            maxChars: 3,
        });

        expect(document).toMatchObject({
            dataset: "SCC",
            citation: "2020 SCC 5",
            name: "Nevsun Resources Ltd. v. Araya",
            url: "https://decisions.scc-csc.ca/item/18169",
            text: "abc",
        });
        expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
            "citation=2020+SCC+5",
        );
    });

    it("maps search metadata without exposing the raw API payload", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                json: async () => ({
                    results: [
                        {
                            dataset: "ONCA",
                            citation_en: "2024 ONCA 1",
                            name_en: "Example v. Example",
                            url_en: "https://example.test/case",
                            snippet: "A matching passage",
                        },
                    ],
                }),
            }),
        );

        await expect(searchA2AJ({ query: "privacy", size: 1 })).resolves.toEqual([
            {
                dataset: "ONCA",
                citation: "2024 ONCA 1",
                alternateCitation: null,
                name: "Example v. Example",
                date: null,
                url: "https://example.test/case",
                snippet: "A matching passage",
            },
        ]);
    });
});

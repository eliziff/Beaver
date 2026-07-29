import { describe, expect, it } from "vitest";
import {
    parseCourtlistenerCaseSearches,
    parseCourtlistenerEventCases,
} from "./assistantStreamEvents";

describe("CourtListener assistant event parsing", () => {
    it("keeps valid rows and normalizes untrusted fields", () => {
        expect(
            parseCourtlistenerEventCases([
                { cluster_id: 42, case_name: "R v Test", citation: 7 },
                { cluster_id: 0 },
                null,
            ]),
        ).toEqual([
            {
                cluster_id: 42,
                case_name: "R v Test",
                citation: null,
                dateFiled: null,
                url: null,
            },
        ]);
        expect(
            parseCourtlistenerCaseSearches([
                { cluster_id: 42, query: "duty", total_matches: "many" },
                [],
            ]),
        ).toEqual([
            {
                cluster_id: 42,
                query: "duty",
                total_matches: 0,
                case_name: null,
                citation: null,
                error: undefined,
            },
        ]);
    });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCanliiCaseUrl, buildCanliiCaseUrlFromCitation, buildCanliiPdfUrl,
} from "./canliiUrls";

// Isolate route construction from the native citation grammar, which has its own tests.
const native = vi.hoisted(() => ({
  matches: [] as Array<{ family: string; year: number; court: string; number: number }>,
}));
vi.mock("./structureNative", () => ({
  structureNative: () => ({ providerCitationsInText: () => native.matches }),
}));
const neutral = (court: string, number = 7) => ({
  family: "neutral", year: 2024, court, number,
});
beforeEach(() => { native.matches = []; });

describe("CanLII court route inventory", () => {
  it.each([
    ["ABCA", "ab/abca"], ["BCCA", "bc/bcca"], ["SCC", "ca/scc"],
    ["MBCA", "mb/mbca"], ["NBCA", "nb/nbca"], ["NLCA", "nl/nlca"],
    ["NSCA", "ns/nsca"], ["NTCA", "nt/ntca"], ["NUCA", "nu/nuca"],
    ["ONCA", "on/onca"], ["PESCAD", "pe/pescad"], ["QCCA", "qc/qcca"],
    ["SKCA", "sk/skca"], ["YKCA", "yt/ykca"],
    ["AHRC", "ab/ahrc"], ["ALRB", "ab/alrb"], ["CGYSDAB", "ab/cgysdab"],
    ["LSBC", "bc/lsbc"], ["YJCN", "nu/yjcn"], ["SCC-L", "ca/scc-l"],
    ["BCWCAT", "bc/bwcwcat"], ["FC", "ca/fct"], ["HRTO", "on/onhrt"],
    ["NBBR", "nb/NBQB"], ["NBSM", "nb/nbs"], ["NSLRB", "ns/nsrb"],
    ["NTYDAB", "nt/ntyadab"], ["QCCQLC", "qc/qcqlc"],
    ["SKAIA", "sk/skia"], ["UKJCPC", "ukjcpc"],
  ])("routes %s through %s without changing the decision slug", (court, route) => {
    native.matches = [neutral(court.toLowerCase())];
    const citations = [`2024 ${court} 7`];
    const slug = `2024${court.toLowerCase()}7`;
    for (const language of ["en", "fr"] as const) {
      const page = `https://www.canlii.org/${language}/${route}/doc/2024/${slug}/${slug}.html`;
      expect(buildCanliiCaseUrlFromCitation(citations, language)).toBe(page);
      expect(buildCanliiCaseUrl({
        dataset: ` ${court.toLowerCase()} `, citations, language,
      })).toBe(page);
      expect(buildCanliiPdfUrl(page)).toBe(page.replace(/\.html$/u, ".pdf"));
    }
  });

  it.each(["ABUNKNOWN", "ONMISSING", "YTCA", "CANLII", "UNKNOWN", "", "toString"])(
    "does not invent a route for %s", (court) => {
      native.matches = [neutral(court)];
      expect(buildCanliiCaseUrlFromCitation([`2024 ${court} 7`])).toBeNull();
      expect(buildCanliiCaseUrl({
        dataset: court, citations: [`2024 ${court} 7`], language: "en",
      })).toBeNull();
    },
  );

  it("does not substitute a different known court for the selected dataset", () => {
    native.matches = [neutral("FCA")];
    expect(buildCanliiCaseUrl({
      dataset: "FC", citations: ["2024 FCA 7"], language: "en",
    })).toBeNull();
  });

  it("continues past unknown and different courts to the selected dataset", () => {
    native.matches = [neutral("ONMISSING"), neutral("FCA"), neutral("FC", 9)];
    expect(buildCanliiCaseUrl({
      dataset: "FC", citations: ["2024 ONMISSING 7; 2024 FCA 7; 2024 FC 9"], language: "fr",
    })).toBe("https://www.canlii.org/fr/ca/fct/doc/2024/2024fc9/2024fc9.html");
  });

  it("continues past unknown courts without a dataset filter", () => {
    native.matches = [neutral("ONMISSING"), neutral("SCC")];
    expect(buildCanliiCaseUrlFromCitation(["2024 ONMISSING 7; 2024 SCC 7"]))
      .toBe("https://www.canlii.org/en/ca/scc/doc/2024/2024scc7/2024scc7.html");
  });

  it("does not turn a reporter citation into a neutral-citation URL", () => {
    native.matches = [{ ...neutral("SCC"), family: "reporter" }];
    expect(buildCanliiCaseUrlFromCitation(["[1997] 1 SCR 241"])).toBeNull();
  });
});

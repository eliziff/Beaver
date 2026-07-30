import { describe, expect, it } from "vitest";
import { classifyCitatorExcerpt } from "../citatorExcerpts";

// Real edge excerpts from the 2026-07-30 full citator build (random
// sample probe recorded in the research plan / session log).
const AUTHORITY_LISTS = [
  "6 SCC 14, [2016] 1 S.C.R. 180; R. v. Malmo‑Levine, 2003 SCC 74, [2003] 3 S.C.R. 571; R. v. Bissonnette, 2022 SCC 23; R. v. Boudreault, 2018 SCC 58, [2018] 3 S.C.R. 599; R. v. Hills, 2023 SCC 2; R. v. Lloyd, 2016 SCC 13,",
  "; R. v. Marakah, 2017 SCC 59, [2017] 2 S.C.R. 608; R. v. Spencer, 2014 SCC 43, [2014] 2 S.C.R. 212; R. v. Patrick, 2009 SCC 17, [2009] 1 S.C.R. 579; R. v. Ward, 2012 ONCA 660, 112 O.R. (3d) 321; R. v. Wong, [1990] 3 S.C.",
  "1045; R. v. Goltz, [1991] 3 S.C.R. 485; R. v. Nasogaluak, 2010 SCC 6, [2010] 1 S.C.R. 206; R. v. Guiller (1985), 48 C.R. (3d) 226; Steele v. Mountain Institution, [1990] 2 S.C.R. 1385; R. v. Luxton, [1990] 2 S.C.R. 711;",
];

const PROSE = [
  "succeed on this appeal it needs to adduce fresh evidence to show a sheriff would have become available. [27] That a precipitous stay was not an appropriate disposition of the charge",
  "ct proceeding was a derivative action, if leave to bring one were obtained. [42] The judge considered the overlap between the oppression remedy and a derivative action as discussed",
  "elling and other efforts Mr. Watson has made towards rehabilitation since sentence was imposed is properly a matter for correctional authorities outside of very exceptional circums",
];

// Prose that ends in a short supporting cite — usable, but not pure prose.
const MIXED =
  "elied upon, a stay may only be entered to prevent an abuse of process and is only to be granted in the clearest of cases: R. v. Babos, 2014 SCC 16 at paras. 30-31; R. v. Regan, 200";

describe("classifyCitatorExcerpt", () => {
  it("classifies string-cite runs as authority_list with no prose window", () => {
    for (const excerpt of AUTHORITY_LISTS) {
      const result = classifyCitatorExcerpt(excerpt);
      expect(result.kind, excerpt.slice(0, 60)).toBe("authority_list");
      expect(result.proseWindow).toBeNull();
      expect(result.citeRuns).toBeGreaterThanOrEqual(3);
    }
  });

  it("classifies citing prose as prose with a usable window", () => {
    for (const excerpt of PROSE) {
      const result = classifyCitatorExcerpt(excerpt);
      expect(result.kind, excerpt.slice(0, 60)).toBe("prose");
      expect(result.proseWindow).toBeTruthy();
      expect(result.proseWindow!.length).toBeGreaterThan(40);
    }
  });

  it("classifies prose-then-cites as mixed and extracts the prose part", () => {
    const result = classifyCitatorExcerpt(MIXED);
    expect(result.kind).toBe("mixed");
    expect(result.proseWindow).toContain("abuse of process");
    expect(result.proseWindow).not.toContain("SCC");
  });

  it("trims the mid-word truncation artifacts of excerpt windows", () => {
    const result = classifyCitatorExcerpt(PROSE[0]);
    // window starts mid-word ("succeed" is intact but the leading token
    // of the raw excerpt may not be) — first word of the window must be
    // a whole word from the excerpt's interior
    expect(result.proseWindow!.startsWith("on this appeal")).toBe(true);
  });

  it("refuses short excerpts with a typed verdict", () => {
    const result = classifyCitatorExcerpt("R. v. Babos, 2014 SCC 16");
    expect(result.kind).toBe("insufficient");
    expect(result.rule).toBe("shorter_than_min_excerpt");
  });
});

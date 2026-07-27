import { describe, expect, it } from "vitest";
import { CITATIONS_OPEN_TAG } from "./citations";
import { createVisibleStreamSplitter } from "./visibleStream";

function harness() {
  const visible: string[] = [];
  const hidden: string[] = [];
  let opened = 0;
  const splitter = createVisibleStreamSplitter({
    onVisible: (t) => visible.push(t),
    onOpen: () => (opened += 1),
    onHidden: (t) => hidden.push(t),
  });
  return { splitter, visible, hidden, opened: () => opened };
}

describe("createVisibleStreamSplitter", () => {
  it("passes plain prose through, flushing the held tail at the end", () => {
    const h = harness();
    h.splitter.push("Hello ");
    h.splitter.push("world.");
    const tail = h.splitter.takeTail();
    expect(h.visible.join("") + tail).toBe("Hello world.");
    expect(h.hidden).toEqual([]);
    expect(h.opened()).toBe(0);
  });

  it("splits visible from hidden when the marker arrives in one chunk", () => {
    const h = harness();
    h.splitter.push(`Answer.${CITATIONS_OPEN_TAG}[{"ref":1}]`);
    expect(h.visible.join("")).toBe("Answer.");
    expect(h.hidden.join("")).toBe('[{"ref":1}]');
    expect(h.opened()).toBe(1);
    expect(h.splitter.takeTail()).toBe("");
  });

  it("detects a marker that straddles chunk boundaries", () => {
    const h = harness();
    const mid = Math.floor(CITATIONS_OPEN_TAG.length / 2);
    h.splitter.push(`Answer.${CITATIONS_OPEN_TAG.slice(0, mid)}`);
    h.splitter.push(`${CITATIONS_OPEN_TAG.slice(mid)}{"ref":1}`);
    expect(h.visible.join("")).toBe("Answer.");
    expect(h.hidden.join("")).toBe('{"ref":1}');
    expect(h.opened()).toBe(1);
  });

  it("reconstructs marker-prefix false positives losslessly without opening", () => {
    const h = harness();
    h.splitter.push("text <CIT");
    h.splitter.push("RUS> more");
    const tail = h.splitter.takeTail();
    expect(h.visible.join("") + tail).toBe("text <CITRUS> more");
    expect(h.hidden).toEqual([]);
    expect(h.opened()).toBe(0);
  });

  it("routes everything after open to hidden and reset() rearms it", () => {
    const h = harness();
    h.splitter.push(`${CITATIONS_OPEN_TAG}first`);
    h.splitter.push("second");
    expect(h.hidden.join("")).toBe("firstsecond");
    expect(h.splitter.open).toBe(true);
    h.splitter.reset();
    expect(h.splitter.open).toBe(false);
    h.splitter.push("fresh prose");
    expect(h.visible.join("") + h.splitter.takeTail()).toBe("fresh prose");
  });
});

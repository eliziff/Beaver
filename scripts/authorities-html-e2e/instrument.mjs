// Runs in the page before Authorities starts: performance observers for long tasks, layout
// shifts and input-to-paint (Event Timing), text-selection helpers for the review, and the file
// picker the test answers. Everything is reached through `window.__e2e`.
export function instrument() {
  const name = (element) => `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${
    element.classList.length ? `.${[...element.classList].slice(0, 2).join(".")}` : ""}${
    element.getAttribute("aria-label") ? `[${element.getAttribute("aria-label")}]` : ""}`;
  /** An element and its two nearest ancestors, so an anonymous div is still findable. */
  const describe = (node) => {
    if (!node || node.nodeType !== 1) return node ? node.nodeName : null;
    const chain = [];
    for (let element = node; element && chain.length < 3; element = element.parentElement) chain.unshift(name(element));
    return chain.join(" > ");
  };
  const record = { longTasks: [], shifts: [], events: [] };
  const observe = (type, map, options = {}) => {
    try { new PerformanceObserver((list) => { for (const entry of list.getEntries()) record[map.key].push(map.read(entry)); })
      .observe({ type, buffered: true, ...options }); } catch { /* unsupported entry type */ }
  };
  observe("longtask", { key: "longTasks", read: (entry) => ({ start: entry.startTime, duration: entry.duration }) });
  observe("layout-shift", { key: "shifts", read: (entry) => ({ start: entry.startTime, value: entry.value,
    recentInput: entry.hadRecentInput, sources: (entry.sources ?? []).map((source) => ({ node: describe(source.node),
      moved: [source.previousRect, source.currentRect].map(({ x, y, width, height }) => [x, y, width, height].map(Math.round).join(",")).join(" -> "),
      // The citation list grows and shrinks with the citations; its rows moving is that change, not a shift.
      list: !!source.node?.closest?.(".citation-outline") })) }) });
  observe("event", { key: "events", read: (entry) => ({ name: entry.name, start: entry.startTime,
    duration: entry.duration, target: describe(entry.target) }) }, { durationThreshold: 16 });

  /** Every visible text character under `root` with its node and offset, whitespace dropped, so
   *  a phrase matches however a PDF text layer or Word view splits it into runs. */
  const characters = (root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), items = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || parent.closest(".citation-overlay,[aria-hidden=true]")) continue;
      for (let offset = 0; offset < node.data.length; offset += 1)
        if (!/\s/u.test(node.data[offset])) items.push({ node, offset, char: node.data[offset] });
    }
    return items;
  };
  const SCOPE = ".citation-document .docx-view-container,.citation-document .pdf-text-layer,.citation-fallback>div";
  /** The DOM range of the `nth` occurrence of `phrase` in the review's document. */
  const find = (phrase, nth = 0) => {
    const roots = [...document.querySelectorAll(SCOPE)];
    const items = roots.flatMap(characters), text = items.map(({ char }) => char).join("");
    const needle = phrase.replace(/\s+/gu, "");
    let at = -1;
    for (let index = 0; index <= nth; index += 1) { at = text.indexOf(needle, at + 1); if (at < 0) break; }
    if (at < 0) throw new Error(`"${phrase}" is not in the document view`);
    const first = items[at], last = items[at + needle.length - 1], range = document.createRange();
    range.setStart(first.node, first.offset); range.setEnd(last.node, last.offset + 1);
    return range;
  };
  const select = (range) => { const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); };
  window.__e2e = {
    record,
    now: () => performance.now(),
    /** Entries that started inside [from, to). */
    window: (from, to) => Object.fromEntries(Object.entries(record).map(([key, items]) =>
      [key, items.filter(({ start }) => start >= from && start < to)])),
    select(phrase, nth) { select(find(phrase, nth)); return getSelection().toString(); },
    /** A caret `within` characters (spaces skipped) into the phrase. */
    caret(phrase, within, nth) {
      const range = find(phrase, nth), items = characters(range.commonAncestorContainer.nodeType === 1
        ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement);
      const start = items.findIndex(({ node, offset }) => node === range.startContainer && offset === range.startOffset);
      const target = items[start + within], caret = document.createRange();
      caret.setStart(target.node, target.offset); caret.collapse(true); select(caret);
    },
    rect(phrase, nth) { const { left, top, width, height } = find(phrase, nth).getBoundingClientRect(); return { left, top, width, height }; },
    /** The first and last character boxes of the phrase, for a pointer to select it. */
    ends(phrase, nth, prefix) {
      // `prefix` characters (spaces skipped) of the phrase, when only its start is wanted.
      const range = find(phrase, nth);
      if (prefix) { const characters = []; let node = range.startContainer, offset = range.startOffset;
        const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
        walker.currentNode = node;
        while (node && characters.length < prefix) {
          for (; offset < node.data.length && characters.length < prefix; offset += 1)
            if (!/\s/u.test(node.data[offset])) characters.push([node, offset]);
          node = walker.nextNode(); offset = 0;
        }
        range.setEnd(characters.at(-1)[0], characters.at(-1)[1] + 1);
      }
      // A reader scrolls a phrase into view before pointing at it.
      const { top, bottom } = range.getBoundingClientRect(), holder = range.startContainer.parentElement;
      const view = (holder.closest(".docx-view-scroll,.beaver-pdf-scroll,.citation-fallback>div") ?? document.documentElement).getBoundingClientRect();
      if (top < Math.max(0, view.top) || bottom > Math.min(innerHeight, view.bottom)) holder.scrollIntoView({ block: "center" });
      const box = (node, offset) => {
        const character = document.createRange(); character.setStart(node, offset); character.setEnd(node, offset + 1);
        const { left, top, right, bottom } = character.getBoundingClientRect(); return { left, top, right, bottom };
      };
      return { first: box(range.startContainer, range.startOffset), last: box(range.endContainer, range.endOffset - 1) };
    },
    clear() { getSelection().removeAllRanges(); },
  };
  // The page's file picker. On a file:// page Chrome has no origin-private storage, so the page
  // uses its <input type=file> path; served over http, the picker returns real file handles,
  // written to origin-private storage, for the files the test stages in `__e2ePick`.
  if (location.protocol === "file:") delete window.showOpenFilePicker;
  else window.showOpenFilePicker = async () => {
    const staged = window.__e2ePick; window.__e2ePick = null;
    if (!staged) throw new DOMException("The user aborted a request.", "AbortError");
    const root = await navigator.storage.getDirectory();
    return Promise.all(staged.map(async ({ name, base64 }) => {
      const handle = await root.getFileHandle(name, { create: true }), writable = await handle.createWritable();
      await writable.write(Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))); await writable.close();
      return handle;
    }));
  };
}

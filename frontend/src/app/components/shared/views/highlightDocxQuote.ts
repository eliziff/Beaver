import { normalizeQuoteText, strippedToOriginal } from "./quoteText";

const HIGHLIGHT_CLASS = "docx-text-highlight";
const IGNORED_TEXT_SELECTOR = ".star-pagination,.case-page-number";
function collectTextNodes(root: HTMLElement): Text[] {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node: Node) {
            const p = node.parentElement;
            if (!p) return NodeFilter.FILTER_REJECT;
            const tag = p.tagName;
            if (tag === "STYLE" || tag === "SCRIPT")
                return NodeFilter.FILTER_REJECT;
            if (p.closest(IGNORED_TEXT_SELECTOR))
                return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        },
    });
    const out: Text[] = [];
    let cur = walker.nextNode() as Text | null;
    while (cur) {
        out.push(cur);
        cur = walker.nextNode() as Text | null;
    }
    return out;
}
export function clearDocxQuoteHighlights(root: HTMLElement): void {
    root.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach((span) => {
        const parent = span.parentNode;
        if (!parent) return;
        while (span.firstChild) parent.insertBefore(span.firstChild, span);
        parent.removeChild(span);
    });
    root.normalize();
}
export function highlightDocxQuote(
    root: HTMLElement,
    quote: string,
): HTMLElement | null {
    return highlightDocxQuotes(root, [quote])[0] ?? null;
}

/** Highlight every verified text directive from one index of the rendered text. */
export function highlightDocxQuotes(
    root: HTMLElement,
    quotes: readonly (string | { quote: string; locator?: string; color?: string })[],
): Array<HTMLElement | null> {
    clearDocxQuoteHighlights(root);
    const matches = quotes.map(() => null as HTMLElement | null);
    if (!quotes.some(Boolean)) return matches;
    const scoped = quotes.some((quote) => typeof quote !== "string");
    const textNodes = collectTextNodes(root), ranges = textNodes.map(() => [] as Array<{
        start: number; end: number; quoteIndex: number;
    }>);
    const nodeStartInFull: number[] = [], locators = new Map<string, [number, number]>();
    const nodeStrippedLen: number[] = [];
    let fullStripped = "";
    for (const node of textNodes) {
        const stripped = normalizeQuoteText(node.data);
        const start = fullStripped.length;
        nodeStartInFull.push(start);
        nodeStrippedLen.push(stripped.length);
        fullStripped += stripped;
        const locator = scoped
            ? node.parentElement?.closest<HTMLElement>("[data-locator-value]")?.dataset.locatorValue : undefined;
        if (locator) locators.set(locator, [locators.get(locator)?.[0] ?? start, fullStripped.length]);
    }
    const firstNodeAt = (position: number) => {
        let low = 0, high = textNodes.length;
        while (low < high) { const middle = (low + high) >>> 1;
            if (nodeStartInFull[middle] + nodeStrippedLen[middle] <= position) low = middle + 1;
            else high = middle; }
        return low;
    };
    const locatorBounds = (value: string) => {
        let bounds = locators.get(value);
        for (let split = value.indexOf("-"); !bounds && split > 0;
            split = value.indexOf("-", split + 1)) {
            const first = locators.get(value.slice(0, split)), last = locators.get(value.slice(split + 1));
            if (first && last) bounds = [first[0], last[1]];
        }
        return bounds;
    };
    quotes.forEach((input, quoteIndex) => {
      const quote = typeof input === "string" ? input : input.quote;
      const bounds = typeof input === "string" || !input.locator ? [0, fullStripped.length] : locatorBounds(input.locator);
      if (!bounds) return;
      quote.split(/\.{3}|…/).map(normalizeQuoteText).filter(Boolean).forEach((segment) => {
        const matchPos = fullStripped.indexOf(segment, bounds[0]);
        const matchEnd = matchPos + segment.length;
        if (matchPos < 0 || matchEnd > bounds[1]) return;
        for (let i = firstNodeAt(matchPos); i < textNodes.length && nodeStartInFull[i] < matchEnd; i++) {
            const start = nodeStartInFull[i];
            const end = start + nodeStrippedLen[i];
            if (matchPos >= end || matchEnd <= start) continue;
            const localStart = Math.max(0, matchPos - start);
            const localEnd = Math.min(nodeStrippedLen[i], matchEnd - start);
            const text = textNodes[i].data;
            const origStart = strippedToOriginal(text, localStart);
            const origEnd = strippedToOriginal(text, localEnd);
            if (origStart >= origEnd) continue;
            ranges[i].push({ start: origStart, end: origEnd, quoteIndex });
        }
      });
    });
    ranges.forEach((items, index) => {
        if (!items.length) return;
        const node = textNodes[index], text = node.data,
            points = [...new Set(items.flatMap(({ start, end }) => [start, end]))].sort((a, b) => a - b),
            fragment = document.createDocumentFragment();
        let cursor = points[0];
        node.data = text.slice(0, cursor);
        for (let at = 0; at < points.length - 1; at++) {
            const start = points[at], end = points[at + 1];
            if (cursor < start) fragment.append(text.slice(cursor, start));
            let child: Node = document.createTextNode(text.slice(start, end));
            for (const quoteIndex of new Set(items.filter((item) => item.start <= start && item.end >= end)
              .map((item) => item.quoteIndex))) {
                const span = document.createElement("span");
                span.className = HIGHLIGHT_CLASS; span.dataset.qspan = String(quoteIndex);
                const input = quotes[quoteIndex], color = typeof input === "string" ? undefined : input.color;
                if (color && /^#[\da-f]{6}$/iu.test(color)) {
                    span.style.setProperty("background-color", `${color}59`, "important");
                    span.style.borderBottom = `3px solid ${color}`;
                }
                span.append(child); child = span; matches[quoteIndex] ??= span;
            }
            fragment.append(child); cursor = end;
        }
        if (cursor < text.length) fragment.append(text.slice(cursor));
        node.after(fragment);
    });
    return matches;
}

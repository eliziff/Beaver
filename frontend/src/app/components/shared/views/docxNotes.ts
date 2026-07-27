/**
 * Correct footnote/endnote rendering on top of `docx-preview`.
 *
 * docx-preview gets four things wrong for note-heavy legal documents:
 *
 *   1. Reference numbers come from a per-page counter that `renderSections`
 *      resets on every rendered page (`currentFootnoteIds = []`), so the
 *      markers restart at 1 on each page instead of running continuously.
 *   2. `w:footnoteRef` — the note's own label, printed at the head of the
 *      note body — has no `DomType` and is dropped during parsing, so the
 *      note area shows unlabelled text.
 *   3. Nothing carries an id, so a reference cannot be linked to its note
 *      (or back), and a note referenced from more than one page is emitted
 *      once per page.
 *   4. `w:customMarkFollows` is dropped too. A reference carrying it prints
 *      an author-supplied symbol — held in the run right after it — instead
 *      of an auto number, and does not consume one. Numbering every
 *      reference therefore shifts the whole document by one.
 *
 * Instead of forking the library we tag its parsed model with bookmark
 * nodes — which docx-preview renders as empty `<span id>` — and swap those
 * spans for real anchors once the DOM exists. Two linear passes, no
 * re-parse of the zip, no extra dependency.
 *
 * Numbering is continuous across the whole document, which is Word's
 * default (`w:footnotePr/w:numRestart` = "continuous"). Per-section and
 * per-page restarts are deliberately not modelled: docx-preview's "pages"
 * come from the `w:lastRenderedPageBreak` hints Word saved during its last
 * layout, so a per-page restart derived from them would be a guess.
 */

const REF_MARK = "dxnr-";
const BODY_MARK = "dxnb-";
/** `<mark prefix><n|c auto-number flag><f|e kind><seq>-<note id>` */
const REF_ID = /^dxnr-([nc])([fe])\d+-(.+)$/;
/** `<mark prefix><n|c auto-number flag><f|e kind>-<note id>` */
const BODY_ID = /^dxnb-([nc])([fe])-(.+)$/;

interface ModelNode {
    type?: string;
    id?: string;
    name?: string;
    noteType?: string;
    children?: ModelNode[];
}

interface RawPart {
    path?: string;
    _package?: { load(path: string): Promise<unknown> };
}

export interface DocxNoteModel {
    documentPart?: RawPart & { body?: ModelNode };
    footnotesPart?: { notes?: ModelNode[] };
    endnotesPart?: { notes?: ModelNode[] };
}

/**
 * `f-12` / `e-3` for every reference Word marks with a custom symbol.
 * Read straight from `document.xml` because docx-preview's parser drops
 * the attribute; absence of the attribute (the overwhelmingly common case,
 * and the safe default for documents produced by non-Word tooling) means
 * "auto-numbered".
 */
async function customMarkedNotes(doc: DocxNoteModel): Promise<Set<string>> {
    const marked = new Set<string>();
    const part = doc.documentPart;
    if (!part?.path || !part._package) return marked;
    const xml: unknown = await part._package.load(part.path).catch(() => null);
    if (typeof xml !== "string") return marked;
    for (const match of xml.matchAll(
        /<w:(footnote|endnote)Reference\b[^>]*>/g,
    )) {
        if (!/\bw:customMarkFollows="(?:1|true|on)"/.test(match[0])) continue;
        const id = /\bw:id="(-?\d+)"/.exec(match[0])?.[1];
        if (id) marked.add(`${match[1][0]}-${id}`);
    }
    return marked;
}

/**
 * Mark every note reference and note body in a freshly parsed document.
 * Call once per parsed document, before rendering.
 */
export async function tagDocxNotes(doc: DocxNoteModel): Promise<void> {
    const custom = await customMarkedNotes(doc);
    const flagFor = (key: string) => (custom.has(key) ? "c" : "n");

    let seq = 0;
    const tag = (nodes: ModelNode[]): ModelNode[] => {
        // Copy-on-write: untouched subtrees keep their original array.
        let out: ModelNode[] | null = null;
        for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];
            const kind =
                node.type === "footnoteReference"
                    ? "f"
                    : node.type === "endnoteReference"
                      ? "e"
                      : null;
            if (kind) {
                const key = `${kind}-${node.id}`;
                out ??= nodes.slice(0, i);
                out.push({
                    type: "bookmarkStart",
                    name: `${REF_MARK}${flagFor(key)}${kind}${seq++}-${node.id}`,
                });
            } else if (node.children?.length) {
                node.children = tag(node.children);
            }
            out?.push(node);
        }
        return out ?? nodes;
    };

    const body = doc.documentPart?.body;
    if (body?.children) body.children = tag(body.children);

    for (const [kind, notes] of [
        ["f", doc.footnotesPart?.notes],
        ["e", doc.endnotesPart?.notes],
    ] as const) {
        for (const note of notes ?? []) {
            // `separator` / `continuationSeparator` notes are structural and
            // never referenced, so they are never rendered either.
            if (note.noteType) continue;
            const first = note.children?.[0];
            if (first?.type !== "paragraph") continue;
            // Word writes `w:footnoteRef` at the head of the first paragraph;
            // put the label back in the same place.
            (first.children ??= []).unshift({
                type: "bookmarkStart",
                name: `${BODY_MARK}${flagFor(`${kind}-${note.id}`)}${kind}-${note.id}`,
            });
        }
    }
}

/**
 * Turn the markers left by {@link tagDocxNotes} into numbered, linked
 * references and note labels. Safe to call on output that was never
 * tagged (it simply finds nothing).
 */
export function linkDocxNotes(container: HTMLElement): void {
    const doc = container.ownerDocument;
    const numbers = new Map<string, number>();
    const counters: Record<string, number> = { f: 0, e: 0 };

    // References, in document order — this is what makes numbering continuous.
    for (const mark of container.querySelectorAll<HTMLElement>(
        `span[id^="${REF_MARK}"]`,
    )) {
        const parsed = REF_ID.exec(mark.id);
        const sup = mark.nextElementSibling;
        mark.remove();
        if (!parsed || sup?.tagName !== "SUP") continue;
        const [, flag, kind, noteId] = parsed;
        // A custom-marked reference prints the author's symbol, which lives
        // in the run right after it — drop docx-preview's invented number.
        if (flag === "c") {
            sup.remove();
            continue;
        }

        const key = `${kind}-${noteId}`;
        let number = numbers.get(key);
        const firstUse = number === undefined;
        if (firstUse) {
            number = ++counters[kind];
            numbers.set(key, number);
        }
        sup.textContent = String(number);
        const link = doc.createElement("a");
        link.className = "docx-note-ref";
        link.href = `#docx-note-${key}`;
        // Only the first reference is a link target, so a note's back-link
        // always lands on the marker Word would have numbered it from.
        if (firstUse) link.id = `docx-noteref-${key}`;
        sup.replaceWith(link);
        link.appendChild(sup);
    }

    // Note bodies.
    const rendered = new Set<string>();
    const lists = new Set<HTMLElement>();
    for (const mark of container.querySelectorAll<HTMLElement>(
        `span[id^="${BODY_MARK}"]`,
    )) {
        const parsed = BODY_ID.exec(mark.id);
        const item = mark.closest("li");
        if (!parsed || !item) {
            mark.remove();
            continue;
        }
        const [, flag, kind, noteId] = parsed;
        const key = `${kind}-${noteId}`;
        if (item.parentElement) lists.add(item.parentElement);
        // docx-preview repeats a note on every page that references it.
        if (rendered.has(key)) {
            item.remove();
            continue;
        }
        rendered.add(key);
        const number = numbers.get(key);
        if (flag === "c" || number === undefined) {
            // Custom-marked notes already carry their symbol as body text.
            mark.remove();
            continue;
        }
        item.id = `docx-note-${key}`;
        const label = doc.createElement("a");
        label.className = "docx-note-label";
        label.href = `#docx-noteref-${key}`;
        label.textContent = String(number);
        mark.replaceWith(label);
    }

    for (const list of lists) {
        if (list.childElementCount === 0) list.remove();
        else list.classList.add("docx-notes");
    }
}

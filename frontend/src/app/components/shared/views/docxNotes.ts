const REF_MARK = "dxnr-";
const BODY_MARK = "dxnb-";
const REF_ID = /^dxnr-([nc])([fe])\d+-(.+)$/;
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
export async function tagDocxNotes(doc: DocxNoteModel): Promise<void> {
    const custom = await customMarkedNotes(doc);
    const flagFor = (key: string) => (custom.has(key) ? "c" : "n");
    let seq = 0;
    const tag = (nodes: ModelNode[]): ModelNode[] => {
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
            if (note.noteType) continue;
            const first = note.children?.[0];
            if (first?.type !== "paragraph") continue;
            (first.children ??= []).unshift({
                type: "bookmarkStart",
                name: `${BODY_MARK}${flagFor(`${kind}-${note.id}`)}${kind}-${note.id}`,
            });
        }
    }
}
export function linkDocxNotes(container: HTMLElement): void {
    const doc = container.ownerDocument;
    const numbers = new Map<string, number>();
    const counters: Record<string, number> = { f: 0, e: 0 };
    for (const mark of container.querySelectorAll<HTMLElement>(
        `span[id^="${REF_MARK}"]`,
    )) {
        const parsed = REF_ID.exec(mark.id);
        const sup = mark.nextElementSibling;
        mark.remove();
        if (!parsed || sup?.tagName !== "SUP") continue;
        const [, flag, kind, noteId] = parsed;
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
        if (firstUse) link.id = `docx-noteref-${key}`;
        sup.replaceWith(link);
        link.appendChild(sup);
    }
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
        if (rendered.has(key)) {
            item.remove();
            continue;
        }
        rendered.add(key);
        const number = numbers.get(key);
        if (flag === "c" || number === undefined) {
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

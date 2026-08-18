/**
 * Shared OOXML kernel: the fast-xml-parser preserveOrder settings, the tiny
 * node helpers built on that tree shape, and package entry access. All DOCX
 * consumers share it so OOXML text and attribute semantics stay identical.
 */

import { XMLParser, XMLBuilder } from "fast-xml-parser";

/** preserveOrder node: `{ [name]: children[] }`, attrs under ":@", text "#text". */
export type XNode = Record<string, unknown>;

export const ATTR_KEY = ":@";
export const TEXT_KEY = "#text";

export function elName(n: unknown): string | null {
    if (!n || typeof n !== "object") return null;
    for (const k of Object.keys(n as XNode)) {
        if (k === ATTR_KEY || k === TEXT_KEY) continue;
        return k;
    }
    return null;
}

export function isTextNode(n: unknown): n is { [TEXT_KEY]: string } {
    if (!n || typeof n !== "object") return false;
    const obj = n as XNode;
    return TEXT_KEY in obj && elName(n) === null;
}

export function elChildren(n: unknown): XNode[] {
    const name = elName(n);
    if (!name) return [];
    const v = (n as XNode)[name];
    return Array.isArray(v) ? (v as XNode[]) : [];
}

export function setChildren(n: XNode, children: XNode[]): void {
    const name = elName(n);
    if (!name) return;
    n[name] = children;
}

export function elAttrs(n: unknown): Record<string, string> {
    if (!n || typeof n !== "object") return {};
    const a = (n as XNode)[ATTR_KEY];
    return (a as Record<string, string>) ?? {};
}

export function makeEl(
    name: string,
    children: XNode[] = [],
    attrs?: Record<string, string>,
): XNode {
    const el: XNode = { [name]: children };
    if (attrs) {
        const attrObj: Record<string, string> = {};
        for (const [k, v] of Object.entries(attrs)) {
            attrObj[`@_${k}`] = v;
        }
        el[ATTR_KEY] = attrObj;
    }
    return el;
}

export function makeText(s: string): XNode {
    return { [TEXT_KEY]: s };
}

export function getTextContent(wtEl: XNode): string {
    // A w:t node has only a single text child (or nothing).
    const kids = elChildren(wtEl);
    let out = "";
    for (const k of kids) {
        if (isTextNode(k)) out += String(k[TEXT_KEY] ?? "");
    }
    return out;
}

export function cloneNode<T>(n: T): T {
    return JSON.parse(JSON.stringify(n)) as T;
}

export function createParser() {
    return new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "@_",
        preserveOrder: true,
        trimValues: false,
        // Word text nodes are strings even when a run happens to contain
        // only "1.0", "001", or another numeric-looking token. Letting the
        // XML parser coerce them corrupts numbering and leading zeroes when
        // tracked edits split a paragraph into smaller runs.
        parseTagValue: false,
        parseAttributeValue: false,
        processEntities: true,
    });
}

export function createBuilder() {
    return new XMLBuilder({
        ignoreAttributes: false,
        attributeNamePrefix: "@_",
        preserveOrder: true,
        suppressEmptyNode: false,
        processEntities: true,
    });
}

export function ensureXmlDeclaration(xml: string): string {
    if (xml.startsWith("<?xml")) return xml;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${xml}`;
}

/** The w:body element itself. */
export function findBody(doc: XNode[]): XNode | null {
    for (const top of doc) {
        if (elName(top) === "w:document") {
            for (const c of elChildren(top)) {
                if (elName(c) === "w:body") return c;
            }
        }
    }
    return null;
}

// Package bounds enforced by the canonical session before parts are read.
export const MAX_DRAFTING_DOCX_BYTES = 25 * 1024 * 1024;
export const MAX_DRAFTING_XML_ENTRY_BYTES = 16 * 1024 * 1024;

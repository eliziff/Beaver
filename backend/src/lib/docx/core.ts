/**
 * Shared OOXML kernel: the fast-xml-parser preserveOrder settings, the tiny
 * node helpers built on that tree shape, and package entry access.
 *
 * Extracted verbatim from docxTrackedChanges / docxCompareVersions /
 * docxDeterministicCleanup — byte-parity constraint: every helper here
 * behaves exactly as the copies it replaces. Extraction, not redesign.
 */

import type JSZip from "jszip";
import { XMLParser, XMLBuilder } from "fast-xml-parser";
import { loadZip } from "../zip";

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

/** Callers that splice the body in place need the node; callers that only
 *  read blocks need its children — both shapes existed, so both are kept. */
export function findBodyChildren(doc: XNode[]): XNode[] | null {
    const body = findBody(doc);
    return body ? elChildren(body) : null;
}

/** Max w:id across existing w:ins/w:del so fresh ids never collide. */
export function maxTrackedId(doc: XNode[]): number {
    let max = 0;
    const visit = (n: unknown) => {
        const name = elName(n);
        if (!name) return;
        if (name === "w:ins" || name === "w:del") {
            const raw = elAttrs(n)["@_w:id"];
            if (raw != null) {
                const v = parseInt(String(raw), 10);
                if (Number.isFinite(v) && v > max) max = v;
            }
        }
        for (const c of elChildren(n as XNode)) visit(c);
    };
    for (const top of doc) visit(top);
    return max;
}

// Package bounds shared by the drafting-source extractor and every docx/*
// scanner (pathology, stories, numbering, redline). They live in the kernel
// so docx/* modules never import from docxDraftingSource — which itself
// imports from this kernel; that cycle blocked drafting-source-consumes-stories.
export const MAX_DRAFTING_DOCX_BYTES = 25 * 1024 * 1024;
export const MAX_DRAFTING_XML_ENTRY_BYTES = 16 * 1024 * 1024;

// Some older Windows/Word archives store entries with backslash path
// separators (e.g. `word\document.xml`) even though the zip spec requires
// forward slashes. JSZip looks up entries by exact string, so
// `zip.file("word/document.xml")` misses those files. These helpers accept
// the canonical forward-slash form and transparently fall back to the
// backslash variant for both reads and writes.

export function getZipEntry(zip: JSZip, pathSlash: string) {
    const direct = zip.file(pathSlash);
    if (direct) return direct;
    return zip.file(pathSlash.replace(/\//g, "\\"));
}

export function setZipEntry(
    zip: JSZip,
    pathSlash: string,
    content: string | Buffer,
): void {
    const backslash = pathSlash.replace(/\//g, "\\");
    // If the archive already stores the entry under backslashes, keep it
    // there so we don't emit both variants side by side.
    if (!zip.file(pathSlash) && zip.file(backslash)) {
        zip.file(backslash, content);
        return;
    }
    zip.file(pathSlash, content);
}

/** Open a .docx package (JSZip stays lazily required — see lib/zip). */
export function loadDocxPackage(
    bytes: Buffer | Uint8Array | ArrayBuffer,
): Promise<JSZip> {
    return loadZip(bytes);
}

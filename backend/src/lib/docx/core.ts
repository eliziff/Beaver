import { XMLBuilder, XMLParser } from "fast-xml-parser";

/** preserveOrder node: element children under its name, attrs under :@. */
export type XNode = Record<string, unknown>;
export const ATTR_KEY = ":@", TEXT_KEY = "#text";

export function elName(node: unknown): string | null {
  if (!node || typeof node !== "object") return null;
  return Object.keys(node as XNode).find((key) =>
    key !== ATTR_KEY && key !== TEXT_KEY) ?? null;
}

export function isTextNode(node: unknown): node is { [TEXT_KEY]: string } {
  return !!node && typeof node === "object" && TEXT_KEY in node && elName(node) === null;
}

export function elChildren(node: unknown): XNode[] {
  const name = elName(node);
  const value = name && (node as XNode)[name];
  return Array.isArray(value) ? value as XNode[] : [];
}

export function setChildren(node: XNode, children: XNode[]) {
  const name = elName(node);
  if (name) node[name] = children;
}

export function elAttrs(node: unknown): Record<string, string> {
  return node && typeof node === "object"
    ? (node as XNode)[ATTR_KEY] as Record<string, string> ?? {} : {};
}

export function makeEl(name: string, children: XNode[] = [],
  attrs?: Record<string, string>): XNode {
  const node: XNode = { [name]: children };
  if (attrs) node[ATTR_KEY] = Object.fromEntries(
    Object.entries(attrs).map(([key, value]) => [`@_${key}`, value]));
  return node;
}

export const makeText = (value: string): XNode => ({ [TEXT_KEY]: value });
export const getTextContent = (node: XNode) => elChildren(node)
  .flatMap((child) => isTextNode(child) ? [String(child[TEXT_KEY] ?? "")] : []).join("");
export const cloneNode = <T>(node: T): T => JSON.parse(JSON.stringify(node)) as T;

const XML_OPTIONS = {
  ignoreAttributes: false, attributeNamePrefix: "@_", preserveOrder: true,
  trimValues: false, parseTagValue: false, parseAttributeValue: false,
  processEntities: true,
} as const;
export const createParser = () => new XMLParser(XML_OPTIONS);
export const createBuilder = () => new XMLBuilder({ ...XML_OPTIONS,
  suppressEmptyNode: false });

export const ensureXmlDeclaration = (xml: string) => xml.startsWith("<?xml")
  ? xml : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${xml}`;

export function findBody(document: XNode[]): XNode | null {
  const root = document.find((node) => elName(node) === "w:document");
  return root ? elChildren(root).find((node) => elName(node) === "w:body") ?? null : null;
}

export function isRedFamily(value: string) {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(value.trim());
  if (!match) return false;
  const [red, green, blue] = match.slice(1).map((part) => Number.parseInt(part, 16));
  return red >= 0xb0 && green <= 0x60 && blue <= 0x60;
}

// Package bounds enforced by the canonical session before parts are read.
export const MAX_DRAFTING_DOCX_BYTES = 25 * 1024 * 1024;
export const MAX_DRAFTING_XML_ENTRY_BYTES = 16 * 1024 * 1024;

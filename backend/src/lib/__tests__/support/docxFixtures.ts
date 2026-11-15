import { Document, Packer, type IPropertiesOptions, type ISectionOptions } from "docx";
import { XMLBuilder, XMLParser } from "fast-xml-parser";
import JSZip from "jszip";

/** preserveOrder node: element children under its name, attrs under :@. */
export type XNode = Record<string, unknown>;

export const elName = (node: unknown): string | null =>
  node && typeof node === "object"
    ? Object.keys(node).find((key) => key !== ":@" && key !== "#text") ?? null : null;

export function elChildren(node: unknown): XNode[] {
  const name = elName(node);
  const value = name && (node as XNode)[name];
  return Array.isArray(value) ? value as XNode[] : [];
}

export function setChildren(node: XNode, children: XNode[]) {
  const name = elName(node);
  if (name) node[name] = children;
}

export function makeEl(name: string, children: XNode[] = [], attrs?: Record<string, string>): XNode {
  const node: XNode = { [name]: children };
  if (attrs) node[":@"] = Object.fromEntries(
    Object.entries(attrs).map(([key, value]) => [`@_${key}`, value]));
  return node;
}

export function findBody(document: XNode[]): XNode | null {
  const root = document.find((node) => elName(node) === "w:document");
  return root ? elChildren(root).find((node) => elName(node) === "w:body") ?? null : null;
}

const XML_OPTIONS = {
  ignoreAttributes: false, attributeNamePrefix: "@_", preserveOrder: true,
  trimValues: false, parseTagValue: false, parseAttributeValue: false, processEntities: true,
} as const;
export const createParser = () => new XMLParser(XML_OPTIONS);
export const createBuilder = () => new XMLBuilder({ ...XML_OPTIONS, suppressEmptyNode: false });

export function docxBytes(
  children: ISectionOptions["children"],
  options: Omit<IPropertiesOptions, "sections"> = {},
  section: Omit<ISectionOptions, "children"> = {},
): Promise<Buffer> {
  return Packer.toBuffer(
    new Document({ ...options, sections: [{ ...section, children }] }),
  );
}

export async function docxXml(bytes: Buffer, name = "word/document.xml"): Promise<string> {
  const entry = (await JSZip.loadAsync(bytes)).file(name);
  if (!entry) throw new Error(`Missing ${name}`);
  return entry.async("string");
}

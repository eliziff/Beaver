import { Document, Packer, type IPropertiesOptions, type ISectionOptions } from "docx";
import JSZip from "jszip";

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

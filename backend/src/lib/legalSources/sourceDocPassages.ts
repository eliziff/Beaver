import { sha256 } from "../hash";
import {
  documentRevisionNative,
  documentTextNative,
  readDocumentRangeNative,
  type NativeDocument,
  type NativeDocumentBlock,
} from "../structureNative";
import type { LegalSourcePassage, LegalSourcePassageRequest, LegalSourceReference } from ".";

export function nativeDocumentPassages<Native extends object = never>(options: {
  request: LegalSourcePassageRequest;
  reference: LegalSourceReference;
  document: NativeDocument;
  native?: Native;
  revision?: string;
}): LegalSourcePassage<NativeDocument | NativeDocumentBlock, Native>[] {
  const { document, native, reference, request } = options;
  const documentRevision = documentRevisionNative(document);
  const revision = options.revision ?? documentRevision;
  if (!request.locator) {
    const text = documentTextNative(document);
    return [{ source: reference, locator: { requested: null, label: "document" },
      role: "document", text, textSha256: documentRevision,
      documentSha256: documentRevision, revision,
      blockArtifact: document, documentArtifact: document,
      ...(native ? { native } : {}) }];
  }
  const { locator } = request;
  const context = request.contextBlocks ?? 0;
  const range = readDocumentRangeNative(
    document, locator.kind, locator.value, locator.endValue ?? locator.value, context,
  );
  if (!range) return [];
  const groups = locator.endValue
    ? [[range.before, "context"], [range.selected, "selected"], [range.after, "context"]] as const
    : [[range.selected, "selected"], [range.before, "context"], [range.after, "context"]] as const;
  const seen = new Set<string>();
  return groups.flatMap(([units, role]) => units.flatMap((unit) => {
        const key = `${unit.kind}:${unit.start}:${unit.end}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [{
          source: reference,
          locator: { requested: locator, label: unit.label,
            anchor: unit.anchor ?? null, pageScoped: unit.kind === "page" },
          role,
          text: unit.text,
          textSha256: sha256(unit.text),
          documentSha256: documentRevision,
          revision,
          blockArtifact: unit,
          documentArtifact: document,
          ...(native ? { native } : {}),
        }];
      }));
}

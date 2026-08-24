import {
  structureNative,
  type NativeDocument,
} from "../structureNative";
import type { LegalSourcePassage, LegalSourcePassageRequest, LegalSourceReference } from ".";

export function nativeDocumentPassages<Native extends object = never>(options: {
  request: LegalSourcePassageRequest;
  reference: LegalSourceReference;
  document: NativeDocument;
  native?: Native;
}): LegalSourcePassage<Native>[] {
  const { document, native, reference, request } = options;
  if (!request.locator) {
    const text = structureNative().documentText(document);
    return [{ source: reference, locator: { requested: null, label: "document" },
      role: "document", text,
      documentArtifact: document,
      ...(native ? { native } : {}) }];
  }
  const { locator } = request;
  const context = request.contextBlocks ?? 0;
  const range = structureNative().readDocumentRange(
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
          blockArtifact: unit,
          documentArtifact: document,
          ...(native ? { native } : {}),
        }];
      }));
}

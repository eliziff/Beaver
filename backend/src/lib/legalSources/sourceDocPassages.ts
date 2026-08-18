import { sha256 } from "../hash";
import {
  readSourceDocRange,
  type SourceDoc,
  type SourceDocBlock,
  type SourceDocLocatorKind,
  type SourceDocLookup,
} from "../sourceDoc";
import type {
  LegalSourcePassage,
  LegalSourcePassageRequest,
  LegalSourceReference,
} from ".";

type NativeLookup = SourceDocLookup & { anchor?: string | null };

export function sourceDocPassages<
  Native extends object,
  Lookup extends NativeLookup,
>(options: {
  request: LegalSourcePassageRequest;
  reference: LegalSourceReference;
  document: SourceDoc;
  native: Native;
  revision?: string;
  lookup: (
    kind: SourceDocLocatorKind,
    value: string,
    contextBlocks: number,
  ) => Lookup | null;
}): LegalSourcePassage<SourceDoc | string, Native & { lookup?: Lookup }>[] {
  const { document, native, reference, request } = options;
  const revision = options.revision ?? document.revision;
  if (!request.locator) {
    return [{
      source: reference,
      locator: { requested: null, label: "document" },
      role: "document",
      text: document.text,
      textSha256: sha256(document.text),
      documentSha256: document.revision,
      revision,
      blockArtifact: document,
      documentArtifact: document,
      native,
    }];
  }
  const locator = request.locator;
  const lookup = options.lookup(
    locator.kind,
    locator.value,
    request.contextBlocks ?? 0,
  );
  if (lookup?.status !== "found" || !lookup.block) return [];
  const range = locator.endValue
    ? readSourceDocRange(
        document,
        locator.kind,
        locator.value,
        locator.endValue,
        request.contextBlocks ?? 0,
      )
    : null;
  if (locator.endValue && !range) return [];
  const visible: Array<{
    block: SourceDocBlock & { text: string };
    role: "selected" | "context";
  }> = range
    ? [
        ...range.before.map((block) => ({ block, role: "context" as const })),
        ...range.selected.map((block) => ({ block, role: "selected" as const })),
        ...range.after.map((block) => ({ block, role: "context" as const })),
      ]
    : [
        { block: lookup.block, role: "selected" },
        ...lookup.before.map((block) => ({ block, role: "context" as const })),
        ...lookup.after.map((block) => ({ block, role: "context" as const })),
      ];
  return visible.map(({ block, role }) => ({
    source: reference,
    locator: {
      requested: locator,
      label: block.label,
      anchor: block.anchor ?? (role === "selected" ? lookup.anchor : null),
      pageScoped: block.kind === "page",
    },
    role,
    text: block.text,
    textSha256: sha256(block.text),
    documentSha256: document.revision,
    revision,
    blockArtifact: block.text,
    documentArtifact: document,
    native: {
      ...native,
      lookup: {
        ...lookup,
        requestedLabel: block.label,
        matches: [block.label],
        block,
        before: [],
        after: [],
        anchor: block.anchor ?? null,
      } as Lookup,
    },
  }));
}

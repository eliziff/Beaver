import { lookupSourceDoc, type SourceDoc, type SourceDocBlock, type SourceDocLocatorKind } from "../../src/lib/sourceDoc";

export const SOURCE_DOC_KINDS: SourceDocLocatorKind[] = [
  "paragraph", "page", "section", "footnote",
];
export const SERIALIZER_CONTRACT = JSON.stringify({
  schema: "source-structure-parity.v1",
  document: ["provider", "id", "status", "mode", "revision", "text"],
  block: ["kind", "label", "start", "end", "origin", "anchor", "aliases", "parent_label"],
  ranges: SOURCE_DOC_KINDS,
  lookups: "every ordered block label, alias, and anchor; context=2; full materialized blocks",
});
export const SOURCE_DOC_BYTES_CONTRACT = JSON.stringify({
  schema: "source-doc-public-bytes.v1",
  serialization: "UTF-8 JSON.stringify(SourceDoc)",
  fields: ["provider", "id", "url", "docType", "status", "revision", "text", "blocks", "ranges"],
});

export function sourceDocMode(doc: SourceDoc) {
  const origins = new Set(doc.blocks.map(({ origin }) => origin));
  return origins.has("native")
    ? origins.has("heuristic") ? "hybrid" as const : "native" as const
    : "flat" as const;
}

function canonicalBlock(value: SourceDocBlock & { text?: string }) {
  return {
    kind: value.kind,
    label: value.label,
    start: value.start,
    end: value.end,
    origin: value.origin,
    anchor: value.anchor ?? null,
    aliases: value.aliases ?? [],
    parent_label: value.parentLabel ?? null,
    ...(value.text === undefined ? {} : { text: value.text }),
  };
}

export function canonicalSourceDocBytes(doc: SourceDoc) {
  const requests = new Map<string, { kind: SourceDocLocatorKind; value: string }>();
  for (const item of doc.blocks) {
    for (const value of [item.label, ...(item.aliases ?? []), item.anchor]) {
      if (value) requests.set(`${item.kind}\0${value}`, { kind: item.kind, value });
    }
  }
  const lookups = [...requests.values()]
    .sort((left, right) =>
      left.kind.localeCompare(right.kind) || left.value.localeCompare(right.value),
    )
    .map(({ kind, value }) => {
      const found = lookupSourceDoc(doc, kind, value, 2);
      return {
        kind,
        value,
        status: found.status,
        requested_label: found.requestedLabel,
        matches: found.matches,
        block: found.block ? canonicalBlock(found.block) : null,
        before: found.before.map(canonicalBlock),
        after: found.after.map(canonicalBlock),
      };
    });
  return Buffer.from(JSON.stringify({
    schema_version: "source-structure-parity.v1",
    provider: doc.provider,
    id: doc.id,
    status: doc.status,
    mode: sourceDocMode(doc),
    revision: doc.revision,
    text: doc.text,
    blocks: doc.blocks.map(canonicalBlock),
    ranges: Object.fromEntries(SOURCE_DOC_KINDS.map((kind) => [kind, doc.ranges[kind]])),
    lookups,
  }));
}

/** Exact public SourceDoc bytes for corpus-scale hashing; the lookup battery stays in fixture parity. */
export function sourceDocPublicBytes(doc: SourceDoc) {
  return Buffer.from(JSON.stringify(doc));
}

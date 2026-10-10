// A link an editor gives one citation, carried to the other citations of the same authority: its short forms,
// supras and ibids. Identity is the citation resolver's own (`occurrence.authorityId`, set as the draft is read),
// so the targets are whatever the resolver says cites that authority. The Word add-in, the standalone page and
// the viewer ask for the targets, confirm them with the editor, then save them with "set-occurrence-links".
import type { AuthoritiesDraft, AuthorityOccurrence } from "./authoritiesDomain";
import { legalSourceOperations } from "./legalSourceApplication";
import { buildLegalSourcePinpoint } from "./legalSourceLinks";
import type { LegalSourceReference } from "./legalSources";
import { structureNative } from "./structureNative";

export type LinkPropagationTarget = { occurrenceId: string; footnote: number | null;
  form: "full" | "short" | "supra" | "ibid"; url: string };

const ANCHOR = /#(par|sec)([^:#]*)$/u;
const openingWords = (text: string) => text.replace(/^\s*\[?\d+[\].]?\s+/u, "").trim().split(/\s+/u).slice(0, 12).join(" ");

/** The link for the origin itself, `url` re-anchored to its own pinpoint where it gives no anchor of its own, and the
 *  other citations of the origin's authority that have no link of their own, in reading order, each with
 *  `url` re-anchored to its own pinpoint (an own pinpoint replaces the inherited one, a bare supra drops it, an
 *  ibid keeps it). Where re-anchoring adds a paragraph or section anchor, the passage's opening words are added
 *  beside it as a text fragment when the authority's source text can be read. */
export async function linkPropagationTargets(draft: AuthoritiesDraft, originOccurrenceId: string, url: string,
  signal?: AbortSignal, sources: Pick<typeof legalSourceOperations, "readPassage"> = legalSourceOperations) {
  const origin = draft.occurrences[originOccurrenceId];
  if (!origin) throw new Error(`Unknown occurrence: ${originOccurrenceId}`);
  const authority = origin.authorityId ? draft.authorities[origin.authorityId] : undefined;
  if (!authority) return { url, targets: [] };
  const units = new Map(draft.units.map((unit) => [unit.id, unit]));
  const others = Object.values(draft.occurrences).filter((item) => item.id !== origin.id &&
    item.authorityId === authority.id && !item.link && units.has(item.unitId))
    .sort((a, b) => units.get(a.unitId)!.ordinal - units.get(b.unitId)!.ordinal || a.start - b.start);
  const sourceDocument = sourceReader(authority, sources, signal);
  const targets: LinkPropagationTarget[] = [];
  for (const occurrence of others) {
    signal?.throwIfAborted();
    const unit = units.get(occurrence.unitId)!;
    targets.push({ occurrenceId: occurrence.id, footnote: unit.kind === "footnote" ? unit.noteNumber ?? unit.footnoteId : null,
      form: occurrence.referenceKind ?? "full", url: await anchored(url, occurrence, sourceDocument) });
  }
  return { url: ANCHOR.test(url) ? url : await anchored(url, origin, sourceDocument), targets };
}

/** `fresh` (the draft read again from its edited document) with the links `draft` gave its citations: each goes to
 *  the citation of the same authority and form in the same note (the only one there), else to the only citation with
 *  the same words, re-anchored to that citation's own pinpoint as a carried link is. */
export async function carriedLinks(draft: AuthoritiesDraft, fresh: AuthoritiesDraft, signal?: AbortSignal,
  sources: Pick<typeof legalSourceOperations, "readPassage"> = legalSourceOperations) {
  const key = (state: AuthoritiesDraft, item: AuthorityOccurrence) => item.authorityId ? state.authorities[item.authorityId]?.key : undefined;
  const linked = Object.values(draft.occurrences).filter((item) => item.link);
  const documents = new Map<string, () => Promise<unknown>>();
  for (const item of Object.values(fresh.occurrences)) {
    signal?.throwIfAborted();
    if (item.link) continue;
    const same = linked.filter((old) => old.unitId === item.unitId && key(draft, old) && key(draft, old) === key(fresh, item)
      && (old.referenceKind ?? "full") === (item.referenceKind ?? "full"));
    const worded = linked.filter((old) => old.text === item.text);
    const old = same.length === 1 ? same[0] : worded.length === 1 ? worded[0] : undefined;
    if (!old) continue;
    if (old.text === item.text) { item.link = old.link; continue; }
    const id = item.authorityId ?? "";
    if (!documents.has(id)) documents.set(id, sourceReader(fresh.authorities[id], sources, signal));
    item.link = await anchored(old.link!, item, documents.get(id)!);
  }
  return fresh;
}

/** The authority's source text, read once when first asked for. */
function sourceReader(authority: AuthoritiesDraft["authorities"][string] | undefined,
  sources: Pick<typeof legalSourceOperations, "readPassage">, signal?: AbortSignal) {
  const identity = authority?.sourceIdentity;
  let document: Promise<unknown> | undefined;
  return () => document ??= authority && identity ? sources.readPassage({ source: { provider: identity.provider,
    id: identity.stableSourceId, kind: authority.kind === "commentary" ? "journal" : authority.kind, title: authority.name,
    citation: authority.citation, date: identity.version, url: identity.externalUrl } as LegalSourceReference, signal })
    .then((read) => read.status === "found" ? read.values[0]?.documentArtifact : undefined).catch(() => undefined)
    : Promise.resolve(undefined);
}

async function anchored(url: string, occurrence: AuthorityOccurrence, sourceDocument: () => Promise<unknown>) {
  const reanchored = structureNative().citationEngineCall("reanchorReference",
    JSON.stringify({ link: url, text: occurrence.text })) as unknown as string;
  const added = ANCHOR.exec(reanchored);
  if (!added || reanchored === url) return reanchored;
  const document = await sourceDocument() as Parameters<ReturnType<typeof structureNative>["readDocumentRange"]>[0] | undefined;
  const block = document && structureNative().readDocumentRange(document, added[1] === "par" ? "paragraph" : "section",
    added[2], added[2], 0)?.selected[0];
  const words = block ? openingWords(block.text) : "";
  // The anchor stays beside the fragment (belt and suspenders): the block's own, else the one re-anchoring added.
  const pinpoint = block && words && buildLegalSourcePinpoint({ url: reanchored, anchor: block.anchor ?? undefined,
    blockText: block.text, documentText: document }, [words]);
  return pinpoint && pinpoint.target.includes(":~:text=") ? pinpoint.target : reanchored;
}

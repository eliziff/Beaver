import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { legalSourceOperations } from "../legalSourceApplication";
import type { LegalSourcePassage, LegalSourceReference } from "../legalSources";
import { nativeDocumentPassages } from "../legalSources/nativeDocumentPassages";
import { structureNative } from "../structureNative";
import { createLegalEvidenceTurnState, legalSourceEvidence } from "../chat/legalEvidence";
import { researchSourceFromResource, researchSourceResource } from "../researchFile";
import { sha256 } from "../hash";
import { localAssistantToolRegistry } from "./support/localAssistantTools";
import type { BeaverOutcome } from "../chat/toolRegistry";
import { readResearchResource } from "../researchReader";
import type { DocumentStore } from "../documentStore";

afterEach(() => vi.restoreAllMocks());

function reader(passages: LegalSourcePassage[]) {
  vi.spyOn(legalSourceOperations, "readWithRenditions").mockImplementation(async (request) => ({
    status: "found", pdfRenditions: [], values: passages.filter(({ source }) =>
      !request.source.part || request.source.part === source.part).flatMap((passage) =>
      nativeDocumentPassages({ request, reference: passage.source,
        document: passage.documentArtifact, native: passage.native as object })),
  }));
  const state = createLegalEvidenceTurnState(), registry = localAssistantToolRegistry("local-user", {
    legalEvidence: state,
  });
  return { state, async read(input: Record<string, unknown>) {
    let outcome!: BeaverOutcome;
    const [result] = await registry.run([{ id: "read", name: "Read", input }], {}, undefined,
      (_call, value) => { outcome = value; });
    expect(result.status, result.content).toBe("ok");
    return { payload: JSON.parse(result.content), outcome };
  } };
}

it("starts captured numbered reasons at the first native paragraph and preserves locator receipts", async () => {
  const fixture = JSON.parse(await readFile(path.join(__dirname,
    "fixtures/sourcedoc/a2aj-case-scc-2014scc53-bracket.json"), "utf8"));
  const native = structureNative(), artifact = await native.deriveDocumentStructure({ kind: "provider_text",
    input: { provider: "a2aj", citation: fixture.citation, source_kind: "cases", text: fixture.text,
      dataset: fixture.dataset, name: fixture.name, alternate_citation: fixture.alternateCitation,
      require_report_start: true } });
  const source: LegalSourceReference = { provider: "a2aj", id: fixture.citation, kind: "case",
    title: fixture.name, citation: fixture.citation, collection: fixture.dataset, language: "en", url: fixture.url };
  const passage: LegalSourcePassage = { source, role: "document", locator: { requested: null, label: "document" },
    text: native.documentText(artifact), documentArtifact: artifact, native: {
      citation: fixture.citation, name: fixture.name, dataset: fixture.dataset, language: "en",
      url: fixture.url, native: artifact, searchNative: artifact, searchText: fixture.text,
    } };
  const first = native.documentAnchors(artifact).find(({ kind }) => kind === "paragraph")!;
  const { read } = reader([passage]), initial = await read({ file_path: researchSourceResource(source), limit: 3 });
  expect(initial.payload.sources[0]).toMatchObject({ title: fixture.name, citation: fixture.citation });
  expect(initial.payload.passages[0].text).toBe(native.readDocumentTextRange(
    artifact, first.start, passage.text.length, undefined, 3).rows[0].text);
  expect(initial.outcome.evidence?.every((receipt) => receipt.source_sha256 === native.documentRevision(artifact)))
    .toBe(true);
  const located = await read({ file_path: researchSourceResource(source), locator_kind: "paragraph", locator: first.label });
  const direct = nativeDocumentPassages({ request: { source, locator: { kind: "paragraph", value: first.label } },
    reference: source, document: artifact, native: passage.native as object });
  expect(located.outcome.evidence).toEqual(direct.map((value) => legalSourceEvidence(value)));
  const header = await read({ file_path: researchSourceResource(source), offset: 1, limit: 1 });
  expect(header.payload.passages[0].text).toBe(native.readDocumentTextWindow(artifact, 1, 0, 1).rows[0].text);
});

it("continues every exact Unicode span through long lines and serialized-budget stops", async () => {
  const text = Array.from({ length: 30 }, (_, index) => `${index}: ${'é😀"\\'.repeat(index ? 500 : 15_000)}`).join("\n"),
    native = structureNative(), artifact = await native.deriveDocumentStructure({ kind: "native_markup",
      input: { provider: "govinfo", id: "long-lines", text } }),
    source: LegalSourceReference = { provider: "govinfo", id: "long-lines", kind: "case",
      title: "Unnumbered source", citation: "Example", date: "2025-01-01" },
    original = native.documentText(artifact), { read, state } = reader([{ source, role: "document",
      locator: { requested: null, label: "document" }, text: original, documentArtifact: artifact }]);
  let input: Record<string, unknown> | undefined = { file_path: researchSourceResource(source), limit: 2_000 };
  const received: string[] = [], ids = new Set<string>();
  for (let page = 0; input && page < 100; page++) {
    const { payload, outcome } = await read(input);
    expect(payload.sources[0].qualification).toContain("editorial material");
    expect(JSON.stringify(payload).length).toBeLessThan(34_000);
    for (const passage of payload.passages) {
      const receipt = outcome.evidence!.find(({ evidence_id }) => evidence_id === passage.evidence_id)!;
      expect(receipt.span_text).toBe(passage.text);
      expect(receipt.exact_span_sha256).toBe(`sha256:${sha256(passage.text)}`);
      expect(receipt.source_reference?.id).toBe(source.id);
      expect(receipt.version).toBe(source.date);
      expect(ids.has(receipt.evidence_id)).toBe(false);
      ids.add(receipt.evidence_id); received.push(passage.text);
    }
    input = payload.next?.[0] && { ...payload.next[0], limit: 2_000 };
  }
  expect(input).toBeUndefined();
  expect(received.join("")).toBe(original.replace(/[\r\n]/gu, ""));
  expect(state.evidence.size).toBe(ids.size);
});

it("keeps lead and dissent identities on every opinion-specific continuation", async () => {
  const native = structureNative(), opinions = [
    { opinionId: 8, type: "020lead", author: "Lead judge" },
    { opinionId: 9, type: "040dissent", author: "Dissenting judge" },
  ], passages: LegalSourcePassage[] = [];
  for (const opinion of opinions) {
    const artifact = await native.deriveDocumentStructure({ kind: "native_markup", input: {
      provider: "courtlistener", id: String(opinion.opinionId), text: "", markup:
        `<p id="paragraph-1">${opinion.author} first exact proposition.</p><p id="paragraph-2">${opinion.author} second exact proposition.</p>`,
    } });
    passages.push({ source: { provider: "courtlistener", id: "42", part: String(opinion.opinionId),
      kind: "case", title: "Shared case name", citation: "410 U.S. 113",
      url: `https://www.courtlistener.com/opinion/${opinion.opinionId}/example/` },
      role: "document", locator: { requested: null, label: "document" },
      text: native.documentText(artifact), documentArtifact: artifact, native: { case: { opinions } } });
  }
  const { read } = reader(passages), first = await read({
    file_path: "source://courtlistener/42", limit: 1 });
  const scoped = await readResearchResource({} as DocumentStore, { userId: "local-user" }, {
    resource: "source://courtlistener/42", limit: 1 });
  expect(scoped.coverage).toEqual({ complete: false, next: first.payload.next.map(
    ({ file_path, ...cursor }: { file_path: string }) => ({ resource: file_path, ...cursor })) });
  expect(scoped.coverage.next).toHaveLength(2);
  expect(first.payload.sources.map(({ opinion_type, author }: Record<string, unknown>) => [opinion_type, author]))
    .toEqual(opinions.map(({ type, author }) => [type, author]));
  const pending = [...(first.payload.next ?? [])], evidence = [...first.outcome.evidence!];
  while (pending.length) {
    const input = pending.shift()!;
    expect(opinions.map(({ opinionId }) => String(opinionId)))
      .toContain(researchSourceFromResource(input.file_path)?.part);
    const value = await read({ ...input, limit: 1 });
    evidence.push(...value.outcome.evidence!); pending.push(...(value.payload.next ?? []));
  }
  for (const opinion of opinions) expect(evidence.filter(({ source_reference }) =>
    source_reference?.part === String(opinion.opinionId)).map(({ span_text }) => span_text).join(""))
    .toBe(native.documentText(passages.find(({ source }) => source.part === String(opinion.opinionId))!
      .documentArtifact).replace(/\n/gu, ""));
  const firstPassage = passages[0], anchor = native.documentAnchors(firstPassage.documentArtifact)
    .find(({ kind }) => kind === "paragraph")!;
  const located = await read({ file_path: researchSourceResource(firstPassage.source),
    locator_kind: "paragraph", locator: anchor.label });
  expect(evidence.find(({ span_text, source_reference }) =>
    source_reference?.part === firstPassage.source.part && span_text === located.outcome.evidence![0].span_text))
    .toEqual(located.outcome.evidence![0]);
});

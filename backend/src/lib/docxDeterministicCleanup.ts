import type { DocumentStore } from "./documentStore";
import { openDocxSession } from "./docx/session";
import { createBuilder, elChildren, elName,
  ensureXmlDeclaration, getTextContent, setChildren, type XNode } from "./docx/core";
import { emitDocxRevisionPlan, revisionAttrs, type AppliedChange } from "./docxTrackedChanges";
import { structureNative } from "./structureNative";

function descendants(nodes: XNode[], name: string): XNode[] {
  return nodes.flatMap((node) => elName(node) === name ? [node]
    : descendants(elChildren(node), name));
}

/** Track the native converter's run changes without flattening its NOTEREF fields. */
async function trackSupraChanges(before: Buffer, after: Buffer) {
  const original = await openDocxSession(before), revised = await openDocxSession(after);
  const revisions = await original.revisions();
  if (revisions.changes.length) throw new Error(
    "Accept or reject pending tracked changes before fixing supra references");
  let nextId = revisions.maximum + 1;
  const changes: AppliedChange[] = [];
  const date = new Date().toISOString();
  const serialize = (nodes: XNode[]) => createBuilder().build(nodes) as string;
  const text = (nodes: XNode[]) => descendants(nodes, "w:t").map(getTextContent).join("");
  for (const path of ["word/document.xml", "word/footnotes.xml", "word/endnotes.xml"]) {
    const oldTree = await original.readXml(path), newTree = await revised.readXml(path);
    if (!oldTree || !newTree) continue;
    const oldParagraphs = descendants(oldTree, "w:p"), newParagraphs = descendants(newTree, "w:p");
    if (oldParagraphs.length !== newParagraphs.length) throw new Error("Supra cleanup changed the document structure");
    for (let index = 0; index < newParagraphs.length; index++) {
      const oldNodes = elChildren(oldParagraphs[index]), newNodes = elChildren(newParagraphs[index]);
      const fields = (nodes: XNode[]) => descendants(nodes, "w:instrText")
        .filter((node) => /\bNOTEREF\b/u.test(getTextContent(node))).length;
      if (fields(newNodes) <= fields(oldNodes)) continue;
      let start = 0, oldEnd = oldNodes.length, newEnd = newNodes.length;
      while (start < oldEnd && start < newEnd && serialize([oldNodes[start]]) === serialize([newNodes[start]])) start++;
      while (oldEnd > start && newEnd > start && serialize([oldNodes[oldEnd - 1]]) === serialize([newNodes[newEnd - 1]])) { oldEnd--; newEnd--; }
      const oldRuns = oldNodes.slice(start, oldEnd), newRuns = newNodes.slice(start, newEnd);
      const delId = String(nextId++), insId = String(nextId++);
      const deletedText = text(oldRuns), insertedText = text(newRuns);
      setChildren(newParagraphs[index], emitDocxRevisionPlan(newNodes, [{ start, end: newEnd,
        replacement: newRuns, insertion: revisionAttrs(insId, "Beaver", date),
        deletion: { nodes: oldRuns, attributes: revisionAttrs(delId, "Beaver", date) } }]));
      changes.push({ id: `${delId}:${insId}`, delId, insId, deletedText, insertedText,
        contextBefore: text(newNodes.slice(0, start)), contextAfter: text(newNodes.slice(newEnd)),
        reason: "Link supra references to native Word note numbers",
        diff: [{ kind: "delete", text: deletedText }, { kind: "insert", text: insertedText }] });
    }
    revised.write(path, ensureXmlDeclaration(serialize(newTree)));
  }
  if (!changes.length) throw new Error("Supra changes could not be represented as tracked changes");
  return { bytes: await revised.save(), changes };
}

export async function fixDocxSupras(bytes: Buffer) {
  const cleanup = await structureNative().fixDocxSupraCrossReferences(bytes);
  return cleanup.converted ? { ...cleanup, ...await trackSupraChanges(bytes, cleanup.bytes) }
    : { ...cleanup, changes: [] as AppliedChange[] };
}

export async function inspectDocxWorkflowCapabilities(
  documents: DocumentStore,
  userId: string,
  documentId: string,
) {
  const file = await documents.read({ userId }, documentId, null, false);
  if (!file) throw new Error("Document not found");
  if (file.fileType.toLowerCase() !== "docx") {
    throw new Error("Document workflows currently require a DOCX document");
  }
  return {
    supra_references: await structureNative().hasDocxSupraReferences(file.bytes),
  };
}

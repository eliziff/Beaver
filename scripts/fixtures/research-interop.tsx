/** Synthetic transport only; exercise the production conversion/promote components. */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { ImportResearchSet } from "@/app/components/tabular/ImportResearchSet";
import { ColumnLabelsDialog } from "@/app/components/tabular/ColumnLabelsDialog";
import { SaveResearchPassages } from "@/app/components/legal/SaveResearchPassages";
import { SourcesWorkspaceProvider } from "@/app/components/legal/SourcesWorkspace";
import { initializeRuntimeConfig } from "@/app/lib/runtimeConfig";
import type { ResearchFile } from "@/app/lib/researchFiles";
import type { ResearchImportColumn, ResearchTableInput } from "@/app/lib/api/researchFiles";
import "./probe.css";

const file = { document: { id: "workspace", filename: "Termination provisions.research.md", file_type: "md" },
  versionId: "version", workingRevision: 3, state: { schemaVersion: "beaver.research.v2", sources: {}, queries: null, note: "",
    labels: { relevance: { id: "relevance", name: "Relevance", scope: "source", parentId: null, color: null, order: 0 },
      drafting: { id: "drafting", name: "Drafting language", scope: "highlight", parentId: null, color: "#d6b656", order: 0 } } } } as unknown as ResearchFile;
const names = ["Miller v. Northlake", "Chen v. Eastwind", "Singh v. Cedar"];
const findings = names.map((name, i) => ({ sourceId: `source-${i}`, resource: `document://source-${i}/version/v1`,
  reference: { kind: "answer", chatId: "chat", answerId: `answer-${i}`, resource: `document://source-${i}/version/v1` },
  question: { title: "Why was the clause rejected?", prompt: "Why was the clause rejected?" },
  answer: { claims: [{ text: "The provisions were treated as an integrated scheme.", evidence_ids: [`e_${i}`] }] },
  evidence: [{ evidence_id: `e_${i}`, name, citation: `2099 EXAMPLE ${i+1}`, scope: "passage", locator: { kind: "paragraph", label: String(40+i) },
    span_text: "The termination provisions must be read together. The offending language affects the scheme as a whole." },
    { evidence_id: `e_read_${i}`, name, scope: "passage", locator: { kind: "paragraph", label: "2" }, span_text: "Unselected read, not supporting evidence." }] }));
const defaultColumns: ResearchImportColumn[] = [
  { index: 0, name: "Existing classification", prompt: "Use my case classification.", format: "text", fieldIds: ["labels"] },
  { index: 1, name: "Why the provisions were treated together", prompt: "What drove the result?", format: "text", fieldIds: ["reason"] },
  { index: 2, name: "Drafting language", prompt: "Which wording mattered?", format: "text", fieldIds: ["wording"] },
  { index: 3, name: "Treatment of the severability clause", prompt: "Did the severability clause affect the result?", format: "text", fieldIds: [] },
];
const values: Record<string, string[]> = { labels: ["Integrated scheme", "Integrated scheme", "Distinguished"],
  reason: ["The provisions were treated as an integrated scheme.", "The clause was not read in isolation.", "Different wording drove the result."],
  wording: ['“The termination provisions must be read together.”', '“The offending language affects the whole scheme.”', ""] };
const calls: Array<{ path: string; input: Record<string, unknown> }> = [];
Object.assign(globalThis, { __interopCalls: calls });
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
  if (!path.startsWith("/api/")) return nativeFetch(input, init);
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
  calls.push({ path, input: body });
  let data: unknown = file;
  if (path.endsWith("/table-plan")) {
    const input = body as ResearchTableInput, columns = input.columns ?? defaultColumns;
    data = { title: input.title || "Termination provisions — comparison", basis: `basis-${calls.length}`, versionId: file.versionId,
      workingRevision: file.workingRevision, columns, selection: input.selection ?? { target: "sources" }, findingRefs: findings.map(({ reference }) => reference),
      arrangement: { rows: names.map((title, i) => ({ id: `source-${i}`, sourceId: `source-${i}`, title })) },
      fields: [{ id: "labels", name: "Existing classification", kind: "classification", rows: 3, samples: values.labels },
        { id: "reason", name: "Why was the clause rejected?", kind: "finding", rows: 3, samples: values.reason },
        { id: "wording", name: "Drafting language", kind: "passages", rows: 2, samples: values.wording }],
      reuse: columns.map((column) => { const reused = names.filter((_, i) => column.fieldIds.some((id) => values[id]?.[i])).length;
        return { index: column.index, reused, unrun: names.length-reused, kinds: [] }; }),
      preview: names.map((title, i) => ({ title, values: columns.map(({ fieldIds }) => fieldIds.map((id) => values[id]?.[i]).filter(Boolean).join("\n")) })) };
  } else if (path.endsWith("/table")) data = { id: "created-review" };
  else if (path.endsWith("/findings")) data = { items: findings, total: findings.length, next_offset: null };
  else if (path.endsWith("/column-label-plan")) data = { title: "Reason", basis: "labels-basis", mapping: [
    { value: "Generally relevant — same wording", label: "Directly relevant", sources: 2 },
    { value: "Helpful analogy, different wording", label: "Analogous", sources: 1 },
    { value: "Not decided", label: null, sources: 1 }] };
  else if (path.includes("/items")) data = { items: [], next_cursor: null, total: 0 };
  else if (path.endsWith("/views")) data = { chats: [], tables: [] };
  else if (!/\/source-workspaces\/workspace(?:\/(actions|save-highlights|column-labels))?$/.test(path))
    return new Response(JSON.stringify({ detail: `Unexpected fixture request ${path}` }), { status: 500 });
  return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
};
await initializeRuntimeConfig(async () => new Response(JSON.stringify({ mode: "local", capabilities: { connectors: false } })));
function App() {
  const [mode, setMode] = useState(""), [result, setResult] = useState("");
  return <MemoryRouter><SourcesWorkspaceProvider file={file}>
    <main className="min-h-dvh bg-gray-50 p-5 text-gray-900"><h1 className="text-xl font-semibold">Research interoperability</h1>
      <p className="mt-2 text-sm text-gray-500">Synthetic examples. Actual Beaver components; no legal findings or live model calls.</p>
      <nav className="my-4 flex flex-wrap gap-2">{["Review", "Collect", "Labels"].map((name) => <button key={name}
        className="rounded border border-gray-300 bg-white px-3 py-2 text-sm" onClick={() => setMode(name)}>{name}</button>)}</nav>
      <p role="status">{result}</p>
      {mode === "Review" && <ImportResearchSet open fileId="workspace" selection={{ target: "sources", sourceIds: ["source-0", "source-1", "source-2"] }}
        onClose={() => setMode("")} onOpen={(path) => setResult(`Opened ${path}`)} />}
      {mode === "Collect" && <SaveResearchPassages fileId="workspace" chatId="chat" collect onClose={() => setMode("")}
        onDone={(_, selection) => { setResult(`Collected ${selection.sourceIds?.length} sources`); setMode(""); }} />}
      {mode === "Labels" && <ColumnLabelsDialog input={{ reviewId: "review", columnIndex: 0 }} onClose={() => setMode("")}
        onApplied={() => setResult("Label proposal created")} />}
    </main>
  </SourcesWorkspaceProvider></MemoryRouter>;
}
createRoot(document.getElementById("root")!).render(<App />);

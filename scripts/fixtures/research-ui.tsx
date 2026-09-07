// Synthetic, offline transport fixture. The workspace, reader, table and inspector
// below are production components, not a reimplementation of their UI.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { BookOpen, Files, Plus } from "lucide-react";
import { initializeRuntimeConfig } from "@/app/lib/runtimeConfig";
import { SourcesWorkspaceProvider } from "@/app/components/legal/SourcesWorkspace";
import { ResearchWorkspaceHost } from "@/app/components/legal/ResearchWorkspaceHost";
import { LegalSourceViewer } from "@/app/components/legal/LegalSourceViewer";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { TRTable } from "@/app/components/tabular/TRTable";
import { TRSidePanel } from "@/app/components/tabular/TRSidePanel";
import type { ResearchFile, ResearchSource, ResearchEvidence } from "@/app/lib/researchFiles";
import type { TabularCell, ColumnConfig } from "@/app/lib/api/tabular";
import "./probe.css";

const type = (id: string, name: string, color: string, order: number, parentId: string | null = null) =>
  ({ id, name, color, order, parentId, scope: "highlight" as const });
const label = (id: string, name: string, order: number, parentId: string | null = null) =>
  ({ id, name, order, parentId, color: null, scope: "source" as const });
const names = ["Miller v. Northlake", "Roy v. Eastern Works", "Chen v. Parkside", "Brown v. Summit"];
const sources: ResearchSource[] = names.map((title, i) => ({
  id: `case-${i}`, labelIds: i === 0 ? ["unused", "wording"] : i === 1 ? ["integrated"] : i === 3 ? ["irrelevant"] : [],
  badge: "", note: "", passages: i === 3 ? null : { count: i === 0 ? 2 : 1, sha256: `passages-${i}`,
    labelCounts: i === 0 ? { statement: 1, application: 1 } : { statement: 1 }, unlabelledCount: 0 },
  reference: { provider: "a2aj", kind: "case", id: `fixture-${i}`, title, citation: `2099 EXAMPLE ${i + 1}`, collection: "Example" },
}));
const sentences = [
  "The termination provisions must be read together.",
  "The court considered the language of the agreement as a whole.",
  "The employer had not relied on the provision in issue.",
  "The saving language did not change the analysis in this example.",
];
const receipt = (i: number, sourceIndex = 0) => ({
  evidence_id: `e_${sourceIndex}_${i}`, provider: "a2aj", source_reference: { id: `fixture-${sourceIndex}` },
  stable_source_id: `fixture-${sourceIndex}`, source_sha256: "a".repeat(64), span_sha256: "b".repeat(64),
  block_id: `paragraph:par${i + 1}`, span_text: sentences[i % sentences.length], name: names[sourceIndex],
  citation: `2099 EXAMPLE ${sourceIndex + 1}`, external_url: null, source_class: "case" as const, dataset: "Example",
  locator: { kind: "paragraph", label: `par${i + 1}` },
});
const passages: Record<string, ResearchEvidence[]> = Object.fromEntries(sources.map((source, i) => [source.id,
  Array.from({ length: source.passages?.count ?? 0 }, (_, n) => ({ sourceId: source.id,
    receipt: receipt(n, i), labelIds: [n ? "application" : "statement"], note: "" }))]));
const memoHref = "/sources/view?provider=a2aj&source_id=fixture-0&citation=2099+EXAMPLE+1&title=Miller+v.+Northlake&research_file=fixture&research_source=case-0&locator=par1&locator_kind=paragraph&evidence_id=e_0_0";
let file: ResearchFile = {
  document: { id: "fixture", filename: "Termination clauses.research.md", file_type: "md", current_version_id: "version-1",
    project_id: null, size_bytes: 1, page_count: null, created_at: null, pdf_storage_path: null },
  versionId: "version-1", workingRevision: 0,
  state: { schemaVersion: "beaver.research.v2", labels: {
    integrated: label("integrated", "Integrated scheme", 0), unused: label("unused", "Unused provision", 0, "integrated"),
    wording: label("wording", "Wording matters", 1), irrelevant: label("irrelevant", "Not relevant", 2),
    rule: type("rule", "Rule", "#d6b656", 0), statement: type("statement", "Statement", "#d6b656", 0, "rule"),
    scope: type("scope", "Scope", "#91a8bb", 1, "rule"), application: type("application", "Application", "#91aa94", 1),
    drafting: type("drafting", "Drafting language", "#ba9c93", 2),
  }, sources: Object.fromEntries(sources.map((source) => [source.id, source])), queries: null,
  note: `## Working analysis\n\nCompare the wording and the reasons for treating the provisions together. [Miller v. Northlake, 2099 EXAMPLE 1 at para 1](${memoHref}).\n\nThe saved passages distinguish the rule from its application.\n\n*Illustrative test data, not legal research.*` },
};
(globalThis as any).__researchActions = [];
window.fetch = async (input, init) => {
  const url = new URL(String(input), "https://research-fixture.invalid/");
  if (url.origin !== "https://research-fixture.invalid" || !url.pathname.startsWith("/api/")) throw new Error(`Fixture blocked ${url}`);
  let result: unknown;
  if (url.pathname === "/api/config") result = { mode: "local", capabilities: { connectors: false } };
  else if (url.pathname.endsWith("/actions")) {
    const { action } = JSON.parse(String(init?.body));
    (globalThis as any).__researchActions.push(action);
    if (action.type === "label") {
      const { type: _, ...value } = action;
      file = { ...file, workingRevision: file.workingRevision + 1, state: { ...file.state,
        labels: { ...file.state.labels, [value.id]: value } } };
    } else if (action.type === "note") file = { ...file, workingRevision: file.workingRevision + 1, state: { ...file.state, note: action.markdown } };
    result = file;
  } else if (url.pathname.endsWith("/items")) {
    const values = passages[url.searchParams.get("source_id") ?? ""] ?? [];
    result = { items: values.map((value, index) => ({ kind: "passage", value, index })), total: values.length, next_cursor: null };
  } else if (url.pathname.endsWith("/findings")) result = { items: [], total: 0, next_offset: null };
  else if (url.pathname.endsWith("/views")) result = { chats: [], tables: [] };
  else if (url.pathname === "/api/sources/document") {
    const sourceId = url.searchParams.get("source_id") ?? "fixture-0";
    const i = Math.max(0, Number(sourceId.split("-").at(-1)) || 0);
    let offset = 0;
    const slices = Array.from({ length: 12 }, (_, n) => {
      const text = `[${n + 1}] ${sentences[n % 4]} This is synthetic wording for interface verification. It is not an actual judicial decision.`;
      const start = offset; offset += text.length + 2;
      return { text, start, end: offset - 2, depth: 0, anchors: [],
        primary: { kind: "paragraph", label: `par${n + 1}`, start, end: offset - 2 } };
    });
    result = { schemaVersion: "mike.legal-source.v1", provider: "a2aj",
      reference: { docType: "cases", provider: "a2aj", id: sourceId, kind: "case", sourceSha256: "a".repeat(64), citation: `2099 EXAMPLE ${i + 1}`, language: "en", dataset: "Example" },
      metadata: { title: names[i], citation: `2099 EXAMPLE ${i + 1}`, alternateCitation: null, date: null, dataset: "Example", url: null, pdfUrl: null, language: "en", upstreamLicense: null },
      slices, truncated: false };
  } else if (url.pathname === "/api/source-workspaces/fixture") result = file;
  else throw new Error(`Unexpected fixture request: ${url.pathname}`);
  return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
};
await initializeRuntimeConfig();
const columns: ColumnConfig[] = [
  { index: 0, name: "Outcome", prompt: "Identify the result.", format: "short" },
  { index: 1, name: "Why the for-cause and without-cause provisions were treated together", prompt: "Explain how the court read the provisions together.", format: "short" },
  { index: 2, name: "Contract wording that drove the result", prompt: "Quote the material wording.", format: "short" },
];
const cells: TabularCell[] = sources.flatMap((source, i) => columns.map((column) => ({
  id: `cell-${i}-${column.index}`, review_id: "review", document_id: source.id, column_index: column.index, status: "done" as const, created_at: "2099-01-01",
  content: { summary: column.index === 0 ? "Invalid" : column.index === 1 ? "Integrated termination scheme" : "See the contract wording",
    reasoning: "The result follows from reading the relevant language together, not from treating each provision in isolation.",
    claims: Array.from({ length: 12 }, (_, n) => ({ text: `Point ${n + 1}: ${sentences[n % 4]}`, evidence_ids: [receipt(n).evidence_id] })),
    value: null, flag: "green" as const, outcome: "answered" as const, coverage: "complete" as const,
    query_ids: ["q_fixture"], evidence: Array.from({ length: 12 }, (_, n) => receipt(n)),
  },
})));
function App() {
  const [mode, setMode] = useState("sources"), [active, setActive] = useState(sources[0]);
  const [locator, setLocator] = useState<string>(), [selected, setSelected] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<TabularCell | null>(null);
  const documents = sources.map((source) => ({ id: source.id, filename: source.reference.title!, file_type: "md", reference: source.reference,
    project_id: null, size_bytes: null, page_count: null, created_at: null, pdf_storage_path: null }));
  return <MemoryRouter><SourcesWorkspaceProvider file={file}>
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-app-background">
      <header className="flex h-10 shrink-0 items-center gap-4 border-b border-gray-200 bg-white px-4 text-xs text-gray-500">
        <span>Beaver · offline UI fixture</span><button onClick={() => setMode("sources")}>Sources fixture</button><button onClick={() => setMode("table")}>Table fixture</button>
      </header>
      {mode === "sources" ? <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <main className="min-h-0 min-w-0 flex-1"><LegalSourceViewer provider="a2aj" citation={active.reference.citation!} sourceId={active.reference.id}
          docType="cases" initialLocator={locator} compact /></main>
        <ResearchWorkspaceHost embedded={false} open onOpenChange={() => undefined} onReadSource={(source, pinpoint) => { setActive(source); setLocator(pinpoint); }} selectedSourceId={active.id} />
      </div> : <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <PageHeader titleOnOwnLine shrink breadcrumbs={[{ label: "Tabular Review" }, { label: "Termination clauses — wording, severability and the effect of an unused for-cause provision" }]}
          actions={[{ icon: <Files />, label: "Docs", title: "Add documents" }, { icon: <BookOpen />, label: "Sources", title: "Open sources", onClick: () => setMode("sources") }, { icon: <Plus />, label: "Column", title: "Add column" }]} />
        <div className="mx-4 mb-4 min-h-0 min-w-0 flex-1 overflow-hidden"><TRTable loading={false} columns={columns} documents={documents} cells={cells}
          savingColumnsConfig={false} selectedDocIds={selected} onSelectionChange={setSelected} onExpand={setExpanded}
          onCitationClick={(cell) => setExpanded(cell)} onEditColumn={() => undefined} /></div>
      </main>}
      {expanded && <TRSidePanel cell={expanded} document={documents.find(({ id }) => id === expanded.document_id)!} column={columns[expanded.column_index]}
        onClose={() => setExpanded(null)} onRegenerate={async () => undefined} />}
    </div>
  </SourcesWorkspaceProvider></MemoryRouter>;
}
createRoot(document.getElementById("root")!).render(<App />);

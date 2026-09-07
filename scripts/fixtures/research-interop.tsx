// Synthetic transport, real conversion/editor components. No user data or model calls.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { initializeRuntimeConfig } from "@/app/lib/runtimeConfig";
import { SourcesWorkspaceProvider } from "@/app/components/legal/SourcesWorkspace";
import { ImportResearchSet } from "@/app/components/tabular/ImportResearchSet";
import { SaveFindingHighlights } from "@/app/components/legal/SaveFindingHighlights";
import type { ResearchFile } from "@/app/lib/researchFiles";
import "./probe.css";

const file = { document: { id: "research", filename: "Termination clauses.research.md" }, versionId: "v1", workingRevision: 1,
  state: { schemaVersion: "beaver.research.v2", labels: { rule: { id: "rule", name: "Rule", scope: "highlight", color: "#d6b656", parentId: null, order: 0 } },
    sources: {}, queries: null, note: "", tables: [], chats: [] } } as ResearchFile;
const columns = [
  { index: 0, name: "Reason for invalidity", prompt: "The existing classification of the whole case.", format: "text" },
  { index: 1, name: "Rule", prompt: "The deliberately saved passages stating the rule.", format: "text" },
  { index: 2, name: "How did the court treat the saving clause?", prompt: "Reuse the grounded answer to this question.", format: "text" },
];
const texts = ["Integrated termination scheme", "The termination provisions must be read together.",
  "The saving language did not cure the invalid scheme."];
const kinds = ["classification", "passages", "answer"];
const rows = ["Miller v. Northlake", "Davis v. Orchard", "Singh v. Riverbank", "Chen v. Parkway"].map((title, index) => ({ id: `case-${index}`, sourceId: `case-${index}`, title }));
const mappings = rows.flatMap(({ id }) => columns.map(({ index }) => ({ rowId: id, columnIndex: index, itemIds: [`${id}-${index}`] })));
const preview = (assisted: boolean) => ({ fingerprint: "a".repeat(64), rows,
  design: { title: "Termination clauses", columns: assisted ? [...columns, { index: 3, name: "Costs", prompt: "Were costs awarded?", format: "text" }] : columns, cells: mappings },
  stats: [...columns.map(({ index }) => ({ index, reused: 4, kinds: [kinds[index]], evidence: index ? 4 : 0 })),
    ...(assisted ? [{ index: 3, reused: 0, kinds: [], evidence: 0 }] : [])],
  samples: rows.slice(0, 3).flatMap(({ id }) => columns.map(({ index }) => ({ rowId: id, columnIndex: index, text: texts[index], kinds: [kinds[index]] }))) });
const requests: Array<{ path: string; body: unknown }> = [];
Object.assign(globalThis, { __interopRequests: requests });
window.fetch = async (input, init) => {
  const path = String(input), body = init?.body ? JSON.parse(String(init.body)) : {};
  if (init?.method === "POST") requests.push({ path, body });
  let data: unknown;
  if (path === "/api/config") data = { mode: "local", capabilities: { connectors: false } };
  else if (path.endsWith("/table/preview")) data = preview(!!body.request);
  else if (path.endsWith("/table")) data = { id: "created-review", project_id: null };
  else if (path.endsWith("/save-findings")) data = { file, saved: 1 };
  else if (path.includes("/items")) data = { items: [], total: 0, next_cursor: null };
  else if (path.includes("/views")) data = { chats: [], tables: [] };
  else if (path.includes("/findings")) data = { items: [], total: 0, next_offset: null };
  else if (path === "/api/source-workspaces/research") data = file;
  else throw new Error(`Unexpected fixture request: ${path}`);
  return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
};
await initializeRuntimeConfig();
function App() {
  const [open, setOpen] = useState(true), [destination, setDestination] = useState("");
  return <MemoryRouter><SourcesWorkspaceProvider file={file}>
    <main className="mx-auto max-w-4xl p-6"><h1 className="text-2xl font-semibold">Termination-clause research</h1>
      <p className="my-3 text-sm text-gray-600">Synthetic component fixture</p>
      <button className="rounded border px-3 py-2" onClick={() => setOpen(true)}>Review this research</button>
      {destination && <p role="status">Review opened: {destination}</p>}
      <section className="mt-6 border-t pt-3"><h2 className="font-medium">Saving-clause finding</h2><p className="mt-2">{texts[2]}</p>
        <SaveFindingHighlights references={[{ kind: "cell", reviewId: "created-review", rowId: "case-0", columnIndex: 2 }]} />
      </section>
    </main>
    <ImportResearchSet open={open} onClose={() => setOpen(false)} fileId="research" chatId="chat" onOpen={setDestination} />
  </SourcesWorkspaceProvider></MemoryRouter>;
}
createRoot(document.getElementById("root")!).render(<App />);

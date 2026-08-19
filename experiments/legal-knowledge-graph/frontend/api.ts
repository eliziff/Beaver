export type LegalResearchProject = { id: string; name: string; order: number };
export type LegalResearchNode = { id: string; kind: string; name: string; color: string };
type LegalSourceMark = { label_ids: string[]; note: string };
export type LegalSourceMarking = {
  nodes: LegalResearchNode[];
  edges: { from_node_id: string; to_node_id: string; relation: string }[];
  mark: LegalSourceMark | null;
};

async function request<T>(path: string, method = "GET", body?: unknown) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Legal knowledge request failed (${response.status})`);
  return response.json() as Promise<T>;
}

export const createLegalResearchProject = (name: string) =>
  request<LegalResearchProject>("/legal-knowledge/projects", "POST", { name });
export const getLegalSourceMarking = (projectId: string, sourceId: string) =>
  request<LegalSourceMarking>(
    `/legal-knowledge/projects/${encodeURIComponent(projectId)}/marking?${
      new URLSearchParams({ source_id: sourceId })
    }`,
  );
export const createLegalResearchLabel = (
  projectId: string,
  label: { name: string; color: string; parentId: string | null },
) => request<LegalResearchNode>(
  `/legal-knowledge/projects/${encodeURIComponent(projectId)}/nodes`,
  "POST",
  { kind: "label", name: label.name, color: label.color, parent_id: label.parentId },
);
export const saveLegalSourceMark = (
  projectId: string,
  sourceId: string,
  mark: { labelIds: string[]; note: string },
) => request<LegalSourceMark | null>(
  `/legal-knowledge/projects/${encodeURIComponent(projectId)}/sources/${
    encodeURIComponent(sourceId)
  }/mark`,
  "PUT",
  { label_ids: mark.labelIds, note: mark.note },
);

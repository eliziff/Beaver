import type { ResearchLabel } from "./researchContract";

export function researchLabelPath(labels: Record<string, ResearchLabel>, id: string) {
  const path: ResearchLabel[] = [], seen = new Set<string>();
  let label: ResearchLabel | undefined = labels[id];
  while (label && !seen.has(label.id)) {
    path.unshift(label); seen.add(label.id);
    label = label.parentId ? labels[label.parentId] : undefined;
  }
  return path;
}

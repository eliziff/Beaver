import { researchLabelPath, type ResearchLabel } from "@/app/lib/researchFiles";

export const researchLabelColor = (label: ResearchLabel) => label.color ??
  (label.scope === "highlight" ? "#d6b656" : "#3498db");

export function ResearchLabelCircle({ labels, labelIds, size = "md" }: {
  labels: Record<string, ResearchLabel>; labelIds: string[]; size?: "sm" | "md" }) {
  const applied = labelIds.flatMap((id) => labels[id] ? [labels[id]] : []);
  const names = applied.map(({ id }) => researchLabelPath(labels, id).map(({ name }) => name).join(" / "));
  const dot = `${size === "sm" ? "size-2" : "size-2.5"} rounded-full`;
  return <span role="group" aria-label={names.length ? `Labels: ${names.join(", ")}` : "No labels"}
    data-empty={applied.length ? undefined : "true"} className="inline-flex shrink-0 items-center gap-0.5">
    {applied.length ? applied.slice(0, 3).map((label) => <span key={label.id} data-label-dot={label.id}
      className={dot} style={{ backgroundColor: researchLabelColor(label) }} />)
      : <span className={`${dot} border border-gray-400`} />}
    {applied.length > 3 && <span className="text-[10px] leading-none text-gray-500">+{applied.length - 3}</span>}
  </span>;
}

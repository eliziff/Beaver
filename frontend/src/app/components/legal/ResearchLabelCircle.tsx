import { researchLabelPath, type ResearchLabel } from "@/app/lib/researchFiles";

export const researchLabelColor = (label: ResearchLabel) => label.color ??
  (label.scope === "highlight" ? "#eab308" : "#3498db");

export function ResearchLabelCircle({ labels, labelIds, size = "md" }: {
  labels: Record<string, ResearchLabel>; labelIds: string[]; size?: "sm" | "md" }) {
  const [primary, middle, inner] = labelIds[0]
    ? researchLabelPath(labels, labelIds[0]).slice(0, 3) : [];
  const additional = labelIds.slice(1).flatMap((id) => labels[id] ? [labels[id]] : []);
  const primaryName = [primary, middle, inner].flatMap((label) => label?.name ?? []).join(" / ");
  const names = [primaryName, ...additional.map(({ id }) =>
    researchLabelPath(labels, id).map(({ name }) => name).join(" / "))].filter(Boolean).join(", ");
  const layers = [primary, middle, inner].filter((label): label is ResearchLabel => !!label);
  return <svg aria-label={names ? `Labels: ${names}` : "No labels"} role="group"
    className={`${size === "sm" ? "h-[18px] w-5" : "h-7 w-8"} shrink-0 overflow-visible`}
    viewBox="0 0 30 28" data-empty={primary ? undefined : "true"}>
    {layers.length ? layers.map((label, index) => <path key={label.id}
      data-label-layer={index ? index === 1 ? "middle" : "inner" : "primary"}
      transform={`translate(${4 - index * 2} ${6 - index * 3})`}
      d="M1 5V3.5A2.5 2.5 0 0 1 3.5 1H9l2.5 2H19A2 2 0 0 1 21 5v12a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2Z"
      fill={researchLabelColor(label)} stroke="white" strokeWidth="1.25" />).reverse() : <path data-label-layer="primary"
      transform="translate(4 6)" d="M1 5V3.5A2.5 2.5 0 0 1 3.5 1H9l2.5 2H19A2 2 0 0 1 21 5v12a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2Z"
      fill="white" stroke="#94a3b8" strokeWidth="1.75" />}
    {additional.slice(0, additional.length > 3 ? 2 : 3).map((label, index) =>
      <rect key={label.id} data-additional-label={label.id} x={9 + index * 5} y="19" width="4" height="4"
        rx="0.75" fill={researchLabelColor(label)} stroke="white" strokeWidth="0.75" />)}
    {additional.length > 3 && <path aria-label={`${additional.length - 2} more labels`}
      d="M19 21h4m-2-2v4" stroke="white" strokeWidth="1.25" strokeLinecap="round" />}
  </svg>;
}

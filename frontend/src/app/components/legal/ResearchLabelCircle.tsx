import { researchLabelPath, type ResearchLabel } from "@/app/lib/researchFiles";

const COLORS = ["#991b1b", "#1d4ed8", "#047857", "#7c3aed"];
const color = (label: ResearchLabel) => label.color ?? COLORS[[...label.id]
  .reduce((sum, character) => sum + character.charCodeAt(0), 0) % COLORS.length];

export function ResearchLabelCircle({ labels, labelIds, size = "md" }: {
  labels: Record<string, ResearchLabel>; labelIds: string[]; size?: "sm" | "md" }) {
  const [primary, middle, inner] = labelIds[0]
    ? researchLabelPath(labels, labelIds[0]).slice(0, 3) : [];
  const additional = labelIds.slice(1).flatMap((id) => labels[id]?.name ?? []);
  const primaryName = [primary, middle, inner].flatMap((label) => label?.name ?? []).join(" / ");
  const names = [primaryName, ...additional].filter(Boolean).join(", ");
  const layers = [primary, middle, inner].filter((label): label is ResearchLabel => !!label),
    start = layers.length === 1 ? 4 : layers.length === 2 ? 2 : 0;
  return <svg aria-label={names ? `Labels: ${names}` : "No labels"} role="group"
    className={`${size === "sm" ? "h-[18px] w-5" : "h-7 w-8"} shrink-0 overflow-visible`}
    viewBox="0 0 30 28" data-empty={primary ? undefined : "true"}>
    {layers.length ? layers.map((label, index) => <path key={label.id}
      data-label-layer={index ? index === 1 ? "middle" : "inner" : "primary"}
      transform={`translate(${start + index * 4} ${start + index * 4})`}
      d="M1 5V3.5A2.5 2.5 0 0 1 3.5 1H9l2.5 2H19A2 2 0 0 1 21 5v12a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2Z"
      fill={color(label)} stroke="white" strokeWidth="1.25" />) : <path data-label-layer="primary"
      transform="translate(4 3)" d="M1 5V3.5A2.5 2.5 0 0 1 3.5 1H9l2.5 2H19A2 2 0 0 1 21 5v12a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2Z"
      fill="white" stroke="#94a3b8" strokeWidth="1.75" />}
  </svg>;
}

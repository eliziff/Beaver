import type { ResearchLabel } from "@/app/lib/researchSets";
import { researchLabelPath } from "@/app/lib/researchSets";

const COLORS = ["#991b1b", "#1d4ed8", "#047857", "#7c3aed"];
const color = (label: ResearchLabel) => label.color ?? COLORS[[...label.id]
  .reduce((sum, character) => sum + character.charCodeAt(0), 0) % COLORS.length];
const rings = (path: ResearchLabel[]) => {
  const [inner, middle, outer] = path.slice(-3).reverse().map(color);
  const stops = outer
    ? [`white 0 12%`, `${inner} 13% 34%`, `white 35% 38%`, `${middle} 39% 62%`,
      `white 63% 66%`, `${outer} 67% 100%`]
    : middle ? [`white 0 16%`, `${inner} 17% 44%`, `white 45% 49%`,
      `${middle} 50% 100%`] : [`white 0 22%`, `${inner} 23% 100%`];
  return `radial-gradient(circle, ${stops.join(", ")})`;
};

export function ResearchLabelCircle({ labels, labelIds, size = "md" }: {
  labels: Record<string, ResearchLabel>; labelIds: string[]; size?: "sm" | "md" }) {
  const paths = labelIds.map((id) => researchLabelPath(labels, id)).filter((path) => path.length);
  const names = paths.map((path) => path.map(({ name }) => name).join(" / "));
  return <span aria-label={names.length ? `Labels: ${names.join(", ")}` : "No labels"}
    role="group" className="inline-flex shrink-0 items-center gap-1">
    {paths.map((path) => <span key={path.at(-1)!.id}
      title={path.map(({ name }) => name).join(" / ")}
      className={`${size === "sm" ? "size-6" : "size-9"} shrink-0 rounded-full border border-gray-300`}
      style={{ background: rings(path) }} />)}
    {!paths.length && <span className={`${size === "sm" ? "size-6" : "size-9"}
      shrink-0 rounded-full border border-gray-300 bg-gray-100`} />}
  </span>;
}

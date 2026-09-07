import { cn } from "@/app/lib/utils";

export const FLAGS = {
  green: { dot: "bg-emerald-600", meaning: "Supported" },
  yellow: { dot: "bg-amber-500", meaning: "Check" },
  red: { dot: "bg-red-600", meaning: "Conflict" },
  grey: { dot: "bg-gray-400", meaning: "No answer" },
} as const;
export type AnswerFlag = keyof typeof FLAGS;
export function FlagDot({ flag, className }: { flag: AnswerFlag; className?: string }) {
  return <span role="img" aria-label={FLAGS[flag].meaning} title={FLAGS[flag].meaning}
    className={cn("inline-block size-2 shrink-0 rounded-full", FLAGS[flag].dot, className)} />;
}

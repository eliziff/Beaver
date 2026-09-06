import type { Citation } from "@/app/lib/citations";
import type { ColumnConfig } from "@/app/lib/api/tabular";
import { groundedAnswerMarkdown, type GroundedAnswer, type GroundedEvidence } from "@/app/lib/groundedAnswers";
import { cn } from "@/app/lib/utils";
import { TabularMarkdown } from "../tabular/TabularMarkdown";

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
export const PartialCoverageTag = ({ className }: { className?: string }) =>
  <span role="status" className={cn("inline-flex rounded bg-amber-50 px-1.5 text-xs leading-5 text-amber-800", className)}>Partial coverage</span>;

export function GroundedAnswerContent({ answer, column, onCitation }: {
  answer: GroundedAnswer & { evidence: GroundedEvidence[]; summary?: string; flag?: AnswerFlag; coverage?: "complete" | "partial" };
  column: Pick<ColumnConfig, "format" | "tags">; onCitation: (citation: Citation) => void;
}) {
  const grounded = groundedAnswerMarkdown(answer);
  return <div className="max-w-prose space-y-3 text-sm leading-relaxed text-gray-700 [overflow-wrap:anywhere]">
    {(answer.flag || answer.coverage === "partial") && <div className="flex flex-wrap items-center gap-2 text-xs">
      {answer.flag && <span className="inline-flex items-center gap-1.5 font-medium text-gray-800">
        <FlagDot flag={answer.flag} />{FLAGS[answer.flag].meaning}</span>}
      {answer.coverage === "partial" && <PartialCoverageTag />}
    </div>}
    {answer.summary && <TabularMarkdown text={answer.summary} value={answer.value} column={column} onCitationClick={onCitation} />}
    <TabularMarkdown text={grounded.text} citations={grounded.citations} onCitationClick={onCitation} />
  </div>;
}

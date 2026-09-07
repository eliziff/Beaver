import type { ColumnConfig, TabularCell } from "@/app/lib/api/tabular";
import type { Citation } from "@/app/lib/citations";
import { evidenceCitation, type GroundedEvidence } from "@/app/lib/groundedAnswers";
import { FLAGS, FlagDot } from "../shared/GroundedAnswerContent";
import { TabularMarkdown } from "./TabularMarkdown";

/** One result surface: answer, cited evidence, explanation, then inspectable provenance. */
export function TabularResultContent({ cell, column, onEvidence }: {
  cell: TabularCell; column: ColumnConfig; onEvidence: (citation: Citation, evidence: GroundedEvidence) => void;
}) {
  const answer = cell.content;
  if (!answer) return <p role="status" className="text-sm text-gray-500">{cell.status === "error" ? "This result failed. Regenerate to try again."
    : cell.status === "generating" ? "Running…" : "This question has not run yet."}</p>;
  const byId = new Map(answer.evidence.map((item) => [item.evidence_id, item]));
  const ids = [...new Set(answer.claims.flatMap((claim) => claim.evidence_ids))];
  const support = ids.map((id, index) => ({ id, receipt: byId.get(id), number: index + 1 }));
  const summary = answer.summary || (answer.value != null ? String(answer.value) : "");
  const paragraphs = summary ? answer.claims.filter(({ text }) => text.trim() !== summary.trim()) : [];
  const reasoning = answer.reasoning?.trim();
  const extraReasoning = reasoning && reasoning !== summary.trim() && !answer.claims.some(({ text }) => text.trim() === reasoning);
  const open = (receipt: GroundedEvidence, index: number) => { const citation = evidenceCitation(receipt, index); if (citation) onEvidence(citation, receipt); };
  return <div className="space-y-5 text-sm leading-6 text-gray-800 [overflow-wrap:anywhere]">
    <section aria-label="Answer">
      <h3 className="mb-2 text-xs font-medium text-gray-500">Answer</h3>
      {summary ? <TabularMarkdown text={summary} value={answer.value} column={column} onCitationClick={() => undefined} />
        : answer.outcome === "not_found" ? <p>No answer found.</p> : answer.claims.length ? <div className="space-y-3">{answer.claims.map((claim, index) => <TabularMarkdown key={index} text={claim.text} onCitationClick={() => undefined} />)}</div> : <p>No answer recorded.</p>}
      {answer.coverage === "partial" && <p role="status" className="mt-2 text-xs text-amber-800">Partial coverage — not all selected material was reviewed.</p>}
    </section>
    {!!support.length && <section aria-label="Evidence">
      <h3 className="mb-2 text-xs font-medium text-gray-500">Evidence</h3>
      <ol className="space-y-4">{support.map(({ id, receipt, number }) => <li key={id} id={`evidence-${cell.id}-${number}`}>
        {receipt ? <>
          <button type="button" disabled={!evidenceCitation(receipt, number)} onClick={() => open(receipt, number)}
            className="text-left text-xs font-medium leading-5 text-gray-700 underline decoration-gray-300 underline-offset-2 hover:decoration-gray-700 disabled:no-underline">
            [{number}] {receipt.name || receipt.citation} · {evidenceCitation(receipt, number)?.pinpoint ?? receipt.locator.label}
          </button>
          <blockquote className="mt-1 border-s-2 border-gray-200 ps-3 text-sm text-gray-600">{receipt.span_text || "Original passage text is unavailable."}</blockquote>
        </> : <p role="status" className="text-xs text-amber-800">[{number}] Supporting passage unavailable.</p>}
      </li>)}</ol>
    </section>}
    {(!!paragraphs.length || extraReasoning) && <section aria-label="Explanation">
      <h3 className="mb-2 text-xs font-medium text-gray-500">Explanation</h3>
      <div className="space-y-3">{paragraphs.map((claim, index) => <div key={index}>
        <TabularMarkdown text={claim.text} onCitationClick={() => undefined} />
        {[...new Set(claim.evidence_ids)].map((id) => { const ref = support.find((item) => item.id === id);
          return ref?.receipt && <button key={id} type="button" aria-label={`Open evidence ${ref.number}`} onClick={() => open(ref.receipt!, ref.number)}
            className="me-1 text-xs text-gray-500 underline">[{ref.number}]</button>; })}
      </div>)}
      {extraReasoning && <TabularMarkdown text={reasoning} onCitationClick={() => undefined} />}</div>
    </section>}
    <details className="border-t border-gray-200 pt-2 text-xs text-gray-500">
      <summary className="cursor-pointer py-1">More details</summary>
      <dl className="mt-2 space-y-2">
        {column.prompt && <div><dt className="font-medium">Question</dt><dd className="whitespace-pre-wrap">{column.prompt}</dd></div>}
        {answer.flag && <div><dt className="font-medium">Assessment</dt><dd className="flex items-center gap-1.5"><FlagDot flag={answer.flag} />{FLAGS[answer.flag].meaning}</dd></div>}
        <div><dt className="font-medium">Coverage</dt><dd>{answer.coverage}</dd></div>
        {!!answer.query_ids?.length && <div><dt className="font-medium">Queries</dt><dd>{answer.query_ids.join(", ")}</dd></div>}
      </dl>
      {answer.evidence.map((receipt) => <details key={receipt.evidence_id} className="mt-2">
        <summary className="cursor-pointer py-1">Receipt · {receipt.name || receipt.citation} · {receipt.locator.label}</summary>
        <pre className="whitespace-pre-wrap break-all rounded bg-gray-50 p-2 text-[11px] leading-4">{JSON.stringify(receipt, null, 2)}</pre>
      </details>)}
    </details>
  </div>;
}

import type { ColumnConfig, TabularCell } from "@/app/lib/api/tabular";
import { citationPinpoint, type Citation } from "@/app/lib/citations";
import { evidenceCitation } from "@/app/lib/groundedAnswers";
import { FLAGS, FlagDot } from "../shared/GroundedAnswerContent";
import { TabularMarkdown } from "./TabularMarkdown";

/** A result has one evidence list; raw receipts are inspectable but never the reading surface. */
export function TabularResultDetails({ answer, column, onCitation }: {
  answer: NonNullable<TabularCell["content"]>; column: ColumnConfig; onCitation: (citation: Citation) => void;
}) {
  const ids = [...new Set(answer.claims.flatMap((claim) => claim.evidence_ids))];
  const byId = new Map(answer.evidence.map((item) => [item.evidence_id, item]));
  const evidence = ids.map((id, index) => ({ id, receipt: byId.get(id), ref: index + 1 }));
  const summary = answer.summary || (answer.value == null ? "" : Array.isArray(answer.value) ? answer.value.join(", ") : String(answer.value));
  const claims = answer.claims.filter((claim) => claim.text.trim() !== summary.trim());
  const reasoning = answer.reasoning && ![summary, ...answer.claims.map(({ text }) => text)].some((text) => text.trim() === answer.reasoning?.trim())
    ? answer.reasoning : "";
  return <div className="space-y-5 text-sm leading-6 text-gray-700 [overflow-wrap:anywhere]">
    <section aria-label="Answer">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <h3 className="font-medium text-gray-500">Answer</h3>
        {answer.flag && <span className="inline-flex items-center gap-1.5"><FlagDot flag={answer.flag} />{FLAGS[answer.flag].meaning}</span>}
        {answer.coverage === "partial" && <span role="status" className="text-amber-800">Partial coverage</span>}
      </div>
      {summary ? <TabularMarkdown text={summary} value={answer.value} column={column} onCitationClick={onCitation} />
        : answer.outcome === "not_found" ? <p>No answer found in the reviewed material.</p> : <p>See the supported findings below.</p>}
    </section>
    {!!evidence.length && <section aria-label="Evidence" className="space-y-3">
      <h3 className="text-xs font-medium text-gray-500">Evidence</h3>
      {evidence.map(({ id, receipt, ref }) => {
        if (!receipt) return <p key={id} role="status" className="text-xs text-amber-800">Supporting passage {ref} is unavailable.</p>;
        const citation = evidenceCitation(receipt, ref), title = receipt.name || receipt.citation,
          locator = citation ? citationPinpoint(citation) : receipt.locator.label;
        return <div key={id} className="border-s-2 border-gray-200 ps-3">
          {citation ? <button type="button" aria-label={`Open passage ${ref}: ${title}`} onClick={() => onCitation(citation)}
            className="text-start text-xs font-medium text-gray-700 underline decoration-gray-300 underline-offset-2 hover:decoration-gray-700">
            {ref}. {title}{locator ? ` · ${locator}` : ""}
          </button> : <p className="text-xs font-medium">{ref}. {title} · {locator}</p>}
          {receipt.span_text && <blockquote className="mt-1 whitespace-pre-wrap text-sm leading-6">{receipt.span_text}</blockquote>}
        </div>;
      })}
    </section>}
    {(!!claims.length || reasoning) && <section aria-label="Explanation" className="space-y-3">
      <h3 className="text-xs font-medium text-gray-500">Explanation</h3>
      {claims.map((claim, index) => <div key={index}>
        <TabularMarkdown text={claim.text} onCitationClick={onCitation} />
        {[...new Set(claim.evidence_ids)].map((id) => {
          const item = evidence.find((item) => item.id === id), citation = item?.receipt && evidenceCitation(item.receipt, item.ref);
          return citation && <button key={id} type="button" aria-label={`Open evidence ${citation.ref}`} onClick={() => onCitation(citation)}
            className="me-1 text-xs text-gray-500 underline underline-offset-2">[{citation.ref}]</button>;
        })}
      </div>)}
      {reasoning && <TabularMarkdown text={reasoning} onCitationClick={onCitation} />}
    </section>}
    <details className="border-t border-gray-200 pt-3 text-xs text-gray-500">
      <summary className="cursor-pointer">More details</summary>
      {column.prompt && <div className="mt-3"><h3 className="font-medium">Column prompt</h3><p className="whitespace-pre-wrap">{column.prompt}</p></div>}
      <pre className="mt-3 whitespace-pre-wrap break-all text-[11px] leading-5">{JSON.stringify({ outcome: answer.outcome, coverage: answer.coverage,
        resource: answer.resource, query_ids: answer.query_ids, evidence: answer.evidence }, null, 2)}</pre>
    </details>
  </div>;
}

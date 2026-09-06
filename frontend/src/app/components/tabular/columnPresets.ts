import type { ColumnFormat } from "@/app/lib/api/tabular";
interface ColumnPreset {
    name: string;
    prompt: string;
    format: ColumnFormat;
    tags?: string[];
}
export const PROMPT_PRESETS: ColumnPreset[] = [
    {
        name: "Parties",
        format: "bulleted_list",
        prompt: 'List all parties to this agreement. For each party, state their full legal name, entity type, and defined role, e.g.:\n• ABC Corp, a Delaware corporation ("Company")\n• John Smith ("Shareholder")\nOne party per bullet. No additional commentary.',
    },
    {
        name: "Governing Law",
        format: "text",
        prompt: 'State only the governing law of this agreement using the short-form jurisdiction name, e.g. "New York Law", "English Law", "Indian Law", "PRC Law". No other text.',
    },
    {
        name: "Effective Date",
        format: "date",
        prompt: 'State only the effective date of this agreement in DD Mon YYYY format, e.g. "2 Jan 2026". If not explicitly stated, write "Not specified".',
    },
    {
        name: "Term",
        format: "text",
        prompt: 'State only the duration or term of this agreement in a concise form, e.g. "3 years", "24 months", "perpetual". No other text.',
    },
    {
        name: "Termination",
        format: "text",
        prompt: "Extract the termination provisions. State who may terminate, the trigger events, required notice period, any cure period, and the key consequences of termination. Be concise.",
    },
    {
        name: "Change of Control",
        format: "text",
        prompt: "Identify any change of control provisions. Summarize the trigger events, consequences, consent requirements, and any related termination or acceleration rights. Be concise.",
    },
    {
        name: "Confidentiality",
        format: "text",
        prompt: "Summarize the confidentiality obligations: scope of confidential information, permitted disclosures, use restrictions, duration, and key carve-outs or exceptions.",
    },
    {
        name: "Assignment",
        format: "yes_no",
        prompt: "Is assignment of this agreement permitted without the other party's consent?",
    },
    {
        name: "Payment & Fees",
        format: "text",
        prompt: 'State the key payment obligations concisely: amount, timing, and currency, e.g. "USD 10,000 payable within 30 days of invoice". Note any late payment consequences.',
    },
    {
        name: "Amendment",
        format: "text",
        prompt: "Summarize the amendment provisions: how amendments may be made, who must consent, and any formality requirements such as writing or signature.",
    },
    {
        name: "Indemnity",
        format: "text",
        prompt: "Summarize the indemnity provisions: who indemnifies whom, the scope of indemnified losses, any liability caps or exclusions, and key claims procedures.",
    },
    {
        name: "Warranties",
        format: "text",
        prompt: "Identify and describe key representations and warranties provided by any party, including the scope of such assurances and any specific time periods or conditions applicable to them. In particular highlight any non-standard warranties.",
    },
    {
        name: "Force Majeure",
        format: "yes_no",
        prompt: "Does this agreement contain a force majeure clause?",
    },
];

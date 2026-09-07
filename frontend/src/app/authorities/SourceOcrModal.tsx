import { useState } from "react";
import { Modal } from "@/app/components/modals/Modal";
import type { AuthoritiesBuildSettings } from "./types";

export type ScannedAuthorityPdf = { role: string; name: string; pageCount: number; textlessPages: number[] };
type Policy = AuthoritiesBuildSettings["scannedPdfPolicy"];
const choices = [
  { value: "page-margin", title: "Keep the original pages",
    description: "Do not run OCR. Keep scanned pages as images; only page-level marking is available where text cannot be selected." },
  { value: "cited-pages", title: "Recognize cited pages",
    description: "Add searchable text for cited pages. Paragraph-only citations need recognition across the scan to locate the paragraph." },
  { value: "full", title: "Recognize the whole PDF",
    description: "Recognize all scanned pages and add searchable text to the exported PDF. Check the resulting words and highlights against the image." },
] as const;

export function SourceOcrModal({ files, policy, busy, onClose, onContinue, onPreview }: {
  files: ScannedAuthorityPdf[]; policy: Policy; busy: boolean; onClose: () => void;
  onContinue: (policy: Policy) => void; onPreview?: (role: string) => void;
}) {
  const [selected, setSelected] = useState(policy);
  return <Modal open onClose={() => { if (!busy) onClose(); }} size="xl" breadcrumbs={["Scanned source PDFs"]}
    fit
    cancelAction={{ label: "Back to sources", disabled: busy, onClick: onClose }}
    primaryAction={{ label: "Continue to highlights", disabled: busy, onClick: () => onContinue(selected) }}>
    <p className="mb-3 text-sm leading-6 text-gray-600">Some pages have no selectable text. They may be scans or blank pages. OCR estimates words from the image; the original page appearance is preserved.</p>
    <ul className="mb-4 max-h-32 overflow-y-auto divide-y divide-gray-100 rounded-md border border-gray-200">
      {files.map((file) => <li key={file.role} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
        <span className="min-w-0"><span className="block truncate font-medium" title={file.name}>{file.name}</span>
          <span className="text-xs text-gray-500">{file.textlessPages.length} of {file.pageCount} pages without text</span></span>
        {onPreview && <button type="button" disabled={busy} className="shrink-0 rounded border border-gray-300 px-3 py-1.5 text-xs hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-red-600"
          onClick={() => onPreview(file.role)}>Preview</button>}
      </li>)}
    </ul>
    <fieldset className="space-y-2"><legend className="sr-only">Text recognition</legend>
      {choices.map(({ value, title, description }) => <label key={value}
        className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${selected === value ? "border-red-700 bg-red-50/40" : "border-gray-300 hover:bg-gray-50"}`}>
        <input type="radio" name="source-ocr-policy" value={value} checked={selected === value}
          disabled={busy} onChange={() => setSelected(value)} className="mt-1 accent-red-700" />
        <OcrPreview policy={value} />
        <span><strong className="block text-sm font-medium text-gray-950">{title}</strong>
          <span className="mt-1 block text-xs leading-5 text-gray-600">{description}</span></span>
      </label>)}
    </fieldset>
  </Modal>;
}

/** Illustrate image-only pages versus selectable text without implying OCR certainty. */
function OcrPreview({ policy }: { policy: Policy }) {
  return <div aria-hidden="true" className="hidden shrink-0 gap-1 sm:flex">
    {[0, 1].map((page) => {
      const recognized = policy === "full" || policy === "cited-pages" && page === 0;
      return <div key={page} className="relative h-16 w-11 overflow-hidden rounded-sm border border-gray-300 bg-white p-1.5 shadow-sm">
        <span className={`mb-1 block text-xs leading-4 ${recognized ? "bg-blue-100 text-blue-900" : "text-gray-400 blur-[0.6px]"}`}>Aa</span>
        {[0, 1, 2].map((line) => <span key={line} className={`mb-1 block h-1 ${line === 2 ? "w-3/4" : "w-full"} ${recognized ? "bg-blue-200" : "bg-gray-300 blur-[0.6px]"}`} />)}
        {!recognized && policy === "page-margin" && <span className="absolute right-0.5 top-6 h-6 w-0.5 bg-amber-400" />}
      </div>;
    })}
  </div>;
}

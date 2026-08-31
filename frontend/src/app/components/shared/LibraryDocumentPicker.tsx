import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { Modal } from "@/app/components/modals/Modal";
import type { Document } from "@/app/components/shared/types";
import { SearchBar } from "@/app/components/ui/search-bar";
import { formatBytes } from "@/app/lib/utils";
import { CollectionState } from "./CollectionState";
import { DocumentResultRow } from "./DocumentResultRow";

export function LibraryDocumentPicker({ open, title, formatLabel, query, results, busy,
  sourceLabel = "Library", detail, onQuery, onSelect, onClose }: {
  open: boolean; title: string; formatLabel: string; query: string;
  results: Document[]; busy: boolean;
  sourceLabel?: string;
  detail?: (document: Document) => ReactNode;
  onQuery: (query: string) => void; onSelect: (document: Document) => void;
  onClose: () => void;
}) {
  return <Modal open={open} onClose={onClose} size="xl" breadcrumbs={[title]}
    className="!h-fit max-h-[calc(100dvh-2rem)]">
    <div className="pb-5">
      <p className="mb-3 text-sm text-gray-500">{formatLabel} files</p>
      <SearchBar autoFocus value={query} onValueChange={onQuery} booleanSearch
        placeholder={`Search ${sourceLabel} ${formatLabel} files`} aria-label={`Search ${sourceLabel} ${formatLabel} files`} />
      <div className="mt-3 max-h-[min(28rem,55vh)] min-h-44 overflow-y-auto rounded-xl border border-gray-200" aria-busy={busy}>
        {busy ? <CollectionState loading className="h-44 gap-2"><Loader2 className="h-4 w-4 motion-safe:animate-spin" /> Loading {sourceLabel}</CollectionState>
          : results.length ? <ul className="divide-y divide-gray-100">{results.map((document) => <li key={document.id}>
            <DocumentResultRow filename={document.filename} fileType={document.file_type}
              onClick={() => onSelect(document)} metadata={detail?.(document) ?? <>{document.page_count ? `${document.page_count} pages` : "Page count unavailable"}{document.size_bytes ? ` · ${formatBytes(document.size_bytes)}` : ""}</>} />
          </li>)}</ul> : <CollectionState className="h-44">No matching files.</CollectionState>}
      </div>
    </div>
  </Modal>;
}

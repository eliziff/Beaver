import { Loader2 } from "lucide-react";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Modal } from "@/app/components/modals/Modal";
import type { Document } from "@/app/lib/api/documents";
import { SearchBar } from "@/app/components/ui/search-bar";
import { usePagedQuery } from "@/app/hooks/usePagedQuery";
import { useDebounced } from "@/app/hooks/useDebounced";
import { formatBytes } from "@/app/lib/utils";
import { CollectionState } from "./CollectionState";
import { DocumentResultRow } from "./DocumentResultRow";

export type LibraryDocumentPickerProps<T extends Document = Document> = {
  open: boolean; title: string; formatLabel: string; busy?: boolean;
  sourceLabel?: string;
  detail?: (document: T) => ReactNode;
  search: (query: string, signal: AbortSignal) => Promise<T[]>;
  onSelect: (document: T) => void;
  onError: (error: unknown) => void;
  onClose: () => void;
};

export function LibraryDocumentPicker<T extends Document>(props: LibraryDocumentPickerProps<T>) {
  return props.open ? <OpenPicker {...props} /> : null;
}

function OpenPicker<T extends Document>({ title, formatLabel, busy = false,
  sourceLabel = "Library", detail, search, onSelect, onClose, onError }: LibraryDocumentPickerProps<T>) {
  const [query, setQuery] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => searchInput.current?.focus(), []);
  const load = useRef(search), reportError = useEffectEvent(onError);
  useLayoutEffect(() => { load.current = search; }, [search]);
  const settledQuery = useDebounced(query);
  const { items: results, loading: searching, error } = usePagedQuery<T>(
    async (_cursor, signal) => ({ items: await load.current(settledQuery, signal), next_cursor: null }), [settledQuery]);
  useEffect(() => { if (error) reportError(error); }, [error]);
  const loading = busy || searching;
  return <Modal open onClose={onClose} size="2xl" breadcrumbs={[title]}>
    <div className="flex min-h-0 flex-1 flex-col pb-5">
      <p className="mb-3 text-sm text-gray-500">{formatLabel} files</p>
      <SearchBar ref={searchInput} value={query} onValueChange={setQuery} booleanSearch
        placeholder={`Search ${sourceLabel}`} aria-label={`Search ${sourceLabel}`} />
      <div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-xl border border-gray-200" aria-busy={loading}>
        {loading ? <CollectionState loading className="h-full gap-2"><Loader2 className="h-4 w-4 motion-safe:animate-spin" /> Loading {sourceLabel}</CollectionState>
          : results.length ? <ul className="divide-y divide-gray-100">{results.map((document) => <li key={document.id}>
            <DocumentResultRow filename={document.filename} fileType={document.file_type}
              onClick={() => onSelect(document)} metadata={detail?.(document) ?? [
                document.page_count ? `${document.page_count} pages` : "",
                document.size_bytes ? formatBytes(document.size_bytes) : "",
              ].filter(Boolean).join(" · ")} />
          </li>)}</ul> : <CollectionState className="h-full">No matching files.</CollectionState>}
      </div>
    </div>
  </Modal>;
}

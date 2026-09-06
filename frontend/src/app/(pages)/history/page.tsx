import { useEffect, useState } from "react";
import { Download } from "lucide-react";

import { PageHeader } from "@/app/components/shared/PageHeader";
import {
  TableBody,
  TableCell,
  TableEmptyState,
  TableHeaderCell,
  TableHeaderRow,
  Pagination,
  TableRow,
  TableScrollArea,
  TableStickyCell,
} from "@/app/components/shared/TablePrimitive";
import { downloadBlob } from "@/app/lib/download";
import { SearchBar } from "@/app/components/ui/search-bar";
import {
  exportAuditHistory,
  getAuditHistory,
  type AuditEvent,
  type AuditHistoryQuery,
} from "@/app/lib/api/account";

const ACTIONS = [
  ["", "All actions"],
  ["chat.message", "Chat"],
  ["document.uploaded", "Document upload"],
  ["document.generated", "Generated document"],
  ["document.edited", "Document edit"],
  ["tabular.created", "Tabular review"],
  ["tabular.generated", "Tabular run"],
  ["export.account", "Account export"],
  ["export.chats", "Chat export"],
  ["export.tabular", "Review export"],
] as const;
const labelForAction: ReadonlyMap<string, string> = new Map(ACTIONS);
const controlClass =
  "h-9 rounded-md border border-gray-300 bg-white px-3 text-sm text-gray-700 outline-none focus-visible:ring-2 focus-visible:ring-gray-400";

export default function HistoryPage() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [filters, setFilters] = useState<AuditHistoryQuery>({});
  const [draft, setDraft] = useState<AuditHistoryQuery>({});

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void getAuditHistory({ ...filters, page }, controller.signal)
      .then((result) => {
        setEvents(result.events);
        setTotal(result.total);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(
            reason instanceof Error ? reason.message : "Could not load history",
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [filters, page]);
  const pageCount = Math.max(1, Math.ceil(total / 50));

  const download = async () => {
    setExporting(true);
    try {
      const { blob, filename } = await exportAuditHistory(filters);
      downloadBlob(blob, filename ?? "beaver-history.csv");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not export history");
    } finally {
      setExporting(false);
    }
  };

  return (
    <main className="flex h-full min-h-0 flex-col">
      <PageHeader
        shrink
        actions={[{
          icon: <Download className="h-4 w-4" />,
          label: exporting ? "Exporting…" : "Export CSV",
          disabled: exporting,
          onClick: download,
        }]}
      >
        <h1 className="font-serif text-2xl font-medium text-gray-900">Activity log</h1>
      </PageHeader>

      <form
        className="mx-4 mb-3 flex flex-wrap items-end gap-2 md:mx-6"
        onSubmit={(event) => {
          event.preventDefault();
          setPage(1);
          setFilters(draft);
        }}
      >
        <label className="flex min-w-52 flex-1 flex-col gap-1 text-xs text-gray-600">
          Search titles
          <SearchBar value={draft.q ?? ""} booleanSearch
            onValueChange={(q) => setDraft({ ...draft, q })} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-600">
          Action
          <select
            className={controlClass}
            value={draft.action ?? ""}
            onChange={(event) => setDraft({ ...draft, action: event.target.value })}
          >
            {ACTIONS.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-600">
          Status
          <select
            className={controlClass}
            value={draft.status ?? ""}
            onChange={(event) => setDraft({ ...draft, status: event.target.value })}
          >
            <option value="">All statuses</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
            <option value="failed">Failed</option>
          </select>
        </label>
        <button className={`${controlClass} cursor-pointer hover:bg-gray-50`} type="submit">
          Apply
        </button>
      </form>

      {error && <p className="mx-6 mb-2 text-sm text-red-700" role="alert">{error}</p>}
      <TableScrollArea
        header={
          <TableHeaderRow>
            <TableStickyCell header widthClassName="min-w-0 flex-1 sm:w-[332px] sm:flex-none">Activity</TableStickyCell>
            <TableHeaderCell className="hidden w-44 sm:flex">When</TableHeaderCell>
            <TableHeaderCell className="hidden w-28 sm:flex">Status</TableHeaderCell>
            <TableHeaderCell className="hidden min-w-0 flex-1 sm:flex">Application</TableHeaderCell>
          </TableHeaderRow>
        }
      >
        <TableBody aria-busy={loading}>
          {loading ? (
            <p className="p-6 text-sm text-gray-500" role="status">Loading history…</p>
          ) : events.length === 0 ? (
            <TableEmptyState>No history matches these filters.</TableEmptyState>
          ) : events.map((event) => (
            <TableRow key={event.id} interactive={false} className="h-auto min-h-20 sm:h-11">
              <TableStickyCell widthClassName="min-w-0 flex-1 sm:w-[332px] sm:flex-none" className="min-w-0 flex-col">
                <span className="w-full truncate text-sm text-gray-900">
                  {event.title || labelForAction.get(event.action) || event.action}
                </span>
                {event.title && <span className="w-full truncate text-xs text-gray-500">
                  {labelForAction.get(event.action) || event.action}
                </span>}
                <span className="mt-1 w-full text-xs text-gray-600 sm:hidden">
                  {new Date(event.created_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                </span>
                <span className="w-full text-xs capitalize text-gray-600 sm:hidden">
                  {event.status} · {event.surface || "—"}
                </span>
              </TableStickyCell>
              <TableCell className="hidden w-44 sm:block">
                {new Date(event.created_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
              </TableCell>
              <TableCell className="hidden w-28 capitalize sm:block">{event.status}</TableCell>
              <TableCell className="hidden min-w-0 flex-1 capitalize sm:block">{event.surface || "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </TableScrollArea>

      <Pagination page={page} pages={pageCount} label={`${total} history events`}
        disabled={loading} onPage={setPage} />
    </main>
  );
}

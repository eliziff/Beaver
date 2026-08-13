"use client";

import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { useRouter } from "next/navigation";

import { PageHeader } from "@/app/components/shared/PageHeader";
import {
  TableBody,
  TableCell,
  TableEmptyState,
  TableHeaderCell,
  TableHeaderRow,
  TableRow,
  TableScrollArea,
  TableStickyCell,
} from "@/app/components/shared/TablePrimitive";
import { isAnonymousMode } from "@/app/lib/authMode";
import {
  exportAuditHistory,
  getAuditHistory,
  type AuditEvent,
  type AuditHistoryQuery,
} from "@/app/lib/beaverApi";

const ACTIONS = [
  ["", "All actions"],
  ["chat.message", "Chat"],
  ["document.uploaded", "Document upload"],
  ["document.generated", "Generated document"],
  ["document.edited", "Document edit"],
  ["workflow.applied", "Workflow"],
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
  const router = useRouter();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [filters, setFilters] = useState<AuditHistoryQuery>({});
  const [draft, setDraft] = useState<AuditHistoryQuery>({});

  useEffect(() => {
    if (isAnonymousMode) {
      router.replace("/assistant");
      return;
    }
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
  }, [filters, page, router]);

  if (isAnonymousMode) return null;
  const pageCount = Math.max(1, Math.ceil(total / 50));

  const download = async () => {
    setExporting(true);
    try {
      const { blob, filename } = await exportAuditHistory(filters);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename ?? "beaver-history.csv";
      link.click();
      URL.revokeObjectURL(url);
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
        <h1 className="font-serif text-2xl font-medium text-gray-900">History</h1>
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
          <input
            className={controlClass}
            type="search"
            value={draft.q ?? ""}
            onChange={(event) => setDraft({ ...draft, q: event.target.value })}
          />
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
            <TableStickyCell header>Activity</TableStickyCell>
            <TableHeaderCell className="w-44">When</TableHeaderCell>
            <TableHeaderCell className="w-28">Status</TableHeaderCell>
            <TableHeaderCell className="min-w-0 flex-1">Application</TableHeaderCell>
          </TableHeaderRow>
        }
      >
        <TableBody aria-busy={loading}>
          {loading ? (
            <p className="p-6 text-sm text-gray-500" role="status">Loading history…</p>
          ) : events.length === 0 ? (
            <TableEmptyState>No history matches these filters.</TableEmptyState>
          ) : events.map((event) => (
            <TableRow key={event.id} interactive={false}>
              <TableStickyCell className="min-w-0 flex-col">
                <span className="w-full truncate text-sm text-gray-900">
                  {event.title || labelForAction.get(event.action) || event.action}
                </span>
                {event.title && <span className="w-full truncate text-xs text-gray-500">
                  {labelForAction.get(event.action) || event.action}
                </span>}
              </TableStickyCell>
              <TableCell className="w-44">
                {new Date(event.created_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
              </TableCell>
              <TableCell className="w-28 capitalize">{event.status}</TableCell>
              <TableCell className="min-w-0 flex-1 capitalize">{event.surface || "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </TableScrollArea>

      <div className="mx-4 mb-4 flex items-center justify-end gap-3 text-sm text-gray-600 md:mx-6">
        <span>{total} events · page {page} of {pageCount}</span>
        <button className={controlClass} disabled={page === 1 || loading} onClick={() => setPage(page - 1)}>Previous</button>
        <button className={controlClass} disabled={page === pageCount || loading} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </main>
  );
}

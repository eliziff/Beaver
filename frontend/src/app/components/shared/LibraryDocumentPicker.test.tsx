import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { LibraryDocumentPicker } from "./LibraryDocumentPicker";
import type { Document } from "@/app/lib/api/documents";

const file = (id: string): Document => ({ id, filename: `${id}.pdf`, project_id: null,
  file_type: "pdf", pdf_storage_path: null, size_bytes: 1, page_count: 1, created_at: "" });

it("ignores superseded searches and keeps import progress independent of search completion", async () => {
  const pending = new Map<string, (items: Document[]) => void>();
  const props = { open: true, title: "Choose a file", formatLabel: "PDF", onClose: vi.fn(),
    onError: vi.fn(), onSelect: vi.fn(),
    search: (query: string) => new Promise<Document[]>((resolve) => pending.set(query, resolve)) };
  const { rerender } = render(<LibraryDocumentPicker {...props} />);
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "current" } });
  await waitFor(() => expect(pending.has("current")).toBe(true));
  await act(async () => pending.get("current")!([file("current")]));
  rerender(<LibraryDocumentPicker {...props} busy />);
  await act(async () => pending.get("")!([file("obsolete")]));
  expect(screen.queryByRole("button", { name: /\.pdf/ })).not.toBeInTheDocument();
  rerender(<LibraryDocumentPicker {...props} />);
  fireEvent.click(screen.getByRole("button", { name: /current\.pdf/ }));
  expect(props.onSelect).toHaveBeenCalledWith(file("current"));
  expect(screen.queryByRole("button", { name: /obsolete\.pdf/ })).not.toBeInTheDocument();
});

it("cancels a closed picker and reopens with a fresh search", async () => {
  const pending: { signal: AbortSignal; reject: (error: Error) => void;
    resolve: (items: Document[]) => void }[] = [];
  const props = { open: true, title: "Choose a file", formatLabel: "PDF", onClose: vi.fn(),
    onError: vi.fn(), onSelect: vi.fn(),
    search: (_query: string, signal: AbortSignal) => new Promise<Document[]>((resolve, reject) =>
      pending.push({ signal, reject, resolve })) };
  const { rerender } = render(<LibraryDocumentPicker {...props} />);
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "old query" } });
  rerender(<LibraryDocumentPicker {...props} open={false} />);
  expect(pending.every(({ signal }) => signal.aborted)).toBe(true);
  await act(async () => pending.forEach(({ reject }) => reject(new Error("Old request failed"))));
  rerender(<LibraryDocumentPicker {...props} />);
  expect(screen.getByRole("searchbox")).toHaveValue("");
  await act(async () => pending.at(-1)!.resolve([file("fresh")]));
  expect(screen.getByRole("button", { name: /fresh\.pdf/ })).toBeInTheDocument();
  expect(props.onError).not.toHaveBeenCalled();
});

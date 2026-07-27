import { describe, expect, it } from "vitest";
import { buildMessages } from "../chat/contextBuilders";
import {
  buildSystemPrompt,
  SPREADSHEET_CITATION_PROMPT,
  SYSTEM_PROMPT,
} from "../chat/prompts";

function systemContent(result: unknown[]): string {
  const first = result[0] as { role: string; content: string };
  expect(first.role).toBe("system");
  return first.content;
}

describe("system prompt assembly", () => {
  it("keeps spreadsheet citation syntax out of the static prompt", () => {
    expect(SYSTEM_PROMPT).not.toContain("SPREADSHEET CITATIONS");
    expect(buildSystemPrompt(false)).not.toContain("SPREADSHEET CITATIONS");
    expect(SYSTEM_PROMPT).not.toContain("⟨merged");
  });

  it("does not restate rules the server enforces deterministically", () => {
    // Top-level page/quote is synthesized from quotes[0] in citations.ts.
    expect(SYSTEM_PROMPT).not.toContain("legacy compatibility");
    // The contiguity rule is stated exactly once.
    expect(SYSTEM_PROMPT.match(/contiguous/gu)?.length ?? 0).toBe(1);
  });

  it("states the read-once rule only in the per-turn documents block", () => {
    expect(SYSTEM_PROMPT).not.toContain("at most once per response");
    const messages = buildMessages(
      [{ role: "user", content: "Summarize the lease." }],
      [{ doc_id: "doc-0", filename: "lease.pdf" }],
    );
    const content = systemContent(messages);
    const copies = content.match(/do not call read_document or fetch_documents again/gu);
    expect(copies?.length).toBe(1);
  });

  it("omits the spreadsheet block when no spreadsheet is in context", () => {
    const messages = buildMessages(
      [{ role: "user", content: "Summarize the lease." }],
      [{ doc_id: "doc-0", filename: "lease.pdf" }],
    );
    expect(systemContent(messages)).not.toContain("SPREADSHEET CITATIONS");
  });

  it("splices the spreadsheet block when a spreadsheet document is available", () => {
    const messages = buildMessages(
      [{ role: "user", content: "What is the total?" }],
      [
        { doc_id: "doc-0", filename: "lease.pdf" },
        { doc_id: "doc-1", filename: "rent-roll.xlsx" },
      ],
    );
    const content = systemContent(messages);
    expect(content).toContain("SPREADSHEET CITATIONS");
    expect(content).toContain("⟨merged");
  });

  it("splices the spreadsheet block for message-attached spreadsheets", () => {
    const messages = buildMessages(
      [
        {
          role: "user",
          content: "Check the numbers.",
          files: [{ filename: "cap-table.CSV" }],
        },
      ],
      [],
    );
    expect(systemContent(messages)).toContain("SPREADSHEET CITATIONS");
  });

  it("splices the spreadsheet block for docIndex spreadsheets", () => {
    const messages = buildMessages(
      [{ role: "user", content: "Check the numbers." }],
      [],
      undefined,
      {
        "doc-0": { document_id: "u-1", filename: "model.xlsm" },
      },
    );
    expect(systemContent(messages)).toContain("SPREADSHEET CITATIONS");
  });

  it("keeps the static prefix stable so provider caching survives splicing", () => {
    const base = buildSystemPrompt(true);
    const withSheet = systemContent(
      buildMessages(
        [{ role: "user", content: "q" }],
        [{ doc_id: "doc-0", filename: "a.xlsx" }],
      ),
    );
    const withoutSheet = systemContent(
      buildMessages(
        [{ role: "user", content: "q" }],
        [{ doc_id: "doc-0", filename: "a.pdf" }],
      ),
    );
    expect(withSheet.startsWith(base)).toBe(true);
    expect(withoutSheet.startsWith(base)).toBe(true);
    // The conditional matter is appended, never inserted mid-prompt.
    expect(withSheet.indexOf("SPREADSHEET CITATIONS")).toBeGreaterThan(
      base.length,
    );
  });

  it("orders the tail: extra prompt, spreadsheet syntax, then documents", () => {
    const content = systemContent(
      buildMessages(
        [{ role: "user", content: "q" }],
        [{ doc_id: "doc-0", filename: "a.xlsx" }],
        "MATTER FOCUS: acquisition",
      ),
    );
    const extra = content.indexOf("MATTER FOCUS");
    const sheet = content.indexOf("SPREADSHEET CITATIONS");
    const docs = content.indexOf("AVAILABLE DOCUMENTS");
    expect(extra).toBeGreaterThan(0);
    expect(sheet).toBeGreaterThan(extra);
    expect(docs).toBeGreaterThan(sheet);
  });

  it("keeps the essential citation contract intact", () => {
    for (const required of [
      "<CITATIONS>",
      '"doc_id" must be the exact chat-local label',
      "[[PAGE_BREAK]]",
      "only citation annotation markers",
      "Omit the <CITATIONS> block when there are no citations",
    ]) {
      expect(SYSTEM_PROMPT).toContain(required);
    }
    expect(SPREADSHEET_CITATION_PROMPT).toContain('"cell"');
    expect(SPREADSHEET_CITATION_PROMPT).toContain("⟨merged");
  });
});

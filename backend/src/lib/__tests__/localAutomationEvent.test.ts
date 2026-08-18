import { describe, expect, it } from "vitest";
import {
  citationLinkingEvent,
  supraFixEvent,
  tableOfAuthoritiesEvent,
} from "../chat/localAutomationEvent";

describe("localAutomationEvent", () => {
  it("preserves deterministic document receipts", () => {
    expect(
      supraFixEvent(
        {
          ok: true,
          document_id: "document-1",
          version_id: "version-2",
          filename: "Brief - supras fixed.docx",
          detected: 4,
          converted: 3,
          already_linked: 1,
          review_required: 0,
        },
        "call-1",
      ),
    ).toMatchObject({
      type: "automation_run",
      id: "call-1",
      status: "complete",
      version_id: "version-2",
      counts: expect.arrayContaining([
        { label: "Found", value: 4 },
        { label: "Fixed", value: 3 },
      ]),
    });
  });

  it("preserves Authorities stage, status, output, and destination", () => {
    expect(
      tableOfAuthoritiesEvent(
        {
          ok: true,
          job: {
            id: "a".repeat(32),
            state: "complete",
            operation: "Build",
            progress: 100,
            message: "Book ready",
            error: "",
            app_url: "/table-of-authorities?job=abc",
            files: [{ name: "Book.pdf", url: "/download/book" }],
          },
        },
        "call-2",
      ),
    ).toMatchObject({
      type: "automation_run",
      id: "call-2",
      status: "complete",
      stage: "Build",
      progress: 100,
      outputs: [{ name: "Book.pdf", url: "/download/book" }],
      app_url: "/table-of-authorities?job=abc",
    });
  });

  it("keeps failed tool receipts visible", () => {
    expect(
      citationLinkingEvent(
        { ok: false, error: "No footnotes found" },
        "call-3",
      ),
    ).toMatchObject({
      type: "automation_run",
      status: "error",
      error: "No footnotes found",
    });
  });
});

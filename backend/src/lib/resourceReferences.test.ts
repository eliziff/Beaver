import { describe, expect, it } from "vitest";
import { parseResourceReference, resourceReference } from "./resourceReferences";

describe("resource references", () => {
  it("round-trips every resource kind", () => {
    const references = [
      resourceReference.document("document id", "version/1"),
      resourceReference.source("CanLII", "2026 ABCA 1"),
      resourceReference.project("project id"),
      resourceReference.workflow("workflow id"),
      resourceReference.job("job id"),
    ];
    expect(references.map(parseResourceReference)).toEqual([
      { kind: "document", documentId: "document id", versionId: "version/1" },
      { kind: "source", provider: "CanLII", sourceId: "2026 ABCA 1" },
      { kind: "project", id: "project id" },
      { kind: "workflow", id: "workflow id" },
      { kind: "job", id: "job id" },
    ]);
  });

  it("rejects incomplete and decorated references", () => {
    expect(parseResourceReference("document://doc/version")).toBeNull();
    expect(parseResourceReference("document://doc/version/v?latest=true")).toBeNull();
    expect(parseResourceReference("source://provider/source/extra")).toBeNull();
    expect(parseResourceReference("notes.docx")).toBeNull();
  });
});

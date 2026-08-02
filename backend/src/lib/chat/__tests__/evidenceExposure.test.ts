import { describe, expect, it } from "vitest";
import {
  applyEvidenceExposure,
  compileEvidenceHandoff,
  compileEvidenceResearchRefresh,
  createEvidenceExposureState,
  renderEvidenceManifest,
} from "../evidenceExposure";

const source = "alpha beta gamma delta";
const load = async (documentId: string, versionId: string) =>
  documentId === "d1" && versionId === "v1"
    ? { filename: "contract.docx", text: source }
    : null;

describe("evidence exposure union", () => {
  it("renders a compact deterministic selection manifest", () => {
    expect(
      renderEvidenceManifest([
        {
          alias: "E-12345678",
          filename: "contract.docx",
          locator: "9.2",
          chars: 42,
          preview: "first\nline",
        },
      ]),
    ).toBe(
      "file\tcontract.docx\n" +
        "alias\tlocator\tchars\tpreview\n" +
        "E-12345678\t9.2\t42\tfirst line",
    );
  });

  it("suppresses exact repeat reads and preserves a later read after Grep", async () => {
    const state = createEvidenceExposureState();
    const candidate = {
      tool_use_id: "g1",
      content: "contract.docx:1:alpha",
      evidenceSegments: [
        { documentId: "d1", versionId: "v1", start: 0, end: 5, kind: "candidate" as const },
      ],
    };
    const read = {
      tool_use_id: "r1",
      content: "1 alpha",
      evidenceSegments: [
        { documentId: "d1", versionId: "v1", start: 0, end: 5, kind: "evidence" as const },
      ],
    };

    expect((await applyEvidenceExposure(state, candidate, load)).status).toBeUndefined();
    expect((await applyEvidenceExposure(state, read, load)).content).toBe("1 alpha");
    const repeated = await applyEvidenceExposure(
      state,
      { ...read, tool_use_id: "r2" },
      load,
    );
    expect(repeated.status).toBe("already_exposed");
    expect(JSON.parse(repeated.content)).toMatchObject({
      already_exposed: true,
      unique_source_chars: 0,
      suppressed_source_chars: 5,
    });
  });

  it("returns only the unseen tail for a partially overlapping read", async () => {
    const state = createEvidenceExposureState();
    await applyEvidenceExposure(
      state,
      {
        tool_use_id: "r1",
        content: "alpha beta",
        evidenceSegments: [
          { documentId: "d1", versionId: "v1", start: 0, end: 10 },
        ],
      },
      load,
    );
    const partial = await applyEvidenceExposure(
      state,
      {
        tool_use_id: "r2",
        content: "beta gamma",
        evidenceSegments: [
          { documentId: "d1", versionId: "v1", start: 6, end: 16 },
        ],
      },
      load,
    );
    const payload = JSON.parse(partial.content);
    expect(payload.suppressed_source_chars).toBe(4);
    expect(payload.unique_source_chars).toBe(6);
    expect(payload.new_evidence[0].text).toBe(" gamma");
  });

  it("carries exact Grep excerpts without letting them suppress a later Read", async () => {
    const state = createEvidenceExposureState();
    await applyEvidenceExposure(
      state,
      {
        tool_use_id: "g1",
        content: "gamma",
        evidenceSegments: [
          { documentId: "d1", versionId: "v1", start: 11, end: 16, kind: "candidate" },
        ],
      },
      load,
    );
    await applyEvidenceExposure(
      state,
      {
        tool_use_id: "r1",
        content: "beta",
        evidenceSegments: [
          { documentId: "d1", versionId: "v1", start: 6, end: 10, kind: "evidence" },
        ],
      },
      load,
    );
    const handoff = await compileEvidenceHandoff({
      state,
      load,
      originalRequest: "Draft the clause.",
      maxChars: 100,
    });
    expect(handoff.status).toBe("ready");
    if (handoff.status !== "ready") return;
    expect(handoff.prompt).toContain("beta");
    expect(handoff.prompt).toContain("gamma");
  });

  it("lets a stronger Read subsume the same Grep excerpt at handoff", async () => {
    const state = createEvidenceExposureState();
    await applyEvidenceExposure(
      state,
      {
        tool_use_id: "g1",
        content: "alpha",
        evidenceSegments: [
          { documentId: "d1", versionId: "v1", start: 0, end: 5, kind: "candidate" },
        ],
      },
      load,
    );
    await applyEvidenceExposure(
      state,
      {
        tool_use_id: "r1",
        content: "alpha beta",
        evidenceSegments: [
          { documentId: "d1", versionId: "v1", start: 0, end: 10, kind: "evidence" },
        ],
      },
      load,
    );
    const handoff = await compileEvidenceHandoff({
      state,
      load,
      originalRequest: "Summarize.",
      maxChars: 100,
    });
    expect(handoff.status).toBe("ready");
    if (handoff.status !== "ready") return;
    expect(handoff.manifest).toHaveLength(1);
    expect(handoff.prompt.match(/alpha/gu)).toHaveLength(1);
  });

  it("replaces prior source text with a compact index during research", async () => {
    const state = createEvidenceExposureState();
    const priorText = `opening ${"x".repeat(5_000)} SECRET_TAIL`;
    await applyEvidenceExposure(
      state,
      {
        tool_use_id: "r1",
        content: priorText,
        evidenceRefs: [
          {
            handle: "exact:prior",
            filename: "prior.docx",
            locator: "section 1",
            text: priorText,
          },
        ],
      },
      load,
    );

    const refresh = await compileEvidenceResearchRefresh({
      state,
      load,
      originalRequest: "Analyze the record.",
      latestResults: [{ name: "Read", content: "latest exact result" }],
    });

    expect(refresh.manifest).toHaveLength(1);
    expect(refresh.sourceChars).toBe(priorText.length);
    expect(refresh.latestResultChars).toBe("latest exact result".length);
    expect(refresh.prompt).toContain("Analyze the record.");
    expect(refresh.prompt).toContain("latest exact result");
    expect(refresh.prompt).toContain("prior.docx");
    expect(refresh.prompt).not.toContain("SECRET_TAIL");
    expect(refresh.prompt.length).toBeLessThan(priorText.length / 2);

    const handoff = await compileEvidenceHandoff({
      state,
      load,
      originalRequest: "Analyze the record.",
      maxChars: priorText.length,
    });
    expect(handoff.status).toBe("ready");
    if (handoff.status === "ready") {
      expect(handoff.prompt).toContain("SECRET_TAIL");
    }
  });

  it("reports only explicitly selected evidence after a capped handoff", async () => {
    const state = createEvidenceExposureState();
    await applyEvidenceExposure(
      state,
      {
        tool_use_id: "r1",
        content: "alpha gamma",
        evidenceSegments: [
          { documentId: "d1", versionId: "v1", start: 0, end: 5, locator: "A" },
          { documentId: "d1", versionId: "v1", start: 11, end: 16, locator: "B" },
        ],
      },
      load,
    );
    const capped = await compileEvidenceHandoff({
      state,
      load,
      originalRequest: "Summarize.",
      maxChars: 6,
    });
    expect(capped.status).toBe("selection_required");
    if (capped.status !== "selection_required") return;
    const selected = await compileEvidenceHandoff({
      state,
      load,
      originalRequest: "Summarize.",
      maxChars: 6,
      carryEvidence: [capped.manifest[0].alias],
    });
    expect(selected.status).toBe("ready");
    if (selected.status !== "ready") return;
    expect(selected.manifest).toHaveLength(1);
    expect(selected.manifest[0].alias).toBe(capped.manifest[0].alias);
  });

  it("does not replay the manifest after an unknown selection alias", async () => {
    const state = createEvidenceExposureState();
    await applyEvidenceExposure(
      state,
      {
        tool_use_id: "r1",
        content: "alpha gamma",
        evidenceSegments: [
          { documentId: "d1", versionId: "v1", start: 0, end: 5, locator: "A" },
          { documentId: "d1", versionId: "v1", start: 11, end: 16, locator: "B" },
        ],
      },
      load,
    );
    const unknown = await compileEvidenceHandoff({
      state,
      load,
      originalRequest: "Summarize.",
      maxChars: 6,
      carryEvidence: ["E-?"],
    });
    expect(unknown.status).toBe("error");
    if (unknown.status !== "error") return;
    expect(unknown.manifest).toEqual([]);
    expect(unknown.message).toContain("wildcards and placeholders are not accepted");
  });

  it("bundles noncontiguous exact excerpts under one legal locator", async () => {
    const state = createEvidenceExposureState();
    await applyEvidenceExposure(
      state,
      {
        tool_use_id: "g1",
        content: "alpha gamma",
        evidenceSegments: [
          {
            documentId: "d1",
            versionId: "v1",
            start: 0,
            end: 5,
            kind: "candidate",
            locator: "9.2",
          },
          {
            documentId: "d1",
            versionId: "v1",
            start: 11,
            end: 16,
            kind: "candidate",
            locator: "9.2",
          },
        ],
      },
      load,
    );
    const handoff = await compileEvidenceHandoff({
      state,
      load,
      originalRequest: "Summarize.",
      maxChars: 20,
    });
    expect(handoff.status).toBe("ready");
    if (handoff.status !== "ready") return;
    expect(handoff.manifest).toHaveLength(1);
    expect(handoff.manifest[0]).toMatchObject({ locator: "9.2", chars: 10 });
    expect(handoff.prompt).toContain("--- exact excerpt 1 ---\nalpha");
    expect(handoff.prompt).toContain("--- exact excerpt 2 ---\ngamma");
    expect(handoff.prompt).not.toContain("chars 0-5");
  });

  it("rejoins coding lines across exact newline-only gaps", async () => {
    const text = "first\n\nsecond\nthird";
    const state = createEvidenceExposureState();
    const lineLoader = async () => ({ filename: "memo.txt", text });
    await applyEvidenceExposure(
      state,
      {
        tool_use_id: "r1",
        content: "1 first\n2 second",
        evidenceSegments: [
          { documentId: "d1", versionId: "v1", start: 0, end: 5 },
          { documentId: "d1", versionId: "v1", start: 7, end: 13 },
        ],
      },
      lineLoader,
    );
    const handoff = await compileEvidenceHandoff({
      state,
      load: lineLoader,
      originalRequest: "Summarize.",
      maxChars: 100,
    });
    expect(handoff.status).toBe("ready");
    if (handoff.status !== "ready") return;
    expect(handoff.manifest).toHaveLength(1);
    expect(handoff.prompt).toContain("first\n\nsecond");
    expect(handoff.prompt).not.toContain("third");
  });
});

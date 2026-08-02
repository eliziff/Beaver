import { describe, expect, it } from "vitest";
import {
  INITIAL_RESEARCH_CHECKPOINT_MAX_COUNT,
  applyEvidenceExposure,
  compileCheckpointedEvidenceResearchRefresh,
  compileEvidenceHandoff,
  compileEvidenceResearchCheckpoint,
  compileEvidenceResearchRefresh,
  compileEvidenceWorkingSet,
  compilePagedEvidenceHandoff,
  continueInitialResearch,
  createEvidenceExposureState,
  markReviewedUnionEvidence,
  renderEvidenceManifest,
} from "../evidenceExposure";

const source = "alpha beta gamma delta";
const load = async (documentId: string, versionId: string) =>
  documentId === "d1" && versionId === "v1"
    ? { filename: "contract.docx", text: source }
    : null;

describe("evidence exposure union", () => {
  it("bounds initial research while leaving targeted redraft research separate", () => {
    expect(INITIAL_RESEARCH_CHECKPOINT_MAX_COUNT).toBe(3);
    expect(continueInitialResearch(true, 2)).toBe(true);
    expect(continueInitialResearch(true, 3)).toBe(false);
    expect(continueInitialResearch(false, 1)).toBe(false);
  });

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

  it("can reproduce the pre-checkpoint v5 drafting handoff prompt", async () => {
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
    const handoff = await compileEvidenceHandoff({
      state,
      load,
      originalRequest: "Draft the clause.",
      maxChars: 100,
      promptVariant: "legacy-v5",
      domainGuidance: "Use output_document.",
    });
    expect(handoff.status).toBe("ready");
    if (handoff.status !== "ready") return;
    expect(handoff.prompt).toContain(
      "Complete the requested deliverable in this fresh drafting context.",
    );
    expect(handoff.prompt).toContain(
      "The tool domain that triggered this handoff is already loaded.",
    );
    expect(handoff.prompt).not.toContain("previous research agent");
    expect(handoff.prompt).toContain("alpha beta");
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
    expect(refresh.prompt).toContain("Inspect an indexed passage again only");
    expect(refresh.prompt).not.toContain("transcript");
    expect(refresh.prompt).not.toContain("tool");
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
      expect(handoff.prompt).toContain("You are the drafting agent");
      expect(handoff.prompt).toContain("A previous research agent");
      expect(handoff.prompt).not.toContain("tool domain");
      expect(handoff.prompt).not.toContain("fresh drafting context");
    }
  });

  it("compresses each evidence batch into an accretive research checkpoint", async () => {
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

    const checkpoint = await compileEvidenceResearchCheckpoint({
      state,
      load,
      originalRequest: "Analyze the record.",
      priorBrief: "Earlier finding from prior.docx.",
      orientation: [{ name: "Glob", content: "prior.docx\tchars=5019" }],
      latestResults: [{ name: "Grep", content: "new exact result" }],
      maxBriefChars: 12_000,
    });
    expect(checkpoint.prompt).toContain("checkpoint_research");
    expect(checkpoint.prompt).toContain("continue_research");
    expect(checkpoint.prompt).toContain("materially change");
    expect(checkpoint.prompt).toContain("corroboration is not enough");
    expect(checkpoint.prompt).toContain("Earlier finding from prior.docx.");
    expect(checkpoint.prompt).toContain("new exact result");
    expect(checkpoint.prompt).toContain("prior.docx\tchars=5019");
    expect(checkpoint.prompt).not.toContain("SECRET_TAIL");

    const finalCheckpoint = await compileEvidenceResearchCheckpoint({
      state,
      load,
      originalRequest: "Analyze the record.",
      priorBrief: "Earlier finding from prior.docx.",
      orientation: [],
      latestResults: [{ name: "Grep", content: "final exact result" }],
      maxBriefChars: 12_000,
      forceComplete: true,
    });
    expect(finalCheckpoint.prompt).toContain(
      "final initial-research checkpoint",
    );
    expect(finalCheckpoint.prompt).toContain("set continue_research=false");
    expect(finalCheckpoint.prompt).toContain("reopen targeted research");

    const refresh = await compileCheckpointedEvidenceResearchRefresh({
      state,
      load,
      originalRequest: "Analyze the record.",
      researchBrief: "Updated finding; verify section 1.",
      continueResearch: true,
      orientation: [{ name: "Glob", content: "prior.docx\tchars=5019" }],
    });
    expect(refresh.prompt).toContain("Updated finding; verify section 1.");
    expect(refresh.prompt).toContain("You are the research agent");
    expect(refresh.prompt).toContain("Do not draft the deliverable");
    expect(refresh.prompt).toContain("Do not scan unread sources");
    expect(refresh.prompt).toContain("do not stop for confirmation");
    expect(refresh.prompt).toContain("file\titems\tchars\tlocators");
    expect(refresh.prompt).toContain("prior.docx\t1\t");
    expect(refresh.prompt).not.toContain("SECRET_TAIL");
    expect(refresh.prompt).not.toContain("alias\tlocator");

    const completed = await compileCheckpointedEvidenceResearchRefresh({
      state,
      load,
      originalRequest: "Analyze the record.",
      researchBrief: "Updated finding; no material checks remain.",
      continueResearch: false,
      orientation: [],
    });
    expect(completed.prompt).toContain("marked research complete");
    expect(completed.prompt).toContain("Call describe_tools now");
    expect(completed.prompt).toContain("carry this exact reviewed checkpoint");
    expect(completed.prompt).not.toContain("drafting_brief");
    expect(completed.prompt).toContain("Do not make another research call");
  });

  it("hands drafting notes and hot evidence while paging the full exact union", async () => {
    const text = `TARGET FACT\n${"z".repeat(5_000)}\nSECRET_TAIL`;
    const state = createEvidenceExposureState();
    const loader = async () => ({ filename: "long-contract.docx", text });
    await applyEvidenceExposure(
      state,
      {
        tool_use_id: "whole",
        content: text,
        evidenceSegments: [
          {
            documentId: "d1",
            versionId: "v1",
            start: 0,
            end: text.length,
            kind: "evidence",
          },
        ],
      },
      loader,
    );
    await applyEvidenceExposure(
      state,
      {
        tool_use_id: "grep",
        content: "TARGET FACT",
        evidenceSegments: [
          {
            documentId: "d1",
            versionId: "v1",
            start: 0,
            end: "TARGET FACT".length,
            kind: "candidate",
            locator: "section 9.2",
          },
        ],
      },
      loader,
    );

    const handoff = await compilePagedEvidenceHandoff({
      state,
      load: loader,
      originalRequest: "Draft the advice.",
      researchBrief: "The target fact controls; verify section 9.2.",
      orientation: [{ name: "Glob", content: "long-contract.docx\tchars=5025" }],
      workingSetPath: ".mike/working-sets/evidence.txt",
      hotMaxChars: 1_000,
    });
    expect(handoff.prompt).toContain("previous research agent");
    expect(handoff.prompt).toContain("The target fact controls");
    expect(handoff.prompt).toContain(
      'Grep(path=".mike/working-sets/evidence.txt", output_mode="content")',
    );
    expect(handoff.prompt).toContain("Never page through the union sequentially");
    expect(handoff.prompt).toContain("checkpoint as a coverage checklist");
    expect(handoff.prompt).toContain("complete operative provisions");
    expect(handoff.prompt).toContain("rereading a mapped source span");
    expect(handoff.prompt).toContain("PINNED ORIENTATION");
    expect(handoff.prompt).toContain("long-contract.docx\tchars=5025");
    expect(handoff.prompt).toContain("HOT EXACT EVIDENCE");
    expect(handoff.prompt).toContain("TARGET FACT");
    expect(handoff.prompt).not.toContain("SECRET_TAIL");
    expect(handoff.workingSet.text).toContain("SECRET_TAIL");
    expect(handoff.workingSet.segments).toHaveLength(1);
    expect(handoff.sourceChars).toBe(text.length);
    expect(handoff.hotSourceChars).toBe("TARGET FACT".length);
    expect(handoff.orientationChars).toBeGreaterThan(0);
  });

  it("mounts exact observed evidence without creating a handoff prompt", async () => {
    const state = createEvidenceExposureState();
    await applyEvidenceExposure(
      state,
      {
        tool_use_id: "read",
        content: source,
        evidenceSegments: [
          {
            documentId: "d1",
            versionId: "v1",
            start: 0,
            end: source.length,
            kind: "evidence",
          },
        ],
      },
      load,
    );

    const workingSet = await compileEvidenceWorkingSet({
      state,
      load,
      path: ".mike/working-sets/evidence.txt",
    });

    expect(workingSet.path).toBe(".mike/working-sets/evidence.txt");
    expect(workingSet.text).toContain(source);
    expect(workingSet.sourceChars).toBe(source.length);
    expect(workingSet.segments).toHaveLength(1);
    expect(workingSet.demandPaged).toBe(true);
  });

  it("keeps reviewed direct rereads in drafting but leaves new ranges for research", async () => {
    const durable = createEvidenceExposureState();
    await applyEvidenceExposure(
      durable,
      {
        tool_use_id: "source",
        content: source.slice(0, 10),
        evidenceSegments: [
          {
            documentId: "d1",
            versionId: "v1",
            start: 0,
            end: 10,
            projection: "canonical",
          },
        ],
        evidenceRefs: [
          {
            handle: "provider:one",
            filename: "case.html",
            text: "candidate passage",
          },
        ],
      },
      load,
    );
    const handoff = await compilePagedEvidenceHandoff({
      state: durable,
      load,
      originalRequest: "Draft from the evidence.",
      researchBrief: "The evidence was reviewed.",
      workingSetPath: ".mike/working-sets/evidence.txt",
      hotMaxChars: 0,
    });
    const direct = markReviewedUnionEvidence(
      {
        tool_use_id: "direct",
        content: "alpha passage",
        evidenceSegments: [
          {
            documentId: "d1",
            versionId: "v1",
            start: 0,
            end: 5,
          },
        ],
        evidenceRefs: [
          {
            handle: "provider:one#chars=10-17",
            filename: "case.html",
            text: "passage",
          },
        ],
      },
      handoff.workingSet,
    );
    expect(direct.reviewedUnionBackedSourceChars).toBe(12);
    expect(direct.evidenceSegments?.[0].durableUnionBacked).toBe(true);
    expect(direct.evidenceRefs?.[0].durableUnionBacked).toBe(true);

    const unionResult = await applyEvidenceExposure(durable, direct, load, {
      skipDurableUnionBacked: true,
    });
    expect(unionResult.exposure).toEqual({
      uniqueSourceChars: 0,
      suppressedSourceChars: 12,
    });

    const freshContext = await applyEvidenceExposure(
      createEvidenceExposureState(),
      direct,
      load,
    );
    expect(freshContext.content).toBe("alpha passage");
    expect(freshContext.exposure?.uniqueSourceChars).toBe(12);

    const partiallyNew = markReviewedUnionEvidence(
      {
        tool_use_id: "partial",
        content: "beta gamma",
        evidenceSegments: [
          {
            documentId: "d1",
            versionId: "v1",
            start: 6,
            end: 16,
          },
        ],
      },
      handoff.workingSet,
    );
    expect(partiallyNew.reviewedUnionBackedSourceChars).toBeUndefined();
    expect(partiallyNew.evidenceSegments?.[0].durableUnionBacked).toBeUndefined();
  });

  it("retains an exact provider candidate when no stronger passage replaces it", async () => {
    const state = createEvidenceExposureState();
    await applyEvidenceExposure(
      state,
      {
        tool_use_id: "candidate",
        content: "candidate passage",
        evidenceRefs: [
          {
            handle: "provider:one",
            filename: "case.html",
            locator: "para 12",
            text: "candidate passage",
            kind: "candidate",
          },
        ],
      },
      load,
    );
    const handoff = await compilePagedEvidenceHandoff({
      state,
      load,
      originalRequest: "Analyze the case.",
      researchBrief: "Candidate at paragraph 12 needs treatment.",
      workingSetPath: ".mike/working-sets/evidence.txt",
      hotMaxChars: 1_000,
    });
    expect(handoff.workingSet.text).toContain("candidate passage");
    expect(handoff.workingSet.refs).toEqual([
      expect.objectContaining({
        handle: "provider:one",
        filename: "case.html",
        locator: "para 12",
        durableUnionBacked: true,
      }),
    ]);
    expect(handoff.hotSourceChars).toBe("candidate passage".length);
  });

  it("delivers a mounted provider span without adding it to the durable union twice", async () => {
    const durable = createEvidenceExposureState();
    await applyEvidenceExposure(
      durable,
      {
        tool_use_id: "provider-full",
        content: "candidate passage",
        evidenceRefs: [
          {
            handle: "provider:one",
            filename: "case.html",
            text: "candidate passage",
          },
        ],
      },
      load,
    );
    const projected = {
      tool_use_id: "provider-page",
      content: "passage",
      evidenceRefs: [
        {
          handle: "provider:one#chars=10-17",
          filename: "case.html",
          text: "passage",
          durableUnionBacked: true as const,
        },
      ],
    };
    const unionResult = await applyEvidenceExposure(
      durable,
      projected,
      load,
      { skipDurableUnionBacked: true },
    );
    expect(unionResult.exposure).toEqual({
      uniqueSourceChars: 0,
      suppressedSourceChars: "passage".length,
    });
    expect(durable.uniqueSourceChars).toBe("candidate passage".length);

    const freshContext = createEvidenceExposureState();
    const contextResult = await applyEvidenceExposure(
      freshContext,
      projected,
      load,
    );
    expect(contextResult.content).toBe("passage");
    expect(contextResult.exposure?.uniqueSourceChars).toBe("passage".length);
  });

  it("keeps a fresh partially overlapping mounted page bounded and exact", async () => {
    const exact = '"\\\n'.repeat(8_000);
    const mountedPage = exact.slice(0, 23_900);
    const context = createEvidenceExposureState();
    const result = await applyEvidenceExposure(
      context,
      {
        tool_use_id: "mounted-overlap",
        content: mountedPage,
        evidenceSegments: [
          {
            documentId: "large",
            versionId: "v1",
            start: 0,
            end: 23_000,
            durableUnionBacked: true,
          },
          {
            documentId: "large",
            versionId: "v1",
            start: 0,
            end: 100,
            durableUnionBacked: true,
          },
        ],
      },
      async (documentId, versionId) =>
        documentId === "large" && versionId === "v1"
          ? { filename: "large.txt", text: exact }
          : null,
    );

    expect(result.content).toBe(mountedPage);
    expect(result.content.length).toBeLessThanOrEqual(24_000);
    expect(result.status).not.toBe("already_exposed");
    expect(result.exposure).toEqual({
      uniqueSourceChars: 23_000,
      suppressedSourceChars: 100,
    });
  });

  it("bounds the compact evidence map without dropping the exact union", async () => {
    const state = createEvidenceExposureState();
    for (let index = 0; index < 120; index += 1) {
      const text = `exact evidence ${index}`;
      await applyEvidenceExposure(
        state,
        {
          tool_use_id: `r${index}`,
          content: text,
          evidenceRefs: [
            {
              handle: `provider:${index}`,
              filename: `${String(index).padStart(3, "0")}-${"long-name-".repeat(20)}.html`,
              locator: `paragraph ${index}`,
              text,
            },
          ],
        },
        load,
      );
    }

    const handoff = await compilePagedEvidenceHandoff({
      state,
      load,
      originalRequest: "Draft from every source.",
      researchBrief: "All sources remain material.",
      workingSetPath: ".mike/working-sets/evidence.txt",
      hotMaxChars: 0,
    });

    expect(handoff.evidenceMapChars).toBeLessThanOrEqual(12_000);
    expect(handoff.prompt).toContain("files omitted from this compact map");
    expect(handoff.workingSet.refs).toHaveLength(120);
    expect(handoff.workingSet.text).toContain("exact evidence 119");
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

import { describe, expect, it, vi } from "vitest";
import { applyAuthoritiesUserAction } from "../authoritiesActions";
import type { AuthoritiesUserAction } from "../authoritiesActionContract";
import { createAuthoritiesDraft, type AuthoritiesDraft } from "../authoritiesDomain";
import { assistantTools } from "./assistantTools";

/** A body sentence carrying two citations and one pinpoint, as the scan leaves it. */
const TEXT = "The duty of honest performance was recognized in Bhasin v Hrynew, 2014 SCC 71 " +
  "at para 33, and applied in R v Jordan, 2016 SCC 27.";
const at = (needle: string) => ({ start: TEXT.indexOf(needle),
  end: TEXT.indexOf(needle) + needle.length });

/** The reducer is the oracle: the seed and every edit run the production action. */
const seeded = (...needles: string[]) => needles.reduce((draft, needle) =>
  applyAuthoritiesUserAction(draft, { type: "add-occurrence", unitId: "body:7", ...at(needle) }),
{ ...createAuthoritiesDraft({ kind: "manual" }),
  units: [{ id: "body:7", kind: "body", ordinal: 7, footnoteId: null, footnoteRefs: [],
    pageNumbers: [3], text: TEXT, occurrenceIds: [] }] } as AuthoritiesDraft);

const harness = (seed: AuthoritiesDraft) => {
  let state = seed, revision = 4;
  const product = () => ({ id: "draft-1", kind: "authorities" as const, title: "Authorities",
    projectId: "matter-1", revision, state, outputs: {},
    createdAt: "2026-09-10T00:00:00.000Z", updatedAt: "2026-09-10T00:00:00.000Z" });
  const act = vi.fn(async (_scope: unknown, _id: string, _revision: number,
    action: AuthoritiesUserAction) => {
    state = applyAuthoritiesUserAction(state, action);
    revision += 1;
    return product();
  });
  const entries = assistantTools<Record<string, never>>({
    userId: "user-1", documents: {} as never, library: {} as never, projects: {} as never,
    workProducts: { get: vi.fn(async () => product()) } as never,
    authorities: { act } as never,
    authoritiesId: "draft-1", authoritiesRevision: revision,
    matterId: "matter-1", scope: "main", resolveArtifact: () => undefined,
    artifactFor: () => "", onMutationCommitted: () => undefined,
  });
  const tool = entries.find(({ name }) => name === "update_work_product")!;
  return {
    occurrenceIds: () => state.units[0].occurrenceIds,
    async edit(authorities_action: Record<string, unknown>) {
      const input = { action: "update", authorities_action };
      const output = await tool.execute(input, {}, new AbortController().signal,
        { id: "call-1", name: tool.name, input });
      const payload = JSON.parse((output.result.content[0] as { text: string }).text);
      expect(payload.ok).toBe(true);
      return payload.change as Record<string, unknown>;
    },
  };
};

describe("Authorities edits report their own delta", () => {
  it("returns the before and after authority span of a widened citation", async () => {
    const tools = harness(seeded("2014 SCC 71"));
    const [occurrenceId] = tools.occurrenceIds();

    const change = await tools.edit({ type: "set-authority-span", occurrenceId,
      ...at("Bhasin v Hrynew, 2014 SCC 71") });

    expect(change).toMatchObject({ type: "set-authority-span", changed: [{
      occurrence_id: occurrenceId, unit_id: "body:7", status: "updated",
      authority_span: {
        before: { ...at("2014 SCC 71"), text: "2014 SCC 71" },
        after: { ...at("Bhasin v Hrynew, 2014 SCC 71"), text: "Bhasin v Hrynew, 2014 SCC 71" },
      } }] });
    expect(change.changed_truncated).toBeUndefined();
  });

  it("reports the occurrence a removal dropped and the one an addition minted", async () => {
    const tools = harness(seeded("Bhasin v Hrynew, 2014 SCC 71", "R v Jordan, 2016 SCC 27"));
    const [, jordan] = tools.occurrenceIds();

    const removal = await tools.edit({ type: "remove-occurrence", occurrenceId: jordan });
    expect(removal).toMatchObject({ type: "remove-occurrence", changed: [{
      occurrence_id: jordan, unit_id: "body:7", status: "removed",
      citation: "2016 SCC 27", authority_span: { ...at("R v Jordan, 2016 SCC 27"),
        text: "R v Jordan, 2016 SCC 27" } }] });
    expect(removal.authorities_removed).toEqual([
      { id: "2016scc27", label: "R v Jordan, 2016 SCC 27" }]);

    const survivors = tools.occurrenceIds();
    const addition = await tools.edit({ type: "add-occurrence", unitId: "body:7",
      ...at("R v Jordan, 2016 SCC 27") });
    const added = tools.occurrenceIds().find((id) => !survivors.includes(id));
    expect(addition).toMatchObject({ type: "add-occurrence", changed: [{
      occurrence_id: added, unit_id: "body:7", status: "added",
      citation: "2016 SCC 27", authority_id: "2016scc27" }] });
    expect(addition.authorities_added).toEqual([
      { id: "2016scc27", label: "R v Jordan, 2016 SCC 27" }]);
  });

  it("reports an empty change list when the edit moved nothing", async () => {
    const tools = harness(seeded("2014 SCC 71"));
    const [occurrenceId] = tools.occurrenceIds();
    const span = at("Bhasin v Hrynew, 2014 SCC 71");

    const first = await tools.edit({ type: "set-authority-span", occurrenceId, ...span });
    const repeat = await tools.edit({ type: "set-authority-span", occurrenceId, ...span });

    expect((first.changed as unknown[]).length).toBe(1);
    expect(repeat).toEqual({ type: "set-authority-span", changed: [] });
  });
});

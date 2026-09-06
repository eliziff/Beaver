import { describe, expect, it } from "vitest";
import { deriveAuthorityProcedure, tabLabel } from "mike/shared/authorities-order.mjs";
import { createAuthoritiesDraft, decodeAuthoritiesDraft, reduceAuthoritiesDraft,
  type AuthorityIdentity } from "./authoritiesDomain";
import { decodeAuthoritiesUserAction } from "./authoritiesActionContract";

const identity = (id: string): AuthorityIdentity => ({ id, key: id, kind: "case", citation: id,
  name: id, displayName: null, sourceIdentity: null, source: { kind: "unresolved" },
  excluded: false, locators: [], evidenceIds: [] });
const state = () => ["Zulu", "Alpha", "Middle"].reduce((draft, id) => reduceAuthoritiesDraft(draft,
  { type: "add-authority", authority: identity(id) }), createAuthoritiesDraft({ kind: "manual" }));
const procedure = (ids = ["Zulu", "Alpha", "Middle"]) => deriveAuthorityProcedure({
  authorities: ids.map((id) => ({ id, citation: id, sortLabel: id, kind: "case" as const,
    excluded: false, reproduced: id !== "Alpha" })), units: [], occurrences: {},
  purpose: "book", manual: false, tableOrder: "alphabetical", tabStyle: "numeric",
});

describe("Authorities workflow contracts", () => {
  it("reserves a monotonically numbered slot even when its PDF is missing", () => {
    expect(procedure().map(({ id, tab }) => [id, tab])).toEqual([
      ["Zulu", "Tab 1"], ["Alpha", "Tab 2"], ["Middle", "Tab 3"],
    ]);
    expect(procedure(["Middle", "Zulu", "Alpha"]).map(({ id, tab }) => [id, tab])).toEqual([
      ["Middle", "Tab 1"], ["Zulu", "Tab 2"], ["Alpha", "Tab 3"],
    ]);
  });
  it("keeps custom labels on slots, not movable authorities", () => {
    const configured = reduceAuthoritiesDraft(state(), { type: "set-settings", settings: {
      tabStyle: "roman", tabPrefix: "Schedule ", tabStart: 4, tabLabels: ["Front", "", "Annex Z"],
    } });
    const moved = reduceAuthoritiesDraft(configured, { type: "move-authority", authorityId: "Middle", toIndex: 0 });
    expect(moved.authorityOrder).toEqual(["Middle", "Zulu", "Alpha"]);
    expect(moved.authorities).toEqual(configured.authorities);
    expect(moved.settings).toEqual(configured.settings);
    expect([1, 2, 3, 4].map((slot) => tabLabel(slot, moved.settings.tabStyle, moved.settings)))
      .toEqual(["Front", "Schedule V", "Annex Z", "Schedule VII"]);
    expect(decodeAuthoritiesDraft(moved)?.settings.tabLabels).toEqual(["Front", "", "Annex Z"]);
  });
  it.each([[-1], [3], [1.5]])("rejects invalid move target %s without mutating the draft", (toIndex) => {
    const draft = state();
    expect(() => reduceAuthoritiesDraft(draft, { type: "move-authority", authorityId: "Middle", toIndex })).toThrow();
    expect(draft.authorityOrder).toEqual(["Zulu", "Alpha", "Middle"]);
  });
  it("persists stages and returns replaced sources to source review", () => {
    let draft = reduceAuthoritiesDraft(state(), { type: "set-stage", stage: "build" });
    expect(decodeAuthoritiesDraft(draft)?.stage).toBe("build");
    draft = reduceAuthoritiesDraft(draft, { type: "attach-source", authorityId: "Zulu",
      bindingRole: "authority:z", binding: { kind: "local-file", handleId: "pdf" },
      filename: "z.pdf", sourceSha256: "a".repeat(64), sourceUrl: null, language: "en" });
    expect(draft.stage).toBe("sources");
  });
  it("validates the public slot, stage and explicit incomplete-export actions", () => {
    expect(decodeAuthoritiesUserAction({ type: "set-stage", stage: "sources" })).toEqual({ type: "set-stage", stage: "sources" });
    expect(decodeAuthoritiesUserAction({ type: "move-authority", authorityId: "Zulu", toIndex: 2 }))
      .toEqual({ type: "move-authority", authorityId: "Zulu", toIndex: 2 });
    expect(decodeAuthoritiesUserAction({ type: "set-settings", settings: { tabStart: 4, tabPrefix: "Schedule ",
      tabLabels: ["Intro", ""], allowIncomplete: true } })).toEqual({ type: "set-settings", settings: {
      tabStart: 4, tabPrefix: "Schedule ", tabLabels: ["Intro", ""], allowIncomplete: true,
    } });
    expect(() => decodeAuthoritiesUserAction({ type: "set-settings", settings: { tabStart: 0 } })).toThrow();
    expect(() => decodeAuthoritiesUserAction({ type: "set-settings", settings: { allowIncomplete: "yes" } })).toThrow();
    expect(() => decodeAuthoritiesUserAction({ type: "set-stage", stage: "export-everything" })).toThrow();
  });
});

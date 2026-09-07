import { describe, expect, it } from "vitest";
import { attachAuthoritySource, authoritiesInputPlan, hasBilingualAuthoritySource,
  type AttachedAuthoritySource, type AuthoritySourceDecision } from "mike/shared/authorities-sources.mjs";

const source = (role: string, language: AttachedAuthoritySource["language"] = "en") => ({
  bindingRole: role, filename: `${role}.pdf`, sourceSha256: "a".repeat(64), sourceUrl: null,
  origin: "manual" as const, language,
});
const authority = (sources: AttachedAuthoritySource[], excluded = false) => ({
  excluded, source: { kind: "attached", sources } as AuthoritySourceDecision,
});
function draft() {
  return {
    import: { kind: "document" as const, bindingRole: "source", fileType: "pdf" as "pdf" | "docx" },
    bindings: Object.fromEntries(["en", "fr", "excluded", "cover", "source"].map(role =>
      [role, { handleId: role }])),
    authorities: { included: authority([source("en"), source("fr", "fr")]),
      excluded: authority([source("excluded")], true) },
    bookParts: { cover: source("cover"), index: null, supplements: [] },
    outputMode: "both" as "table" | "book" | "both", insertIntoDocument: false,
    stage: "build" as "citations" | "sources" | "highlights" | "build",
  };
}

describe("shared Authorities attachment rules", () => {
  it("replaces a language pair with one bilingual PDF and returns to source review", () => {
    const state = draft(), binding = { handleId: "bilingual" };
    attachAuthoritySource(state, state.authorities.included, source("bilingual", "bilingual"), binding);
    expect(state.authorities.included.source).toEqual({ kind: "attached", sources: [source("bilingual", "bilingual")] });
    expect(Object.keys(state.bindings).sort()).toEqual(["bilingual", "cover", "excluded", "source"]);
    expect(state.stage).toBe("sources");
    binding.handleId = "changed externally";
    expect(state.bindings.bilingual.handleId).toBe("bilingual");
    expect(hasBilingualAuthoritySource(state.authorities.included.source)).toBe(true);
  });

  it("replaces bilingual with one language, retains the other on subsequent replacement, and keeps citation review open", () => {
    const state = draft(); state.stage = "citations";
    attachAuthoritySource(state, state.authorities.included, source("bilingual", "bilingual"), { handleId: "bi" });
    attachAuthoritySource(state, state.authorities.included, source("fr", "fr"), { handleId: "fr" });
    expect(hasBilingualAuthoritySource(state.authorities.included.source)).toBe(false);
    attachAuthoritySource(state, state.authorities.included, source("en"), { handleId: "en" });
    attachAuthoritySource(state, state.authorities.included, source("new-en"), { handleId: "new-en" });
    expect(state.authorities.included.source).toEqual({ kind: "attached", sources: [source("new-en"), source("fr", "fr")] });
    expect(state.bindings.bilingual).toBeUndefined();
    expect(state.bindings.en).toBeUndefined();
    expect(state.stage).toBe("citations");
    expect(hasBilingualAuthoritySource(state.authorities.included.source)).toBe(true);
  });

  it.each(["authority", "book", "import"])("does not delete a discarded binding still used by another %s", (consumer) => {
    const state = draft();
    if (consumer === "authority") state.authorities.excluded = authority([source("en")], true);
    if (consumer === "book") state.bookParts.cover = source("en");
    if (consumer === "import") state.import.bindingRole = "en";
    attachAuthoritySource(state, state.authorities.included, source("bilingual", "bilingual"), { handleId: "bi" });
    expect(state.bindings.en).toEqual({ handleId: "en" });
    expect(state.bindings.fr).toBeUndefined();
  });
});

describe("shared Authorities input planning", () => {
  it.each(["book", "both"] as const)("selects included authority and book bytes for %s without losing excluded references", (mode) => {
    const state = draft(); state.outputMode = mode;
    const plan = authoritiesInputPlan(state);
    expect([...plan.byteRoles]).toEqual(["en", "fr", "cover"]);
    expect([...plan.bookRoles]).toEqual(["en", "fr"]);
    expect(plan.authoritySources.map(({ source }) => source.bindingRole)).toEqual(["en", "fr", "excluded"]);
    expect(plan.bookPdfs).toEqual([source("cover")]);
  });

  it.each([
    [false, "pdf", true, []],
    [true, "docx", true, ["source"]],
    [true, "pdf", false, ["source"]],
    [true, "pdf", true, ["en", "fr", "source"]],
  ] as const)("plans table bytes for insertion=%s, %s, filing requirement=%s", (insert, fileType, required, roles) => {
    const state = draft(); state.outputMode = "table"; state.insertIntoDocument = insert;
    state.import.fileType = fileType;
    const plan = authoritiesInputPlan(state, { unlinkedPdfTableSources: required });
    expect([...plan.byteRoles]).toEqual(roles);
    expect(plan.bookRoles.size).toBe(0);
    expect(plan.bookPdfs).toEqual([]);
    expect(plan.authoritySources).toHaveLength(3);
  });

  it("deduplicates uploads without dropping authority references from the verification plan", () => {
    const state = draft();
    state.authorities.excluded = authority([source("en")]);
    const plan = authoritiesInputPlan(state);
    expect([...plan.byteRoles]).toEqual(["en", "fr", "cover"]);
    expect(plan.authoritySources).toHaveLength(3);
  });
});

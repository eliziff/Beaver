import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ supabaseCalls: 0 }));
vi.mock("../../lib/localMode", () => ({ isLocalRuntime: () => true }));
vi.mock("../../lib/supabase", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/supabase")>()),
  createServerSupabase: () => {
    mocks.supabaseCalls += 1;
    throw new Error("Supabase must not be used by local workflow routes");
  },
}));

const canonicalIds = [
  "drafting", "document-review", "legal-research", "quote-checking",
  "agreement-work", "due-diligence",
  "transaction-management", "corporate-approvals", "submission-drafting",
  "evidence-review", "court-records", "authorities",
];
const preservedRecipeIds = [
  "builtin-change-of-control-tabular-review",
  "builtin-commercial-agreement-tabular-review", "builtin-commercial-lease-review",
  "builtin-commercial-lease-tabular-review", "builtin-compare-documents",
  "builtin-corporate-approvals-review", "builtin-credit-agreement-review",
  "builtin-credit-agreement-tabular-review", "builtin-draft-cp-checklist",
  "builtin-draft-from-template", "builtin-draft-issues-list",
  "builtin-e-discovery-tabular-review", "builtin-employment-agreement-review",
  "builtin-employment-agreement-tabular-review", "builtin-extract-key-terms",
  "builtin-guarantee-agreement-review",
  "builtin-limited-partnership-agreement-tabular-review", "builtin-nda-review",
  "builtin-nda-tabular-review", "builtin-proofread",
  "builtin-shareholder-agreement-review",
  "builtin-shareholder-agreement-tabular-review", "builtin-spa-tabular-review",
  "builtin-supply-agreement-tabular-review",
];

async function loadApi() {
  vi.resetModules();
  return (await import("../../api")).api;
}

let dataHome: string;
beforeEach(async () => {
  dataHome = await mkdtemp(path.join(os.tmpdir(), "beaver-workflows-"));
  vi.stubEnv("AUTH_MODE", "local");
  vi.stubEnv("MIKE_LOCAL_DATA_DIR", dataHome);
  vi.stubEnv("SUPABASE_URL", "");
  vi.stubEnv("SUPABASE_SECRET_KEY", "");
  mocks.supabaseCalls = 0;
});
afterEach(async () => {
  await (await import("../../lib/relationalDatabase")).closeRelationalDatabase();
  vi.unstubAllEnvs();
  vi.resetModules();
  await rm(dataHome, { recursive: true, force: true });
}, 30_000);

describe("account-free workflow catalogue", () => {
  it("lists 12 canonical workflows while preserving each concrete recipe as a variant", async () => {
    const api = await loadApi();
    const [all, general, solicitor, litigator, search] = await Promise.all([
      request(api).get("/workflows?audience=all"),
      request(api).get("/workflows?audience=general"),
      request(api).get("/workflows?audience=solicitor"),
      request(api).get("/workflows?audience=litigator"),
      request(api).get("/workflows?audience=all&q=commercial%20lease"),
    ]);

    expect(all.status).toBe(200);
    expect(all.body.map(({ id }: { id: string }) => id)).toEqual(canonicalIds);
    expect(general.body).toHaveLength(4);
    expect(solicitor.body).toHaveLength(8);
    expect(litigator.body).toHaveLength(8);
    expect(search.body.map(({ id }: { id: string }) => id)).toEqual(["agreement-work"]);
    const variants = all.body.flatMap(({ launcher }: {
      launcher: { variants?: { id: string; result: string; description: string }[] };
    }) => launcher.variants ?? []);
    expect(variants.every((variant: object) => !("skill_md" in variant))).toBe(true);
    expect(variants.every(({ result, description }: { result: string; description: string }) => {
      const detail = description.trim();
      return detail.split(/\s+/u).length >= 12 && detail.length > result.trim().length;
    })).toBe(true);
    const publicDescriptions = all.body.flatMap(({ metadata, launcher }: {
      metadata: { description: string }; launcher: { variants?: { description: string }[] };
    }) => [metadata.description, ...(launcher.variants ?? []).map(({ description }) => description)]);
    expect(publicDescriptions.some((description: string) =>
      /table-columns\.yaml|If the user has not provided|read_document|library_read|requires_review|\{\{|## Instructions|exactly these columns|Before finalizing/iu
        .test(description))).toBe(false);
    expect(JSON.stringify(all.body)).not.toMatch(/[âÃÂ]/u);
    expect(JSON.stringify((await import("../../lib/systemWorkflows")).SYSTEM_WORKFLOWS))
      .not.toMatch(/[âÃÂ]/u);
    expect(all.body.some(({ launcher }: { launcher: { variants?: { columns_config?: unknown[] }[] } }) =>
      launcher.variants?.some(({ columns_config }) => columns_config?.length))).toBe(true);
    const variantIds = variants.map(({ id }: { id: string }) => id);
    expect(variantIds).toEqual(expect.arrayContaining(preservedRecipeIds));
    expect(new Set(variantIds).size).toBe(variantIds.length);
    expect(variants.every(({ result }: { result: string | null }) => result?.trim() &&
      !["Written review", "Review table"].includes(result))).toBe(true);
    expect(all.body.find(({ id }: { id: string }) => id === "drafting").launcher.variants
      .map(({ id }: { id: string }) => id)).toEqual(expect.arrayContaining([
        "builtin-create-template", "builtin-draft-from-template",
      ]));
    expect(all.body.find(({ id }: { id: string }) => id === "document-review").launcher.variants
      .map(({ id }: { id: string }) => id)).toContain("builtin-compare-documents");
    expect(all.body.find(({ id }: { id: string }) => id === "document-review").launcher.variants
      .map(({ id }: { id: string }) => id)).not.toContain("builtin-draft-issues-list");
    expect(all.body.find(({ id }: { id: string }) => id === "agreement-work").launcher.variants
      .map(({ id }: { id: string }) => id)).toContain("builtin-draft-issues-list");
    expect(variantIds).not.toContain("builtin-agreement-work-general");
    expect(all.body.find(({ id }: { id: string }) => id === "authorities").launcher)
      .toEqual({ kind: "authorities" });
    expect(all.body.find(({ id }: { id: string }) => id === "court-records").launcher)
      .toEqual({ kind: "court_records" });
    expect(mocks.supabaseCalls).toBe(0);
  }, 30_000);

  it("persists one canonical custom instruction variant and exports that exact result", async () => {
    const api = await loadApi();
    const created = await request(api).post("/workflows").send({
      metadata: {
        title: "Contract review", category: "Document review and comparison",
        audiences: ["general"],
      },
      launcher: { kind: "instructions", variants: [{
        label: "Review contracts", result: "Review table", execution: "tabular",
        skill_md: "Review each agreement.",
        columns_config: [{ index: 0, name: "Term", prompt: "Extract the term." }],
      }] },
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    expect(created.body).toMatchObject({
      id, metadata: { category: "Document review and comparison", audiences: ["general"] },
      launcher: { kind: "instructions", variants: [{ id, label: "Review contracts",
        result: "Review table", execution: "tabular" }] },
    });

    const updated = await request(api).patch(`/workflows/${id}`).send({
      metadata: { title: "Focused contract review", audiences: ["solicitor"] },
      launcher: { kind: "instructions", variants: [{
        label: "Review one contract", result: null, execution: "assistant",
        skill_md: "Review the selected agreement.", columns_config: null,
      }] },
    });
    expect(updated.body).toMatchObject({ id,
      metadata: { title: "Focused contract review", audiences: ["solicitor"] },
      launcher: { variants: [{ id, label: "Review one contract", result: null,
        execution: "assistant", skill_md: "Review the selected agreement." }] } });
    expect((await request(api).get("/workflows?audience=general")).body
      .some((item: { id: string }) => item.id === id)).toBe(false);
    expect((await request(api).get("/workflows?audience=solicitor")).body
      .some((item: { id: string }) => item.id === id)).toBe(true);
    expect((await request(api).get(`/workflows/${id}`)).body.launcher.variants[0].skill_md)
      .toBe("Review the selected agreement.");

    const exported = await request(api).get(`/workflows/${id}/export`).buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => done(null, Buffer.concat(chunks)));
      });
    const zip = await (await import("jszip")).default.loadAsync(exported.body);
    expect(Object.keys(zip.files).filter((name) => !zip.files[name].dir))
      .toEqual(["focused-contract-review/SKILL.md"]);
    expect(await zip.file("focused-contract-review/SKILL.md")!.async("text"))
      .toContain("Review the selected agreement.");

    const { runtime } = await import("../../runtime");
    const store = await runtime.workflows().then((ports) => ports.repository({
      userId: "00000000-0000-0000-0000-000000000001",
    }).assistants());
    expect(store.get(id)).toEqual({ workflow_id: id,
      title: "Focused contract review", skill_md: "Review the selected agreement." });
    expect((await request(api).delete(`/workflows/${id}`)).status).toBe(204);
    expect((await request(api).get(`/workflows/${id}`)).status).toBe(404);
    expect(mocks.supabaseCalls).toBe(0);
  }, 30_000);
});

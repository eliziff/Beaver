import express from "express";
import { PDFDocument } from "pdf-lib";
import request from "supertest";
import { beforeAll, it } from "vitest";
import { createAuthoritiesDraft, reduceAuthoritiesDraft } from "../lib/authoritiesDomain";
import { createAuthoritiesWorkspaceApplication } from "../lib/authoritiesWorkspaceApplication";
import { createAuthoritiesRouter } from "./authorities";
import { createAuthoritiesRuntimeRouter } from "./authoritiesRuntime";

beforeAll(() => { process.env.AUTH_MODE = "local"; });

it.each([
  { citation: "2034 FC 744", authorityId: "harbour" },
  { citation: "2034 FC 745", authorityId: null },
])("Beaver and standalone identify $citation from the PDF rather than its filename", async ({ citation, authorityId }) => {
  const state = reduceAuthoritiesDraft(createAuthoritiesDraft({ kind: "manual" }), {
    type: "add-authority", authority: { id: "harbour", key: "harbour", kind: "case", citation: "2034 FC 744",
      name: "Harbour Paddlers v River Board", displayName: null, excluded: false, evidenceIds: [], locators: [],
      sourceIdentity: null, source: { kind: "unresolved" } },
  });
  type Dependencies = Parameters<typeof createAuthoritiesWorkspaceApplication>;
  const application = createAuthoritiesWorkspaceApplication({} as Dependencies[0], {
    get: async () => ({ id: "draft", kind: "authorities", revision: 1, state }),
  } as unknown as Dependencies[1], {} as Dependencies[2]);
  const app = express(); app.use(express.json());
  app.use("/authorities", createAuthoritiesRouter(application));
  app.use("/authorities-runtime", createAuthoritiesRuntimeRouter((_req, _res, next) => next()));
  const pdf = await PDFDocument.create();
  pdf.addPage().drawText(`Citation: ${citation}\n[1] The board gave notice before the hearing began.`, {
    x: 50, y: 740, size: 12, maxWidth: 510, lineHeight: 16,
  });
  const bytes = Buffer.from(await pdf.save());

  await request(app).post("/authorities/draft/pdf-authority")
    .attach("file", bytes, "2034fc744.pdf").expect(200, { authorityId });
  await request(app).post("/authorities-runtime/pdf-authority")
    .field("draft", JSON.stringify(state)).attach("file", bytes, "2034fc744.pdf")
    .expect(200, { authorityId });
});

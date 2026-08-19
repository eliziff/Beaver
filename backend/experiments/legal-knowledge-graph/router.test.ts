import express from "express";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LegalKnowledgeGraphStore } from "./store";
import { createLegalKnowledgeRouter } from "./router";

let directory = "";
let store: LegalKnowledgeGraphStore;
let app: express.Express;
const originalAuthMode = process.env.AUTH_MODE;

beforeEach(async () => {
  process.env.AUTH_MODE = "local";
  directory = await mkdtemp(path.join(os.tmpdir(), "beaver-knowledge-route-"));
  store = new LegalKnowledgeGraphStore(path.join(directory, "knowledge.sqlite"));
  app = express();
  app.use(express.json());
  app.use(
    "/legal-knowledge",
    createLegalKnowledgeRouter({
      store,
      sourceExists: async (_userId, sourceId) => sourceId === "case-1",
    }),
  );
});

afterEach(async () => {
  store.close();
  await rm(directory, { recursive: true, force: true });
  process.env.AUTH_MODE = originalAuthMode;
});

describe("legal knowledge routes", () => {
  it("creates project-scoped hierarchical labels and marks a saved source", async () => {
    expect(store.hasProject("local-user", "general")).toBe(true);

    const parent = await request(app)
      .post("/legal-knowledge/projects/general/nodes")
      .send({ kind: "label", name: "Public law", color: "#b91c1c" });
    const child = await request(app)
      .post("/legal-knowledge/projects/general/nodes")
      .send({
        kind: "label",
        name: "Reasonableness",
        parent_id: parent.body.id,
      });
    const mark = await request(app)
      .put("/legal-knowledge/projects/general/sources/case-1/mark")
      .send({
        label_ids: [child.body.id],
        note: "Use for the standard of review.",
      });
    const graphRead = vi
      .spyOn(store, "graph")
      .mockImplementation(() => {
        throw new Error("marking must not load the whole graph");
      });
    const snapshot = await request(app)
      .get("/legal-knowledge/projects/general/marking")
      .query({ source_id: "case-1" });

    expect(parent.status).toBe(201);
    expect(child.status).toBe(201);
    expect(mark.status).toBe(200);
    expect(snapshot.status).toBe(200);
    expect(graphRead).not.toHaveBeenCalled();
    expect(snapshot.body.mark).toEqual(mark.body);
    expect(snapshot.body.edges).toContainEqual({
      from_node_id: child.body.id,
      to_node_id: parent.body.id,
      relation: "parent",
      order: 0,
    });
  });

  it("stores ontology structure but does not expose the mutable evidence writer", async () => {
    const testNode = await request(app)
      .post("/legal-knowledge/projects/general/nodes")
      .send({ kind: "legal_test", name: "Reasonableness review" });
    const factor = await request(app)
      .post("/legal-knowledge/projects/general/nodes")
      .send({
        kind: "factor",
        name: "Justification",
        parent_id: testNode.body.id,
      });
    const evidence = await request(app)
      .post("/legal-knowledge/projects/general/evidence")
      .send({
        source_id: "case-1",
        locator_kind: "paragraph",
        locator: "85",
        quote: "The reasons must be justified.",
        canonical_url: "https://example.test/case#par85",
      });
    const graph = await request(app).get(
      "/legal-knowledge/projects/general/graph",
    );

    expect(testNode.status).toBe(201);
    expect(factor.status).toBe(201);
    expect(evidence.status).toBe(404);
    expect(graph.body.edges).toContainEqual({
      from_node_id: factor.body.id,
      to_node_id: testNode.body.id,
      relation: "parent",
      order: 0,
    });
    expect(graph.body.evidence).toEqual([]);
  });
});

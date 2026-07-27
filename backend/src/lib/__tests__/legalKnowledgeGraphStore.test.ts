import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  LEGAL_KNOWLEDGE_SCHEMA_VERSION,
  LegalKnowledgeGraphStore,
} from "../legalKnowledgeGraphStore";

const stores: LegalKnowledgeGraphStore[] = [];
const directories: string[] = [];

async function store() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mike-knowledge-"));
  directories.push(directory);
  const result = new LegalKnowledgeGraphStore(
    path.join(directory, "knowledge.sqlite"),
  );
  stores.push(result);
  return result;
}

afterEach(async () => {
  for (const item of stores.splice(0)) item.close();
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("LegalKnowledgeGraphStore", () => {
  it("versions the schema and waits briefly for another local SQLite writer", async () => {
    const knowledge = await store();
    expect(
      (
        knowledge.database.prepare("PRAGMA user_version").get() as {
          user_version: number;
        }
      ).user_version,
    ).toBe(LEGAL_KNOWLEDGE_SCHEMA_VERSION);
    expect(
      (
        knowledge.database.prepare("PRAGMA busy_timeout").get() as {
          timeout: number;
        }
      ).timeout,
    ).toBe(5_000);
  });

  it("provides durable account-free research projects", async () => {
    const knowledge = await store();
    expect(knowledge.listProjects("local")).toEqual([
      { id: "general", name: "General research", order: 0 },
    ]);
    const project = knowledge.createProject("local", "Judicial review appeal");
    expect(knowledge.renameProject("local", project.id, "JR appeal")).toEqual({
      id: project.id,
      name: "JR appeal",
      order: 1,
    });
    knowledge.createLabel({
      userId: "local",
      projectId: project.id,
      name: "Remedy",
    });
    expect(knowledge.deleteProject("local", project.id)).toBe(true);
    expect(knowledge.listNodes("local", project.id)).toEqual([]);
    expect(() => knowledge.deleteProject("local", "general")).toThrow(
      /cannot be deleted/u,
    );
  });

  it("stores matter metadata and pointer-only Library membership by owner", async () => {
    const knowledge = await store();
    const matter = knowledge.createMatter("owner-a", {
      name: "Appeal",
      cmNumber: "CA-42",
      practice: "Litigation",
    });

    expect(knowledge.attachMatterDocument("owner-a", matter.id, "document-a")).toBe(
      true,
    );
    expect(knowledge.attachMatterDocument("owner-a", matter.id, "document-a")).toBe(
      true,
    );
    expect(knowledge.attachMatterDocument("owner-a", matter.id, "document-b")).toBe(
      true,
    );
    expect(knowledge.listMatterDocumentIds("owner-a", matter.id)).toEqual([
      "document-a",
      "document-b",
    ]);
    expect(knowledge.getMatter("owner-b", matter.id)).toBeNull();

    expect(
      knowledge.updateMatter("owner-a", matter.id, {
        name: "Appeal record",
        cmNumber: null,
      }),
    ).toMatchObject({
      id: matter.id,
      name: "Appeal record",
      cm_number: null,
      practice: "Litigation",
    });
    expect(
      knowledge.removeMatterDocument("owner-a", matter.id, "document-a"),
    ).toBe(true);
    expect(knowledge.listMatterDocumentIds("owner-a", matter.id)).toEqual([
      "document-b",
    ]);
  });

  it("uses the same graph for hierarchical labels and legal-test ontology", async () => {
    const knowledge = await store();
    const label = knowledge.createLabel({
      userId: "local",
      projectId: "appeal",
      name: "Standard of review",
    });
    const test = knowledge.createNode({
      userId: "local",
      projectId: "appeal",
      kind: "legal_test",
      name: "Reasonableness review",
    });
    const factor = knowledge.createNode({
      userId: "local",
      projectId: "appeal",
      kind: "factor",
      name: "Justification",
    });
    knowledge.setParent({
      userId: "local",
      projectId: "appeal",
      nodeId: factor.id,
      parentId: test.id,
    });
    const evidence = knowledge.upsertEvidence({
      userId: "local",
      projectId: "appeal",
      sourceId: "case-1",
      locatorKind: "paragraph",
      locator: "85",
      quote: "The reasons must be justified in relation to the legal constraints.",
      canonicalUrl: "https://example.test/case#par85",
    });
    knowledge.linkEvidence({
      userId: "local",
      projectId: "appeal",
      evidenceId: evidence.id,
      nodeId: factor.id,
      relation: "discusses",
    });

    const graph = knowledge.graph("local", "appeal");
    expect(graph.nodes.map((node) => node.id)).toEqual(
      expect.arrayContaining([label.id, test.id, factor.id]),
    );
    expect(graph.edges).toContainEqual({
      from_node_id: factor.id,
      to_node_id: test.id,
      relation: "parent",
      order: 0,
    });
    expect(graph.evidence_links).toContainEqual({
      evidence_id: evidence.id,
      node_id: factor.id,
      relation: "discusses",
    });
    expect(graph.evidence[0].quote_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("keeps marks isolated by project and exposes labels as a graph view", async () => {
    const knowledge = await store();
    const parent = knowledge.createLabel({
      userId: "local",
      projectId: "appeal",
      name: "Issue",
      color: "#b91c1c",
    });
    const child = knowledge.createLabel({
      userId: "local",
      projectId: "appeal",
      name: "Application",
      parentId: parent.id,
    });
    knowledge.createLabel({
      userId: "local",
      projectId: "other",
      name: "Application",
    });

    expect(
      knowledge.setMark({
        userId: "local",
        projectId: "appeal",
        sourceId: "case-1",
        labelIds: [child.id, child.id],
        note: "Use for the application section.",
      }),
    ).toEqual({
      source_id: "case-1",
      project_id: "appeal",
      label_ids: [child.id],
      note: "Use for the application section.",
    });
    expect(knowledge.listLabels("local", "appeal")).toHaveLength(2);
    expect(knowledge.listMarks("local", "other")).toEqual([]);
  });

  it("retags a source without mutating exact evidence for that source", async () => {
    const knowledge = await store();
    knowledge.listProjects("local");
    const label = knowledge.createLabel({
      userId: "local",
      projectId: "general",
      name: "Standard of review",
    });
    const evidence = knowledge.upsertEvidence({
      userId: "local",
      projectId: "general",
      sourceId: "case-1",
      quote: "The whole-source proposition remains exact.",
      canonicalUrl: "https://example.test/case",
      note: "Evidence note",
    });

    knowledge.setMark({
      userId: "local",
      projectId: "general",
      sourceId: "case-1",
      labelIds: [label.id],
      note: "First project note",
    });
    knowledge.setMark({
      userId: "local",
      projectId: "general",
      sourceId: "case-1",
      labelIds: [],
      note: "Retagged project note",
    });

    expect(
      knowledge
        .graph("local", "general")
        .evidence.find((item) => item.id === evidence.id),
    ).toEqual(evidence);
    expect(knowledge.getMark("local", "general", "case-1")).toEqual({
      source_id: "case-1",
      project_id: "general",
      label_ids: [],
      note: "Retagged project note",
    });
  });

  it("limits only the label picker hierarchy while allowing deeper ontology", async () => {
    const knowledge = await store();
    const first = knowledge.createLabel({
      userId: "local",
      projectId: "appeal",
      name: "One",
    });
    const second = knowledge.createLabel({
      userId: "local",
      projectId: "appeal",
      name: "Two",
      parentId: first.id,
    });
    const third = knowledge.createLabel({
      userId: "local",
      projectId: "appeal",
      name: "Three",
      parentId: second.id,
    });
    expect(() =>
      knowledge.createLabel({
        userId: "local",
        projectId: "appeal",
        name: "Four",
        parentId: third.id,
      }),
    ).toThrow(/maximum depth/u);

    let parent = knowledge.createNode({
      userId: "local",
      projectId: "appeal",
      kind: "factor",
      name: "Factor 1",
    });
    expect(() =>
      knowledge.setParent({
        userId: "local",
        projectId: "appeal",
        nodeId: third.id,
        parentId: parent.id,
      }),
    ).toThrow(/separate hierarchies/u);
    for (let depth = 2; depth <= 5; depth += 1) {
      const node = knowledge.createNode({
        userId: "local",
        projectId: "appeal",
        kind: "factor",
        name: `Factor ${depth}`,
      });
      knowledge.setParent({
        userId: "local",
        projectId: "appeal",
        nodeId: node.id,
        parentId: parent.id,
      });
      parent = node;
    }
    expect(knowledge.listEdges("local", "appeal", "parent")).toHaveLength(6);
  });

  it("rolls back a failed parent replacement", async () => {
    const knowledge = await store();
    knowledge.listProjects("local");
    const child = knowledge.createNode({
      userId: "local",
      projectId: "general",
      kind: "factor",
      name: "Child",
    });
    const first = knowledge.createNode({
      userId: "local",
      projectId: "general",
      kind: "factor",
      name: "First parent",
    });
    const second = knowledge.createNode({
      userId: "local",
      projectId: "general",
      kind: "factor",
      name: "Second parent",
    });
    knowledge.setParent({
      userId: "local",
      projectId: "general",
      nodeId: child.id,
      parentId: first.id,
    });
    knowledge.database.exec(`
      CREATE TRIGGER reject_parent_insert
      BEFORE INSERT ON legal_knowledge_edges
      WHEN NEW.relation = 'parent'
      BEGIN
        SELECT RAISE(ABORT, 'rejected for test');
      END;
    `);

    expect(() =>
      knowledge.setParent({
        userId: "local",
        projectId: "general",
        nodeId: child.id,
        parentId: second.id,
      }),
    ).toThrow(/rejected for test/u);
    expect(knowledge.listEdges("local", "general", "parent")).toContainEqual({
      from_node_id: child.id,
      to_node_id: first.id,
      relation: "parent",
      order: 0,
    });
  });

  it("removes empty source marks when their label subtree is deleted", async () => {
    const knowledge = await store();
    const parent = knowledge.createLabel({
      userId: "local",
      projectId: "appeal",
      name: "Issue",
    });
    const child = knowledge.createLabel({
      userId: "local",
      projectId: "appeal",
      name: "Application",
      parentId: parent.id,
    });
    knowledge.setMark({
      userId: "local",
      projectId: "appeal",
      sourceId: "case-1",
      labelIds: [child.id],
    });

    expect(knowledge.deleteLabel("local", "appeal", parent.id)).toBe(true);
    expect(knowledge.listLabels("local", "appeal")).toEqual([]);
    expect(knowledge.listMarks("local", "appeal")).toEqual([]);
  });
});

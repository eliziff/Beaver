import { Router, type Response } from "express";
import { requireAuth } from "../middleware/auth";
import {
  legalKnowledgeGraphStore,
  type LegalKnowledgeGraphStore,
} from "../lib/legalKnowledgeGraphStore";
import { getLocalLegalSource } from "../lib/localDocumentStore";

type SourceExists = (userId: string, sourceId: string) => Promise<boolean>;

function text(value: unknown, name: string, maximum = 500) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw new Error(`${name} is required`);
  if (result.length > maximum) throw new Error(`${name} is too long`);
  return result;
}

function optionalText(value: unknown, maximum = 500) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new Error("value must be text");
  const result = value.trim();
  if (result.length > maximum) throw new Error("value is too long");
  return result || null;
}

function optionalObject(value: unknown) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("data must be an object");
  }
  return value as Record<string, unknown>;
}

function userId(res: Response) {
  return String(res.locals.userId);
}

async function storedSourceExists(user: string, sourceId: string) {
  return Boolean(await getLocalLegalSource(user, sourceId));
}

export function createLegalKnowledgeRouter(options?: {
  store?: LegalKnowledgeGraphStore;
  sourceExists?: SourceExists;
}) {
  const router = Router();
  const store = () => options?.store ?? legalKnowledgeGraphStore();
  const sourceExists = options?.sourceExists ?? storedSourceExists;

  router.use(requireAuth);

  function projectExists(user: string, projectId: string) {
    return store().listProjects(user).some((project) => project.id === projectId);
  }

  router.get("/projects", (_req, res) => {
    res.json({ projects: store().listProjects(userId(res)) });
  });

  router.post("/projects", (req, res) => {
    try {
      res
        .status(201)
        .json(store().createProject(userId(res), text(req.body?.name, "name", 120)));
    } catch (error) {
      res.status(400).json({
        detail:
          error instanceof Error ? error.message : "Could not create project",
      });
    }
  });

  router.patch("/projects/:projectId", (req, res) => {
    try {
      const project = store().renameProject(
        userId(res),
        req.params.projectId,
        text(req.body?.name, "name", 120),
      );
      if (!project) {
        res.status(404).json({ detail: "Research project not found" });
        return;
      }
      res.json(project);
    } catch (error) {
      res.status(400).json({
        detail:
          error instanceof Error ? error.message : "Could not rename project",
      });
    }
  });

  router.delete("/projects/:projectId", (req, res) => {
    try {
      if (!store().deleteProject(userId(res), req.params.projectId)) {
        res.status(404).json({ detail: "Research project not found" });
        return;
      }
      res.status(204).end();
    } catch (error) {
      res.status(400).json({
        detail:
          error instanceof Error ? error.message : "Could not delete project",
      });
    }
  });

  router.get("/projects/:projectId/graph", (req, res) => {
    const user = userId(res);
    if (!projectExists(user, req.params.projectId)) {
      res.status(404).json({ detail: "Research project not found" });
      return;
    }
    res.json(store().graph(user, req.params.projectId));
  });

  router.get("/projects/:projectId/marking", (req, res) => {
    try {
      const user = userId(res);
      const projectId = req.params.projectId;
      if (!projectExists(user, projectId)) {
        res.status(404).json({ detail: "Research project not found" });
        return;
      }
      const sourceId = optionalText(req.query.source_id, 500);
      const nodes = store().listNodes(user, projectId, "label");
      const labelIds = new Set(nodes.map((node) => node.id));
      res.json({
        nodes,
        edges: store().listEdges(user, projectId, "parent").filter(
          (edge) =>
            labelIds.has(edge.from_node_id) &&
            labelIds.has(edge.to_node_id),
        ),
        mark: sourceId ? store().getMark(user, projectId, sourceId) : null,
      });
    } catch (error) {
      res.status(400).json({
        detail:
          error instanceof Error ? error.message : "Could not load marking data",
      });
    }
  });

  router.post("/projects/:projectId/nodes", (req, res) => {
    const user = userId(res);
    const projectId = req.params.projectId;
    try {
      if (!projectExists(user, projectId)) {
        res.status(404).json({ detail: "Research project not found" });
        return;
      }
      const nodeKind = text(req.body?.kind, "kind", 40).toLowerCase();
      const parentId = optionalText(req.body?.parent_id, 200);
      if (nodeKind === "label") {
        res.status(201).json(
          store().createLabel({
            userId: user,
            projectId,
            name: text(req.body?.name, "name", 80),
            color: optionalText(req.body?.color, 20) ?? undefined,
            parentId,
          }),
        );
        return;
      }
      const node = store().createNode({
        userId: user,
        projectId,
        kind: nodeKind,
        name: text(req.body?.name, "name", 200),
        color: optionalText(req.body?.color, 20) ?? undefined,
        data: optionalObject(req.body?.data),
      });
      try {
        if (parentId) {
          store().setParent({
            userId: user,
            projectId,
            nodeId: node.id,
            parentId,
          });
        }
      } catch (error) {
        store().deleteNode(user, projectId, node.id);
        throw error;
      }
      res.status(201).json(node);
    } catch (error) {
      res.status(400).json({
        detail: error instanceof Error ? error.message : "Could not create node",
      });
    }
  });

  router.patch("/projects/:projectId/nodes/:nodeId", (req, res) => {
    const user = userId(res);
    const projectId = req.params.projectId;
    try {
      const current = store()
        .listNodes(user, projectId)
        .find((node) => node.id === req.params.nodeId);
      if (!current) {
        res.status(404).json({ detail: "Knowledge node not found" });
        return;
      }
      const parentProvided = Object.hasOwn(req.body ?? {}, "parent_id");
      const parentId = parentProvided
        ? optionalText(req.body?.parent_id, 200)
        : undefined;
      const updated =
        current.kind === "label"
          ? store().updateLabel({
              userId: user,
              projectId,
              labelId: current.id,
              name:
                req.body?.name === undefined
                  ? undefined
                  : text(req.body.name, "name", 80),
              color:
                req.body?.color === undefined
                  ? undefined
                  : text(req.body.color, "color", 20),
              ...(parentProvided ? { parentId } : {}),
            })
          : store().updateNode({
              userId: user,
              projectId,
              nodeId: current.id,
              name:
                req.body?.name === undefined
                  ? undefined
                  : text(req.body.name, "name", 200),
              color:
                req.body?.color === undefined
                  ? undefined
                  : text(req.body.color, "color", 20),
              data: optionalObject(req.body?.data),
            });
      if (current.kind !== "label" && parentProvided) {
        store().setParent({
          userId: user,
          projectId,
          nodeId: current.id,
          parentId: parentId ?? null,
        });
      }
      res.json(updated);
    } catch (error) {
      res.status(400).json({
        detail: error instanceof Error ? error.message : "Could not update node",
      });
    }
  });

  router.delete("/projects/:projectId/nodes/:nodeId", (req, res) => {
    const user = userId(res);
    const projectId = req.params.projectId;
    const current = store()
      .listNodes(user, projectId)
      .find((node) => node.id === req.params.nodeId);
    if (!current) {
      res.status(404).json({ detail: "Knowledge node not found" });
      return;
    }
    const deleted =
      current.kind === "label"
        ? store().deleteLabel(user, projectId, current.id)
        : store().deleteNode(user, projectId, current.id);
    if (!deleted) {
      res.status(404).json({ detail: "Knowledge node not found" });
      return;
    }
    res.status(204).end();
  });

  router.post("/projects/:projectId/edges", (req, res) => {
    try {
      const user = userId(res);
      const projectId = req.params.projectId;
      const relation = text(req.body?.relation, "relation", 40);
      const fromNodeId = text(req.body?.from_node_id, "from_node_id", 200);
      const toNodeId = text(req.body?.to_node_id, "to_node_id", 200);
      if (relation === "parent") {
        store().setParent({
          userId: user,
          projectId,
          nodeId: fromNodeId,
          parentId: toNodeId,
        });
        res.status(201).json({
          from_node_id: fromNodeId,
          to_node_id: toNodeId,
          relation,
          order: 0,
        });
        return;
      }
      res.status(201).json(
        store().createEdge({
          userId: user,
          projectId,
          fromNodeId,
          toNodeId,
          relation,
        }),
      );
    } catch (error) {
      res.status(400).json({
        detail: error instanceof Error ? error.message : "Could not create edge",
      });
    }
  });

  router.put(
    "/projects/:projectId/sources/:sourceId/mark",
    async (req, res) => {
      try {
        const user = userId(res);
        const projectId = req.params.projectId;
        const sourceId = req.params.sourceId;
        if (
          !projectExists(user, projectId) ||
          !(await sourceExists(user, sourceId))
        ) {
          res.status(404).json({ detail: "Project or saved source not found" });
          return;
        }
        const rawLabelIds = req.body?.label_ids;
        if (
          rawLabelIds !== undefined &&
          (!Array.isArray(rawLabelIds) ||
            rawLabelIds.length > 100 ||
            rawLabelIds.some((value) => typeof value !== "string"))
        ) {
          throw new Error("label_ids must be an array of up to 100 IDs");
        }
        res.json(
          store().setMark({
            userId: user,
            projectId,
            sourceId,
            labelIds: rawLabelIds,
            note: optionalText(req.body?.note, 10_000) ?? undefined,
          }),
        );
      } catch (error) {
        res.status(400).json({
          detail: error instanceof Error ? error.message : "Could not mark source",
        });
      }
    },
  );

  return router;
}

export const legalKnowledgeRouter = createLegalKnowledgeRouter();

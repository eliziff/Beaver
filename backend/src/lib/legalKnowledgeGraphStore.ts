import crypto from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mikeLocalDataHome } from "./legalDataPath";

const GENERAL_RESEARCH_PROJECT_ID = "general";
export const LEGAL_KNOWLEDGE_SCHEMA_VERSION = 2;
const MAX_LABEL_DEPTH = 3;
const KIND = /^[a-z][a-z0-9_-]{0,39}$/u;

export type LegalKnowledgeNode = {
  id: string;
  project_id: string;
  kind: string;
  name: string;
  color: string;
  order: number;
  data: Record<string, unknown>;
};

export type LegalKnowledgeProject = {
  id: string;
  name: string;
  order: number;
};

export type LocalMatter = {
  id: string;
  name: string;
  cm_number: string | null;
  practice: string | null;
  created_at: string;
  updated_at: string;
  order: number;
};

export type LegalKnowledgeEdge = {
  from_node_id: string;
  to_node_id: string;
  relation: string;
  order: number;
};

export type LegalKnowledgeEvidence = {
  id: string;
  project_id: string;
  source_id: string;
  locator_kind: string | null;
  locator: string | null;
  quote: string | null;
  quote_sha256: string | null;
  canonical_url: string | null;
  note: string;
};

export type LegalKnowledgeEvidenceLink = {
  evidence_id: string;
  node_id: string;
  relation: string;
};

export type LegalKnowledgeGraph = {
  nodes: LegalKnowledgeNode[];
  edges: LegalKnowledgeEdge[];
  evidence: LegalKnowledgeEvidence[];
  evidence_links: LegalKnowledgeEvidenceLink[];
};

export type LegalResearchLabel = {
  id: string;
  project_id: string;
  name: string;
  color: string;
  parent_id: string | null;
  order: number;
};

export type LegalSourceMark = {
  source_id: string;
  project_id: string;
  label_ids: string[];
  note: string;
};

type NodeRow = {
  id: string;
  project_id: string;
  kind: string;
  name: string;
  color: string;
  sort_order: number;
  data_json: string;
};

type EdgeRow = {
  from_node_id: string;
  to_node_id: string;
  relation: string;
  sort_order: number;
};

type EvidenceRow = {
  id: string;
  project_id: string;
  source_id: string;
  locator_kind: string;
  locator: string;
  quote: string;
  quote_sha256: string;
  canonical_url: string;
  note: string;
};

function requiredText(value: string, name: string, maximum: number) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required`);
  if (normalized.length > maximum) throw new Error(`${name} is too long`);
  return normalized;
}

function optionalMatterText(value: string | null | undefined, maximum: number) {
  if (value === null || value === undefined) return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

function kind(value: string, name: string) {
  const normalized = value.trim().toLowerCase();
  if (!KIND.test(normalized)) throw new Error(`${name} is invalid`);
  return normalized;
}

function color(value: string | undefined) {
  const normalized = value?.trim() || "#b91c1c";
  if (!/^#[0-9a-f]{6}$/iu.test(normalized)) {
    throw new Error("color must be a six-digit hex value");
  }
  return normalized.toLowerCase();
}

function dataJson(value: Record<string, unknown> | undefined) {
  const serialized = JSON.stringify(value ?? {});
  if (serialized.length > 64_000) throw new Error("node data is too large");
  return serialized;
}

function nodeResponse(row: NodeRow): LegalKnowledgeNode {
  let data: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.data_json) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    // A malformed optional metadata value must not hide the durable node.
  }
  return {
    id: row.id,
    project_id: row.project_id,
    kind: row.kind,
    name: row.name,
    color: row.color,
    order: row.sort_order,
    data,
  };
}

function edgeResponse(row: EdgeRow): LegalKnowledgeEdge {
  return {
    from_node_id: row.from_node_id,
    to_node_id: row.to_node_id,
    relation: row.relation,
    order: row.sort_order,
  };
}

function evidenceResponse(row: EvidenceRow): LegalKnowledgeEvidence {
  return {
    id: row.id,
    project_id: row.project_id,
    source_id: row.source_id,
    locator_kind: row.locator_kind || null,
    locator: row.locator || null,
    quote: row.quote || null,
    quote_sha256: row.quote_sha256 || null,
    canonical_url: row.canonical_url || null,
    note: row.note,
  };
}

export class LegalKnowledgeGraphStore {
  readonly database: DatabaseSync;

  constructor(
    filename = path.join(mikeLocalDataHome(), "legal-knowledge.sqlite"),
  ) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.database = new DatabaseSync(filename);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS legal_knowledge_projects (
        user_id TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, id)
      );
      CREATE TABLE IF NOT EXISTS legal_knowledge_nodes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        data_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS legal_knowledge_nodes_scope
        ON legal_knowledge_nodes(user_id, project_id, kind, sort_order);
      CREATE TABLE IF NOT EXISTS legal_knowledge_edges (
        user_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        from_node_id TEXT NOT NULL REFERENCES legal_knowledge_nodes(id) ON DELETE CASCADE,
        to_node_id TEXT NOT NULL REFERENCES legal_knowledge_nodes(id) ON DELETE CASCADE,
        relation TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        PRIMARY KEY (user_id, project_id, from_node_id, to_node_id, relation)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS legal_knowledge_one_parent
        ON legal_knowledge_edges(user_id, project_id, from_node_id)
        WHERE relation = 'parent';
      CREATE INDEX IF NOT EXISTS legal_knowledge_edges_scope
        ON legal_knowledge_edges(user_id, project_id, relation, sort_order);
      CREATE TABLE IF NOT EXISTS legal_knowledge_evidence (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        locator_kind TEXT NOT NULL DEFAULT '',
        locator TEXT NOT NULL DEFAULT '',
        quote TEXT NOT NULL DEFAULT '',
        quote_sha256 TEXT NOT NULL DEFAULT '',
        canonical_url TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, project_id, source_id, locator_kind, locator)
      );
      CREATE INDEX IF NOT EXISTS legal_knowledge_evidence_scope
        ON legal_knowledge_evidence(user_id, project_id, source_id);
      CREATE TABLE IF NOT EXISTS legal_knowledge_evidence_links (
        user_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        evidence_id TEXT NOT NULL REFERENCES legal_knowledge_evidence(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL REFERENCES legal_knowledge_nodes(id) ON DELETE CASCADE,
        relation TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (user_id, project_id, evidence_id, node_id, relation)
      );
      CREATE INDEX IF NOT EXISTS legal_knowledge_evidence_links_scope
        ON legal_knowledge_evidence_links(user_id, project_id, relation);
      CREATE TABLE IF NOT EXISTS legal_knowledge_source_marks (
        user_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, project_id, source_id)
      );
      CREATE TABLE IF NOT EXISTS legal_knowledge_source_mark_labels (
        user_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        label_id TEXT NOT NULL REFERENCES legal_knowledge_nodes(id) ON DELETE CASCADE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, project_id, source_id, label_id),
        FOREIGN KEY (user_id, project_id, source_id)
          REFERENCES legal_knowledge_source_marks(user_id, project_id, source_id)
          ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS legal_knowledge_source_mark_labels_scope
        ON legal_knowledge_source_mark_labels(user_id, project_id, source_id, sort_order);
      CREATE TABLE IF NOT EXISTS mike_matter_metadata (
        user_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        cm_number TEXT,
        practice TEXT,
        PRIMARY KEY (user_id, project_id),
        FOREIGN KEY (user_id, project_id)
          REFERENCES legal_knowledge_projects(user_id, id)
          ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS mike_matter_documents (
        user_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        PRIMARY KEY (user_id, project_id, document_id),
        FOREIGN KEY (user_id, project_id)
          REFERENCES legal_knowledge_projects(user_id, id)
          ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS mike_matter_documents_scope
        ON mike_matter_documents(user_id, project_id, sort_order, created_at);
    `);
    this.migrateSourceMarks();
  }

  close() {
    this.database.close();
  }

  private transaction<T>(operation: () => T) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private migrateSourceMarks() {
    const version = Number(
      (
        this.database.prepare("PRAGMA user_version").get() as {
          user_version: number;
        }
      ).user_version,
    );
    if (version > LEGAL_KNOWLEDGE_SCHEMA_VERSION) {
      throw new Error(`Unsupported legal knowledge schema version ${version}`);
    }
    if (version === LEGAL_KNOWLEDGE_SCHEMA_VERSION) return;

    this.transaction(() => {
      if (version < 1) {
        this.database.exec(`
        INSERT OR IGNORE INTO legal_knowledge_source_marks
          (user_id, project_id, source_id, note, created_at, updated_at)
        SELECT evidence.user_id, evidence.project_id, evidence.source_id,
               evidence.note, evidence.created_at, evidence.updated_at
        FROM legal_knowledge_evidence AS evidence
        WHERE evidence.locator_kind = '' AND evidence.locator = ''
          AND (
            evidence.note <> ''
            OR EXISTS (
              SELECT 1
              FROM legal_knowledge_evidence_links AS link
              WHERE link.evidence_id = evidence.id
                AND link.relation = 'tagged'
            )
          );

        INSERT OR IGNORE INTO legal_knowledge_source_mark_labels
          (user_id, project_id, source_id, label_id, sort_order)
        SELECT evidence.user_id, evidence.project_id, evidence.source_id,
               link.node_id, 0
        FROM legal_knowledge_evidence AS evidence
        JOIN legal_knowledge_evidence_links AS link
          ON link.evidence_id = evidence.id
         AND link.relation = 'tagged'
        WHERE evidence.locator_kind = '' AND evidence.locator = '';

        DELETE FROM legal_knowledge_evidence_links
        WHERE relation = 'tagged';

        DELETE FROM legal_knowledge_evidence
        WHERE locator_kind = '' AND locator = ''
          AND quote = '' AND canonical_url = ''
          AND NOT EXISTS (
            SELECT 1
            FROM legal_knowledge_evidence_links AS link
            WHERE link.evidence_id = legal_knowledge_evidence.id
          );
        `);
      }
      this.database.exec(
        `PRAGMA user_version = ${LEGAL_KNOWLEDGE_SCHEMA_VERSION}`,
      );
    });
  }

  listProjects(userId: string): LegalKnowledgeProject[] {
    const user = requiredText(userId, "user_id", 200);
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT OR IGNORE INTO legal_knowledge_projects
          (user_id, id, name, sort_order, created_at, updated_at)
         VALUES (?, ?, 'General research', 0, ?, ?)`,
      )
      .run(user, GENERAL_RESEARCH_PROJECT_ID, now, now);
    return (
      this.database
        .prepare(
          `SELECT id, name, sort_order
           FROM legal_knowledge_projects
           WHERE user_id = ?
           ORDER BY sort_order, name COLLATE NOCASE, id`,
        )
        .all(user) as { id: string; name: string; sort_order: number }[]
    ).map((row) => ({
      id: row.id,
      name: row.name,
      order: row.sort_order,
    }));
  }

  createProject(userId: string, name: string) {
    const matter = this.createMatter(userId, { name });
    return { id: matter.id, name: matter.name, order: matter.order };
  }

  renameProject(userId: string, projectId: string, name: string) {
    const matter = this.updateMatter(userId, projectId, { name });
    return matter
      ? { id: matter.id, name: matter.name, order: matter.order }
      : null;
  }

  listMatters(userId: string): LocalMatter[] {
    const user = requiredText(userId, "user_id", 200);
    this.listProjects(user);
    return (
      this.database
        .prepare(
          `SELECT project.id, project.name, project.sort_order,
                  project.created_at, project.updated_at,
                  metadata.cm_number, metadata.practice
           FROM legal_knowledge_projects AS project
           LEFT JOIN mike_matter_metadata AS metadata
             ON metadata.user_id = project.user_id
            AND metadata.project_id = project.id
           WHERE project.user_id = ? AND project.id <> ?
           ORDER BY project.sort_order, project.name COLLATE NOCASE, project.id`,
        )
        .all(user, GENERAL_RESEARCH_PROJECT_ID) as {
        id: string;
        name: string;
        sort_order: number;
        created_at: string;
        updated_at: string;
        cm_number: string | null;
        practice: string | null;
      }[]
    ).map((row) => ({
      id: row.id,
      name: row.name,
      cm_number: row.cm_number,
      practice: row.practice,
      created_at: row.created_at,
      updated_at: row.updated_at,
      order: row.sort_order,
    }));
  }

  getMatter(userId: string, projectId: string) {
    return (
      this.listMatters(userId).find((matter) => matter.id === projectId) ?? null
    );
  }

  createMatter(
    userId: string,
    input: { name: string; cmNumber?: string | null; practice?: string | null },
  ) {
    const user = requiredText(userId, "user_id", 200);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const order = this.listProjects(user).length;
    this.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO legal_knowledge_projects
            (user_id, id, name, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          user,
          id,
          requiredText(input.name, "name", 120),
          order,
          now,
          now,
        );
      this.database
        .prepare(
          `INSERT INTO mike_matter_metadata
            (user_id, project_id, cm_number, practice)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          user,
          id,
          optionalMatterText(input.cmNumber, 200),
          optionalMatterText(input.practice, 200),
        );
    });
    return this.getMatter(user, id)!;
  }

  updateMatter(
    userId: string,
    projectId: string,
    input: {
      name?: string;
      cmNumber?: string | null;
      practice?: string | null;
    },
  ) {
    const current = this.getMatter(userId, projectId);
    if (!current) return null;
    const name =
      input.name === undefined
        ? current.name
        : requiredText(input.name, "name", 120);
    const cmNumber =
      input.cmNumber === undefined
        ? current.cm_number
        : optionalMatterText(input.cmNumber, 200);
    const practice =
      input.practice === undefined
        ? current.practice
        : optionalMatterText(input.practice, 200);
    const now = new Date().toISOString();
    this.transaction(() => {
      this.database
        .prepare(
          `UPDATE legal_knowledge_projects
           SET name = ?, updated_at = ?
           WHERE user_id = ? AND id = ?`,
        )
        .run(name, now, userId, projectId);
      this.database
        .prepare(
          `INSERT INTO mike_matter_metadata
            (user_id, project_id, cm_number, practice)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(user_id, project_id)
           DO UPDATE SET
             cm_number = excluded.cm_number,
             practice = excluded.practice`,
        )
        .run(userId, projectId, cmNumber, practice);
    });
    return this.getMatter(userId, projectId);
  }

  listMatterDocumentIds(userId: string, projectId: string) {
    if (!this.getMatter(userId, projectId)) return null;
    return (
      this.database
        .prepare(
          `SELECT document_id
           FROM mike_matter_documents
           WHERE user_id = ? AND project_id = ?
           ORDER BY sort_order, created_at, document_id`,
        )
        .all(userId, projectId) as { document_id: string }[]
    ).map((row) => row.document_id);
  }

  attachMatterDocument(userId: string, projectId: string, documentId: string) {
    if (!this.getMatter(userId, projectId)) return false;
    const order = (
      this.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM mike_matter_documents
           WHERE user_id = ? AND project_id = ?`,
        )
        .get(userId, projectId) as { count: number }
    ).count;
    this.database
      .prepare(
        `INSERT OR IGNORE INTO mike_matter_documents
          (user_id, project_id, document_id, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        userId,
        projectId,
        requiredText(documentId, "document_id", 200),
        order,
        new Date().toISOString(),
      );
    return true;
  }

  removeMatterDocument(userId: string, projectId: string, documentId: string) {
    return (
      this.database
        .prepare(
          `DELETE FROM mike_matter_documents
           WHERE user_id = ? AND project_id = ? AND document_id = ?`,
        )
        .run(userId, projectId, documentId).changes > 0
    );
  }

  removeDocumentFromMatters(userId: string, documentId: string) {
    this.removeDocumentsFromMatters(userId, [documentId]);
  }

  removeDocumentsFromMatters(userId: string, documentIds: Iterable<string>) {
    const ids = [...new Set(documentIds)];
    if (!ids.length) return;
    const statement = this.database.prepare(
      `DELETE FROM mike_matter_documents
       WHERE user_id = ? AND document_id = ?`,
    );
    this.transaction(() => {
      for (const documentId of ids) statement.run(userId, documentId);
    });
  }

  deleteProject(userId: string, projectId: string) {
    if (projectId === GENERAL_RESEARCH_PROJECT_ID) {
      throw new Error("General research cannot be deleted");
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(
          `DELETE FROM legal_knowledge_source_marks
           WHERE user_id = ? AND project_id = ?`,
        )
        .run(userId, projectId);
      this.database
        .prepare(
          `DELETE FROM legal_knowledge_evidence
           WHERE user_id = ? AND project_id = ?`,
        )
        .run(userId, projectId);
      this.database
        .prepare(
          `DELETE FROM legal_knowledge_nodes
           WHERE user_id = ? AND project_id = ?`,
        )
        .run(userId, projectId);
      const deleted =
        this.database
          .prepare(
            `DELETE FROM legal_knowledge_projects
             WHERE user_id = ? AND id = ?`,
          )
          .run(userId, projectId).changes > 0;
      this.database.exec("COMMIT");
      return deleted;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private node(userId: string, projectId: string, nodeId: string) {
    return this.database
      .prepare(
        `SELECT id, project_id, kind, name, color, sort_order, data_json
         FROM legal_knowledge_nodes
         WHERE id = ? AND user_id = ? AND project_id = ?`,
      )
      .get(nodeId, userId, projectId) as NodeRow | undefined;
  }

  private parentId(userId: string, projectId: string, nodeId: string) {
    const row = this.database
      .prepare(
        `SELECT to_node_id
         FROM legal_knowledge_edges
         WHERE user_id = ? AND project_id = ?
           AND from_node_id = ? AND relation = 'parent'`,
      )
      .get(userId, projectId, nodeId) as { to_node_id: string } | undefined;
    return row?.to_node_id ?? null;
  }

  private parentDepth(userId: string, projectId: string, nodeId: string) {
    let depth = 1;
    let current: string | null = nodeId;
    const seen = new Set<string>();
    while (current) {
      if (seen.has(current)) throw new Error("Knowledge graph contains a cycle");
      seen.add(current);
      current = this.parentId(userId, projectId, current);
      if (current) depth += 1;
    }
    return depth;
  }

  private subtreeDepth(userId: string, projectId: string, nodeId: string) {
    const rows = this.listEdges(userId, projectId, "parent");
    const children = new Map<string, string[]>();
    for (const row of rows) {
      children.set(row.to_node_id, [
        ...(children.get(row.to_node_id) ?? []),
        row.from_node_id,
      ]);
    }
    const visit = (id: string, seen: Set<string>): number => {
      if (seen.has(id)) throw new Error("Knowledge graph contains a cycle");
      const next = new Set(seen).add(id);
      return (
        1 +
        Math.max(
          0,
          ...(children.get(id) ?? []).map((child) => visit(child, next)),
        )
      );
    };
    return visit(nodeId, new Set());
  }

  listNodes(userId: string, projectId: string, nodeKind?: string) {
    const user = requiredText(userId, "user_id", 200);
    const project = requiredText(projectId, "project_id", 200);
    const rows = nodeKind
      ? this.database
          .prepare(
            `SELECT id, project_id, kind, name, color, sort_order, data_json
             FROM legal_knowledge_nodes
             WHERE user_id = ? AND project_id = ? AND kind = ?
             ORDER BY sort_order, name COLLATE NOCASE, id`,
          )
          .all(user, project, kind(nodeKind, "kind"))
      : this.database
          .prepare(
            `SELECT id, project_id, kind, name, color, sort_order, data_json
             FROM legal_knowledge_nodes
             WHERE user_id = ? AND project_id = ?
             ORDER BY kind, sort_order, name COLLATE NOCASE, id`,
          )
          .all(user, project);
    return (rows as NodeRow[]).map(nodeResponse);
  }

  listEdges(userId: string, projectId: string, edgeRelation?: string) {
    const rows = edgeRelation
      ? this.database
          .prepare(
            `SELECT from_node_id, to_node_id, relation, sort_order
             FROM legal_knowledge_edges
             WHERE user_id = ? AND project_id = ? AND relation = ?
             ORDER BY sort_order, from_node_id, to_node_id`,
          )
          .all(userId, projectId, kind(edgeRelation, "relation"))
      : this.database
          .prepare(
            `SELECT from_node_id, to_node_id, relation, sort_order
             FROM legal_knowledge_edges
             WHERE user_id = ? AND project_id = ?
             ORDER BY relation, sort_order, from_node_id, to_node_id`,
          )
          .all(userId, projectId);
    return (rows as EdgeRow[]).map(edgeResponse);
  }

  createNode(params: {
    userId: string;
    projectId: string;
    kind: string;
    name: string;
    color?: string;
    order?: number;
    data?: Record<string, unknown>;
  }) {
    const userId = requiredText(params.userId, "user_id", 200);
    const projectId = requiredText(params.projectId, "project_id", 200);
    const nodeKind = kind(params.kind, "kind");
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const order =
      params.order ??
      Number(
        (
          this.database
            .prepare(
              `SELECT COUNT(*) AS count
               FROM legal_knowledge_nodes
               WHERE user_id = ? AND project_id = ? AND kind = ?`,
            )
            .get(userId, projectId, nodeKind) as { count: number }
        ).count,
      );
    this.database
      .prepare(
        `INSERT INTO legal_knowledge_nodes
          (id, user_id, project_id, kind, name, color, sort_order, data_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        userId,
        projectId,
        nodeKind,
        requiredText(params.name, "name", 200),
        color(params.color),
        Number.isSafeInteger(order) ? order : 0,
        dataJson(params.data),
        now,
        now,
      );
    return nodeResponse(this.node(userId, projectId, id)!);
  }

  updateNode(params: {
    userId: string;
    projectId: string;
    nodeId: string;
    name?: string;
    color?: string;
    order?: number;
    data?: Record<string, unknown>;
  }) {
    const current = this.node(params.userId, params.projectId, params.nodeId);
    if (!current) return null;
    this.database
      .prepare(
        `UPDATE legal_knowledge_nodes
         SET name = ?, color = ?, sort_order = ?, data_json = ?, updated_at = ?
         WHERE id = ? AND user_id = ? AND project_id = ?`,
      )
      .run(
        params.name === undefined
          ? current.name
          : requiredText(params.name, "name", 200),
        params.color === undefined ? current.color : color(params.color),
        params.order === undefined || !Number.isSafeInteger(params.order)
          ? current.sort_order
          : params.order,
        params.data === undefined ? current.data_json : dataJson(params.data),
        new Date().toISOString(),
        params.nodeId,
        params.userId,
        params.projectId,
      );
    return nodeResponse(
      this.node(params.userId, params.projectId, params.nodeId)!,
    );
  }

  setParent(params: {
    userId: string;
    projectId: string;
    nodeId: string;
    parentId: string | null;
    maxDepth?: number;
  }) {
    const node = this.node(params.userId, params.projectId, params.nodeId);
    if (!node) throw new Error("Knowledge node does not exist");
    const parentId = params.parentId?.trim() || null;
    if (parentId === node.id) throw new Error("A node cannot contain itself");
    if (parentId) {
      const parent = this.node(params.userId, params.projectId, parentId);
      if (!parent) {
        throw new Error("Parent node does not exist in this project");
      }
      if ((node.kind === "label") !== (parent.kind === "label")) {
        throw new Error("Labels and ontology nodes use separate hierarchies");
      }
      let cursor: string | null = parentId;
      while (cursor) {
        if (cursor === node.id) throw new Error("Knowledge hierarchy would cycle");
        cursor = this.parentId(params.userId, params.projectId, cursor);
      }
      if (
        params.maxDepth &&
        this.parentDepth(params.userId, params.projectId, parentId) +
          this.subtreeDepth(params.userId, params.projectId, node.id) >
          params.maxDepth
      ) {
        throw new Error(`Hierarchy supports at most ${params.maxDepth} levels`);
      }
    }
    this.transaction(() => {
      this.database
        .prepare(
          `DELETE FROM legal_knowledge_edges
           WHERE user_id = ? AND project_id = ?
             AND from_node_id = ? AND relation = 'parent'`,
        )
        .run(params.userId, params.projectId, node.id);
      if (parentId) {
        this.createEdge({
          userId: params.userId,
          projectId: params.projectId,
          fromNodeId: node.id,
          toNodeId: parentId,
          relation: "parent",
        });
      }
    });
  }

  createEdge(params: {
    userId: string;
    projectId: string;
    fromNodeId: string;
    toNodeId: string;
    relation: string;
    order?: number;
  }) {
    if (params.fromNodeId === params.toNodeId) {
      throw new Error("A knowledge edge cannot link a node to itself");
    }
    if (
      !this.node(params.userId, params.projectId, params.fromNodeId) ||
      !this.node(params.userId, params.projectId, params.toNodeId)
    ) {
      throw new Error("Knowledge edge nodes must belong to the same project");
    }
    const relation = kind(params.relation, "relation");
    const order =
      params.order !== undefined && Number.isSafeInteger(params.order)
        ? params.order
        : 0;
    this.database
      .prepare(
        `INSERT OR IGNORE INTO legal_knowledge_edges
          (user_id, project_id, from_node_id, to_node_id, relation, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.userId,
        params.projectId,
        params.fromNodeId,
        params.toNodeId,
        relation,
        order,
        new Date().toISOString(),
      );
    return {
      from_node_id: params.fromNodeId,
      to_node_id: params.toNodeId,
      relation,
      order,
    };
  }

  deleteNode(userId: string, projectId: string, nodeId: string) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const deleted =
        this.database
          .prepare(
            `DELETE FROM legal_knowledge_nodes
             WHERE id = ? AND user_id = ? AND project_id = ?`,
          )
          .run(nodeId, userId, projectId).changes > 0;
      this.deleteEmptyMarks(userId, projectId);
      this.database.exec("COMMIT");
      return deleted;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  upsertEvidence(params: {
    userId: string;
    projectId: string;
    sourceId: string;
    locatorKind?: string | null;
    locator?: string | null;
    quote?: string | null;
    canonicalUrl?: string | null;
    note?: string;
  }) {
    const userId = requiredText(params.userId, "user_id", 200);
    const projectId = requiredText(params.projectId, "project_id", 200);
    const sourceId = requiredText(params.sourceId, "source_id", 500);
    const locatorKind = params.locatorKind
      ? kind(params.locatorKind, "locator_kind")
      : "";
    const locator = (params.locator ?? "").trim();
    const quote = (params.quote ?? "").trim();
    const note = (params.note ?? "").trim();
    const canonicalUrl = (params.canonicalUrl ?? "").trim();
    if (locator.length > 500) throw new Error("locator is too long");
    if (quote.length > 100_000) throw new Error("quote is too long");
    if (note.length > 10_000) throw new Error("note is too long");
    if (canonicalUrl.length > 4_000) throw new Error("canonical_url is too long");
    if (canonicalUrl) {
      const url = new URL(canonicalUrl);
      if (!["http:", "https:"].includes(url.protocol)) {
        throw new Error("canonical_url must use HTTP or HTTPS");
      }
    }
    const quoteHash = quote
      ? crypto.createHash("sha256").update(quote).digest("hex")
      : "";
    const existing = this.database
      .prepare(
        `SELECT id
         FROM legal_knowledge_evidence
         WHERE user_id = ? AND project_id = ? AND source_id = ?
           AND locator_kind = ? AND locator = ?`,
      )
      .get(userId, projectId, sourceId, locatorKind, locator) as
      | { id: string }
      | undefined;
    const id = existing?.id ?? crypto.randomUUID();
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO legal_knowledge_evidence
          (id, user_id, project_id, source_id, locator_kind, locator, quote,
           quote_sha256, canonical_url, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, project_id, source_id, locator_kind, locator)
         DO UPDATE SET quote = excluded.quote,
           quote_sha256 = excluded.quote_sha256,
           canonical_url = excluded.canonical_url,
           note = excluded.note,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        userId,
        projectId,
        sourceId,
        locatorKind,
        locator,
        quote,
        quoteHash,
        canonicalUrl,
        note,
        now,
        now,
      );
    return this.evidence(userId, projectId, id)!;
  }

  linkEvidence(params: {
    userId: string;
    projectId: string;
    evidenceId: string;
    nodeId: string;
    relation: string;
  }) {
    if (
      !this.evidence(params.userId, params.projectId, params.evidenceId) ||
      !this.node(params.userId, params.projectId, params.nodeId)
    ) {
      throw new Error("Evidence and node must belong to the same project");
    }
    const relation = kind(params.relation, "relation");
    this.database
      .prepare(
        `INSERT OR IGNORE INTO legal_knowledge_evidence_links
          (user_id, project_id, evidence_id, node_id, relation, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.userId,
        params.projectId,
        params.evidenceId,
        params.nodeId,
        relation,
        new Date().toISOString(),
      );
    return {
      evidence_id: params.evidenceId,
      node_id: params.nodeId,
      relation,
    };
  }

  graph(userId: string, projectId: string): LegalKnowledgeGraph {
    const evidence = (
      this.database
        .prepare(
          `SELECT id, project_id, source_id, locator_kind, locator, quote,
                  quote_sha256, canonical_url, note
           FROM legal_knowledge_evidence
           WHERE user_id = ? AND project_id = ?
           ORDER BY source_id, locator_kind, locator`,
        )
        .all(userId, projectId) as EvidenceRow[]
    ).map(evidenceResponse);
    const evidenceLinks = this.database
      .prepare(
        `SELECT evidence_id, node_id, relation
         FROM legal_knowledge_evidence_links
         WHERE user_id = ? AND project_id = ?
         ORDER BY relation, evidence_id, node_id`,
      )
      .all(userId, projectId) as LegalKnowledgeEvidenceLink[];
    return {
      nodes: this.listNodes(userId, projectId),
      edges: this.listEdges(userId, projectId),
      evidence,
      evidence_links: evidenceLinks,
    };
  }

  listLabels(userId: string, projectId: string): LegalResearchLabel[] {
    return this.listNodes(userId, projectId, "label").map((node) => ({
      id: node.id,
      project_id: node.project_id,
      name: node.name,
      color: node.color,
      parent_id: this.parentId(userId, projectId, node.id),
      order: node.order,
    }));
  }

  createLabel(params: {
    userId: string;
    projectId: string;
    name: string;
    color?: string;
    parentId?: string | null;
  }) {
    const parentId = params.parentId?.trim() || null;
    if (
      parentId &&
      (!this.node(params.userId, params.projectId, parentId) ||
        this.parentDepth(params.userId, params.projectId, parentId) >=
          MAX_LABEL_DEPTH)
    ) {
      throw new Error("Label parent is invalid or already at the maximum depth");
    }
    const node = this.createNode({ ...params, kind: "label" });
    try {
      if (parentId) {
        this.setParent({
          userId: params.userId,
          projectId: params.projectId,
          nodeId: node.id,
          parentId,
          maxDepth: MAX_LABEL_DEPTH,
        });
      }
    } catch (error) {
      this.deleteNode(params.userId, params.projectId, node.id);
      throw error;
    }
    return this.listLabels(params.userId, params.projectId).find(
      (label) => label.id === node.id,
    )!;
  }

  updateLabel(params: {
    userId: string;
    projectId: string;
    labelId: string;
    name?: string;
    color?: string;
    parentId?: string | null;
  }) {
    const current = this.node(params.userId, params.projectId, params.labelId);
    if (!current || current.kind !== "label") return null;
    if (params.parentId !== undefined) {
      this.setParent({
        userId: params.userId,
        projectId: params.projectId,
        nodeId: params.labelId,
        parentId: params.parentId,
        maxDepth: MAX_LABEL_DEPTH,
      });
    }
    this.updateNode({
      userId: params.userId,
      projectId: params.projectId,
      nodeId: params.labelId,
      name: params.name,
      color: params.color,
    });
    return this.listLabels(params.userId, params.projectId).find(
      (label) => label.id === params.labelId,
    )!;
  }

  deleteLabel(userId: string, projectId: string, labelId: string) {
    const root = this.node(userId, projectId, labelId);
    if (!root || root.kind !== "label") return false;
    const children = new Map<string, string[]>();
    for (const edge of this.listEdges(userId, projectId, "parent")) {
      children.set(edge.to_node_id, [
        ...(children.get(edge.to_node_id) ?? []),
        edge.from_node_id,
      ]);
    }
    const subtree: string[] = [];
    const visit = (nodeId: string) => {
      for (const childId of children.get(nodeId) ?? []) visit(childId);
      subtree.push(nodeId);
    };
    visit(labelId);

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const remove = this.database.prepare(
        `DELETE FROM legal_knowledge_nodes
         WHERE id = ? AND user_id = ? AND project_id = ? AND kind = 'label'`,
      );
      for (const nodeId of subtree) remove.run(nodeId, userId, projectId);
      this.deleteEmptyMarks(userId, projectId);
      this.database.exec("COMMIT");
      return true;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listMarks(
    userId: string,
    projectId: string,
    sourceId?: string,
  ): LegalSourceMark[] {
    const marks = (sourceId
      ? this.database
          .prepare(
            `SELECT source_id, project_id, note
             FROM legal_knowledge_source_marks
             WHERE user_id = ? AND project_id = ? AND source_id = ?
             ORDER BY source_id`,
          )
          .all(userId, projectId, sourceId)
      : this.database
          .prepare(
            `SELECT source_id, project_id, note
             FROM legal_knowledge_source_marks
             WHERE user_id = ? AND project_id = ?
             ORDER BY source_id`,
          )
          .all(userId, projectId)) as {
      source_id: string;
      project_id: string;
      note: string;
    }[];
    if (!marks.length) return [];

    const labels = (sourceId
      ? this.database
          .prepare(
            `SELECT source_id, label_id
             FROM legal_knowledge_source_mark_labels
             WHERE user_id = ? AND project_id = ? AND source_id = ?
             ORDER BY source_id, sort_order, label_id`,
          )
          .all(userId, projectId, sourceId)
      : this.database
          .prepare(
            `SELECT source_id, label_id
             FROM legal_knowledge_source_mark_labels
             WHERE user_id = ? AND project_id = ?
             ORDER BY source_id, sort_order, label_id`,
          )
          .all(userId, projectId)) as {
      source_id: string;
      label_id: string;
    }[];
    const labelsBySource = new Map<string, string[]>();
    for (const label of labels) {
      labelsBySource.set(label.source_id, [
        ...(labelsBySource.get(label.source_id) ?? []),
        label.label_id,
      ]);
    }
    return marks.map((mark) => ({
      source_id: mark.source_id,
      project_id: mark.project_id,
      label_ids: labelsBySource.get(mark.source_id) ?? [],
      note: mark.note,
    }));
  }

  getMark(userId: string, projectId: string, sourceId: string) {
    return this.listMarks(userId, projectId, sourceId)[0] ?? null;
  }

  setMark(params: {
    userId: string;
    projectId: string;
    sourceId: string;
    labelIds?: string[];
    note?: string;
  }) {
    const sourceId = requiredText(params.sourceId, "source_id", 500);
    const labelIds = [...new Set(params.labelIds ?? [])];
    for (const labelId of labelIds) {
      const node = this.node(params.userId, params.projectId, labelId);
      if (!node || node.kind !== "label") {
        throw new Error("A selected label does not belong to this project");
      }
    }
    const note = (params.note ?? "").trim();
    if (note.length > 10_000) throw new Error("note is too long");
    if (!note && !labelIds.length) {
      this.database
        .prepare(
          `DELETE FROM legal_knowledge_source_marks
           WHERE user_id = ? AND project_id = ? AND source_id = ?`,
        )
        .run(params.userId, params.projectId, sourceId);
      return null;
    }

    this.transaction(() => {
      const now = new Date().toISOString();
      this.database
        .prepare(
          `INSERT INTO legal_knowledge_source_marks
            (user_id, project_id, source_id, note, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, project_id, source_id)
           DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`,
        )
        .run(params.userId, params.projectId, sourceId, note, now, now);
      this.database
        .prepare(
          `DELETE FROM legal_knowledge_source_mark_labels
           WHERE user_id = ? AND project_id = ? AND source_id = ?`,
        )
        .run(params.userId, params.projectId, sourceId);
      const insertLabel = this.database.prepare(
        `INSERT INTO legal_knowledge_source_mark_labels
          (user_id, project_id, source_id, label_id, sort_order)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const [index, labelId] of labelIds.entries()) {
        insertLabel.run(
          params.userId,
          params.projectId,
          sourceId,
          labelId,
          index,
        );
      }
    });
    return this.getMark(params.userId, params.projectId, sourceId)!;
  }

  private evidence(userId: string, projectId: string, evidenceId: string) {
    const row = this.database
      .prepare(
        `SELECT id, project_id, source_id, locator_kind, locator, quote,
                quote_sha256, canonical_url, note
         FROM legal_knowledge_evidence
         WHERE id = ? AND user_id = ? AND project_id = ?`,
      )
      .get(evidenceId, userId, projectId) as EvidenceRow | undefined;
    return row ? evidenceResponse(row) : null;
  }

  private deleteEmptyMarks(userId: string, projectId: string) {
    this.database
      .prepare(
        `DELETE FROM legal_knowledge_source_marks
         WHERE user_id = ? AND project_id = ?
           AND note = ''
           AND NOT EXISTS (
             SELECT 1 FROM legal_knowledge_source_mark_labels AS label
             WHERE label.user_id = legal_knowledge_source_marks.user_id
               AND label.project_id = legal_knowledge_source_marks.project_id
               AND label.source_id = legal_knowledge_source_marks.source_id
           )`,
      )
      .run(userId, projectId);
  }
}

let sharedStore: LegalKnowledgeGraphStore | null = null;

export function legalKnowledgeGraphStore() {
  sharedStore ??= new LegalKnowledgeGraphStore();
  return sharedStore;
}

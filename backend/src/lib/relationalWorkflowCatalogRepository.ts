import { sql, type RelationalDatabase } from "./relational";
import { canonicalJsonSha256 } from "./hash";
import { validateWorkflowCatalog, type WorkflowCatalogRepository } from "./workflowCatalog";

export function createWorkflowCatalogRepository(db: RelationalDatabase): WorkflowCatalogRepository {
  return {
    async read() {
      const { rows: [row] } = await db.query(sql`SELECT body,content_hash FROM workflow_catalog WHERE id=1`);
      if (!row) return null;
      const value = JSON.parse(String(row.body));
      if (canonicalJsonSha256(value) !== row.content_hash) throw new Error("Workflow catalogue integrity check failed");
      return validateWorkflowCatalog(value);
    },
    async replace(snapshot, contentHash) {
      await db.query(sql`INSERT INTO workflow_catalog(id,source_commit,content_hash,body,updated_at)
        VALUES(1,${snapshot.sourceCommit},${contentHash},${JSON.stringify(snapshot)},${new Date().toISOString()})
        ON CONFLICT(id) DO UPDATE SET source_commit=excluded.source_commit,
          content_hash=excluded.content_hash,body=excluded.body,updated_at=excluded.updated_at`);
    },
  };
}

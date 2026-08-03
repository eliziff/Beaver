#!/usr/bin/env node

import { DatabaseSync } from "node:sqlite";
import { a2ajLocalBulkPath } from "../../../backend/src/lib/a2ajLocalBulk";

const db = new DatabaseSync(a2ajLocalBulkPath(), { readOnly: true });

const indexes = db
  .prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index'")
  .all() as Array<{ name: string; tbl_name: string; sql: string | null }>;
console.log(`indexes: ${indexes.length}`);
for (const index of indexes) console.log(`  ${index.name} on ${index.tbl_name}: ${index.sql ?? "(auto)"}`);

console.log("total rows:", JSON.stringify(db.prepare("SELECT COUNT(*) AS n FROM document").get()));

const filters = [
  "doc_type = 'cases'",
  "unofficial_text_en IS NOT NULL",
  "length(unofficial_text_en) > 0",
  "COALESCE(NULLIF(citation_en, ''), NULLIF(citation2_en, '')) IS NOT NULL",
  "UPPER(dataset) = 'SCC'",
];
const where = filters.join(" AND ");

let t = performance.now();
const ids = (db.prepare(`SELECT id FROM document WHERE ${where} ORDER BY id`).all() as Array<{ id: number }>).map((r) => r.id);
console.log(`full filter ids pass: ${(performance.now() - t).toFixed(0)}ms (${ids.length} ids)`);

t = performance.now();
const cheap = (db.prepare("SELECT id FROM document WHERE doc_type = 'cases' AND UPPER(dataset) = 'SCC'").all() as Array<{ id: number }>).map((r) => r.id);
console.log(`cheap (no text check) ids pass: ${(performance.now() - t).toFixed(0)}ms (${cheap.length} ids)`);

t = performance.now();
const literal = (db.prepare("SELECT id FROM document WHERE doc_type = 'cases' AND dataset = 'SCC'").all() as Array<{ id: number }>).map((r) => r.id);
console.log(`literal dataset='SCC' ids pass: ${(performance.now() - t).toFixed(0)}ms (${literal.length} ids)`);

const lower = (db.prepare("SELECT COUNT(*) AS n FROM document WHERE doc_type = 'cases' AND dataset = lower(dataset) AND dataset != upper(dataset)").get() as { n: number }).n;
console.log(`mixed-case dataset rows: ${lower}`);

t = performance.now();
const textChecked = (db.prepare(`SELECT id FROM document WHERE doc_type = 'cases' AND dataset = 'SCC' AND unofficial_text_en IS NOT NULL AND length(unofficial_text_en) > 0 AND COALESCE(NULLIF(citation_en, ''), NULLIF(citation2_en, '')) IS NOT NULL`).all() as Array<{ id: number }>).map((r) => r.id);
console.log(`literal + text checks: ${(performance.now() - t).toFixed(0)}ms (${textChecked.length} ids)`);

const emptyText = (db.prepare("SELECT COUNT(*) AS n FROM document WHERE unofficial_text_en = ''").get() as { n: number }).n;
console.log(`rows with empty-text-en: ${emptyText}`);

db.close();

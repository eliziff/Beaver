// Run from backend: npm exec --offline --no -- tsx --tsconfig tsconfig.dev.json scripts/check-authorities-operations.ts
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { createAuthoritiesOperations } from "../src/lib/authoritiesOperations";
import { createAuthoritiesRuntimeRouter } from "../src/routes/authoritiesRuntime";
import type { AuthoritiesDraft } from "../src/lib/authoritiesDomain";

async function main() {
const operations = createAuthoritiesOperations();
const context = { signal: new AbortController().signal };
const direct = await operations.create({}, context);
const app = express(); app.use(express.json());
app.use(createAuthoritiesRuntimeRouter((_req, _res, next) => next()));
assert.deepEqual((await request(app).post("/create").send({}).expect(200)).body, direct.data);
const action = { type: "set-output-mode", outputMode: "book" };
const changed = await operations.action({ draft: direct.data, action }, context);
assert.equal((changed.data as AuthoritiesDraft).outputMode, "book");
assert.deepEqual((await request(app).post("/action").send({ draft: direct.data, action }).expect(200)).body, changed.data);

// A real cancelled build uses ordinary draft/roles values, not serialized HTTP fields.
const abort = new AbortController(); abort.abort();
await assert.rejects(operations.build({ draft: changed.data, roles: [], files: [],
  id: "independent-operation-check", revision: 1, title: "Independent operation check" }, { signal: abort.signal }),
  error => error instanceof DOMException && error.name === "AbortError");
console.log("Authorities direct/HTTP draft and action outcomes match; ordinary-value build cancellation preserved.");

}
void main().catch(error => { console.error(error); process.exitCode = 1; });

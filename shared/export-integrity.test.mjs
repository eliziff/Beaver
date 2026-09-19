import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { exportSigningIdentity, sealExport, verifyExport } from "./export-integrity.mjs";

// RFC 8032 test vector 1: independently specified seed and public key.
const seed = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const body = { format: "beaver-project-manifest", version: 1, data: { z: 2, a: "record" } };
test("uses the expected Ed25519 identity and a domain-separated digest", () => {
  const exported = sealExport(body, seed), identity = exportSigningIdentity(seed);
  assert.equal(Buffer.from(identity.public_key, "base64").subarray(-32).toString("hex"),
    "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
  const key = createPublicKey({ key: Buffer.from(identity.public_key, "base64"), format: "der", type: "spki" });
  const signature = Buffer.from(exported.integrity.signature.value, "base64");
  assert.equal(verify(null, Buffer.concat([Buffer.from("beaver-export-v1\0"),
    Buffer.from(exported.integrity.payload_sha256, "hex")]), key, signature), true);
  assert.equal(verify(null, Buffer.from(exported.integrity.payload_sha256, "hex"), key, signature), false);
  assert.deepEqual(verifyExport(exported, identity.public_key), { signed: true, trusted: true });
});
test("distinguishes checksum validity, embedded signatures, and trusted signatures", () => {
  assert.deepEqual(verifyExport(sealExport(body, "")), { signed: false, trusted: false });
  assert.deepEqual(verifyExport(sealExport(body, seed)), { signed: true, trusted: false });
  assert.throws(() => verifyExport(sealExport(body, ""), exportSigningIdentity(seed).public_key), /Expected a signed/);
  assert.throws(() => verifyExport(sealExport(body, "ab".repeat(32)), exportSigningIdentity(seed).public_key), /not trusted/);
});
test("detects body, format, digest, signature and identity changes", () => {
  const exported = sealExport(body, seed), trusted = exportSigningIdentity(seed).public_key;
  for (const mutate of [
    (copy) => { copy.data.a = "changed"; },
    (copy) => { copy.format = "other"; },
    (copy) => { copy.integrity.payload_sha256 = "0".repeat(64); },
    (copy) => { copy.integrity.signature.value = Buffer.alloc(64).toString("base64"); },
    (copy) => { copy.integrity.signature.key_id = "0".repeat(64); },
    (copy) => { copy.integrity.signature = null; },
  ]) {
    const copy = structuredClone(exported); mutate(copy);
    assert.throws(() => verifyExport(copy, trusted));
  }
});
test("normalizes JSON dates and key order and refuses invalid configured keys", () => {
  const date = new Date("2026-09-19T00:00:00Z");
  const a = sealExport({ b: date, a: { z: 2, x: 1 } }, seed);
  const b = sealExport({ a: { x: 1, z: 2 }, b: date.toISOString() }, seed);
  assert.deepEqual(a.integrity, b.integrity);
  assert.deepEqual(verifyExport(JSON.parse(JSON.stringify(a))), { signed: true, trusted: false });
  assert.throws(() => sealExport(body, "bad"), /MANIFEST_SIGNING_KEY/);
  assert.throws(() => sealExport({ integrity: {} }, seed), /cannot contain/);
});
test("offline command checks supplied bytes and refuses malformed trust files", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "beaver-export-check-"));
  try {
    const manifest = path.join(directory, "manifest.json"), key = path.join(directory, "key.json"), file = path.join(directory, "record.txt");
    const { createHash } = await import("node:crypto");
    await writeFile(manifest, JSON.stringify(sealExport({ ...body, data: { document_versions: [
      { id: "version", source_sha256: createHash("sha256").update("abc").digest("hex"), size_bytes: 3 },
    ] } }, seed)));
    await writeFile(key, JSON.stringify(exportSigningIdentity(seed)));
    await writeFile(file, "abc");
    const { fileURLToPath } = await import("node:url");
    const command = () => spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/verify-export.mjs", import.meta.url)),
      manifest, key, `version=${file}`], { encoding: "utf8" });
    assert.equal(command().status, 0);
    await writeFile(file, "abd");
    assert.match(command().stderr, /File mismatch/);
    await writeFile(key, "null");
    assert.match(command().stderr, /Invalid trusted key/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

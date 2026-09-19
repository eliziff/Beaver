import { readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { verifyExport } from "../shared/export-integrity.mjs";

const [manifestPath, identityPath, ...files] = process.argv.slice(2);
try {
  if (!manifestPath) throw new Error("Usage: node scripts/verify-export.mjs export.json [trusted-key.json|-] [version-id=file ...]");
  const envelope = JSON.parse(await readFile(manifestPath, "utf8"));
  const trusted = identityPath && identityPath !== "-" ? JSON.parse(await readFile(identityPath, "utf8")) : null;
  if (identityPath && identityPath !== "-" && (!trusted || trusted.algorithm !== "ed25519" || typeof trusted.public_key !== "string"))
    throw new Error("Invalid trusted key file");
  const result = verifyExport(envelope, trusted?.public_key);
  for (const file of files) {
    const separator = file.indexOf("="), id = file.slice(0, separator), filename = file.slice(separator + 1);
    if (separator <= 0 || !filename) throw new Error("Files must be specified as version-id=file");
    const version = envelope.data?.document_versions?.find((entry) => entry.id === id);
    if (!version?.source_sha256) throw new Error(`Version ${id} is absent from the manifest`);
    const hash = createHash("sha256"); let size = 0;
    for await (const bytes of createReadStream(filename)) { hash.update(bytes); size += bytes.length; }
    if (hash.digest("hex") !== version.source_sha256 || size !== Number(version.size_bytes)) throw new Error(`File mismatch for version ${id}`);
  }
  console.log(result.trusted ? "Signature verified against trusted key." : result.signed
    ? "Signature valid; signing identity not independently trusted." : "Checksum valid; export is unsigned.");
  console.log(`Verified ${files.length} supplied document files; other file bytes were not checked.`);
} catch (error) { console.error(error.message); process.exitCode = 1; }

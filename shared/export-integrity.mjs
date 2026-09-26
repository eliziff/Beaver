import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { canonicalJson } from "./canonical-json.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const payload = (hash) => Buffer.concat([Buffer.from("beaver-export-v1\0"), Buffer.from(hash, "hex")]);
function key(seed) {
  if (!seed?.trim()) return null;
  if (!/^[a-f0-9]{64}$/iu.test(seed.trim())) throw new Error("MANIFEST_SIGNING_KEY must be a 32-byte hex Ed25519 seed");
  return createPrivateKey({ key: Buffer.from(`302e020100300506032b657004220420${seed.trim()}`, "hex"),
    format: "der", type: "pkcs8" });
}
function identity(privateKey) {
  const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return { algorithm: "ed25519", key_id: digest(publicKey), public_key: publicKey.toString("base64") };
}
export function exportSigningIdentity(seed = process.env.MANIFEST_SIGNING_KEY) {
  const privateKey = key(seed);
  return privateKey ? identity(privateKey) : null;
}
export function sealExport(body, seed = process.env.MANIFEST_SIGNING_KEY) {
  if (Object.hasOwn(body, "integrity")) throw new Error("Export body cannot contain integrity metadata");
  // Hash precisely the JSON recipients receive, including normalized database dates.
  const data = JSON.parse(JSON.stringify(body)), hash = digest(canonicalJson(data)), privateKey = key(seed);
  return { ...data, integrity: { algorithm: "sha256", payload_sha256: hash,
    signature: privateKey ? { ...identity(privateKey), value: sign(null, payload(hash), privateKey).toString("base64") } : null } };
}
export function verifyExport(envelope, trustedPublicKey) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new Error("Invalid export");
  const { integrity, ...body } = envelope;
  const hash = digest(canonicalJson(body));
  if (integrity?.algorithm !== "sha256" || integrity.payload_sha256 !== hash) throw new Error("Export checksum mismatch");
  const signature = integrity.signature;
  if (!signature) {
    if (trustedPublicKey) throw new Error("Expected a signed export");
    return { signed: false, trusted: false };
  }
  if (signature.algorithm !== "ed25519" || typeof signature.public_key !== "string" || typeof signature.value !== "string")
    throw new Error("Invalid export signature");
  if (trustedPublicKey && signature.public_key !== trustedPublicKey) throw new Error("Export signing key is not trusted");
  const publicBytes = Buffer.from(signature.public_key, "base64");
  if (signature.key_id !== digest(publicBytes)) throw new Error("Export signing key ID mismatch");
  const publicKey = createPublicKey({ key: publicBytes, type: "spki", format: "der" });
  if (publicKey.asymmetricKeyType !== "ed25519" || !verify(null, payload(hash), publicKey, Buffer.from(signature.value, "base64")))
    throw new Error("Export signature mismatch");
  return { signed: true, trusted: !!trustedPublicKey };
}

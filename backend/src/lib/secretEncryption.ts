// Authenticated secret-at-rest primitive. Public entrypoint: this module.
// Canonical operations: encryptSecret/decryptSecret with a domain-specific salt.
// Do not reimplement AES-GCM or key derivation in storage adapters.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

export type EncryptedSecret = { encrypted: string; iv: string; tag: string };
const derivedKeys = new Map<string, Buffer>();
const derivedKey = (secret: string, salt: string) => {
  const id = `${secret}\0${salt}`;
  return derivedKeys.get(id) ?? derivedKeys.set(id, scryptSync(secret, salt, 32)).get(id)!;
};

export function encryptionSecret(
  name: "USER_API_KEYS_ENCRYPTION_SECRET" | "MCP_CONNECTORS_ENCRYPTION_SECRET",
) {
  const value = process.env[name]?.trim() ?? "";
  if (value.length < 32 || /^(?:your-|change[-_ ]?me|password$)/iu.test(value)) {
    throw new Error(`${name} must be a random secret of at least 32 characters`);
  }
  const other = name === "USER_API_KEYS_ENCRYPTION_SECRET"
    ? process.env.MCP_CONNECTORS_ENCRYPTION_SECRET?.trim()
    : process.env.USER_API_KEYS_ENCRYPTION_SECRET?.trim();
  if (other && other === value) throw new Error("API-key and MCP encryption secrets must differ");
  return value;
}

export function encryptSecret(
  value: string, secret: string, salt: string, context?: string,
): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derivedKey(secret, salt), iv);
  if (context) cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { encrypted: encrypted.toString("base64"), iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64") };
}

export function decryptSecret(
  value: EncryptedSecret, secret: string, salt: string, context?: string,
) {
  const decipher = createDecipheriv("aes-256-gcm", derivedKey(secret, salt),
    Buffer.from(value.iv, "base64"));
  if (context) decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(value.encrypted, "base64")),
    decipher.final()]).toString("utf8");
}

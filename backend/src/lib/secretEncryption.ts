// Authenticated secret-at-rest primitive. Public entrypoint: this module.
// Canonical operations: encryptSecret/decryptSecret with a domain-specific salt.
// Do not reimplement AES-GCM or key derivation in storage adapters.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

export type EncryptedSecret = { encrypted: string; iv: string; tag: string };

export function encryptSecret(
  value: string, secret: string, salt: string,
): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", scryptSync(secret, salt, 32), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { encrypted: encrypted.toString("base64"), iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64") };
}

export function decryptSecret(
  value: EncryptedSecret, secret: string, salt: string,
) {
  const decipher = createDecipheriv("aes-256-gcm", scryptSync(secret, salt, 32),
    Buffer.from(value.iv, "base64"));
  decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(value.encrypted, "base64")),
    decipher.final()]).toString("utf8");
}

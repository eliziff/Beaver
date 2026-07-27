import { createHash } from "node:crypto";

/** Hex SHA-256 of a string or buffer. The one hashing helper — do not redefine locally. */
export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

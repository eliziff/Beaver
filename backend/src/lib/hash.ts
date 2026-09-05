import { createHash } from "node:crypto";
import { canonicalJson } from "mike/shared/canonical-json.mjs";

export { canonicalJson };

/** Hex SHA-256 of a string or buffer. The one hashing helper — do not redefine locally. */
export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export const canonicalJsonSha256 = (value: unknown) => sha256(canonicalJson(value));

export function deterministicUuid(value: string) {
  const hex = sha256(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${
    hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

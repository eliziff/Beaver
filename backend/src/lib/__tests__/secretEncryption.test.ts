import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../secretEncryption";

describe("secretEncryption", () => {
  it("round-trips without storing plaintext", () => {
    const value = encryptSecret("private-token", "server-secret", "domain-v1");
    expect(JSON.stringify(value)).not.toContain("private-token");
    expect(decryptSecret(value, "server-secret", "domain-v1")).toBe("private-token");
  });

  it("fails closed for tampering or a different domain salt", () => {
    const value = encryptSecret("private-token", "server-secret", "domain-v1", "user-a");
    const tampered = `${value.encrypted[0] === "A" ? "B" : "A"}${value.encrypted.slice(1)}`;
    expect(() => decryptSecret({ ...value, encrypted: tampered },
      "server-secret", "domain-v1", "user-a")).toThrow();
    expect(() => decryptSecret(value, "server-secret", "other-domain")).toThrow();
    expect(() => decryptSecret(value, "server-secret", "domain-v1", "user-b")).toThrow();
  });
});

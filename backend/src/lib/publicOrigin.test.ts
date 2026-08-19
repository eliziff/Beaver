import { afterEach, describe, expect, it } from "vitest";
import { publicOrigin } from "./publicOrigin";

const originalNodeEnv = process.env.NODE_ENV;
afterEach(() => {
  delete process.env.PUBLIC_ORIGIN;
  process.env.NODE_ENV = originalNodeEnv;
});

describe("public origin", () => {
  it("accepts one exact HTTPS origin and loopback HTTP outside production", () => {
    process.env.PUBLIC_ORIGIN = "https://beaver.example/";
    expect(publicOrigin()).toBe("https://beaver.example");
    process.env.PUBLIC_ORIGIN = "http://127.0.0.1:3000";
    process.env.NODE_ENV = "development";
    expect(publicOrigin()).toBe("http://127.0.0.1:3000");
  });

  it.each([
    "http://beaver.example", "ftp://localhost", "https://user:secret@beaver.example",
    "https://beaver.example/path", "https://beaver.example?next=evil",
  ])("rejects unsafe origins: %s", (value) => {
    process.env.PUBLIC_ORIGIN = value;
    expect(() => publicOrigin()).toThrow();
  });

  it("requires HTTPS in production, including on loopback", () => {
    process.env.NODE_ENV = "production";
    process.env.PUBLIC_ORIGIN = "http://localhost:3000";
    expect(() => publicOrigin()).toThrow();
  });
});

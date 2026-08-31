import { describe, expect, it } from "vitest";
import { wordManifest } from "./wordManifest";

describe("Word add-in manifest", () => {
  it("points one task pane at Beaver's shared HTTPS application", () => {
    const xml = wordManifest("https://beaver.example");
    expect(xml).toContain('DefaultValue="https://beaver.example/word.html"');
    expect(xml).toContain('<Set Name="WordApi" />');
    expect(xml).toContain("<Permissions>ReadWriteDocument</Permissions>");
    expect(xml).not.toContain("word-chat");
  });

  it("refuses an insecure or path-bearing origin", () => {
    expect(() => wordManifest("http://beaver.example")).toThrow("HTTPS");
    expect(() => wordManifest("https://beaver.example/app")).toThrow("HTTPS");
  });
});

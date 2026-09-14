import { describe, expect, it } from "vitest";
import { normalizeOpenCodeGoCatalog } from "../openCodeGo";

describe("OpenCode Go catalog", () => {
    it("exposes every published slug, including newly released models", () => {
        const models = normalizeOpenCodeGoCatalog({ data: [
            { id: "deepseek-v4.1-flash", object: "model", created: 1, owned_by: "opencode" },
            { id: "deepseek-flash", name: "DeepSeek V4.1 Flash" },
            { id: "glm-5.3", name: "GLM-5.3" },
        ] });
        expect(models).toHaveLength(3);
        expect(Object.fromEntries(models.map((model) => [model.id, model.displayName]))).toEqual({
            "deepseek-v4.1-flash": "deepseek-v4.1-flash",
            "deepseek-flash": "DeepSeek V4.1 Flash",
            "glm-5.3": "GLM-5.3",
        });
    });

    it.each([
        undefined, null, {}, { data: "nope" },
        { data: [{}, null, 7, { id: "" }, { id: " " }, { id: "vendor/model" }] },
    ])("ignores malformed or namespaced entries: %j", (value) => {
        expect(normalizeOpenCodeGoCatalog(value)).toEqual([]);
    });
});

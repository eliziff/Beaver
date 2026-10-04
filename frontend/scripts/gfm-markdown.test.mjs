import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { createRequire } from "node:module";

const frontend = fileURLToPath(new URL("..", import.meta.url));
const root = path.dirname(frontend);
if (process.argv[2] !== "--render") {
    test("shared Markdown preserves rendering and separate document/assistant URL policies", () => {
        const scratch = path.join(frontend, ".tmp");
        mkdirSync(scratch, { recursive: true });
        const directory = mkdtempSync(path.join(scratch, "gfm-check-"));
        try {
            const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--render", directory],
                { cwd: root, encoding: "utf8", timeout: 60000 });
            assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stderr}\n${result.stdout}`);
        } finally { rmSync(directory, { recursive: true, force: true }); }
    });
} else {
    console.error("stage: bundle local renderer");
    const { build } = await import(pathToFileURL(createRequire(path.join(root, "backend/package.json")).resolve("esbuild")));
    const result = await build({
        entryPoints: [path.join(frontend, "src/app/components/shared/GfmMarkdown.tsx")],
        bundle: true, write: false, format: "esm", platform: "node", jsx: "automatic", packages: "external",
        alias: { "@": path.join(frontend, "src") },
        plugins: [{ name: "shared-source", setup(builder) {
            builder.onResolve({ filter: /\.mjs$/ }, ({ path: source, importer }) => {
                if (source.startsWith("mike/shared/runtime/")) return {
                    path: path.join(root, "shared/contracts", source.slice("mike/shared/runtime/".length).replace(/\.mjs$/, ".mts")),
                };
                if (importer.startsWith(path.join(root, "shared")) && source.startsWith(".")) {
                    const candidate = path.resolve(path.dirname(importer), source.replace(/\.mjs$/, ".mts"));
                    if (existsSync(candidate)) return { path: candidate };
                }
            });
        } }],
    });
    const output = path.join(process.argv[3], "renderer.mjs");
    await writeFile(output, result.outputFiles[0].text);
    console.error("stage: import renderer and React server");
    const { GfmMarkdown } = await import(pathToFileURL(output));
    const { createElement } = await import(pathToFileURL(createRequire(path.join(frontend, "package.json")).resolve("react")));
    const { renderToStaticMarkup } = await import(pathToFileURL(createRequire(path.join(frontend, "package.json")).resolve("react-dom/server")));
    const markdown = "[mail](mailto:a@example.test) [relative](/documents/one) [bad](javascript:alert)\n\n| A | B |\n| - | - |\n| one | two |\n\n- [x] done\n\n<script>unsafe</script>";
    console.error("stage: render document policy");
    const document = renderToStaticMarkup(createElement(GfmMarkdown, { documentLinks: true }, markdown));
    console.error("stage: render assistant policy with same cached text");
    const assistant = renderToStaticMarkup(createElement(GfmMarkdown, {}, markdown));
    for (const html of [document, assistant]) {
        assert.ok(html.includes('href="/documents/one"'));
        assert.ok(!html.includes('href="javascript:'));
        assert.ok(html.includes("<table>"));
        assert.ok(html.includes('type="checkbox"'));
        assert.ok(html.includes("&lt;script&gt;"));
        assert.ok(!html.includes("<script>"));
    }
    assert.ok(document.includes('href="mailto:a@example.test"'));
    assert.ok(!assistant.includes('href="mailto:'));
    console.error("stage: outcomes passed");
}

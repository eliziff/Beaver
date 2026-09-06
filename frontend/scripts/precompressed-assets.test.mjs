import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { build } from "vite";
import { precompressedAssets } from "./precompressed-assets.mjs";

test("compressed outputs decode to the exact final build, excluding HTML and private/config data", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "beaver-assets-"));
    try {
        await writeFile(path.join(root, "index.html"), '<script type="module" src="/entry.js"></script>');
        await writeFile(path.join(root, "entry.js"), `import './entry.css';globalThis.fixture=${JSON.stringify("asset fixture ".repeat(800))};`);
        await writeFile(path.join(root, "entry.css"), `.fixture{--fixture:"${"style fixture ".repeat(800)}"}`);
        const result = await build({ root, configFile: false, logLevel: "silent",
            build: { write: false, modulePreload: { polyfill: false } },
            plugins: [precompressedAssets(), { name: "final-asset-fixture", generateBundle(_options, bundle) {
                // A later ordinary hook can still finalize code before compression.
                for (const asset of Object.values(bundle)) if (asset.type === "chunk") asset.code += "\n/* final bytes */";
                this.emitFile({ type: "asset", fileName: "assets/worker.mjs", source: "/* worker */".repeat(800) });
                for (const fileName of ["assets/config.json", "index.html.private", "assets/tiny.js"])
                    this.emitFile({ type: "asset", fileName, source: fileName.endsWith("tiny.js") ? "0;" : "private fixture ".repeat(1000) });
            } }],
        });
        assert.ok(!Array.isArray(result) && "output" in result);
        const outputs = new Map(result.output.map((asset) => [asset.fileName,
            Buffer.from(asset.type === "chunk" ? asset.code : asset.source)]));
        const originals = [...outputs.keys()].filter((name) => /^assets\/.*\.(m?js|css)$/.test(name) && !name.endsWith("tiny.js"));
        assert.equal(originals.length, 3);
        for (const name of originals) {
            assert.deepEqual(brotliDecompressSync(outputs.get(`${name}.br`)), outputs.get(name));
            assert.deepEqual(gunzipSync(outputs.get(`${name}.gz`)), outputs.get(name));
            assert.ok(outputs.get(`${name}.br`).length < outputs.get(name).length);
        }
        for (const name of ["index.html", "assets/config.json", "index.html.private", "assets/tiny.js"])
            for (const suffix of [".br", ".gz"]) assert.equal(outputs.has(name + suffix), false);
    } finally { await rm(root, { recursive: true, force: true }); }
});

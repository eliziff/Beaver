import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "../src");
const allowed = {
    fetch: "app/lib/beaverApi.ts",
    getReader: "app/lib/sse.ts",
};

function sourceFiles(directory = root) {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) return sourceFiles(filename);
        return /\.(?:ts|tsx)$/u.test(entry.name) &&
            !/\.(?:test|spec)\.(?:ts|tsx)$/u.test(entry.name)
            ? [filename]
            : [];
    });
}

test("production HTTP and stream decoding stay behind the shared boundary", () => {
    const violations = [];
    for (const filename of sourceFiles()) {
        const relative = path.relative(root, filename).replaceAll("\\", "/");
        const source = ts.createSourceFile(
            filename,
            readFileSync(filename, "utf8"),
            ts.ScriptTarget.Latest,
            true,
            filename.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
        );
        const inspect = (node) => {
            if (
                ts.isCallExpression(node) &&
                ts.isIdentifier(node.expression) &&
                node.expression.text === "fetch" &&
                relative !== allowed.fetch
            ) {
                violations.push(`${relative}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} calls fetch`);
            }
            if (
                ts.isCallExpression(node) &&
                ts.isPropertyAccessExpression(node.expression) &&
                node.expression.name.text === "getReader" &&
                relative !== allowed.getReader
            ) {
                violations.push(`${relative}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} decodes a stream`);
            }
            if (
                ts.isNewExpression(node) &&
                ts.isIdentifier(node.expression) &&
                ["EventSource", "XMLHttpRequest"].includes(node.expression.text)
            ) {
                violations.push(`${relative}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} opens ${node.expression.text}`);
            }
            ts.forEachChild(node, inspect);
        };
        inspect(source);
    }
    assert.deepEqual(violations, []);
});

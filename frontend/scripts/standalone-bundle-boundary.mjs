import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const dist = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, "../dist"));
const forbidden = [
    [/beaverApi-/u, "the Beaver API bundle"],
    [/\/(?:auth|chat|projects)(?:[/?"'`])/u, "an auth, chat, or project route"],
    [/mfa_verification_required/u, "the MFA classifier"],
];

for (const entry of ["court-records.html", "authorities.html"]) {
    const html = readFileSync(path.join(dist, entry), "utf8");
    const scripts = [...html.matchAll(/(?:src|href)="\/([^"?]+\.js)"/gu)]
        .map((match) => readFileSync(path.join(dist, match[1]), "utf8"));
    const reachable = [html, ...scripts].join("\n");
    for (const [pattern, description] of forbidden) {
        assert.doesNotMatch(reachable, pattern, `${entry} preloads ${description}`);
    }
}

console.log("Standalone bundles preload no Beaver auth, chat, or project API code.");

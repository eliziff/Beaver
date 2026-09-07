#!/usr/bin/env -S npx tsx
/**
 * Replays `authoritiesBuild.authoritySourceUrl` over a real Authorities draft,
 * comparing the old verbatim-URL behaviour with the shared legal-source
 * canonicalization. Read-only: the draft JSON is fetched from the running
 * service, nothing is written back.
 *
 *   node --import tsx authorities-replay.mts <draft.json>
 */
import { readFileSync } from "node:fs";
import { legalSourceLocatorAnchor, sourceUrl as legalSourceUrl }
  from "../../backend/src/lib/legalSourceLinks";
import type { A2AJLocatorKind } from "../../backend/src/lib/legalSources/a2aj";

type Authority = {
  key: string;
  locators: { kind: string; label: string }[];
  sourceIdentity?: { externalUrl?: string | null } | null;
  source:
    | { kind: "attached"; sources: { sourceUrl?: string | null }[] }
    | { kind: "pending-canlii"; pageUrl?: string | null }
    | { kind: string };
};

const storedUrl = (authority: Authority) => {
  const source = authority.source;
  return source.kind === "attached"
    ? (source as { sources: { sourceUrl?: string | null }[] })
        .sources.find(({ sourceUrl }) => sourceUrl)?.sourceUrl ?? null
    : source.kind === "pending-canlii"
      ? (source as { pageUrl?: string | null }).pageUrl ?? null
      : authority.sourceIdentity?.externalUrl ?? null;
};

/** The behaviour before this change: the stored URL, verbatim. */
function before(authority: Authority) {
  const value = storedUrl(authority);
  try {
    return value && ["http:", "https:"].includes(new URL(value).protocol) ? value : null;
  } catch {
    return null;
  }
}

/** The behaviour after: routed through the shared legal-source builder. */
function after(authority: Authority) {
  const value = storedUrl(authority);
  if (!value) return null;
  const [locator] = authority.locators;
  const only = authority.locators.length === 1 && locator &&
    ["paragraph", "page", "section"].includes(locator.kind)
    ? legalSourceLocatorAnchor(value, locator.kind as A2AJLocatorKind, locator.label)
    : undefined;
  return legalSourceUrl(value, only);
}

const draft = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const authorities = Object.values(draft.state.authorities) as Authority[];

let linked = 0, changed = 0, decisia = 0, refused = 0, anchored = 0;
const examples: string[] = [];
for (const authority of authorities) {
  const was = before(authority), now = after(authority);
  if (now) linked += 1;
  if (was && !now) refused += 1;
  if (was !== now) {
    changed += 1;
    if (now?.includes("site_preference=mobile")) decisia += 1;
    if (now?.includes("#") && !now.includes(":~:")) anchored += 1;
    if (examples.length < 3) {
      examples.push(`${authority.key}\n  before: ${was}\n  after:  ${now}`);
    }
  }
}

console.log(`authorities            ${authorities.length}`);
console.log(`linked (before/after)  ${authorities.filter(before).length} / ${linked}`);
console.log(`URLs changed           ${changed}`);
console.log(`  Decisia parameters   ${decisia}`);
console.log(`  locator anchor added ${anchored}`);
console.log(`refused (unlinkable)   ${refused}`);
console.log(`authorities w/ locators ${authorities.filter((a) => a.locators.length).length}`);
console.log(`\n--- examples ---\n${examples.join("\n")}`);

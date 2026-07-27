// Reusable deep-link gate: opens real pinpoint URLs in Chromium, screenshots
// each, and asserts what server-side probes cannot see — that the anchor
// exists in the rendered DOM, the viewport landed on it, the page still
// scrolls afterwards (the site_preference=mobile regression detector), and
// expected text is really rendered.
//
//   node scripts/deeplink-gate.mjs [cases.json]
//
// Case shape: { name, url, expect: { anchor?, text?, scrollable?, shouldFail? , blocked? } }
// - anchor: CSS-matchable id/name (e.g. "par59") that must exist and be near the viewport
// - text: substring that must appear in rendered innerText
// - scrollable: assert the page scrolls after the jump (default true)
// - shouldFail: negative control — the gate PASSES only if checks FAIL
// - blocked: site bot-walls automation; record SKIP, never FAIL
// Also accepts the SourceDoc gate shape {host_class, locator_kind, url, expected_anchor, expected_text}.
import { chromium } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const casesPath = process.argv[2] ?? "scripts/deeplink-gate.cases.json";
const rawCases = JSON.parse(readFileSync(casesPath, "utf8"));
const cases = rawCases.map((c) => ({
  name: c.name ?? `${c.host_class}-${c.locator_kind}`,
  url: c.url,
  expect: c.expect ?? {
    anchor: c.expected_anchor ?? undefined,
    text: c.expected_text ?? undefined,
    shouldFail: /^EXPECTED FAIL/u.test(c.note ?? "") || undefined,
  },
}));

const outDir = path.join(
  "benchmarks",
  "deeplink_gate",
  new Date().toISOString().slice(0, 19).replace(/[T:]/gu, "-"),
);
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const results = [];
for (const testCase of cases) {
  // Fresh context per case: cookies from one case (e.g. Decisia's
  // SITE_PREFERENCE) must never leak into another — it silently turned the
  // negative control into a false failure on the first run of this gate.
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    // Court sites 403 the default headless UA; present as regular Chrome.
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
    locale: "en-CA",
  });
  const page = await context.newPage();
  const r = { name: testCase.name, url: testCase.url, checks: {}, status: "PASS" };
  try {
    await page.goto(testCase.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(3_000); // fragment scroll + late layout

    const expectations = testCase.expect ?? {};
    const hasFragment = testCase.url.includes(":~:text=");
    // A text-fragment URL only "works" if the browser actually jumped: a
    // page whose raw text merely contains the string (XML viewer, JSON API
    // output) is not a pinpoint. scrollY===0 after settle means no jump.
    if (hasFragment) {
      r.checks.landed = { scrollY: await page.evaluate(() => window.scrollY) };
    }
    if (expectations.anchor) {
      r.checks.anchor = await page.evaluate((a) => {
        const el =
          document.getElementById(a) ??
          document.querySelector(`a[name="${a}"], [id="${a}"]`);
        if (!el) return { found: false };
        const rect = el.getBoundingClientRect();
        return {
          found: true,
          nearViewport: Math.abs(rect.top) < window.innerHeight * 1.5,
          docOffset: Math.round(rect.top + window.scrollY),
        };
      }, expectations.anchor);
      // A URL carrying both an anchor and a text fragment lands on the
      // FRAGMENT (browsers give it precedence) — for those cases the anchor
      // only needs to exist; the landing check is the fragment jump above.
      if (hasFragment && r.checks.anchor.found) {
        r.checks.anchor.nearViewport = true;
      }
    }
    if (expectations.scrollable !== false) {
      r.checks.scroll = await page.evaluate(async () => {
        const before = window.scrollY;
        window.scrollBy(0, 400);
        await new Promise((resolve) => setTimeout(resolve, 300));
        const moved = window.scrollY !== before;
        // restore so the screenshot shows the landing position
        window.scrollTo(0, before);
        return { moved, scrollHeight: document.documentElement.scrollHeight };
      });
    }
    if (expectations.text) {
      const body = await page.evaluate(() => document.body?.innerText ?? "");
      r.checks.text = { found: body.includes(expectations.text) };
    }

    const fragmentDidNotJump =
      hasFragment &&
      r.checks.landed.scrollY === 0 &&
      !(r.checks.anchor?.found && r.checks.anchor?.nearViewport);
    const failed =
      (r.checks.anchor && !(r.checks.anchor.found && r.checks.anchor.nearViewport)) ||
      (r.checks.scroll && !r.checks.scroll.moved) ||
      (r.checks.text && !r.checks.text.found) ||
      fragmentDidNotJump;
    const nothingCheckable =
      !expectations.anchor && !expectations.text && !hasFragment;
    r.status = expectations.shouldFail
      ? nothingCheckable
        ? "SKIP(no-checkable-expectation)"
        : failed
          ? "PASS(negative)"
          : "FAIL(negative-control-passed)"
      : failed
        ? "FAIL"
        : "PASS";
  } catch (error) {
    r.status = testCase.expect?.blocked ? "SKIP(blocked)" : "ERROR";
    r.error = String(error).slice(0, 200);
  }
  const shot = path.join(outDir, `${testCase.name}.png`);
  try {
    await page.screenshot({ path: shot });
    r.screenshot = shot;
  } catch {
    /* page may have crashed */
  }
  await page.close();
  await context.close();
  results.push(r);
  console.log(`${r.status.padEnd(28)} ${r.name}`);
  for (const [k, v] of Object.entries(r.checks)) {
    console.log(`  ${k}: ${JSON.stringify(v)}`);
  }
}
await browser.close();

writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
console.log(`\nScreenshots + results in ${outDir}`);
const failures = results.filter((r) => r.status.startsWith("FAIL") || r.status === "ERROR");
process.exitCode = failures.length ? 1 : 0;

#!/usr/bin/env node
// Load a page and report how a given phrase renders in the live DOM:
// every text-normalized match, its enclosing block tag/classes, and the
// immediately surrounding sentences. Diagnostic companion to
// text-fragment-gate.mjs; also how provider fixtures get harvested.
//
// Usage:
//   node scripts/text-fragment-probe.mjs "<url>" "<phrase>" [--html]

import { chromium } from "playwright-core";
import fs from "node:fs";

const [url, phrase] = process.argv.slice(2);
const dumpHtml = process.argv.includes("--html");
if (!url || !phrase) {
  console.error("usage: text-fragment-probe.mjs <url> <phrase> [--html]");
  process.exit(2);
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "load", timeout: 45_000 });
  await page.waitForTimeout(1_000);
  const result = await page.evaluate(({ phrase, dumpHtml }) => {
    const normalize = (value) => value.replace(/\s+/gu, " ").trim();
    const body = normalize(document.body.innerText);
    const needle = normalize(phrase);
    const matches = [];
    let at = body.indexOf(needle);
    while (at >= 0 && matches.length < 8) {
      matches.push(at);
      at = body.indexOf(needle, at + 1);
    }
    const blocks = [];
    if (matches.length) {
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_ELEMENT,
      );
      let element;
      while ((element = walker.nextNode())) {
        const own = normalize(
          Array.from(element.childNodes)
            .filter((node) => node.nodeType === Node.TEXT_NODE)
            .map((node) => node.textContent)
            .join(" "),
        );
        if (!own || !normalize(element.textContent).includes(needle)) continue;
        if (
          Array.from(element.children).some((child) =>
            normalize(child.textContent).includes(needle),
          )
        ) {
          continue;
        }
        blocks.push({
          tag: element.tagName.toLowerCase(),
          class: element.className?.toString().slice(0, 120) ?? "",
          id: element.id || "",
          name: element.getAttribute("name") || "",
          text: normalize(element.textContent).slice(0, 600),
          html: dumpHtml ? element.outerHTML.slice(0, 2_000) : undefined,
        });
      }
    }
    return {
      url: location.href,
      scrollY: Math.round(window.scrollY),
      occurrencesInInnerText: matches.length,
      firstMatchContext: matches.length
        ? body.slice(Math.max(0, matches[0] - 160), matches[0] + needle.length + 160)
        : null,
      blocks,
    };
  }, { phrase, dumpHtml });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}

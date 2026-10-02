// One browser profile driving the built Authorities.html, with what every stress case measures:
// input-to-paint, long tasks and layout shifts for each interaction (scripts/authorities-html-e2e/
// instrument.mjs), every frame sampled for blank or flickering regions, and screenshots at
// 1440×900 and 1280×720 each judged for what a reader would object to.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { instrument } from "../authorities-html-e2e/instrument.mjs";
import { refused, routeNetwork } from "./network.mjs";

/** Budgets in ms, set from measured runs on a laptop CPU with modest headroom (see the runner). */
export const BUDGETS = {
  coldLoad: 1500,       // navigation to an enabled "Add file", nothing stored
  resume: 2500,         // navigation to a stored draft drawn at its step
  inputToPaint: 50,     // a click or key to the frame that shows it
  dialog: 100,          // a click that opens a dialog, to the frame that draws it
  longTask: 50,         // no main-thread task longer than this while interacting
  stepTask: 100,        // nor this long while one step replaces another (a 245-citation review: 51)
  backgroundTask: 200,  // nor this long while the page works on its own (gathering, recognizing)
  flickerFrames: 3,     // a state shown this many frames or fewer, between two others, is a flicker
};
export const SIZES = [[1440, 900], [1280, 720]];

/** What a reader would object to in a screenshot, found in the page: horizontal scroll, controls
 *  off screen, cut off, wrapped or overlapping, controls side by side that do not line up, list
 *  rows whose actions leave their column, and text that barely shows against its background. */
function judgeLayout() {
  const issues = [], vw = document.documentElement.clientWidth, vh = innerHeight;
  const scroller = document.scrollingElement;
  if (scroller.scrollWidth > scroller.clientWidth + 1) issues.push({ kind: "horizontal scroll", detail: scroller.scrollWidth - scroller.clientWidth });
  const shown = (element) => {
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || Number(style.opacity) === 0 || node.matches(".sr-only")) return false;
    }
    return getComputedStyle(element).visibility !== "hidden";
  };
  /** The part of an element left visible by every scrolling or clipping ancestor and the window. */
  const visibleRect = (element) => {
    let { left, top, right, bottom } = element.getBoundingClientRect();
    for (let node = element.parentElement; node && node !== document.documentElement; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.overflowX === "visible" && style.overflowY === "visible") continue;
      const box = node.getBoundingClientRect();
      if (style.overflowX !== "visible") { left = Math.max(left, box.left); right = Math.min(right, box.right); }
      if (style.overflowY !== "visible") { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); }
    }
    top = Math.max(top, 0); bottom = Math.min(bottom, vh);
    return right - left > 1 && bottom - top > 1 ? { left, top, right, bottom } : null;
  };
  const name = (element) => (element.getAttribute("aria-label") || element.innerText || element.value || element.tagName)
    .trim().replace(/\s+/gu, " ").slice(0, 60);
  const dialogs = [...document.querySelectorAll("dialog[open], [role=dialog]")].filter(shown);
  const scope = dialogs.at(-1) ?? document.body;
  const controls = [...scope.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea, [role=tab], [role=menuitem]")]
    .filter((element) => shown(element)).map((element) => ({ element, rect: visibleRect(element), box: element.getBoundingClientRect() }))
    .filter(({ rect }) => rect);
  for (const { element, box } of controls) {
    if (box.right > vw + 1 || box.left < -1) issues.push({ kind: "off screen", what: name(element), left: Math.round(box.left), right: Math.round(box.right) });
    if (!element.matches("button, a, [role=tab], [role=menuitem]") || element.closest("[role=listbox], [role=option]")) continue;
    // A label on two lines (one text node drawn on two line boxes), or cut off where the control has no room for it.
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      // Text set to run to a set number of lines (an excerpt on a card) wraps by design.
      if (!node.data.trim() || !shown(node.parentElement) || getComputedStyle(node.parentElement).webkitLineClamp !== "none") continue;
      const range = document.createRange(); range.selectNodeContents(node);
      const tops = [...range.getClientRects()].filter(({ width }) => width > 1).map(({ top }) => top);
      if (tops.length > 1 && Math.max(...tops) - Math.min(...tops) > 4) { issues.push({ kind: "wrapped label", what: name(element) }); break; }
    }
    const label = [...element.querySelectorAll("*"), element].find((node) => node.childNodes.length &&
      [...node.childNodes].some((child) => child.nodeType === 3 && child.data.trim()) && shown(node));
    // Cut off without an ellipsis: an ellipsis says a long name goes on; a hard edge hides that it does.
    if (label && label.scrollWidth > label.clientWidth + 1 && getComputedStyle(label).overflow !== "visible" &&
        getComputedStyle(label).textOverflow !== "ellipsis") issues.push({ kind: "cut-off label", what: name(element) });
  }
  // Controls drawn over each other.
  for (let first = 0; first < controls.length; first += 1) for (let second = first + 1; second < controls.length; second += 1) {
    const a = controls[first], b = controls[second];
    if (a.element.contains(b.element) || b.element.contains(a.element)) continue;
    const width = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
    const height = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
    if (width > 2 && height > 2) issues.push({ kind: "overlap", what: [name(a.element), name(b.element)] });
  }
  // Bordered controls side by side, within a short gap, share their vertical centre.
  const bordered = controls.filter(({ element }) => element.matches("button, select, input, a") &&
    parseFloat(getComputedStyle(element).borderTopWidth) > 0 && !element.closest("[role=listbox]"));
  for (const a of bordered) for (const b of bordered) {
    if (a === b || b.box.left < a.box.right || b.box.left - a.box.right > 16) continue;
    const overlap = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
    if (overlap < Math.min(a.box.height, b.box.height) / 2) continue;
    const off = Math.abs((a.box.top + a.box.bottom) / 2 - (b.box.top + b.box.bottom) / 2);
    if (off > 1.5) issues.push({ kind: "misaligned", what: [name(a.element), name(b.element)], off: Math.round(off * 10) / 10 });
    else if (Math.abs(a.box.height - b.box.height) > 2) issues.push({ kind: "uneven heights", what: [name(a.element), name(b.element)],
      heights: [Math.round(a.box.height), Math.round(b.box.height)] });
  }
  // A list's rows keep their last action in one column.
  for (const list of scope.querySelectorAll("[role=list], ul")) {
    const rows = [...list.children].filter((row) => shown(row) && row.getBoundingClientRect().height > 20);
    const rights = rows.map((row) => [...row.querySelectorAll("button, a[href]")].filter(shown).map((element) => element.getBoundingClientRect())
      .filter(({ width }) => width > 1).reduce((most, rect) => Math.max(most, rect.right), -1)).filter((right) => right > 0);
    if (rights.length >= 3 && Math.max(...rights) - Math.min(...rights) > 1.5)
      issues.push({ kind: "ragged action column", what: list.getAttribute("aria-label") || list.className.slice(0, 40),
        rights: [...new Set(rights.map(Math.round))].slice(0, 6) });
  }
  // Text that barely shows: below 2.2:1 against what is behind it (white on white and the like).
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const rgba = (color) => { context.clearRect(0, 0, 1, 1); context.fillStyle = "rgba(0,0,0,0)"; context.fillStyle = color;
    context.fillRect(0, 0, 1, 1); const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data; return [r, g, b, a / 255]; };
  const luminance = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const behind = (element) => { for (let node = element; node; node = node.parentElement) {
    const color = rgba(getComputedStyle(node).backgroundColor); if (color[3] > 0.5) return color; } return [255, 255, 255, 1]; };
  for (const element of scope.querySelectorAll("*")) {
    const own = [...element.childNodes].filter((node) => node.nodeType === 3 && node.data.trim()).map((node) => node.data.trim()).join(" ");
    if (!own || !shown(element) || element.closest(".citation-document, canvas, [disabled], .pdf-text-layer, .textLayer")) continue;
    const rect = visibleRect(element);
    if (!rect) continue;
    const [high, low] = [luminance(rgba(getComputedStyle(element).color)), luminance(behind(element))].sort((x, y) => y - x);
    const ratio = (high + 0.05) / (low + 0.05);
    if (ratio < 2.2) issues.push({ kind: "faint text", what: own.slice(0, 50), ratio: Math.round(ratio * 100) / 100 });
  }
  return issues;
}

/** Records each frame's state of the named regions until stopped. A region is a selector, read
 *  as its text, or `[selector, "paint"]`, read as what is drawn in it (pages painted, a document view). */
function sampleFrames(regions) {
  const samples = window.__frames = [];
  window.__framesStop = false;
  const painted = (element) => [...element.querySelectorAll("canvas")].filter((canvas) => {
    const box = canvas.getBoundingClientRect(); return canvas.width > 0 && box.width > 0 && box.bottom > 0 && box.top < innerHeight;
  }).length + (element.querySelector(".docx-view-container")?.firstElementChild ? 1 : 0);
  const tick = (time) => {
    const sample = { time };
    for (const [key, spec] of Object.entries(regions)) {
      const [selector, read] = Array.isArray(spec) ? spec : [spec, "text"];
      const element = document.querySelector(selector);
      if (!element) { sample[key] = null; continue; }
      const box = element.getBoundingClientRect();
      if (read === "paint") { sample[key] = { box: [box.x, box.y, box.width, box.height].map(Math.round).join(","), paint: painted(element) }; continue; }
      const text = element.textContent.replace(/\s+/gu, " ").trim();
      sample[key] = { box: [box.x, box.y, box.width, box.height].map(Math.round).join(","), text: text.slice(0, 120), length: text.length };
    }
    samples.push(sample);
    if (!window.__framesStop) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
/** Blank frames (a region present, then empty or gone, then back) and flickers (a state shown for a
 *  few frames between two others: content that blinks out and back, or a status that flashes). */
export function analyseFrames(samples) {
  const regions = Object.keys(samples[0] ?? {}).filter((key) => key !== "time"), found = { blank: [], flicker: [] };
  const empty = (state) => !state || ("paint" in state ? !state.paint : !state.length);
  for (const key of regions) {
    const states = samples.map((sample) => sample[key]);
    const first = states.findIndex((state) => !empty(state)), last = states.findLastIndex((state) => !empty(state));
    for (let index = first; index >= 0 && index <= last; index += 1)
      if (empty(states[index])) found.blank.push(`${key} @${Math.round(samples[index].time)}`);
    // Runs of one state (by text, or what is painted, and box); a short run between two others is a flicker.
    const runs = [];
    for (const state of states) {
      const signature = state ? `${"paint" in state ? state.paint > 0 : state.text}|${state.box}` : "∅";
      if (runs.at(-1)?.signature === signature) runs.at(-1).count += 1; else runs.push({ signature, count: 1, state });
    }
    const shown = (state) => !state ? "∅" : "paint" in state ? `${state.paint} painted at ${state.box}` : `"${state.text.slice(0, 50)}" at ${state.box}`;
    for (let index = 1; index < runs.length - 1; index += 1) {
      const run = runs[index];
      if (run.count > BUDGETS.flickerFrames) continue;
      // Content that leaves and returns is a flicker (going empty meanwhile counts as blank); text that moves on is not.
      if (runs[index - 1].signature === runs[index + 1].signature && !empty(run.state))
        found.flicker.push(`${key}: ${shown(runs[index - 1].state)} → ${shown(run.state)} ×${run.count} → ${shown(runs[index + 1].state)}`);
    }
  }
  return found;
}

/** The suite's record of one case: its checks, notes, screenshots and outputs. */
export class CaseRecord {
  constructor(name, out) { Object.assign(this, { name, out, failures: [], notes: {}, shots: [], outputs: [], judged: [] }); }
  check(condition, message, detail) {
    if (condition) return true;
    const text = detail === undefined ? message : `${message}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
    this.failures.push(text.slice(0, 1500));
    console.error(`  FAIL ${text.slice(0, 400)}`);
    return false;
  }
  note(key, value) {
    this.notes[key] = value;
    console.log(`  ${key}: ${typeof value === "number" ? `${Math.round(value)} ms` : JSON.stringify(value)?.slice(0, 300)}`);
  }
}

const settleScript = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

/** A fresh browser profile on the built page, from file:// or over http. */
export async function openApp(record, { browser, html, serve, mode = "file", network = {}, init = [], label = mode }) {
  const server = mode === "http" ? await serve(html) : null;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const log = await routeNetwork(context, network);
  await context.addInitScript(instrument);
  for (const script of init) await context.addInitScript(script);
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  const errors = [];
  // Each error with where it was thrown, so a failure says where to look.
  page.on("pageerror", (error) => errors.push(`${error.message} ${(error.stack ?? "").split("\n").slice(1, 4)
    .map((line) => line.trim()).join(" ")}`.trim()));
  // Leptonica and Tesseract's layout analysis, inside the bundled OCR engine, print their own
  // diagnostics to the console as errors.
  page.on("console", (message) => { if (message.type() === "error" && !/^Error in (?:pix|bmf)\w+:|^Detected \d+ diacritics$/u.test(message.text())) errors.push(message.text()); });
  return new App({ record, page, context, server, mode, log, errors, label, url: server?.url ?? pathToFileURL(html).href });
}

export class App {
  constructor(fields) { Object.assign(this, fields, { resized: [], shotNames: new Set(), interactions: [] }); }
  button(name, scope = this.page) { return scope.getByRole("button", { name, exact: true }); }
  settle() { return this.page.evaluate(settleScript); }
  now() { return this.page.evaluate(() => window.__e2e.now()); }
  /** Saving and background work report through the status line; waits for it to rest. */
  async idle(timeout = 60_000) {
    await this.page.waitForFunction(() => !document.querySelector("[role=status][aria-busy=true]"), null, { timeout });
    await this.settle();
  }
  /** Navigation to an enabled "Add file" (nothing stored), or with `until`, to what it waits for
   *  (a stored draft drawn at its step). */
  async load({ budget = BUDGETS.coldLoad, until } = {}) {
    await this.page.goto(this.url);
    return this.ready("load", budget, until);
  }
  async reload({ budget = BUDGETS.resume, until } = {}) {
    await this.page.reload();
    return this.ready("reload", budget, until);
  }
  async ready(label, budget, until) {
    if (until) await until(); else await this.page.waitForFunction(() => !document.querySelector(".beaver-loading-indicator, [aria-busy=true]") &&
      [...document.querySelectorAll("button, label")].some((element) => /^Add files?$/u.test(element.textContent.trim()) && !element.disabled),
    null, { timeout: 60_000 });
    const at = await this.now();
    this.record.note(`${this.label} ${label}`, at);
    this.record.check(at < budget, `${this.label}: ${label} to interactive in ${Math.round(at)} ms (budget ${budget})`);
    return at;
  }
  /** Answers the page's file picker: the file chooser from file://, real handles over http. */
  async pick(trigger, files) {
    if (this.mode === "file") {
      const chooser = this.page.waitForEvent("filechooser");
      chooser.catch(() => {});
      await trigger();
      await (await chooser).setFiles(files);
      return;
    }
    const staged = await Promise.all(files.map(async (file) => ({ name: path.basename(file), base64: (await readFile(file)).toString("base64") })));
    await this.page.evaluate((staged) => { window.__e2ePick = staged; }, staged);
    await trigger();
  }
  /** Runs `action` and returns what the page measured meanwhile, once its effects have painted;
   *  with `regions`, every frame meanwhile is sampled for blanks and flickers. */
  async measure(label, action, { rest = 250, regions = null, wait = null } = {}) {
    if (regions) await this.page.evaluate(sampleFrames, regions);
    const from = await this.now();
    await action();
    if (wait) await wait();
    await this.settle(); await this.page.waitForTimeout(rest); await this.idle();
    const to = await this.now();
    const frames = regions ? analyseFrames(await this.page.evaluate(() => { window.__framesStop = true; return window.__frames; })) : null;
    const seen = await this.page.evaluate(([from, to]) => window.__e2e.window(from, to), [from, to]);
    const input = seen.events.filter(({ name }) => /^(?:key|pointer|click|mouse)/u.test(name));
    // A shift is something seen to move: one whose sources keep their boxes to the pixel is not.
    const shifts = seen.shifts.filter(({ start, sources }) => !this.resized.some(([a, b]) => start >= a && start <= b) &&
      sources.some(({ moved }) => { const [before, after] = moved.split(" -> "); return before !== after; }));
    return { label, ms: to - from, inputToPaint: Math.max(0, ...input.map(({ duration }) => duration)),
      longTasks: seen.longTasks.map(({ duration }) => Math.round(duration)),
      shifts, shift: shifts.reduce((sum, { value }) => sum + value, 0), frames };
  }
  /** An interaction: painted within its budget, no long task, no shift, no blank or flickering frame. */
  async interact(label, action, { budget = BUDGETS.inputToPaint, longTask = BUDGETS.longTask, shiftsOk = null, ...options } = {}) {
    const result = await this.measure(label, action, options);
    this.interactions.push(result);
    const where = `${this.label} ${label}`;
    this.record.check(result.inputToPaint < budget, `${where}: input-to-paint ${Math.round(result.inputToPaint)} ms (budget ${budget})`);
    this.record.check(!result.longTasks.some((duration) => duration > longTask), `${where}: long tasks`, result.longTasks);
    const shifts = result.shifts.filter((shift) => !shiftsOk?.(shift));
    this.record.check(!shifts.length, `${where}: layout shift`, shifts.flatMap(({ value, sources }) =>
      sources.map(({ node, moved }) => `${value.toFixed(4)} ${node} ${moved}`)).slice(0, 6));
    if (result.frames) {
      this.record.check(!result.frames.blank.length, `${where}: blank frames`, result.frames.blank.slice(0, 6));
      this.record.check(!result.frames.flicker.length, `${where}: flicker`, result.frames.flicker.slice(0, 6));
    }
    return result;
  }
  /** The window's own resizes move everything: shifts while the suite resizes are not the page's. */
  async resizing(work) { const from = await this.now(); await work(); this.resized.push([from, await this.now() + 50]); }
  /** Screenshots at both sizes, each judged; the issues found are failures unless `allow` excuses them. */
  async shots(name, { allow = () => false, full = false } = {}) {
    assert(!this.shotNames.has(name), `duplicate screenshot ${name}`); this.shotNames.add(name);
    const dir = path.join(this.record.out, "screenshots"); await mkdir(dir, { recursive: true });
    await this.resizing(async () => {
      for (const [width, height] of SIZES) {
        await this.page.setViewportSize({ width, height }); await this.settle();
        const file = path.join(dir, `${this.label}-${String(this.shotNames.size).padStart(2, "0")}-${name}-${width}x${height}.png`);
        await this.page.screenshot({ path: file, fullPage: full });
        const issues = (await this.page.evaluate(judgeLayout)).filter((issue) => !allow(issue));
        this.record.shots.push(path.relative(this.record.out, file));
        this.record.judged.push({ shot: path.basename(file), issues });
        this.record.check(!issues.length, `${this.label} ${name} at ${width}×${height}: layout`, issues.slice(0, 8));
      }
      await this.page.setViewportSize({ width: 1440, height: 900 }); await this.settle();
    });
  }
  /** Everything an interaction-heavy walk measured, summed up. */
  summary() {
    const worst = this.interactions.reduce((top, item) => item.inputToPaint > (top?.inputToPaint ?? -1) ? item : top, undefined);
    return { interactions: this.interactions.length, maxInputToPaint: Math.round(worst?.inputToPaint ?? 0), slowest: worst?.label,
      longTasks: this.interactions.flatMap(({ label, longTasks }) => longTasks.map((duration) => `${label}: ${duration}`)).slice(0, 10) };
  }
  /** Main-thread tasks over `budget` while the page worked on its own between two times. */
  async backgroundTasks(from, label, budget = BUDGETS.backgroundTask) {
    const tasks = await this.page.evaluate(([from, to]) => window.__e2e.window(from, to).longTasks, [from, await this.now()]);
    const long = tasks.map(({ duration }) => Math.round(duration)).filter((duration) => duration > budget);
    this.record.note(`${this.label} ${label} long tasks`, tasks.map(({ duration }) => Math.round(duration)).filter((duration) => duration > 50));
    this.record.check(!long.length, `${this.label} ${label}: main-thread tasks over ${budget} ms while the page works`, long);
  }
  /** Network that left the page unanswered, and errors the page reported. */
  async close() {
    if (this.closed) return;
    this.closed = true;
    const asked = {};
    for (const { url, answer } of this.log) { const key = `${new URL(url).hostname} ${answer}`; asked[key] = (asked[key] ?? 0) + 1; }
    this.record.note(`${this.label} network`, asked);
    await writeFile(path.join(this.record.out, `${this.label}-network.json`), JSON.stringify(this.log, null, 1)).catch(() => {});
    this.record.check(!this.errors.length, `${this.label}: the page reported errors`, [...new Set(this.errors)].slice(0, 8));
    this.record.check(!refused(this.log).length, `${this.label}: requests left the page`, refused(this.log).slice(0, 6));
    await this.context.close(); await this.server?.close(); this.server = null;
  }
}

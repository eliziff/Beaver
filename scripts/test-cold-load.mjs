// Production-bundle probe; fixture API only, never a live backend.
// Build backend first. node scripts/test-cold-load.mjs CANDIDATE_DIST [BASELINE_DIST] [REPORT_DIR]
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium } from '@playwright/test';
import express from '../backend/node_modules/express/index.js';
import { precompressedAssets } from '../backend/dist/lib/precompressedAssets.js';

const [candidate, baseline, output = '.perf/report'] = process.argv.slice(2);
if (!candidate) throw new Error('Provide the candidate production dist directory');
await mkdir(output, { recursive: true });
const user = { id: '00000000-0000-0000-0000-000000000001', email: 'local@localhost', pendingEmail: null, createdWithGoogle: false };
const project = { id: 'performance-fixture', user_id: user.id, name: 'Performance fixture', created_at: '2026-01-01T00:00:00Z', cm_number: null, practice: null };
const profile = {
  displayName: 'Fixture', organisation: null, practiceSetting: null, professionalTitle: null,
  practiceAreas: [], jurisdictionPreference: { mode: 'ask', jurisdictions: [] },
  onboardingCompleted: true, titleModel: '', tabularModel: '', lastSelectedChatModel: null,
  lastSelectedReasoningEffort: null, mfaOnLogin: false, legalResearchUs: false,
  features: { authorities: true }, workflowFileTargets: { 'court-records': null, authorities: null },
  filingContact: { name: '', address: '', phone: '', fax: '', email: '' },
  draftingStyle: { version: 1, memoHeader: { to: '', from: '' }, documents: Object.fromEntries(
    ['memo', 'factum', 'letter', 'other'].map(key => [key, { citationPlacement: 'footnotes', citationHyperlinks: true, numberHeadings: 'auto' }])) },
  apiKeyStatus: { sources: {} },
};
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm' };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function serve(directory, settings = {}) {
  const root = resolve(directory);
  const requests = [];
  const app = express();
  if (settings.compressed !== false) app.use(precompressedAssets(root));
  const server = createServer(app);
  app.use(async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      requests.push(path);
      if (req.method !== 'GET') { res.writeHead(405).end(); return; }
      const config = { mode: settings.cloud ? 'cloud' : 'local', capabilities: { connectors: false } };
      if (path.startsWith('/api/')) {
        let body = { items: [], next_cursor: null };
        if (path === '/api/config') {
          await pause(settings.configDelay ?? 0);
          body = settings.invalidConfig ? { invalid: true } : config;
        } else if (path === '/api/projects') body = { items: [project], next_cursor: null };
        else if (['/api/chat', '/api/workflows', '/api/work-products'].includes(path)) body = [];
        else if (path === '/api/user/profile') body = profile;
        else if (path === '/api/auth/session') body = { user };
        else if (path === '/api/auth/mfa/assurance') body = { currentLevel: 'aal1', nextLevel: 'aal1' };
        else if (path === '/api/auth/mfa/factors') body = { totp: [] };
        else if (path === '/api/models') body = { models: [] };
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
        return;
      }
      const asset = extname(path) ? path : '/index.html';
      const file = resolve(root, `.${asset}`);
      if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
      let body = await readFile(file);
      if (asset.endsWith('.html') && !settings.fetchedConfig) {
        body = Buffer.from(body.toString().replace('__BEAVER_RUNTIME_CONFIG__', encodeURIComponent(JSON.stringify(config))));
      }
      res.writeHead(200, { 'Content-Type': mime[extname(asset)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }).end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise(resolve => server.close(resolve)) };
}

const browser = await chromium.launch({ headless: true });
const report = { methodology: 'Fresh Chromium context, cache disabled, loopback fixture API, production bundles over HTTP/1.1, original uncompressed serving versus actual production precompressed-asset middleware; cold timings use 80ms RTT / 10Mbps download / 4x CPU slowdown, five alternating samples per configuration, plus an uncompressed candidate control and five unthrottled loopback samples per build. Not a live-backend or HTTP/2 benchmark.', samples: [], checks: [] };
async function contextFor(server, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, ...options });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort());
  return { context, page, errors };
}
async function sample(directory, name, fetchedConfig, loopback = false) {
  const server = await serve(directory, { fetchedConfig, configDelay: fetchedConfig ? 80 : 0, compressed: name === 'candidate' });
  const { context, page, errors } = await contextFor(server);
  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    if (!loopback) await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 80, downloadThroughput: 10 * 1024 * 1024 / 8, uploadThroughput: 1024 * 1024 });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: loopback ? 1 : 4 });
    await page.addInitScript(() => {
      const observer = new MutationObserver(() => {
        if ([...document.querySelectorAll('a')].some(a => a.textContent === 'Performance fixture')) {
          window.__contentReady = performance.now(); observer.disconnect();
        }
      });
      observer.observe(document, { subtree: true, childList: true });
    });
    await page.goto(`${server.origin}/projects`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('link', { name: project.name, exact: true }).waitFor();
    const measured = await page.evaluate(() => ({ contentReadyMs: window.__contentReady, resources: performance.getEntriesByType('resource').map(r => ({ path: new URL(r.name).pathname, start: r.startTime, end: r.responseEnd, bytes: r.encodedBodySize, decodedBytes: r.decodedBodySize })) }));
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `${output}/${loopback ? 'loopback-' : ''}${name}-${fetchedConfig ? 'fetched' : 'embedded'}.png` });
    report.samples.push({ name, environment: loopback ? 'loopback' : 'throttled', config: fetchedConfig ? 'fetched' : 'embedded', ...measured });
  } finally { await context.close(); await server.close(); }
}
async function behavior(reducedMotion) {
  const server = await serve(candidate, { fetchedConfig: true, configDelay: 200 });
  const { context, page, errors } = await contextFor(server, { reducedMotion });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/projects?*', async route => { await held; await route.continue(); });
  try {
    await page.goto(`${server.origin}/projects`, { waitUntil: 'domcontentloaded' });
    const group = page.locator('[role="rowgroup"][aria-busy="true"]');
    await group.waitFor({ state: 'attached' });
    // Seek the real CSS animation deterministically instead of racing CI scheduling.
    const before = await group.evaluate(el => {
      for (const animation of el.getAnimations({ subtree: true })) { animation.pause(); animation.currentTime = 100; }
      const r = el.getBoundingClientRect();
      return { visibility: getComputedStyle(el).visibility, width: r.width, height: r.height,
        childrenHidden: [...el.querySelectorAll('*')].every(child => getComputedStyle(child).visibility === 'hidden') };
    });
    assert.equal(before.visibility, 'hidden'); assert.equal(before.childrenHidden, true);
    assert.ok(before.width > 0 && before.height > 0);
    await page.screenshot({ path: `${output}/pending-before-${reducedMotion}.png` });
    const after = await group.evaluate(el => {
      for (const animation of el.getAnimations({ subtree: true })) animation.currentTime = 160;
      const r = el.getBoundingClientRect(); return { visibility: getComputedStyle(el).visibility, width: r.width, height: r.height };
    });
    assert.equal(after.visibility, 'visible');
    assert.equal(before.width, after.width); assert.equal(before.height, after.height);
    await page.screenshot({ path: `${output}/pending-after-${reducedMotion}.png` });
    release();
    await page.getByRole('link', { name: project.name, exact: true }).waitFor();
    assert.equal(await page.locator('[role="rowgroup"][aria-busy="true"]').count(), 0);
    await page.unroute('**/api/projects?*');
    await page.evaluate(() => {
      window.__flashed = false; window.__watchFrames = true;
      const watch = () => {
        const group = document.querySelector('[role="rowgroup"][aria-busy="true"]');
        if (group && getComputedStyle(group).visibility !== 'hidden') window.__flashed = true;
        if (window.__watchFrames) requestAnimationFrame(watch);
      }; requestAnimationFrame(watch);
    });
    const response = page.waitForResponse(r => r.url().includes('/api/projects?') && r.url().includes('scope=mine'));
    await page.getByRole('tab', { name: 'Mine', exact: true }).click();
    await response;
    await page.getByRole('link', { name: project.name, exact: true }).waitFor();
    const flashed = await page.evaluate(() => { window.__watchFrames = false; return window.__flashed; });
    assert.equal(flashed, false);
    await page.route('**/api/projects?*', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'Fixture failure' }) }));
    await page.getByRole('tab', { name: 'All', exact: true }).click();
    await page.getByText('Could not load projects.', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    await page.unroute('**/api/projects?*');
    await page.getByRole('tab', { name: 'Mine', exact: true }).click();
    await page.getByRole('link', { name: project.name, exact: true }).waitFor();
    const settings = page.getByRole('button', { name: 'Settings', exact: true });
    await settings.click();
    let dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
    await dialog.waitFor();
    await dialog.getByRole('tab', { name: 'Display', exact: true }).click();
    assert.equal(await dialog.getByRole('tab', { name: 'Display', exact: true }).getAttribute('aria-selected'), 'true');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await settings.click();
    dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
    // AppSidebar intentionally unmounts Settings on close; preserve its reset.
    assert.equal(await dialog.getByRole('tab', { name: 'General', exact: true }).getAttribute('aria-selected'), 'true');
    await page.screenshot({ path: `${output}/settings-${reducedMotion}.png` });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'New project', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
    assert.deepEqual(errors, []);
    report.checks.push({ scenario: 'dialogs-and-settings-state', reducedMotion, passed: true });
    report.checks.push({ reducedMotion, hiddenBeforeThreshold: true, visibleWhenSlow: true, stableLayout: true, fastFilterFlashed: flashed, errorsImmediate: true });
  } finally { release(); await context.close(); await server.close(); }
}
try {
  await behavior('no-preference');
  await behavior('reduce');
  for (const settings of [{ cloud: true, fetchedConfig: true, configDelay: 150 }, { fetchedConfig: true, invalidConfig: true }]) {
    const server = await serve(candidate, settings);
    const { context, page, errors } = await contextFor(server);
    try {
      await page.goto(`${server.origin}/projects`);
      if (settings.invalidConfig) {
        await page.getByRole('heading', { name: 'Beaver could not start' }).waitFor();
        assert.deepEqual(server.requests.filter(path => path.startsWith('/api/') && path !== '/api/config'), []);
      } else await page.getByRole('link', { name: project.name, exact: true }).waitFor();
      assert.deepEqual(errors, []);
      report.checks.push({ scenario: settings.invalidConfig ? 'invalid-config-fails-closed' : 'cloud-cold-start', passed: true });
    } finally { await context.close(); await server.close(); }
  }
  {
    const server = await serve(candidate);
    const { context, page, errors } = await contextFor(server);
    try {
      for (const route of ['/assistant', '/library', '/account/features', '/table-of-authorities']) {
        await page.goto(server.origin + route);
        await page.locator('#main-content').waitFor();
        await page.waitForTimeout(250);
        assert.equal(await page.getByRole('heading', { name: 'Something went wrong', exact: true }).count(), 0);
        assert.deepEqual(errors, []);
        await page.screenshot({ path: `${output}/route-${route.slice(1).replaceAll('/', '-')}.png` });
      }
      report.checks.push({ scenario: 'cold-route-smoke', routes: ['assistant', 'library', 'account/features', 'table-of-authorities'], passed: true });
    } finally { await context.close(); await server.close(); }
  }
  for (const fetched of [false, true]) {
    for (let i = 0; i < 5; i++) {
      for (const [dir, name] of i % 2 ? [[candidate, 'candidate'], [baseline, 'baseline'], [candidate, 'candidate-identity']] : [[candidate, 'candidate-identity'], [baseline, 'baseline'], [candidate, 'candidate']]) {
        if (dir) await sample(dir, name, fetched);
      }
    }
  }
  for (let i = 0; i < 5; i++) {
    for (const [dir, name] of i % 2 ? [[candidate, 'candidate'], [baseline, 'baseline']] : [[baseline, 'baseline'], [candidate, 'candidate']]) {
      if (dir) await sample(dir, name, false, true);
    }
  }
  report.loopbackMedians = Object.fromEntries(['baseline', 'candidate'].map(name => {
    const values = report.samples.filter(s => s.environment === 'loopback' && s.name === name).map(s => s.contentReadyMs).sort((a, b) => a - b);
    return [name, values.length ? values[Math.floor(values.length / 2)] : null];
  }));
  report.medians = Object.fromEntries(['embedded', 'fetched'].map(config => [config, Object.fromEntries(['baseline', 'candidate-identity', 'candidate'].map(name => {
    const values = report.samples.filter(s => s.environment === 'throttled' && s.config === config && s.name === name).map(s => s.contentReadyMs).sort((a, b) => a - b);
    return [name, values.length ? values[Math.floor(values.length / 2)] : null];
  }))]));
  console.log(JSON.stringify({ checks: report.checks, medians: report.medians, loopbackMedians: report.loopbackMedians }, null, 2));
} catch (error) { report.failure = error.stack; throw error; }
finally { await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2)); await browser.close(); }

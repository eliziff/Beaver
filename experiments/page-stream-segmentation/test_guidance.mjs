/** Independently invented reference data; no corpus or user transcript needed. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const server = fileURLToPath(new URL('./guidance_server.mjs', import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');
const temporary = path.resolve(os.tmpdir());
const directory = mkdtempSync(path.join(temporary, 'page-guidance-test-'));
const client = new Client({ name: 'guidance-test', version: '1.0.0' }, { capabilities: {} });
try {
  const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGZkAAAAASUVORK5CYII=', 'base64');
  writeFileSync(path.join(directory, 'pixel.png'), pixel);
  const manifest = { root: directory, server_sha256: digest(readFileSync(server)), resources: {
    intent: { text: 'Invented instruction: identify separate calibration records.' },
    examples: { text: 'Invented example: one observation continues.', images: [
      { path: 'pixel.png', sha256: digest(pixel), caption: 'Invented single pixel.' },
    ] },
  } };
  const location = path.join(directory, 'manifest.json');
  const bytes = Buffer.from(JSON.stringify(manifest));
  writeFileSync(location, bytes);
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [server, location, digest(bytes)], stderr: 'pipe' }));
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(tool => tool.name), ['read_guidance']);
  const intent = await client.callTool({ name: 'read_guidance', arguments: { section: 'intent' } });
  assert.equal(intent.content[0].text, manifest.resources.intent.text);
  const examples = await client.callTool({ name: 'read_guidance', arguments: { section: 'examples' } });
  assert.equal(examples.content.find(item => item.type === 'image').data, pixel.toString('base64'));
  const invalid = await client.callTool({ name: 'read_guidance', arguments: { section: '../unrelated-file' } });
  assert.equal(invalid.isError, true);
  writeFileSync(path.join(directory, 'pixel.png'), 'changed input');
  const changed = await client.callTool({ name: 'read_guidance', arguments: { section: 'examples' } });
  assert.equal(changed.isError, true);
  console.log('Guidance resource reads, input restriction and hash checks passed.');
} finally {
  await client.close();
  assert.equal(path.dirname(directory), temporary);
  assert.ok(path.basename(directory).startsWith('page-guidance-test-'));
  rmSync(directory, { recursive: true, force: true });
}

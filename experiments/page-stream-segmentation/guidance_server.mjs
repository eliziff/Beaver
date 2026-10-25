/** Read two frozen, private reference resources for the judge experiment. */
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const [manifestPath, expectedHash, logPath] = process.argv.slice(2);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = readFileSync(manifestPath);
if (digest(bytes) !== expectedHash) throw new Error('Reference manifest changed');
const manifest = JSON.parse(bytes);
if (digest(readFileSync(fileURLToPath(import.meta.url))) !== manifest.server_sha256) {
  throw new Error('Reference server changed');
}
const root = path.resolve(manifest.root);
function image(asset) {
  const location = path.resolve(root, asset.path);
  const relative = path.relative(root, location);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Reference image escapes its store');
  const contents = readFileSync(location);
  if (digest(contents) !== asset.sha256) throw new Error('Reference image changed');
  return { type: 'image', mimeType: 'image/png', data: contents.toString('base64') };
}

const server = new McpServer({ name: 'page-stream-guidance', version: '1.0.0' });
server.registerTool('read_guidance', {
  description: 'Read a frozen reference: intent contains selected verbatim user transcript excerpts about the gold task; examples contains previous reviewed gold and original page images from separate source families. Neither resource contains the current case answer.',
  inputSchema: { section: z.enum(['intent', 'examples']) },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async ({ section }) => {
  const reference = manifest.resources[section];
  const content = [{ type: 'text', text: reference.text }];
  for (const asset of reference.images ?? []) {
    content.push({ type: 'text', text: asset.caption }, image(asset));
  }
  if (logPath) appendFileSync(logPath, JSON.stringify({ section, manifest_sha256: expectedHash,
    images: reference.images?.length ?? 0 }) + '\n');
  return { content };
});
await server.connect(new StdioServerTransport());

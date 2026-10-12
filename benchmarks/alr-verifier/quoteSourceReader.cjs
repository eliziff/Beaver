// Scoped, read-only MCP transport for one gold-correction turn. No dependencies.
const fs = require('node:fs');
const readline = require('node:readline');

function segments(text, start, end) {
  return [...text.slice(start, end).matchAll(/\S+(?:[ \t]+\S+){0,11}[ \t]*/gu)]
    .map(match => [start + match.index, start + match.index + match[0].length, match[0]]);
}

function select(input, name, args) {
  if (!Object.hasOwn(input.checks, args.check_id)) throw Error('Unknown check_id');
  const text = input.documents[input.checks[args.check_id]];
  const result = { check_id: args.check_id, length: text.length, windows: [] };
  const window = (start, end) => ({ segments: segments(text, start, end) });
  if (name === 'read') {
    const { start, end } = args;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > text.length || end <= start || end - start > 8000)
      throw Error('Read requires valid UTF16 start/end, at most 8000 characters');
    result.windows.push(window(start, end));
  } else if (name === 'search') {
    if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 4000)
      throw Error('Query must contain 1–4000 characters');
    const after = args.after ?? 0;
    if (!Number.isInteger(after) || after < 0 || after > text.length) throw Error('Invalid after offset');
    const pattern = args.query.trim().split(/\s+/u).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
    const hits = [...text.matchAll(new RegExp(pattern, 'giu'))];
    result.exact_occurrences = hits.length;
    const selected = hits.filter(hit => hit.index >= after).slice(0, 4);
    if (selected.length) {
      for (const hit of selected) result.windows.push(window(Math.max(0, hit.index - 500), Math.min(text.length, hit.index + hit[0].length + 700)));
      result.next_after = selected.at(-1).index + selected.at(-1)[0].length;
    } else if (!hits.length) {
      const words = new Set(args.query.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
      const ranked = [];
      for (let start = after; start < text.length; start += 800) {
        const end = Math.min(text.length, start + 1200);
        const present = new Set(text.slice(start, end).toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
        ranked.push({ start, end, score: [...words].filter(word => present.has(word)).length });
      }
      for (const hit of ranked.filter(hit => hit.score > 0).sort((a, b) => b.score - a.score || a.start - b.start).slice(0, 4))
        result.windows.push(window(hit.start, hit.end));
    }
    result.coverage = 'Exact count covers the complete source; windows are bounded. Zero exact hits alone does not prove absence.';
  } else throw Error('Unknown tool');
  // Repeated hits often overlap; return each source range once.
  const ranges = result.windows.map(w => [w.segments[0]?.[0], w.segments.at(-1)?.[1]])
    .filter(range => range[0] !== undefined).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [start, end] of ranges) {
    const previous = merged.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  result.windows = merged.map(([start, end]) => window(start, end));
  return result;
}

if (process.argv[2] === '--self-check') {
  const assert = require('node:assert/strict');
  const input = { documents: ['[7] 🦫 A vessel carried seven oranges.\n[8] A vessel carried eight pears.'], checks: { c0: 0 } };
  const found = select(input, 'search', { check_id: 'c0', query: 'EIGHT pears' });
  assert.equal(found.exact_occurrences, 1);
  assert.equal(select(input, 'read', { check_id: 'c0', start: 0, end: input.documents[0].length }).windows.flatMap(w => w.segments).at(-1)[1], input.documents[0].length);
  for (const [start, end, value] of found.windows.flatMap(w => w.segments)) assert.equal(input.documents[0].slice(start, end), value);
  assert.throws(() => select(input, 'read', { check_id: 'c1', start: 0, end: 4 }));
  assert.throws(() => select(input, 'read', { check_id: 'c0', start: -1, end: 4 }));
  assert.throws(() => select({ documents: ['x'.repeat(9000)], checks: { c0: 0 } }, 'read', { check_id: 'c0', start: 0, end: 8001 }));
  assert.equal(select(input, 'search', { check_id: 'c0', query: 'vessel' }).exact_occurrences, 2);
  assert.equal(select(input, 'search', { check_id: 'c0', query: 'carried pears' }).exact_occurrences, 0);
  console.log('Scoped reader self-check passed');
} else {
  const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const schema = properties => ({ type: 'object', properties, required: Object.keys(properties).filter(key => key !== 'after'), additionalProperties: false });
  const tools = [
    { name: 'search', description: 'Search this check’s complete source for a distinctive phrase. Returns exact hit count and bounded source segments with absolute UTF16 offsets; lexical candidates if no literal hits. Use after to page through repeated hits.',
      inputSchema: schema({ check_id: { type: 'string' }, query: { type: 'string' }, after: { type: 'integer' } }) },
    { name: 'read', description: 'Read a source range for this check, at most 8000 UTF16 characters. Returns [start,end,text] segments for selecting final source offsets.',
      inputSchema: schema({ check_id: { type: 'string' }, start: { type: 'integer' }, end: { type: 'integer' } }) },
  ].map(tool => ({ ...tool, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }));
  readline.createInterface({ input: process.stdin }).on('line', line => {
    let message;
    try {
      message = JSON.parse(line);
      if (message.id === undefined) return;
      let result;
      if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'quote_sources', version: '1.0.0' } };
      else if (message.method === 'ping') result = {};
      else if (message.method === 'tools/list') result = { tools };
      else if (message.method === 'tools/call') {
        const value = select(input, message.params.name, message.params.arguments);
        fs.appendFileSync(process.argv[3], JSON.stringify({ check_id: value.check_id, tool: message.params.name,
          spans: value.windows.flatMap(window => window.segments.map(segment => segment.slice(0, 2))) }) + '\n');
        result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
      } else throw Error('Unsupported method');
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
    } catch (error) {
      if (message?.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id,
        ...(message.method === 'tools/call' ? { result: { isError: true, content: [{ type: 'text', text: String(error) }] } }
          : { error: { code: -32602, message: String(error) } }) }) + '\n');
    }
  });
}

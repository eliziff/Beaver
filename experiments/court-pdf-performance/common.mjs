import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const HOME = dirname(fileURLToPath(import.meta.url));
export const FIXED_ISO = '2026-10-02T12:00:00.000Z';
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const canonical = (value) => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
export const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
export async function saveJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n');
}
export function fixedDate() {
  const OriginalDate = Date;
  globalThis.Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : [FIXED_ISO])); }
    static now() { return OriginalDate.parse(FIXED_ISO); }
  };
}
export function args(argv = process.argv.slice(2)) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index].startsWith('--') || argv[index + 1] === undefined)
      throw new Error(`Expected --name value arguments; got ${argv[index]}`);
    result[argv[index].slice(2)] = argv[index + 1];
  }
  return result;
}

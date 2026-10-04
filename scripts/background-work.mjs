import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// tsx uses os.tmpdir()/tsx-<user> and expires old transformations itself.
// Keep that reusable cache and inherited Node scratch in one ignored owner directory.
const temporary = fileURLToPath(new URL('../.tmp/node/', import.meta.url));
mkdirSync(temporary, { recursive: true });
process.env.TMPDIR = process.env.TEMP = process.env.TMP = temporary;

process.env.RAYON_NUM_THREADS ??= '1';
process.env.OMP_NUM_THREADS ??= '1';
process.env.GOMAXPROCS ??= '1';
const preload = `--import=${import.meta.url}`;
if (!process.env.NODE_OPTIONS?.includes(preload)) {
    process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} ${preload}`.trim();
}

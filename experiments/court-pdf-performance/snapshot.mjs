import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve, relative, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { ROOT, HOME, sha256, canonical, saveJson, args } from './common.mjs';

const options = args();
options.name ??= options.label;
if (!options.name || !/^[a-zA-Z0-9_-]+$/.test(options.name)) throw new Error('--name safe-name required');
const target = resolve(HOME, 'snapshots', options.name);
await mkdir(dirname(target), { recursive: true });
await mkdir(target, { recursive: false });
const { rolldown } = await import(pathToFileURL(resolve(ROOT, 'frontend/node_modules/rolldown/dist/index.mjs')).href);
const files = new Set();
const bundle = await rolldown({
  input: resolve(ROOT, 'frontend/src/app/court-records/assembly.ts'),
  platform: 'node',
  plugins: [{
    name: 'court-evaluation-resolver',
    async resolveId(source) {
      if (source === 'pdf-lib') return { id: resolve(ROOT, 'frontend/node_modules/pdf-lib/cjs/index.js'), external: true };
      if (source === '@pdf-lib/fontkit') return { id: resolve(ROOT, 'frontend/node_modules/@pdf-lib/fontkit/dist/fontkit.umd.js'), external: true };
      if (source.startsWith('@/')) return this.resolve(resolve(ROOT, 'frontend/src', source.slice(2)), undefined, { skipSelf: true });
    },
    transform(_code, id) { if (id.startsWith(ROOT + '/') && !id.includes('/node_modules/')) files.add(id); },
  }],
});
await bundle.write({ file: resolve(target, 'assembly.mjs'), format: 'esm', sourcemap: false, inlineDynamicImports: true });
await bundle.close();
const sourceFiles = {};
for (const file of [...files].sort()) {
  const local = relative(ROOT, file);
  sourceFiles[local] = sha256(await readFile(file));
  const dest = resolve(target, 'source', local);
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(file, dest);
}
const deps = {};
for (const name of ['pdf-lib', '@pdf-lib/fontkit', 'pdfjs-dist', 'rolldown', 'typescript']) {
  const bytes = await readFile(resolve(ROOT, 'frontend/node_modules', name, 'package.json'));
  deps[name] = { version: JSON.parse(bytes).version, package_sha256: sha256(bytes) };
}
const patch = execFileSync('git', ['diff', '--binary', '--', ...Object.keys(sourceFiles)], { cwd: ROOT });
await writeFile(resolve(target, 'source.patch'), patch);
const manifest = {
  schema: 'beaver.court-cloud-snapshot.v1', name: options.name,
  git_head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
  node: process.version, dependencies: deps,
  package_lock_sha256: sha256(await readFile(resolve(ROOT, 'frontend/package-lock.json'))),
  files: sourceFiles, source_sha256: sha256(canonical(sourceFiles)),
  bundle_sha256: sha256(await readFile(resolve(target, 'assembly.mjs'))),
  patch_sha256: sha256(patch),
};
await saveJson(resolve(target, 'manifest.json'), manifest);
process.stdout.write(JSON.stringify({ snapshot: target, ...manifest }) + '\n');

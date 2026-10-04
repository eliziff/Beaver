import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

export function selectedTests() {
  const files = process.argv.slice(2).filter(arg => /\.test\.[cm]?[jt]sx?$/.test(arg) && existsSync(arg) && statSync(arg).isFile());
  if (!files.length) throw new Error('Name exact test files: npm test -- src/path/name.test.ts');
  return files.map(file => path.relative(process.cwd(), path.resolve(file)).replaceAll('\\', '/'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  selectedTests();
  const cli = path.join(path.dirname(createRequire(path.resolve('package.json')).resolve('vitest/package.json')), 'vitest.mjs');
  const result = spawnSync(process.execPath, ['--max-old-space-size=384', cli, 'run', ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

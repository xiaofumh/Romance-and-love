import { spawnSync } from 'node:child_process';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
for (const args of [
  ['node_modules/typescript/bin/tsc', '--noEmit'],
  ['scripts/build.mjs'], ['node_modules/vitest/vitest.mjs', 'run'], ['scripts/verify.mjs'],
]) {
  const run = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (run.error) throw run.error;
  if (run.status !== 0) process.exit(run.status ?? 1);
}

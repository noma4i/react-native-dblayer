import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const build = spawnSync('yarn', ['build'], { cwd: rootDir, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

const drift = spawnSync('git', ['diff', '--quiet', '--', 'lib'], { cwd: rootDir });
if (drift.status !== 0) {
  process.stderr.write('Generated lib artifacts differ from the current index. Run yarn build and stage the complete lib diff.\n');
  process.exit(1);
}

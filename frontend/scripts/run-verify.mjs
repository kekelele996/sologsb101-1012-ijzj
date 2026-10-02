/**
 * 本地无浏览器校验：用 esbuild 打包 scripts/*.ts 到临时目录后用 node 运行。
 * 依赖 fake-indexeddb（已在 devDependencies）。不依赖 jest/vitest。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const cases = ['smoke', 'migration', 'replace-flow', 'qualify-sync'];
const dir = mkdtempSync(join(tmpdir(), 'gb-verify-'));

let failed = 0;
for (const name of cases) {
  const out = join(dir, `${name}.cjs`);
  process.stdout.write(`\n=== ${name} ===\n`);
  try {
    execFileSync(
      join(root, 'node_modules', '.bin', esbuildBin()),
      [`scripts/${name}.ts`, '--bundle', '--platform=node', '--format=cjs', `--outfile=${out}`, '--log-level=warning'],
      { cwd: root, stdio: 'inherit' }
    );
    execFileSync(process.execPath, [out], { cwd: root, stdio: 'inherit' });
  } catch {
    failed += 1;
  }
}
rmSync(dir, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n${failed} 个校验脚本失败`);
  process.exit(1);
}
console.log('\n全部本地校验脚本通过 ✅');

function esbuildBin() {
  return process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild';
}

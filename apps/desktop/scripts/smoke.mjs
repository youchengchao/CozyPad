import { execSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = path.resolve(pkgRoot, '..', '..');

execSync('node esbuild.mjs', { stdio: 'inherit', cwd: pkgRoot });

if (!existsSync(path.join(repoRoot, 'apps', 'app', 'dist', 'index.html'))) {
  execSync('pnpm --filter @cozypad/app build', { stdio: 'inherit', cwd: repoRoot });
}

const child = spawn(String(electronPath), ['.', '--smoke-test'], {
  cwd: pkgRoot,
  stdio: 'inherit',
  env: { ...process.env, COZYPAD_MOCK: '1', COZYPAD_DEV_URL: '' },
});

const timer = setTimeout(() => {
  console.error('[smoke] timed out after 30s');
  child.kill();
  process.exitCode = 1;
}, 30_000);

child.on('exit', (code) => {
  clearTimeout(timer);
  console.log(`[smoke] electron exited with code ${code}`);
  process.exit(code ?? 1);
});

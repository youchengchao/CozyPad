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

const child = spawn(String(electronPath), ['.'], {
  cwd: pkgRoot,
  stdio: 'inherit',
  env: { ...process.env, COZYPAD_DEV_URL: '', COZYPAD_MOCK: process.env.COZYPAD_MOCK ?? '0' },
});
child.on('exit', (code) => process.exit(code ?? 0));

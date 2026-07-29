import { execSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = path.resolve(pkgRoot, '..', '..');

const node = process.execPath;
execSync(`"${node}" esbuild.mjs`, { stdio: 'inherit', cwd: pkgRoot });

if (!existsSync(path.join(repoRoot, 'apps', 'app', 'dist', 'index.html'))) {
  const appRoot = path.join(repoRoot, 'apps', 'app');
  const viteBin = path.join(appRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  execSync(`"${node}" "${viteBin}" build`, { stdio: 'inherit', cwd: appRoot });
}

const child = spawn(String(electronPath), ['.'], {
  cwd: pkgRoot,
  stdio: 'inherit',
  env: { ...process.env, COZYPAD_DEV_URL: '', COZYPAD_MOCK: process.env.COZYPAD_MOCK ?? '0' },
});
child.on('exit', (code) => process.exit(code ?? 0));

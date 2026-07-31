import { execSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const pkgRoot = fileURLToPath(new URL('..', import.meta.url));

execSync('node esbuild.mjs --sourcemap', { stdio: 'inherit', cwd: pkgRoot });

const useRealSsh = process.argv.includes('--ssh');

const child = spawn(String(electronPath), ['.'], {
  cwd: pkgRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    COZYPAD_DEV_URL: process.env.COZYPAD_DEV_URL ?? 'http://localhost:5173',
    COZYPAD_MOCK: useRealSsh ? '0' : (process.env.COZYPAD_MOCK ?? '1'),
  },
});
child.on('exit', (code) => process.exit(code ?? 0));

import { spawnSync } from 'node:child_process';

const required = ['CSC_LINK', 'CSC_KEY_PASSWORD'];
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Refusing to package an unsigned desktop release. Missing: ${missing.join(', ')}`);
  process.exit(1);
}

const run = (command, args) => {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run(process.execPath, ['esbuild.mjs']);
run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', [
  'exec',
  'electron-builder',
  '--win',
]);

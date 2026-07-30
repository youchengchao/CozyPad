import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const required = [
  'COZYPAD_ANDROID_KEYSTORE',
  'COZYPAD_ANDROID_STORE_PASSWORD',
  'COZYPAD_ANDROID_KEY_ALIAS',
  'COZYPAD_ANDROID_KEY_PASSWORD',
];
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Refusing to build an unsigned release. Missing: ${missing.join(', ')}`);
  process.exit(1);
}

if (!existsSync(process.env.COZYPAD_ANDROID_KEYSTORE)) {
  console.error('Refusing to build: COZYPAD_ANDROID_KEYSTORE does not exist.');
  process.exit(1);
}

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: false,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['run', 'sync']);
run(
  process.platform === 'win32' ? 'gradlew.bat' : './gradlew',
  ['assembleRelease'],
  { cwd: new URL('../android/', import.meta.url) },
);

import { build } from 'esbuild';

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
};

await build({
  ...shared,
  entryPoints: ['src/main/main.ts'],
  outfile: 'dist/main.cjs',
  external: ['electron', 'ssh2'],
});

await build({
  ...shared,
  entryPoints: ['src/preload/preload.ts'],
  outfile: 'dist/preload.cjs',
  external: ['electron'],
});

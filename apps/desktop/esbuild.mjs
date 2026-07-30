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
  // ssh2 直接打進 bundle（純 JS）；cpu-features 是其選用原生加速，缺少時 try/catch 落空。
  external: ['electron', 'cpu-features', './crypto/build/Release/sshcrypto.node'],
});

await build({
  ...shared,
  entryPoints: ['src/preload/preload.ts'],
  outfile: 'dist/preload.cjs',
  external: ['electron'],
});

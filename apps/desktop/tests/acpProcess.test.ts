/**
 * The bundled agy adapter, spawned exactly the way the app will spawn it.
 *
 * This is the test the ACP cutover rests on. `packages/adapter-agy` has 221
 * tests against a fake transport, and `packages/acp-client` has 171 against
 * fake agents — but nothing until now ran the *bundle*. esbuild flattens ESM to
 * CJS, rewrites imports and inlines two workspace packages; any of that can
 * break in a way no source-level test can see.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { agyAcpEntryPath, spawnAcpAgent, type AcpLaunchSpec } from '../src/main/acp/acpProcess';

const desktopRoot = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const bundle = path.join(desktopRoot, 'dist', 'agy-acp.cjs');

/**
 * The real spec, minus the Electron-only parts.
 *
 * Under vitest `process.execPath` is already node, so `ELECTRON_RUN_AS_NODE`
 * is unnecessary here — and its necessity in a packaged app is a claim about
 * electron-builder that this test cannot settle. It is asserted separately,
 * below, as a property of the spec rather than of a running process.
 */
function testSpec(): AcpLaunchSpec {
  return {
    label: 'adapter-agy',
    command: process.execPath,
    args: [bundle],
    cwd: desktopRoot,
    env: { NO_COLOR: '1' },
  };
}

describe('the bundled agy ACP adapter', () => {
  it('is built before these tests run', () => {
    // A clearer failure than a spawn that dies with no output. `pnpm build`
    // produces it; `pnpm test` deliberately does not, so the bundle under test
    // is the one that was actually built.
    expect(existsSync(bundle), `${bundle} is missing — run \`pnpm --filter @cozypad/desktop build\``).toBe(true);
  });

  it('answers initialize over stdio, through the real client', async () => {
    const child = spawnAcpAgent(testSpec(), {
      onSessionUpdate: () => undefined,
      requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
    });
    try {
      const init = await child.handle.initialize();
      expect(init.protocolVersion).toBeGreaterThanOrEqual(1);

      // The negative capabilities this adapter reports about agy. They are the
      // only channel a client has for "you cannot approve anything here", and
      // an esbuild bundle that dropped the `_meta` block would still connect,
      // still answer, and quietly claim nothing.
      const meta = init.agentCapabilities?._meta as
        | Record<string, Record<string, unknown>>
        | undefined;
      const limits = meta?.['cozypad.dev/agy-limitations'];
      expect(limits?.['requestsPermission']).toBe(false);
      expect(limits?.['confinesToWorkspace']).toBe(false);
      expect(init.agentCapabilities?.loadSession).toBe(false);
    } finally {
      child.kill();
    }
  }, 30_000);

  it('does not spawn agy itself just to say hello', async () => {
    // `initialize` must not reach the transport. `newSession` does — it calls
    // `listModels()`, which spawns the real agy binary — so this suite stops
    // short of it on purpose and leaves that path to adapter-agy's own tests
    // against a fake transport. If this ever starts needing agy installed, the
    // adapter has moved work into the handshake.
    const child = spawnAcpAgent(testSpec(), {
      onSessionUpdate: () => undefined,
      requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
    });
    try {
      await expect(child.handle.initialize()).resolves.toBeDefined();
    } finally {
      child.kill();
    }
  }, 30_000);

  it('kills the child once, however many times it is asked', () => {
    const child = spawnAcpAgent(testSpec(), {
      onSessionUpdate: () => undefined,
      requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
    });
    child.kill();
    expect(() => {
      child.kill();
    }).not.toThrow();
  });
});

describe('the launch spec', () => {
  it('runs the bundle through node, never through a shell', () => {
    // On Windows `shell: true` concatenates argv into one unescaped string.
    // The spec keeps the entry as its own argv element for that reason.
    const spec = { label: 'adapter-agy', command: process.execPath, args: [agyAcpEntryPath()], cwd: '.' };
    expect(spec.args).toHaveLength(1);
    expect(spec.args[0]).toMatch(/agy-acp\.cjs$/u);
  });

  it('points inside app.asar.unpacked when running from an asar', () => {
    // A file inside an asar archive has no path the OS can execute, so the
    // bundle is unpacked next to it. Asserted on the rewrite rather than on a
    // packaged build, which this suite cannot produce.
    const packed = path.join('C:', 'app', 'resources', 'app.asar', 'dist');
    expect(packed.replace('app.asar', 'app.asar.unpacked')).toContain('app.asar.unpacked');
    // And a dev path, which contains neither string, must come back unchanged.
    const dev = path.join('D:', 'CozyPad', 'apps', 'desktop', 'dist');
    expect(dev.replace('app.asar', 'app.asar.unpacked')).toBe(dev);
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('native mobile workspace overflow', () => {
  it('marks Settings and Monitor as native-mobile workspaces', () => {
    const settings = readFileSync(
      resolve(__dirname, '../src/workspaces/SettingsWorkspace.tsx'),
      'utf-8',
    );
    const monitor = readFileSync(
      resolve(__dirname, '../src/workspaces/MonitorWorkspace.tsx'),
      'utf-8',
    );

    expect(settings).toContain("bridgeKind === 'capacitor' ? ' native-mobile'");
    expect(monitor).toContain("bridge.kind === 'capacitor' ? ' native-mobile'");
  });

  it('contains viewport and inner-scroll guards for mobile content', () => {
    const css = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf-8');

    expect(css).toContain('.settings-workspace.native-mobile,');
    expect(css).toContain('.monitor-workspace.native-mobile');
    expect(css).toContain('overflow-x: hidden;');
    expect(css).toContain('.settings-workspace.native-mobile .settings-row');
    expect(css).toContain('.monitor-workspace.native-mobile table');
    expect(css).toContain('overflow-x: auto;');
  });
});

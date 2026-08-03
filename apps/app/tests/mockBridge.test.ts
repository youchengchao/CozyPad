import { describe, expect, it } from 'vitest';
import type { ConnectionStateChanged, TerminalOutputEvent } from '@cozypad/contracts';
import { base64ToText, textToBase64 } from '@cozypad/contracts';
import { createMockBridge } from '../src/platform/mockBridge';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('createMockBridge', () => {
  it('exposes the mock profile', async () => {
    const bridge = createMockBridge();
    const profiles = await bridge.listProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.host).toBe('mock.local');
  });

  it('walks connecting → connected on connect', async () => {
    const bridge = createMockBridge();
    const states: ConnectionStateChanged['state'][] = [];
    bridge.onConnectionState((event) => states.push(event.state));
    await bridge.connect({ profileId: 'mock-local' });
    expect(states).toEqual(['connecting', 'connected']);
  });

  it('refuses to open a terminal before connecting', async () => {
    const bridge = createMockBridge();
    await expect(
      bridge.openTerminal({ profileId: 'mock-local', cols: 80, rows: 24 }),
    ).rejects.toThrow('not connected');
  });

  it('streams the banner after opening a terminal', async () => {
    const bridge = createMockBridge();
    await bridge.connect({ profileId: 'mock-local' });
    const chunks: TerminalOutputEvent[] = [];
    bridge.onTerminalOutput((event) => chunks.push(event));
    const { terminalId } = await bridge.openTerminal({
      profileId: 'mock-local',
      cols: 80,
      rows: 24,
    });
    await delay(80);
    const text = chunks
      .filter((chunk) => chunk.terminalId === terminalId)
      .map((chunk) => base64ToText(chunk.dataBase64))
      .join('');
    expect(text).toContain('CozyPad mock shell');
  });

  it('echoes input and runs commands through the PTY stream', async () => {
    const bridge = createMockBridge();
    await bridge.connect({ profileId: 'mock-local' });
    const chunks: TerminalOutputEvent[] = [];
    bridge.onTerminalOutput((event) => chunks.push(event));
    const { terminalId } = await bridge.openTerminal({
      profileId: 'mock-local',
      cols: 80,
      rows: 24,
    });
    await delay(80);
    bridge.writeTerminal({ terminalId, dataBase64: textToBase64('ls\r') });
    const text = chunks.map((chunk) => base64ToText(chunk.dataBase64)).join('');
    expect(text).toContain('cozypad.study.yaml');
  });

  it('emits closed events and drops terminals on disconnect', async () => {
    const bridge = createMockBridge();
    await bridge.connect({ profileId: 'mock-local' });
    const closed: string[] = [];
    bridge.onTerminalClosed((event) => closed.push(event.terminalId));
    const { terminalId } = await bridge.openTerminal({
      profileId: 'mock-local',
      cols: 80,
      rows: 24,
    });
    await bridge.disconnect({ profileId: 'mock-local' });
    expect(closed).toEqual([terminalId]);
  });

  it('opens AGY as a native TUI and Stop cancels without closing it', async () => {
    const bridge = createMockBridge();
    await bridge.connect({ profileId: 'mock-local' });
    const bundle = await bridge.createAgentSession({
      profileId: 'mock-local',
      agentKind: 'agy',
      cwd: '/home/cozy/project',
      interactionMode: 'chat',
    });
    expect(bundle.session.interactionMode).toBe('terminal');

    const chunks: TerminalOutputEvent[] = [];
    const closed: string[] = [];
    bridge.onTerminalOutput((event) => chunks.push(event));
    bridge.onTerminalClosed((event) => closed.push(event.terminalId));
    const { terminalId } = await bridge.openAgentTerminal({
      sessionId: bundle.session.id,
      cols: 100,
      rows: 32,
    });
    await delay(80);
    bridge.writeTerminal({ terminalId, dataBase64: textToBase64('\u001b[B') });
    const text = chunks.map((chunk) => base64ToText(chunk.dataBase64)).join('');
    expect(text).toContain('AGY 1.1.9');
    expect(text).toContain('❯ Resume a conversation');

    bridge.writeTerminal({ terminalId, dataBase64: textToBase64('\r') });
    bridge.writeTerminal({ terminalId, dataBase64: textToBase64('slow task\r') });
    await bridge.interruptAgentSession({ sessionId: bundle.session.id });
    const afterStop = chunks.map((chunk) => base64ToText(chunk.dataBase64)).join('');
    expect(afterStop).toContain('What would you like AGY to work on?');
    expect(closed).toEqual([]);
  });

  it('deletes an agent session and emits a deletion event', async () => {
    const bridge = createMockBridge();
    await bridge.connect({ profileId: 'mock-local' });
    const bundle = await bridge.createAgentSession({
      profileId: 'mock-local',
      agentKind: 'agy',
      cwd: '/home/cozy/project',
      interactionMode: 'terminal',
    });
    const deleted: string[] = [];
    bridge.onAgentSessionDeleted((event) => deleted.push(event.sessionId));

    await bridge.deleteAgentSession({ sessionId: bundle.session.id });

    expect(deleted).toEqual([bundle.session.id]);
    expect(
      (await bridge.listAgentSessions({ profileId: 'mock-local' })).some(
        ({ session }) => session.id === bundle.session.id,
      ),
    ).toBe(false);
  });
});

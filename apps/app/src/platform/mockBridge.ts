import type {
  ConnectionProfile,
  ConnectionState,
  ConnectionStateChanged,
  PlatformBridge,
  TerminalClosedEvent,
  TerminalOutputEvent,
} from '@cozypad/contracts';
import { base64ToBytes, bytesToBase64 } from '@cozypad/contracts';
import { MockPtyEngine } from '@cozypad/test-fixtures';

const MOCK_PROFILE: ConnectionProfile = {
  id: 'mock-local',
  name: 'Mock Host (browser)',
  host: 'mock.local',
  port: 22,
  username: 'cozy',
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 純瀏覽器模式的 PlatformBridge：讓 UI 開發完全不需要 Electron 或真實主機。 */
export function createMockBridge(): PlatformBridge {
  const stateListeners = new Set<(event: ConnectionStateChanged) => void>();
  const outputListeners = new Set<(event: TerminalOutputEvent) => void>();
  const closedListeners = new Set<(event: TerminalClosedEvent) => void>();
  const terminals = new Map<string, MockPtyEngine>();
  let connected = false;
  let nextTerminalId = 1;

  const emitState = (state: ConnectionState, error?: string): void => {
    const event: ConnectionStateChanged = {
      profileId: MOCK_PROFILE.id,
      state,
      ...(error === undefined ? {} : { error }),
    };
    stateListeners.forEach((listener) => listener(event));
  };

  return {
    kind: 'mock',

    listProfiles: () => Promise.resolve([MOCK_PROFILE]),

    async connect() {
      emitState('connecting');
      await delay(300);
      connected = true;
      emitState('connected');
    },

    async disconnect() {
      connected = false;
      for (const engine of terminals.values()) engine.close();
      terminals.clear();
      emitState('disconnected');
    },

    onConnectionState(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },

    async openTerminal(request) {
      if (!connected) throw new Error('mock bridge: not connected');
      const terminalId = `mock-term-${nextTerminalId++}`;
      const engine = new MockPtyEngine(
        {
          onData: (data) => {
            const event: TerminalOutputEvent = {
              terminalId,
              dataBase64: bytesToBase64(data),
            };
            outputListeners.forEach((listener) => listener(event));
          },
          onClose: (info) => {
            terminals.delete(terminalId);
            const event: TerminalClosedEvent = {
              terminalId,
              exitCode: info.exitCode,
            };
            closedListeners.forEach((listener) => listener(event));
          },
        },
        { cols: request.cols, rows: request.rows },
      );
      terminals.set(terminalId, engine);
      setTimeout(() => engine.start(), 30);
      return { terminalId };
    },

    writeTerminal(input) {
      terminals.get(input.terminalId)?.write(base64ToBytes(input.dataBase64));
    },

    resizeTerminal(request) {
      terminals.get(request.terminalId)?.resize(request.cols, request.rows);
      return Promise.resolve();
    },

    closeTerminal(request) {
      terminals.get(request.terminalId)?.close();
      return Promise.resolve();
    },

    onTerminalOutput(listener) {
      outputListeners.add(listener);
      return () => outputListeners.delete(listener);
    },

    onTerminalClosed(listener) {
      closedListeners.add(listener);
      return () => closedListeners.delete(listener);
    },
  };
}

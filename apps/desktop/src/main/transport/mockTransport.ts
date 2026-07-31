import type {
  ConnectionProfile,
  ConnectionState,
  TerminalOpenRequest,
} from '@cozypad/contracts';
import { MockPtyEngine } from '@cozypad/test-fixtures';
import type { TransportEvents, TransportPort } from './TransportPort';

export const MOCK_PROFILE: ConnectionProfile = {
  id: 'mock-electron',
  name: 'Mock Host (electron)',
  host: 'mock.local',
  port: 22,
  username: 'cozy',
  authMethod: 'password',
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** COZYPAD_MOCK=1 時使用：讓 Electron 整條 IPC 路徑可以離線驗證。 */
export class MockTransport implements TransportPort {
  private events: TransportEvents | null = null;
  private readonly terminals = new Map<string, MockPtyEngine>();
  private connected = false;
  private nextTerminalId = 1;

  setEvents(events: TransportEvents): void {
    this.events = events;
  }

  exec(): Promise<string> {
    return Promise.reject(
      new Error('mock transport has no shell exec; mock services are wired directly'),
    );
  }

  execStream(): Promise<string> {
    return this.exec();
  }

  async connect(profileId: string): Promise<void> {
    this.emitState(profileId, 'connecting');
    await delay(200);
    this.connected = true;
    this.emitState(profileId, 'connected');
  }

  disconnect(profileId: string): Promise<void> {
    this.connected = false;
    for (const engine of this.terminals.values()) engine.close();
    this.terminals.clear();
    this.emitState(profileId, 'disconnected');
    return Promise.resolve();
  }

  openTerminal(request: TerminalOpenRequest): Promise<string> {
    if (!this.connected) return Promise.reject(new Error('mock transport: not connected'));
    const terminalId = `mock-term-${this.nextTerminalId++}`;
    const engine = new MockPtyEngine(
      {
        onData: (data) => this.events?.onTerminalOutput(terminalId, data),
        onClose: (info) => {
          this.terminals.delete(terminalId);
          this.events?.onTerminalClosed(terminalId, info.exitCode);
        },
      },
      { cols: request.cols, rows: request.rows },
    );
    this.terminals.set(terminalId, engine);
    setTimeout(() => engine.start(), 30);
    return Promise.resolve(terminalId);
  }

  writeTerminal(terminalId: string, data: Uint8Array): void {
    this.terminals.get(terminalId)?.write(data);
  }

  resizeTerminal(terminalId: string, cols: number, rows: number): void {
    this.terminals.get(terminalId)?.resize(cols, rows);
  }

  closeTerminal(terminalId: string): void {
    this.terminals.get(terminalId)?.close();
  }

  dispose(): void {
    for (const engine of this.terminals.values()) engine.close();
    this.terminals.clear();
  }

  private emitState(profileId: string, state: ConnectionState): void {
    this.events?.onConnectionState({ profileId, state });
  }
}

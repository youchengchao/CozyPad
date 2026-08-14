import type { DirectoryListing, TerminalOpenRequest } from '@cozypad/contracts';
import type { TransportEvents, TransportPort } from './TransportPort';
import { isLocalProfile } from './localTransport';

/**
 * Makes "this computer" a connection like any other.
 *
 * Everything above this layer — agent sessions, the file browser, telemetry —
 * asks the transport to run a command or open a terminal without caring where
 * that happens. Choosing the implementation from the profile keeps local and
 * SSH at the same level instead of making local a special case threaded
 * through every caller.
 */
export class RoutingTransport implements TransportPort {
  private active: TransportPort;
  private activeProfileId: string | null = null;

  constructor(
    private readonly ssh: TransportPort,
    private readonly local: TransportPort,
  ) {
    this.active = ssh;
  }

  private forProfile(profileId: string): TransportPort {
    return isLocalProfile(profileId) ? this.local : this.ssh;
  }

  /** Terminal ids are namespaced by their transport, so they route themselves. */
  private forTerminal(terminalId: string): TransportPort {
    return terminalId.startsWith('local-') ? this.local : this.ssh;
  }

  setEvents(events: TransportEvents): void {
    this.ssh.setEvents(events);
    this.local.setEvents(events);
  }

  async connect(profileId: string): Promise<void> {
    const target = this.forProfile(profileId);
    // Only one host is in use at a time; leaving the other connected would let
    // a later exec run somewhere the user is no longer looking at. The old
    // host is dropped under *its own* id — reporting it under the new one made
    // the UI read the switch as the new connection immediately dropping.
    if (
      this.activeProfileId !== null &&
      (this.active !== target || this.activeProfileId !== profileId)
    ) {
      await this.active.disconnect(this.activeProfileId).catch(() => undefined);
    }
    this.active = target;
    this.activeProfileId = profileId;
    await target.connect(profileId);
  }

  async disconnect(profileId: string): Promise<void> {
    if (this.activeProfileId === profileId) this.activeProfileId = null;
    await this.forProfile(profileId).disconnect(profileId);
  }

  exec(command: string, timeoutMs?: number, signal?: AbortSignal): Promise<string> {
    return this.active.exec(command, timeoutMs, signal);
  }

  execStream(
    command: string,
    onLine: (line: string) => void,
    timeoutMs?: number,
    collectOutput?: boolean,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.active.execStream(command, onLine, timeoutMs, collectOutput, signal);
  }

  writeFile(path: string, data: Uint8Array): Promise<void> {
    return this.active.writeFile(path, data);
  }

  fsRealpath(path: string): Promise<string> {
    return this.active.fsRealpath(path);
  }

  fsList(path: string): Promise<DirectoryListing> {
    return this.active.fsList(path);
  }

  fsReadText(path: string, maxBytes: number, offset: number): Promise<string> {
    return this.active.fsReadText(path, maxBytes, offset);
  }

  fsReadBytes(path: string, maxBytes: number): Promise<string> {
    return this.active.fsReadBytes(path, maxBytes);
  }

  fsWrite(path: string, data: Uint8Array): Promise<void> {
    return this.active.fsWrite(path, data);
  }

  fsCreate(directory: string, name: string, kind: 'file' | 'directory'): Promise<void> {
    return this.active.fsCreate(directory, name, kind);
  }

  fsRename(path: string, newName: string): Promise<void> {
    return this.active.fsRename(path, newName);
  }

  fsDuplicate(path: string): Promise<string> {
    return this.active.fsDuplicate(path);
  }

  fsCopyTo(sourcePath: string, destinationDirectory: string): Promise<string> {
    return this.active.fsCopyTo(sourcePath, destinationDirectory);
  }

  fsMoveTo(sourcePath: string, destinationDirectory: string): Promise<string> {
    return this.active.fsMoveTo(sourcePath, destinationDirectory);
  }

  fsRemove(path: string): Promise<void> {
    return this.active.fsRemove(path);
  }

  openTerminal(request: TerminalOpenRequest, command?: string): Promise<string> {
    return this.forProfile(request.profileId).openTerminal(request, command);
  }

  writeTerminal(terminalId: string, data: Uint8Array): void {
    this.forTerminal(terminalId).writeTerminal(terminalId, data);
  }

  resizeTerminal(terminalId: string, cols: number, rows: number): void {
    this.forTerminal(terminalId).resizeTerminal(terminalId, cols, rows);
  }

  closeTerminal(terminalId: string): void {
    this.forTerminal(terminalId).closeTerminal(terminalId);
  }

  dispose(): void {
    this.ssh.dispose();
    this.local.dispose();
  }
}

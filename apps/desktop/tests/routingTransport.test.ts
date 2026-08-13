import { describe, expect, it } from 'vitest';
import type { DirectoryListing, TerminalOpenRequest } from '@cozypad/contracts';
import type { TransportEvents, TransportPort } from '../src/main/transport/TransportPort';
import { RoutingTransport } from '../src/main/transport/routingTransport';
import { LOCAL_PROFILE } from '../src/main/transport/localTransport';

class RecordingTransport implements TransportPort {
  readonly calls: string[] = [];
  events: TransportEvents | null = null;

  constructor(private readonly prefix: string) {}

  setEvents(events: TransportEvents): void {
    this.events = events;
  }
  connect(profileId: string): Promise<void> {
    this.calls.push(`connect:${profileId}`);
    return Promise.resolve();
  }
  disconnect(profileId: string): Promise<void> {
    this.calls.push(`disconnect:${profileId}`);
    return Promise.resolve();
  }
  exec(command: string): Promise<string> {
    this.calls.push(`exec:${command}`);
    return Promise.resolve(this.prefix);
  }
  execStream(command: string): Promise<string> {
    this.calls.push(`stream:${command}`);
    return Promise.resolve(this.prefix);
  }
  writeFile(path: string): Promise<void> {
    this.calls.push(`write:${path}`);
    return Promise.resolve();
  }
  fsList(path: string): Promise<DirectoryListing> {
    this.calls.push(`fsList:${path}`);
    return Promise.resolve({ path, items: [], truncated: false });
  }
  fsReadText(path: string): Promise<string> {
    this.calls.push(`fsReadText:${path}`);
    return Promise.resolve('');
  }
  fsReadBytes(path: string, maxBytes: number): Promise<string> {
    this.calls.push(`fsReadBytes:${path}:${maxBytes}`);
    return Promise.resolve('');
  }
  fsWrite(path: string): Promise<void> {
    this.calls.push(`fsWrite:${path}`);
    return Promise.resolve();
  }
  fsCreate(directory: string, name: string): Promise<void> {
    this.calls.push(`fsCreate:${directory}/${name}`);
    return Promise.resolve();
  }
  fsRename(path: string, newName: string): Promise<void> {
    this.calls.push(`fsRename:${path}->${newName}`);
    return Promise.resolve();
  }
  fsDuplicate(path: string): Promise<string> {
    this.calls.push(`fsDuplicate:${path}`);
    return Promise.resolve('');
  }
  fsCopyTo(sourcePath: string, destinationDirectory: string): Promise<string> {
    this.calls.push(`fsCopyTo:${sourcePath}->${destinationDirectory}`);
    return Promise.resolve('');
  }
  fsMoveTo(sourcePath: string, destinationDirectory: string): Promise<string> {
    this.calls.push(`fsMoveTo:${sourcePath}->${destinationDirectory}`);
    return Promise.resolve('');
  }
  fsRemove(path: string): Promise<void> {
    this.calls.push(`fsRemove:${path}`);
    return Promise.resolve();
  }
  openTerminal(request: TerminalOpenRequest): Promise<string> {
    this.calls.push(`open:${request.profileId}`);
    return Promise.resolve(`${this.prefix}-term-1`);
  }
  writeTerminal(terminalId: string): void {
    this.calls.push(`writeTerm:${terminalId}`);
  }
  resizeTerminal(terminalId: string): void {
    this.calls.push(`resize:${terminalId}`);
  }
  closeTerminal(terminalId: string): void {
    this.calls.push(`close:${terminalId}`);
  }
  dispose(): void {
    this.calls.push('dispose');
  }
}

function router(): {
  routing: RoutingTransport;
  ssh: RecordingTransport;
  local: RecordingTransport;
} {
  const ssh = new RecordingTransport('ssh');
  const local = new RecordingTransport('local');
  return { routing: new RoutingTransport(ssh, local), ssh, local };
}

describe('transport routing', () => {
  it('sends work to the host the profile names', async () => {
    const { routing, ssh, local } = router();

    await routing.connect(LOCAL_PROFILE.id);
    await routing.exec('uname -a');

    expect(local.calls).toEqual([`connect:${LOCAL_PROFILE.id}`, 'exec:uname -a']);
    expect(ssh.calls.filter((call) => call.startsWith('exec'))).toEqual([]);
  });

  it('leaves the previous host when switching, so a command cannot land there', async () => {
    const { routing, ssh, local } = router();

    await routing.connect('ssh-profile');
    await routing.connect(LOCAL_PROFILE.id);
    await routing.exec('ls');

    // The old host is dropped under its own id. Reporting it under the new
    // one made the UI see the host it was joining as having just dropped.
    expect(ssh.calls).toContain('disconnect:ssh-profile');
    expect(ssh.calls).not.toContain(`disconnect:${LOCAL_PROFILE.id}`);
    expect(local.calls).toContain('exec:ls');
  });

  it('switches back to a remote host after starting on this machine', async () => {
    const { routing, ssh, local } = router();

    // The default is local, but reaching a remote must never become blocked.
    await routing.connect(LOCAL_PROFILE.id);
    await routing.connect('ssh-profile');
    await routing.exec('uptime');

    expect(local.calls).toContain(`disconnect:${LOCAL_PROFILE.id}`);
    expect(ssh.calls).toContain('connect:ssh-profile');
    expect(ssh.calls).toContain('exec:uptime');
  });

  it('does not tear down a host on the very first connection', async () => {
    const { routing, ssh, local } = router();

    await routing.connect('ssh-profile');

    expect(local.calls).toEqual([]);
    expect(ssh.calls).toEqual(['connect:ssh-profile']);
  });

  it('routes a terminal by the id that opened it', async () => {
    const { routing, ssh, local } = router();
    await routing.connect('ssh-profile');

    const remote = await routing.openTerminal({
      profileId: 'ssh-profile',
      cols: 80,
      rows: 24,
    });
    const here = await routing.openTerminal({
      profileId: LOCAL_PROFILE.id,
      cols: 80,
      rows: 24,
    });
    routing.writeTerminal(remote, new Uint8Array());
    routing.closeTerminal(here);

    expect(ssh.calls).toContain(`writeTerm:${remote}`);
    expect(local.calls).toContain(`close:${here}`);
    expect(local.calls).not.toContain(`writeTerm:${remote}`);
  });

  it('shuts down both hosts, not just the one in use', () => {
    const { routing, ssh, local } = router();

    routing.dispose();

    expect(ssh.calls).toContain('dispose');
    expect(local.calls).toContain('dispose');
  });
});

import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { AgentSessionBundle } from '@cozypad/contracts';
import { MemoryProfileStore } from '../src/main/profileStore';
import { RemoteAgentHostClient } from '../src/main/remoteAgentHostClient';
import type { NodeHostProcessSpec } from '../src/main/transport/nodeHostRuntime';
import type { RemoteHostProcess } from '../src/main/transport/remoteNodeHost';

const SESSION: AgentSessionBundle = {
  session: {
    id: 'session-1',
    agentKind: 'claude',
    title: 'Host session',
    host: 'researcher@lab.example',
    project: 'project',
    projectId: '/srv/project',
    cwd: '/srv/project',
    archivedAt: null,
    status: 'ready',
    unread: 0,
    slashCommands: [],
    updatedAt: '2026-08-15T00:00:00.000Z',
  },
  items: [],
};

class FakeAgentProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  exitCode: number | null = null;
  signalCode: string | null = null;
  ended = false;

  constructor(private readonly listSessions = () => [SESSION]) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        const request = JSON.parse(Buffer.from(chunk).toString('utf8')) as {
          id: number;
          method: string;
        };
        const result =
          request.method === 'listAgentSessions'
            ? this.listSessions()
            : request.method === 'importAgentSessions'
              ? 1
              : undefined;
        this.stdout.write(
          JSON.stringify({ type: 'response', id: request.id, result }) + '\n',
        );
        callback();
      },
    });
  }

  kill(): void {
    if (this.ended) return;
    this.ended = true;
    this.emit('exit', null, null);
  }
}

describe('RemoteAgentHostClient', () => {
  it('uploads and talks to the same target-owned Agent host used by mobile', async () => {
    const writes: Array<{ filePath: string; bytes: number }> = [];
    const specs: NodeHostProcessSpec[] = [];
    const process = new FakeAgentProcess();
    const transport = {
      fsRealpath: async () => '/home/researcher',
      writeFile: async (filePath: string, data: Uint8Array) => {
        writes.push({ filePath, bytes: data.byteLength });
      },
      spawnProcess: async (spec: NodeHostProcessSpec) => {
        specs.push(spec);
        process.stdout.write('{"type":"ready"}\n');
        return process as unknown as RemoteHostProcess;
      },
    };
    const profiles = new MemoryProfileStore([
      {
        id: 'profile-1',
        name: 'Research box',
        host: 'lab.example',
        port: 22,
        username: 'researcher',
        authMethod: 'password',
        hasPassword: true,
        credentialPersisted: false,
      },
    ]);
    const client = new RemoteAgentHostClient(
      transport,
      profiles,
      () => 'SHA256:trusted',
    );

    await client.connected('profile-1');
    await expect(
      client.list({ profileId: 'profile-1', archive: 'all' }),
    ).resolves.toEqual([SESSION]);
    await expect(client.importLegacy('profile-1', [{}])).resolves.toBe(1);

    expect(writes[0]?.filePath).toBe(
      '/home/researcher/.cozypad/remote-agent-host.cjs',
    );
    expect(writes[0]?.bytes).toBeGreaterThan(1000);
    expect(specs[0]).toMatchObject({
      command: 'node',
      cwd: '/home/researcher',
    });
    client.disconnected('profile-1');
    await expect(
      client.list({ profileId: 'profile-1', archive: 'all' }),
    ).resolves.toEqual([]);
  });

  it('queues renderer requests until the target host is ready', async () => {
    let finishUpload!: () => void;
    const uploadGate = new Promise<void>((resolve) => {
      finishUpload = resolve;
    });
    const process = new FakeAgentProcess();
    const transport = {
      fsRealpath: async () => '/home/researcher',
      writeFile: async () => uploadGate,
      spawnProcess: async () => {
        process.stdout.write('{"type":"ready"}\n');
        return process as unknown as RemoteHostProcess;
      },
    };
    const profiles = new MemoryProfileStore([
      {
        id: 'profile-1',
        name: 'Research box',
        host: 'lab.example',
        port: 22,
        username: 'researcher',
        authMethod: 'password',
        hasPassword: true,
        credentialPersisted: false,
      },
    ]);
    const client = new RemoteAgentHostClient(
      transport,
      profiles,
      () => 'SHA256:trusted',
    );

    const connecting = client.connected('profile-1');
    const listing = client.list({ profileId: 'profile-1', archive: 'all' });
    finishUpload();

    await expect(connecting).resolves.toBeUndefined();
    await expect(listing).resolves.toEqual([SESSION]);
    client.disconnected('profile-1');
  });

  it('removes cached sessions that another client deleted', async () => {
    let hostSessions = [SESSION];
    const process = new FakeAgentProcess(() => hostSessions);
    const transport = {
      fsRealpath: async () => '/home/researcher',
      writeFile: async () => undefined,
      spawnProcess: async () => {
        process.stdout.write('{"type":"ready"}\n');
        return process as unknown as RemoteHostProcess;
      },
    };
    const profiles = new MemoryProfileStore([
      {
        id: 'profile-1',
        name: 'Research box',
        host: 'lab.example',
        port: 22,
        username: 'researcher',
        authMethod: 'password',
        hasPassword: true,
        credentialPersisted: false,
      },
    ]);
    const client = new RemoteAgentHostClient(
      transport,
      profiles,
      () => 'SHA256:trusted',
    );

    await client.connected('profile-1');
    await expect(
      client.list({ profileId: 'profile-1', archive: 'all' }),
    ).resolves.toEqual([SESSION]);
    hostSessions = [];
    await expect(
      client.list({ profileId: 'profile-1', archive: 'all' }),
    ).resolves.toEqual([]);
    client.disconnected('profile-1');
  });
});

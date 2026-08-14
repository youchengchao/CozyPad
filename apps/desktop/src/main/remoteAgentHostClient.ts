import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type {
  AgentAttachment,
  AgentCommunicationErrorEvent,
  AgentDetectionRequest,
  AgentInstallation,
  AgentSessionBundle,
  AgentSessionChangedEvent,
  AgentSessionDeletedEvent,
  AgentSessionListRequest,
  AgentSessionRequest,
  AgentTimelineChangedEvent,
  AnswerAgentQuestionRequest,
  ArchiveAgentSessionRequest,
  CreateAgentSessionRequest,
  DeclineAgentQuestionRequest,
  DeleteAgentSessionResult,
  RenameAgentSessionRequest,
  ResolveAgentApprovalRequest,
  SendAgentMessageRequest,
  SetAgentSessionConfigOptionRequest,
  UploadAgentAttachmentsRequest,
} from '@cozypad/contracts';
import type {
  AgentCommunicationEvents,
  AgentCommunicationPort,
} from './agentCommunicationService';
import type { ProfileStorePort } from './profileStore';
import type { NodeHostProcessSpec } from './transport/nodeHostRuntime';
import type { RemoteHostProcess } from './transport/remoteNodeHost';

interface RemoteAgentTransport {
  fsRealpath(inputPath: string): Promise<string>;
  writeFile(filePath: string, data: Uint8Array): Promise<void>;
  spawnProcess(spec: NodeHostProcessSpec): Promise<RemoteHostProcess>;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface RpcMessage {
  type?: unknown;
  id?: unknown;
  result?: unknown;
  error?: unknown;
  event?: unknown;
  payload?: unknown;
}

const EMPTY_EVENTS: AgentCommunicationEvents = {
  onSessionChanged: () => undefined,
  onSessionDeleted: () => undefined,
  onTimelineChanged: () => undefined,
  onError: () => undefined,
};

async function readRemoteAgentHostBundle(): Promise<Buffer> {
  const bundledPath = path.join(__dirname, 'remote-agent-host.cjs');
  try {
    return await readFile(bundledPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // Vitest executes this source module in place; production executes the
    // bundled main beside the host artifact.
    return readFile(path.resolve(__dirname, '../../dist/remote-agent-host.cjs'));
  }
}

/** Thin desktop client for the same target-owned Agent host used by mobile. */
export class RemoteAgentHostClient implements AgentCommunicationPort {
  private events = EMPTY_EVENTS;
  private process: RemoteHostProcess | null = null;
  private activeProfileId: string | null = null;
  private connectingProfileId: string | null = null;
  private connecting: Promise<void> | null = null;
  private connectionGeneration = 0;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly cache = new Map<string, AgentSessionBundle>();
  private cacheProfileId: string | null = null;
  private readonly decoder = new StringDecoder('utf8');
  private pendingText = '';
  private stderrText = '';
  private readyWaiter: (() => void) | null = null;

  constructor(
    private readonly transport: RemoteAgentTransport,
    private readonly profileStore: ProfileStorePort,
    private readonly getHostFingerprint: (profileId: string) => string | undefined,
  ) {}

  setEvents(events: AgentCommunicationEvents): void {
    this.events = events;
  }

  load(): Promise<void> {
    return Promise.resolve();
  }

  connected(profileId: string): Promise<void> {
    if (this.connecting !== null && this.connectingProfileId === profileId) {
      return this.connecting;
    }
    if (this.process !== null && this.activeProfileId === profileId) {
      return Promise.resolve();
    }
    const previous = this.connecting;
    const generation = ++this.connectionGeneration;
    const pending = (async () => {
      // A profile switch can arrive while the previous upload/spawn is still
      // running. Let that attempt observe its cancellation before creating the
      // next host, otherwise the slower attempt could win and own the bridge.
      if (previous !== null) await previous.catch(() => undefined);
      this.assertCurrentConnection(generation);
      await this.startConnection(profileId, generation);
    })();
    this.connecting = pending;
    this.connectingProfileId = profileId;
    const clearPending = () => {
      if (this.connecting === pending) {
        this.connecting = null;
        this.connectingProfileId = null;
      }
    };
    void pending.then(clearPending, clearPending);
    return pending;
  }

  private assertCurrentConnection(generation: number): void {
    if (generation !== this.connectionGeneration) {
      throw new Error('Remote Agent host connection was superseded');
    }
  }

  private async startConnection(
    profileId: string,
    generation: number,
  ): Promise<void> {
    if (this.process !== null) {
      const previousProcess = this.process;
      this.process = null;
      this.activeProfileId = null;
      this.clearSessionCache();
      previousProcess.kill();
      this.close(new Error('Remote Agent host profile changed'));
    }
    this.assertCurrentConnection(generation);
    const profile = this.profileStore.get(profileId);
    if (profile === undefined) throw new Error(`unknown profile: ${profileId}`);
    const fingerprint = this.getHostFingerprint(profileId);
    if (fingerprint === undefined) {
      throw new Error('Cannot start the Agent host before the SSH host key is trusted');
    }
    const home = await this.transport.fsRealpath('~');
    this.assertCurrentConnection(generation);
    const remoteEntry = `${home.replace(/\/+$/u, '')}/.cozypad/remote-agent-host.cjs`;
    const bundle = await readRemoteAgentHostBundle();
    this.assertCurrentConnection(generation);
    await this.transport.writeFile(
      remoteEntry,
      bundle,
    );
    this.assertCurrentConnection(generation);
    const config = Buffer.from(
      JSON.stringify({
        profileId,
        name: profile.name,
        host: profile.host,
        port: profile.port,
        username: profile.username,
        fingerprint,
      }),
      'utf8',
    ).toString('base64');
    const process = await this.transport.spawnProcess({
      command: 'node',
      args: [remoteEntry, config],
      cwd: home,
      env: { NO_COLOR: '1' },
    });
    if (generation !== this.connectionGeneration) {
      process.kill();
      throw new Error('Remote Agent host connection was superseded');
    }
    this.process = process;
    this.activeProfileId = profileId;
    this.pendingText = '';
    this.stderrText = '';

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          this.readyWaiter = null;
          process.kill();
          reject(new Error('Remote Agent host did not become ready'));
        }, 15_000);
        this.readyWaiter = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.readyWaiter = null;
          resolve();
        };
        process.stdout?.on('data', (chunk) => {
          this.receiveData(Buffer.from(chunk));
        });
        process.stderr?.on('data', (chunk) => {
          this.stderrText = (
            this.stderrText + Buffer.from(chunk).toString('utf8')
          ).slice(-4_000);
        });
        process.on('error', (error: Error) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            this.readyWaiter = null;
            reject(error);
          }
        });
        process.on('exit', () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            this.readyWaiter = null;
            reject(
              new Error(
                this.stderrText.trim() || 'Remote Agent host exited before ready',
              ),
            );
          }
          if (this.process === process) {
            this.process = null;
            this.activeProfileId = null;
            this.clearSessionCache();
          }
          this.close(new Error('Remote Agent host bridge closed'));
        });
      });
    } catch (error) {
      if (this.process === process) {
        this.process = null;
        this.activeProfileId = null;
        this.clearSessionCache();
      }
      process.kill();
      this.close(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  disconnected(profileId: string): void {
    const active = this.activeProfileId === profileId;
    const connecting = this.connectingProfileId === profileId;
    if (!active && !connecting) return;
    this.connectionGeneration += 1;
    const process = this.process;
    this.process = null;
    this.activeProfileId = null;
    this.clearSessionCache();
    process?.kill();
    this.close(new Error('Remote Agent host is disconnected'));
  }

  detect(request: AgentDetectionRequest): Promise<AgentInstallation> {
    return this.request('detectAgent', request);
  }

  async list(request: AgentSessionListRequest): Promise<AgentSessionBundle[]> {
    if (this.connecting !== null) await this.connecting;
    if (
      this.process === null ||
      this.activeProfileId !== request.profileId
    ) {
      return [];
    }
    if (this.cacheProfileId !== request.profileId) {
      this.cache.clear();
      this.cacheProfileId = request.profileId;
    }
    if (this.process !== null) {
      const bundles = await this.request<AgentSessionBundle[]>(
        'listAgentSessions',
        request,
      );
      if (request.archive === 'all' && request.projectId === undefined) {
        const listed = new Set(bundles.map((bundle) => bundle.session.id));
        for (const sessionId of this.cache.keys()) {
          if (!listed.has(sessionId)) this.cache.delete(sessionId);
        }
      }
      for (const bundle of bundles) this.cache.set(bundle.session.id, bundle);
    }
    const archive = request.archive ?? 'active';
    return [...this.cache.values()]
      .filter((bundle) =>
        request.projectId === undefined
          ? true
          : (bundle.session.projectId ?? bundle.session.cwd) === request.projectId,
      )
      .filter((bundle) => {
        if (archive === 'all') return true;
        const archived = bundle.session.archivedAt != null;
        return archive === 'archived' ? archived : !archived;
      })
      .sort((a, b) => b.session.updatedAt.localeCompare(a.session.updatedAt));
  }

  private clearSessionCache(): void {
    this.cache.clear();
    this.cacheProfileId = null;
  }

  create(request: CreateAgentSessionRequest): Promise<AgentSessionBundle> {
    return this.request('createAgentSession', request);
  }

  revive(request: AgentSessionRequest): Promise<AgentSessionBundle> {
    return this.request('reviveAgentSession', request);
  }

  archive(request: ArchiveAgentSessionRequest): Promise<AgentSessionBundle> {
    return this.request('archiveAgentSession', request);
  }

  restore(request: AgentSessionRequest): Promise<AgentSessionBundle> {
    return this.request('restoreAgentSession', request);
  }

  rename(request: RenameAgentSessionRequest): Promise<void> {
    return this.request('renameAgentSession', request);
  }

  delete(request: AgentSessionRequest): Promise<DeleteAgentSessionResult> {
    return this.request('deleteAgentSession', request);
  }

  uploadAttachments(
    request: UploadAgentAttachmentsRequest,
  ): Promise<AgentAttachment[]> {
    return this.request('uploadAgentAttachments', request);
  }

  send(request: SendAgentMessageRequest): Promise<void> {
    return this.request('sendAgentMessage', request);
  }

  interrupt(request: AgentSessionRequest): Promise<void> {
    return this.request('interruptAgentSession', request);
  }

  setConfigOption(request: SetAgentSessionConfigOptionRequest): Promise<void> {
    return this.request('setAgentSessionConfigOption', request);
  }

  resolveApproval(request: ResolveAgentApprovalRequest): Promise<void> {
    return this.request('resolveAgentApproval', request);
  }

  answerQuestion(request: AnswerAgentQuestionRequest): Promise<void> {
    return this.request('answerAgentQuestion', request);
  }

  declineQuestion(request: DeclineAgentQuestionRequest): Promise<void> {
    return this.request('declineAgentQuestion', request);
  }

  importLegacy(profileId: string, sessions: readonly unknown[]): Promise<number> {
    return this.request('importAgentSessions', { profileId, sessions });
  }

  private async request<T>(method: string, params: unknown): Promise<T> {
    if (this.connecting !== null) await this.connecting;
    const process = this.process;
    if (process === null || process.stdin === null) {
      return Promise.reject(new Error('Remote Agent host is not connected'));
    }
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      process.stdin!.write(
        Buffer.from(JSON.stringify({ type: 'request', id, method, params }) + '\n'),
        (error) => {
          if (error === undefined || error === null) return;
          this.pending.delete(id);
          reject(error);
        },
      );
    });
  }

  private receiveData(chunk: Uint8Array): void {
    this.pendingText += this.decoder.write(Buffer.from(chunk));
    const lines = this.pendingText.split('\n');
    this.pendingText = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim() === '') continue;
      if (line.trim() === '{"type":"ready"}') {
        this.readyWaiter?.();
        continue;
      }
      this.receiveLine(line);
    }
  }

  private receiveLine(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      this.events.onError({ message: 'Remote Agent host returned invalid JSON' });
      return;
    }
    if (message.type === 'response' && typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      if (typeof message.error === 'string') pending.reject(new Error(message.error));
      else pending.resolve(message.result);
      return;
    }
    if (message.type !== 'event' || typeof message.event !== 'string') return;
    switch (message.event) {
      case 'agentSessionChanged': {
        const event = message.payload as AgentSessionChangedEvent;
        this.ensureEventCacheProfile();
        const prior = this.cache.get(event.session.id);
        this.cache.set(event.session.id, {
          session: event.session,
          items: prior?.items ?? [],
        });
        this.events.onSessionChanged(event);
        break;
      }
      case 'agentSessionDeleted': {
        const event = message.payload as AgentSessionDeletedEvent;
        this.ensureEventCacheProfile();
        this.cache.delete(event.sessionId);
        this.events.onSessionDeleted(event);
        break;
      }
      case 'agentTimelineChanged': {
        const event = message.payload as AgentTimelineChangedEvent;
        this.ensureEventCacheProfile();
        const prior = this.cache.get(event.sessionId);
        if (prior !== undefined) {
          this.cache.set(event.sessionId, { ...prior, items: event.items });
        }
        this.events.onTimelineChanged(event);
        break;
      }
      case 'agentCommunicationError':
        this.events.onError(message.payload as AgentCommunicationErrorEvent);
        break;
    }
  }

  private close(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private ensureEventCacheProfile(): void {
    if (
      this.activeProfileId !== null &&
      this.cacheProfileId !== this.activeProfileId
    ) {
      this.cache.clear();
      this.cacheProfileId = this.activeProfileId;
    }
  }
}

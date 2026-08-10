import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { serveAgyOverStdio } from '@cozypad/adapter-agy';
import { connectAcpAgentProcess, type AcpClientHandlers } from '@cozypad/acp-client';
import type { ConnectionProfile } from '@cozypad/contracts';
import { TmuxRuntime } from '@cozypad/tmux-runtime';
import {
  AgentCommunicationService,
  type AgentCommunicationPort,
} from '../main/agentCommunicationService';
import { AcpAgentRuntime } from '../main/acp/acpAgentRuntime';
import type { AcpChild, AcpLaunchSpec } from '../main/acp/acpProcess';
import type { ProfileStorePort } from '../main/profileStore';
import { LocalTransport } from '../main/transport/localTransport';
import {
  NodeHostRuntime,
  type NodeHostProcessSpec,
} from '../main/transport/nodeHostRuntime';

if (process.argv[2] === '--agy-adapter') {
  serveAgyOverStdio();
  process.stdin.resume();
} else {
  void startAgentHost();
}

interface HostConfig {
  profileId: string;
  name: string;
  host: string;
  port: number;
  username: string;
  fingerprint: string;
}

interface RpcRequest {
  type: 'request';
  id: number;
  method: string;
  params: unknown;
}

type AgentMethod =
  | 'detectAgent'
  | 'listAgentSessions'
  | 'createAgentSession'
  | 'reviveAgentSession'
  | 'renameAgentSession'
  | 'deleteAgentSession'
  | 'uploadAgentAttachments'
  | 'sendAgentMessage'
  | 'interruptAgentSession'
  | 'setAgentSessionConfigOption'
  | 'resolveAgentApproval'
  | 'answerAgentQuestion'
  | 'declineAgentQuestion';

const hostRuntime = new NodeHostRuntime();

function send(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + '\n');
}

function readConfig(): HostConfig {
  const encoded = process.argv[2];
  if (encoded === undefined || encoded === '') {
    throw new Error('Agent host config is missing');
  }
  const parsed = JSON.parse(
    Buffer.from(encoded, 'base64').toString('utf8'),
  ) as Partial<HostConfig>;
  if (
    typeof parsed.profileId !== 'string' ||
    parsed.profileId === '' ||
    typeof parsed.host !== 'string' ||
    parsed.host === '' ||
    typeof parsed.username !== 'string' ||
    parsed.username === '' ||
    typeof parsed.port !== 'number' ||
    !Number.isInteger(parsed.port) ||
    typeof parsed.fingerprint !== 'string' ||
    parsed.fingerprint === ''
  ) {
    throw new Error('Agent host config is invalid');
  }
  return {
    profileId: parsed.profileId,
    name:
      typeof parsed.name === 'string' && parsed.name !== ''
        ? parsed.name
        : parsed.host,
    host: parsed.host,
    port: parsed.port,
    username: parsed.username,
    fingerprint: parsed.fingerprint,
  };
}

function profileStoreFor(config: HostConfig): ProfileStorePort {
  const profile: ConnectionProfile = {
    id: config.profileId,
    name: config.name,
    host: config.host,
    port: config.port,
    username: config.username,
    authMethod: 'password',
    hasPassword: false,
    hasPrivateKey: false,
    credentialPersisted: false,
  };
  return {
    list: () => [profile],
    get: (profileId) => (profileId === profile.id ? profile : undefined),
    save: () => Promise.reject(new Error('Profiles are owned by the mobile client')),
    remove: () =>
      Promise.reject(new Error('Profiles are owned by the mobile client')),
    getCredential: () => null,
  };
}

function launchSpecForHost(agentKind: string, cwd: string): AcpLaunchSpec {
  switch (agentKind) {
    case 'claude':
      return { label: 'claude-agent-acp', command: 'npx', args: [], cwd };
    case 'codex':
      return { label: 'codex-acp', command: 'npx', args: [], cwd };
    default:
      return { label: 'adapter-agy', command: process.execPath, args: [], cwd };
  }
}

function hostProcessSpec(spec: AcpLaunchSpec): NodeHostProcessSpec {
  const env = Object.fromEntries(
    Object.entries(spec.env ?? {}).filter(
      ([name]) => name !== 'ELECTRON_RUN_AS_NODE',
    ),
  );
  const common = { cwd: spec.cwd, env: { ...env, NO_COLOR: '1' } };
  switch (spec.label) {
    case 'claude-agent-acp':
      return {
        ...common,
        command: 'npx',
        args: ['-y', '@zed-industries/claude-agent-acp@0.23.1'],
      };
    case 'codex-acp':
      return {
        ...common,
        command: 'npx',
        args: ['-y', '@agentclientprotocol/codex-acp@1.1.14'],
      };
    case 'adapter-agy':
      return {
        ...common,
        command: process.execPath,
        args: [__filename, '--agy-adapter'],
      };
    default:
      throw new Error('Unsupported remote ACP agent: ' + spec.label);
  }
}

async function spawnHostAgent(
  spec: AcpLaunchSpec,
  handlers: AcpClientHandlers,
): Promise<AcpChild> {
  const child = hostRuntime.spawnProcess(hostProcessSpec(spec));
  const handle = connectAcpAgentProcess({ child, label: spec.label, handlers });
  let killed = false;
  return {
    handle,
    kill: () => {
      if (killed) return;
      killed = true;
      child.kill();
    },
    onExit: (listener) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        queueMicrotask(() =>
          listener({
            code: child.exitCode,
            signal:
              child.signalCode === null ? null : String(child.signalCode),
          }),
        );
        return;
      }
      child.on('exit', (code, signal) =>
        listener({
          code,
          signal: signal === null ? null : String(signal),
        }),
      );
    },
  };
}

async function dispatch(
  service: AgentCommunicationPort,
  method: AgentMethod,
  params: any,
): Promise<unknown> {
  switch (method) {
    case 'detectAgent':
      return service.detect(params);
    case 'listAgentSessions':
      return service.list(params);
    case 'createAgentSession':
      return service.create(params);
    case 'reviveAgentSession':
      return service.revive(params);
    case 'renameAgentSession':
      return service.rename(params);
    case 'deleteAgentSession':
      return service.delete(params);
    case 'uploadAgentAttachments':
      return service.uploadAttachments(params);
    case 'sendAgentMessage':
      return service.send(params);
    case 'interruptAgentSession':
      return service.interrupt(params);
    case 'setAgentSessionConfigOption':
      return service.setConfigOption(params);
    case 'resolveAgentApproval':
      return service.resolveApproval(params);
    case 'answerAgentQuestion':
      return service.answerQuestion(params);
    case 'declineAgentQuestion':
      return service.declineQuestion(params);
    default:
      throw new Error('Unknown Agent method: ' + String(method));
  }
}

async function startAgentHost(): Promise<void> {
  try {
    const config = readConfig();
    const transport = new LocalTransport();
    await transport.connect(config.profileId);
    const tmux = new TmuxRuntime(
      (command, timeoutMs) => transport.exec(command, timeoutMs),
      'cozypad',
    );
    let service!: AgentCommunicationService;
    const acp = new AcpAgentRuntime(
      {
        onTimeline: (sessionId, items) =>
          service.replaceTimeline(sessionId, items),
        onPermission: () => new Promise<string | null>(() => undefined),
        onCommands: (sessionId, commands) =>
          service.setSlashCommands(sessionId, commands),
        onPromptMeta: (sessionId, meta) =>
          service.notePromptMeta(sessionId, meta),
        onExit: (sessionId, detail) =>
          service.noteAgentExit(sessionId, detail),
        onError: (sessionId, message) =>
          send({
            type: 'event',
            event: 'agentCommunicationError',
            payload: { sessionId, message },
          }),
      },
      undefined,
      spawnHostAgent,
      launchSpecForHost,
    );
    service = new AgentCommunicationService({
      transport,
      tmux,
      profileStore: profileStoreFor(config),
      storePath: path.join(os.homedir(), '.cozypad', 'agent-sessions.json'),
      acp,
      getHostFingerprint: () => config.fingerprint,
      isLocalHost: () => false,
    });
    service.setEvents({
      onSessionChanged: (payload) =>
        send({ type: 'event', event: 'agentSessionChanged', payload }),
      onSessionDeleted: (payload) =>
        send({ type: 'event', event: 'agentSessionDeleted', payload }),
      onTimelineChanged: (payload) =>
        send({ type: 'event', event: 'agentTimelineChanged', payload }),
      onError: (payload) =>
        send({ type: 'event', event: 'agentCommunicationError', payload }),
    });
    await service.load();
    await service.connected(config.profileId);

    const input = readline.createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
    });
    input.on('line', (line) => {
      if (line.trim() === '') return;
      void (async () => {
        let requestId = -1;
        try {
          const request = JSON.parse(line) as RpcRequest;
          requestId = request.id;
          if (
            request.type !== 'request' ||
            typeof request.id !== 'number' ||
            typeof request.method !== 'string'
          ) {
            throw new Error('Invalid Agent request');
          }
          const result = await dispatch(
            service,
            request.method as AgentMethod,
            request.params,
          );
          send({ type: 'response', id: request.id, result });
        } catch (error) {
          send({
            type: 'response',
            id: requestId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    });
    input.on('close', () => {
      acp.stopAll();
      hostRuntime.stopExecs();
      process.exitCode = 0;
    });
    send({ type: 'ready' });
  } catch (error) {
    process.stderr.write(
      (error instanceof Error ? error.stack ?? error.message : String(error)) +
        '\n',
    );
    process.exitCode = 1;
  }
}

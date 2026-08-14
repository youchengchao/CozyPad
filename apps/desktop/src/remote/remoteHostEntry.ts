import type { ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import {
  NodeHostRuntime,
  type NodeHostProcessSpec,
} from '../main/transport/nodeHostRuntime';
import type {
  HostRpcProcessEvent,
  HostRpcRequest,
  HostRpcResponse,
} from '../main/transport/remoteHostProtocol';

const host = new NodeHostRuntime();
const controllers = new Map<number, AbortController>();
const processes = new Map<string, ChildProcess>();

function send(
  message: HostRpcResponse | HostRpcProcessEvent | {
    type: 'event';
    requestId: number;
    event: 'line';
    line: string;
  },
): void {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function stringParam(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== 'string') throw new Error('Invalid parameter: ' + name);
  return value;
}

function numberParam(params: Record<string, unknown>, name: string): number {
  const value = params[name];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('Invalid parameter: ' + name);
  }
  return value;
}

function processFor(processId: string): ChildProcess {
  const child = processes.get(processId);
  if (child === undefined) throw new Error('Unknown remote process: ' + processId);
  return child;
}

function processEvent(
  processId: string,
  event: HostRpcProcessEvent['event'],
  detail: Omit<HostRpcProcessEvent, 'type' | 'processId' | 'event'> = {},
): void {
  send({ type: 'process', processId, event, ...detail });
}

async function spawnProcess(
  processId: string,
  spec: NodeHostProcessSpec,
): Promise<void> {
  if (
    typeof spec !== 'object' ||
    spec === null ||
    typeof spec.command !== 'string' ||
    !Array.isArray(spec.args) ||
    typeof spec.cwd !== 'string'
  ) {
    throw new Error('Invalid process specification');
  }

  const child = host.spawnProcess(spec);
  processes.set(processId, child);
  child.stdout?.on('data', (chunk: Buffer) => {
    processEvent(processId, 'stdout', { data: chunk.toString('base64') });
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    processEvent(processId, 'stderr', { data: chunk.toString('base64') });
  });
  child.once('exit', (code, signal) => {
    processes.delete(processId);
    processEvent(processId, 'exit', {
      code,
      signal: signal === null ? null : String(signal),
    });
  });

  let started = false;
  const reportLaterError = (error: Error) => {
    if (started) processEvent(processId, 'error', { error: error.message });
  };
  child.on('error', reportLaterError);
  await new Promise<void>((resolve, reject) => {
    const onSpawn = () => {
      started = true;
      child.off('error', onInitialError);
      resolve();
    };
    const onInitialError = (error: Error) => {
      child.off('spawn', onSpawn);
      processes.delete(processId);
      reject(error);
    };
    child.once('spawn', onSpawn);
    child.once('error', onInitialError);
  });
}

async function writeProcess(processId: string, data: string): Promise<void> {
  const child = processFor(processId);
  if (child.stdin === null) throw new Error('Remote process stdin is not available');
  await new Promise<void>((resolve, reject) => {
    child.stdin!.write(Buffer.from(data, 'base64'), (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function execute(request: HostRpcRequest): Promise<unknown> {
  const params = request.params;
  switch (request.method) {
    case 'ping':
      return undefined;
    case 'cancel':
      controllers.get(numberParam(params, 'requestId'))?.abort();
      return undefined;
    case 'execStream': {
      const controller = new AbortController();
      controllers.set(request.id, controller);
      try {
        return await host.execStream(
          stringParam(params, 'command'),
          (line) => send({
            type: 'event',
            requestId: request.id,
            event: 'line',
            line,
          }),
          numberParam(params, 'timeoutMs'),
          params.collectOutput === true,
          controller.signal,
        );
      } finally {
        controllers.delete(request.id);
      }
    }
    case 'writeFile':
      await host.writeFile(
        stringParam(params, 'filePath'),
        Buffer.from(stringParam(params, 'data'), 'base64'),
      );
      return undefined;
    case 'fsRealpath':
      return host.fsRealpath(stringParam(params, 'inputPath'));
    case 'fsList':
      return host.fsList(stringParam(params, 'dirPath'));
    case 'fsReadText':
      return host.fsReadText(
        stringParam(params, 'filePath'),
        numberParam(params, 'maxBytes'),
        numberParam(params, 'offset'),
      );
    case 'fsReadBytes':
      return host.fsReadBytes(
        stringParam(params, 'filePath'),
        numberParam(params, 'maxBytes'),
      );
    case 'fsWrite':
      await host.fsWrite(
        stringParam(params, 'filePath'),
        Buffer.from(stringParam(params, 'data'), 'base64'),
      );
      return undefined;
    case 'fsCreate':
      await host.fsCreate(
        stringParam(params, 'directory'),
        stringParam(params, 'name'),
        stringParam(params, 'kind') as 'file' | 'directory',
      );
      return undefined;
    case 'fsRename':
      await host.fsRename(
        stringParam(params, 'filePath'),
        stringParam(params, 'newName'),
      );
      return undefined;
    case 'fsDuplicate':
      return host.fsDuplicate(stringParam(params, 'filePath'));
    case 'fsCopyTo':
      return host.fsCopyTo(
        stringParam(params, 'sourcePath'),
        stringParam(params, 'destinationDirectory'),
      );
    case 'fsMoveTo':
      return host.fsMoveTo(
        stringParam(params, 'sourcePath'),
        stringParam(params, 'destinationDirectory'),
      );
    case 'fsRemove':
      await host.fsRemove(stringParam(params, 'filePath'));
      return undefined;
    case 'spawnProcess':
      await spawnProcess(
        stringParam(params, 'processId'),
        params.spec as NodeHostProcessSpec,
      );
      return undefined;
    case 'processWrite':
      await writeProcess(
        stringParam(params, 'processId'),
        stringParam(params, 'data'),
      );
      return undefined;
    case 'processKill':
      processFor(stringParam(params, 'processId')).kill();
      return undefined;
    default:
      throw new Error('Unknown host method: ' + request.method);
  }
}

async function handleLine(line: string): Promise<void> {
  let request: HostRpcRequest;
  try {
    request = JSON.parse(line) as HostRpcRequest;
    if (
      request.type !== 'request' ||
      typeof request.id !== 'number' ||
      typeof request.method !== 'string' ||
      typeof request.params !== 'object' ||
      request.params === null
    ) {
      throw new Error('Invalid host request');
    }
  } catch (error) {
    process.stderr.write(
      (error instanceof Error ? error.message : String(error)) + '\n',
    );
    return;
  }

  try {
    const result = await execute(request);
    send({ type: 'response', id: request.id, result });
  } catch (error) {
    send({
      type: 'response',
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const input = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});
input.on('line', (line) => {
  if (line.trim() !== '') void handleLine(line);
});
input.on('close', () => {
  for (const controller of controllers.values()) controller.abort();
  for (const child of processes.values()) child.kill();
  host.stopExecs();
  process.exitCode = 0;
});

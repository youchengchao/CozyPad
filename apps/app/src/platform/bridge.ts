import type { PlatformBridge } from '@cozypad/contracts';
import { createCapacitorBridge, getCapacitorPlugins } from './capacitorBridge';

export class CozyPadIPCError extends Error {
  constructor(
    public readonly code: 'TIMEOUT' | 'DISCONNECTED' | 'BRIDGE_UNAVAILABLE' | 'IPC_FAILED',
    message: string,
    public readonly isRetryable: boolean = false,
  ) {
    super(message);
    this.name = 'CozyPadIPCError';
  }
}

const FAST_TIMEOUT_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const LONG_TIMEOUT_MS = 45_000;

/**
 * `sendAgentMessage` resolves when the agent's whole turn ends, and a turn is
 * allowed to take as long as it takes — racing it against a timer produced a
 * red "IPC Timeout" banner over every working multi-minute turn. Delivery
 * confirmation is the user message echoing back on the timeline, not this
 * call resolving.
 */
const UNBOUNDED_METHODS = new Set(['sendAgentMessage']);

function getTimeoutForMethod(methodName: string): number {
  if (['fsList', 'listProfiles', 'readClipboard'].includes(methodName)) {
    return FAST_TIMEOUT_MS;
  }
  if (
    ['detectAgent', 'uploadAgentAttachments', 'reviveAgentSession'].includes(
      methodName,
    )
  ) {
    return LONG_TIMEOUT_MS;
  }
  return DEFAULT_TIMEOUT_MS;
}

function wrapResilientBridge(rawBridge: PlatformBridge): PlatformBridge {
  if ((rawBridge as unknown as Record<string, unknown>).__resilientWrapped) {
    return rawBridge;
  }
  try {
    Object.defineProperty(rawBridge, '__resilientWrapped', {
      value: true,
      writable: false,
      enumerable: false,
      configurable: true,
    });
  } catch {
    /* ignore if frozen */
  }

  const keys = new Set<string>();
  for (const k in rawBridge) {
    keys.add(k);
  }
  Object.getOwnPropertyNames(rawBridge).forEach((k) => keys.add(k));

  for (const propName of keys) {
    if (propName.startsWith('on') || propName === '__resilientWrapped') continue;
    try {
      const original = (rawBridge as unknown as Record<string, unknown>)[propName];
      if (typeof original !== 'function') continue;

      (rawBridge as unknown as Record<string, unknown>)[propName] = (...args: unknown[]) => {
        try {
          let requestId: string | undefined;
          if (
            args.length > 0 &&
            args[0] !== null &&
            typeof args[0] === 'object' &&
            !Array.isArray(args[0])
          ) {
            requestId = Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
            args[0] = { ...(args[0] as Record<string, unknown>), requestId };
          }
          const result = (original as Function).apply(rawBridge, args);
          if (
            result !== null &&
            (typeof result === 'object' || typeof result === 'function') &&
            typeof (result as Promise<unknown>).then === 'function'
          ) {
            if (UNBOUNDED_METHODS.has(propName)) {
              return (result as Promise<unknown>).catch((err: unknown) => {
                if (err instanceof CozyPadIPCError) throw err;
                const msg = err instanceof Error ? err.message : String(err);
                throw new CozyPadIPCError('IPC_FAILED', msg, false);
              });
            }
            const timeoutMs = getTimeoutForMethod(propName);
            let timer: ReturnType<typeof setTimeout>;
            const timeoutPromise = new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                if (requestId) {
                  rawBridge.cancelRequest(requestId).catch(() => undefined);
                }
                reject(
                  new CozyPadIPCError(
                    'TIMEOUT',
                    `IPC Timeout (${Math.round(timeoutMs / 1000)}s): ${propName} call timed out`,
                    true,
                  ),
                );
              }, timeoutMs);
            });
            return Promise.race([result, timeoutPromise])
              .catch((err: unknown) => {
                if (err instanceof CozyPadIPCError) {
                  throw err;
                }
                const msg = err instanceof Error ? err.message : String(err);
                throw new CozyPadIPCError('IPC_FAILED', msg, false);
              })
              .finally(() => {
                clearTimeout(timer);
              });
          }
          return result;
        } catch (err: unknown) {
          if (err instanceof CozyPadIPCError) {
            throw err;
          }
          const msg = err instanceof Error ? err.message : String(err);
          throw new CozyPadIPCError('IPC_FAILED', msg, false);
        }
      };
    } catch {
      /* ignore non-configurable properties */
    }
  }

  return rawBridge;
}

let cached: PlatformBridge | null = null;

export function clearBridgeCache(): void {
  cached = null;
}

export function getBridge(): PlatformBridge {
  if (typeof window === 'undefined') {
    cached = null;
  } else if (cached !== null) {
    return cached;
  }

  let rawBridge: PlatformBridge | null = null;
  if (typeof window !== 'undefined' && window.cozypad !== undefined) {
    rawBridge = window.cozypad;
  } else {
    const plugins = getCapacitorPlugins();
    if (plugins !== null) {
      rawBridge = createCapacitorBridge(
        plugins.ssh,
        plugins.store,
        plugins.download,
      );
    }
  }

  if (rawBridge === null) {
    throw new CozyPadIPCError(
      'BRIDGE_UNAVAILABLE',
      'No platform bridge available: run CozyPad through Electron or the mobile shell.',
      false,
    );
  }

  cached = wrapResilientBridge(rawBridge);
  return cached;
}

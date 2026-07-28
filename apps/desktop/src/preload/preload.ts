import { contextBridge, ipcRenderer } from 'electron';
import {
  ConnectRequestSchema,
  ConnectionStateChangedSchema,
  IpcChannels,
  TerminalCloseRequestSchema,
  TerminalClosedEventSchema,
  TerminalInputSchema,
  TerminalOpenRequestSchema,
  TerminalOutputEventSchema,
  TerminalResizeRequestSchema,
} from '@cozypad/contracts';
import type { PlatformBridge, Unsubscribe } from '@cozypad/contracts';

interface ParsableSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

function subscribe<T>(
  channel: string,
  schema: ParsableSchema<T>,
  listener: (event: T) => void,
): Unsubscribe {
  const handler = (_event: unknown, payload: unknown): void => {
    const parsed = schema.safeParse(payload);
    if (parsed.success) listener(parsed.data);
  };
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

/** 唯一暴露給 renderer 的 API 面；窄、具名、雙向 Zod 驗證（SPEC_V3 4.1）。 */
const bridge: PlatformBridge = {
  kind: 'electron',

  listProfiles: () => ipcRenderer.invoke(IpcChannels.listProfiles),

  connect: (request) =>
    ipcRenderer.invoke(IpcChannels.connect, ConnectRequestSchema.parse(request)),

  disconnect: (request) =>
    ipcRenderer.invoke(IpcChannels.disconnect, ConnectRequestSchema.parse(request)),

  onConnectionState: (listener) =>
    subscribe(IpcChannels.connectionState, ConnectionStateChangedSchema, listener),

  openTerminal: (request) =>
    ipcRenderer.invoke(
      IpcChannels.terminalOpen,
      TerminalOpenRequestSchema.parse(request),
    ),

  writeTerminal: (input) => {
    ipcRenderer.send(IpcChannels.terminalWrite, TerminalInputSchema.parse(input));
  },

  resizeTerminal: (request) =>
    ipcRenderer.invoke(
      IpcChannels.terminalResize,
      TerminalResizeRequestSchema.parse(request),
    ),

  closeTerminal: (request) =>
    ipcRenderer.invoke(
      IpcChannels.terminalClose,
      TerminalCloseRequestSchema.parse(request),
    ),

  onTerminalOutput: (listener) =>
    subscribe(IpcChannels.terminalOutput, TerminalOutputEventSchema, listener),

  onTerminalClosed: (listener) =>
    subscribe(IpcChannels.terminalClosed, TerminalClosedEventSchema, listener),
};

contextBridge.exposeInMainWorld('cozypad', bridge);

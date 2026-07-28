import { ipcMain } from 'electron';
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import {
  ConnectRequestSchema,
  IpcChannels,
  TerminalCloseRequestSchema,
  TerminalInputSchema,
  TerminalOpenRequestSchema,
  TerminalResizeRequestSchema,
  base64ToBytes,
  bytesToBase64,
} from '@cozypad/contracts';
import type { TransportPort } from './transport/TransportPort';

/** 所有 IPC 進出都經 Zod 驗證，且只接受主視窗的 sender（SPEC_V3 4.1、13）。 */
export function registerIpc(transport: TransportPort, win: BrowserWindow): void {
  const send = (channel: string, payload: unknown): void => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  };

  transport.setEvents({
    onConnectionState: (event) => send(IpcChannels.connectionState, event),
    onTerminalOutput: (terminalId, data) =>
      send(IpcChannels.terminalOutput, {
        terminalId,
        dataBase64: bytesToBase64(data),
      }),
    onTerminalClosed: (terminalId, exitCode, reason) =>
      send(IpcChannels.terminalClosed, {
        terminalId,
        exitCode,
        ...(reason === undefined ? {} : { reason }),
      }),
  });

  const assertSender = (event: IpcMainInvokeEvent | IpcMainEvent): void => {
    if (event.sender !== win.webContents) throw new Error('unauthorized IPC sender');
  };

  ipcMain.handle(IpcChannels.listProfiles, (event) => {
    assertSender(event);
    return transport.listProfiles();
  });

  ipcMain.handle(IpcChannels.connect, (event, raw: unknown) => {
    assertSender(event);
    return transport.connect(ConnectRequestSchema.parse(raw).profileId);
  });

  ipcMain.handle(IpcChannels.disconnect, (event, raw: unknown) => {
    assertSender(event);
    return transport.disconnect(ConnectRequestSchema.parse(raw).profileId);
  });

  ipcMain.handle(IpcChannels.terminalOpen, async (event, raw: unknown) => {
    assertSender(event);
    const request = TerminalOpenRequestSchema.parse(raw);
    const terminalId = await transport.openTerminal(request);
    return { terminalId };
  });

  ipcMain.on(IpcChannels.terminalWrite, (event, raw: unknown) => {
    assertSender(event);
    const input = TerminalInputSchema.parse(raw);
    transport.writeTerminal(input.terminalId, base64ToBytes(input.dataBase64));
  });

  ipcMain.handle(IpcChannels.terminalResize, (event, raw: unknown) => {
    assertSender(event);
    const request = TerminalResizeRequestSchema.parse(raw);
    transport.resizeTerminal(request.terminalId, request.cols, request.rows);
  });

  ipcMain.handle(IpcChannels.terminalClose, (event, raw: unknown) => {
    assertSender(event);
    transport.closeTerminal(TerminalCloseRequestSchema.parse(raw).terminalId);
  });
}

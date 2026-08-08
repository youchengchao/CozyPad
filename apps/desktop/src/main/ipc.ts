import { clipboard, ipcMain, nativeImage } from 'electron';
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import {
  AgentDetectionRequestSchema,
  AgentAttachmentUploadSchema,
  AgentSessionListRequestSchema,
  AgentSessionRequestSchema,
  AgyTranscriptRequestSchema,
  AgentTerminalOpenRequestSchema,
  AnswerAgentQuestionRequestSchema,
  DeclineAgentQuestionRequestSchema,
  ConnectRequestSchema,
  ConnectionProfileDraftSchema,
  CreateAgentSessionRequestSchema,
  DeleteProfileRequestSchema,
  FsCreateRequestSchema,
  FsPathRequestSchema,
  FsReadRequestSchema,
  FsRenameRequestSchema,
  FsTransferRequestSchema,
  FsWriteRequestSchema,
  HostKeyDecisionSchema,
  IpcChannels,
  RemoteSettingsPatchSchema,
  RenameAgentSessionRequestSchema,
  ResolveAgentApprovalRequestSchema,
  SendAgentMessageRequestSchema,
  UploadAgentAttachmentsRequestSchema,
  TerminalCloseRequestSchema,
  TerminalInputSchema,
  TerminalOpenRequestSchema,
  TerminalResizeRequestSchema,
  base64ToBytes,
  bytesToBase64,
} from '@cozypad/contracts';
import type { AgentCommunicationPort } from './agentCommunicationService';
import type { RemoteFilesPort } from '@cozypad/remote-services';
import type { HostKeyGate } from './hostKeys';
import type { ProfileStorePort } from './profileStore';
import type { RemoteSettingsPort } from '@cozypad/remote-services';
import type { TmuxProvisionerPort } from '@cozypad/remote-services';
import type { TmuxSessionWatcher } from './tmuxWatcher';
import type { TelemetrySource } from '@cozypad/remote-services';
import type { TransportPort } from './transport/TransportPort';

export interface IpcServices {
  transport: TransportPort;
  profileStore: ProfileStorePort;
  files: RemoteFilesPort;
  telemetry: TelemetrySource;
  hostKeys: HostKeyGate | null;
  remoteSettings: RemoteSettingsPort;
  tmuxProvisioner: TmuxProvisionerPort;
  tmuxWatcher: TmuxSessionWatcher | null;
  agentCommunication: AgentCommunicationPort | null;
  /** 啟動時降級處理過的問題，交給 UI 顯示（見 main.ts startupWarnings）。 */
  startupWarnings?: string[];
  /** 本機連線不經 tmux：agent 直接以子行程執行，也就沒有東西要偵測或安裝。 */
  isLocalProfile?: (profileId: string) => boolean;
}

/** 所有 IPC 進出都經 Zod 驗證，且只接受主視窗的 sender（SPEC_V3 4.1、13）。 */
export function registerIpc(services: IpcServices, win: BrowserWindow): void {
  const {
    transport,
    profileStore,
    files,
    telemetry,
    hostKeys,
    remoteSettings,
    tmuxProvisioner,
    tmuxWatcher,
    agentCommunication,
    startupWarnings = [],
    isLocalProfile,
  } = services;
  let clipboardRestoreTimer: ReturnType<typeof setTimeout> | null = null;
  let clipboardBeforeImage:
    | {
        text: string;
        html: string;
        rtf: string;
        image: ReturnType<typeof clipboard.readImage>;
      }
    | null = null;

  const send = (channel: string, payload: unknown): void => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  };

  agentCommunication?.setEvents({
    onSessionChanged: (event) => send(IpcChannels.agentSessionChanged, event),
    onSessionDeleted: (event) => send(IpcChannels.agentSessionDeleted, event),
    onTimelineChanged: (event) => send(IpcChannels.agentTimelineChanged, event),
    onError: (event) => send(IpcChannels.agentCommunicationError, event),
  });

  /**
   * 終端機輸出合併：`cat` 大檔或編譯輸出時，PTY 會以極小的 chunk 高頻回傳，
   * 一個 chunk 一次 IPC 會把 renderer 淹掉。以 16ms（約一幀）為窗口合併。
   */
  const outputBuffers = new Map<string, Uint8Array[]>();
  const terminalOutputSequences = new Map<string, number>();
  const terminalReplayBuffers = new Map<
    string,
    { data: Uint8Array; throughSequence: number }
  >();
  const MAX_TERMINAL_REPLAY_BYTES = 512 * 1024;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const rememberTerminalOutput = (
    terminalId: string,
    data: Uint8Array,
    throughSequence: number,
  ): void => {
    const previous = terminalReplayBuffers.get(terminalId)?.data;
    if (data.length >= MAX_TERMINAL_REPLAY_BYTES) {
      terminalReplayBuffers.set(terminalId, {
        data: data.slice(data.length - MAX_TERMINAL_REPLAY_BYTES),
        throughSequence,
      });
      return;
    }

    const previousLength = Math.min(
      previous?.length ?? 0,
      MAX_TERMINAL_REPLAY_BYTES - data.length,
    );
    const combined = new Uint8Array(previousLength + data.length);
    if (previousLength > 0 && previous !== undefined) {
      combined.set(previous.subarray(previous.length - previousLength));
    }
    combined.set(data, previousLength);
    terminalReplayBuffers.set(terminalId, {
      data: combined,
      throughSequence,
    });
  };

  const flushTerminalOutput = (): void => {
    if (flushTimer !== null) clearTimeout(flushTimer);
    flushTimer = null;
    for (const [terminalId, chunks] of outputBuffers) {
      if (chunks.length === 0) continue;
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      const sequence = (terminalOutputSequences.get(terminalId) ?? 0) + 1;
      terminalOutputSequences.set(terminalId, sequence);
      rememberTerminalOutput(terminalId, merged, sequence);
      send(IpcChannels.terminalOutput, {
        terminalId,
        dataBase64: bytesToBase64(merged),
        sequence,
      });
    }
    outputBuffers.clear();
  };

  transport.setEvents({
    onConnectionState: (event) => {
      send(IpcChannels.connectionState, event);
      if (event.state === 'connected') {
        void agentCommunication?.connected(event.profileId);
        telemetry.start(event.profileId, (snapshot) =>
          send(IpcChannels.telemetryUpdated, snapshot),
        );
        if (isLocalProfile?.(event.profileId) === true) {
          // 本機沒有也不需要 tmux；偵測只會叫使用者在 Windows 上裝 Linux 套件。
          send(IpcChannels.tmuxSessionsChanged, []);
        } else {
          // 連線後立即偵測 tmux，缺少或版本過舊時由 UI 詢問安裝。
          void tmuxProvisioner
            .status()
            .then((status) => send(IpcChannels.tmuxStatusChanged, status))
            .catch(() => undefined);
          tmuxWatcher?.start({
            onSessions: (sessions) => send(IpcChannels.tmuxSessionsChanged, sessions),
          });
        }
      }
      if (event.state === 'disconnected' || event.state === 'error') {
        agentCommunication?.disconnected(event.profileId);
        telemetry.stop();
        tmuxWatcher?.stop();
        send(IpcChannels.tmuxSessionsChanged, []);
      }
    },
    onTerminalOutput: (terminalId, data) => {
      const chunks = outputBuffers.get(terminalId) ?? [];
      chunks.push(data);
      outputBuffers.set(terminalId, chunks);
      flushTimer ??= setTimeout(flushTerminalOutput, 16);
    },
    onTerminalClosed: (terminalId, exitCode, reason) => {
      flushTerminalOutput();
      send(IpcChannels.terminalClosed, {
        terminalId,
        exitCode,
        ...(reason === undefined ? {} : { reason }),
      });
      terminalOutputSequences.delete(terminalId);
      terminalReplayBuffers.delete(terminalId);
    },
  });

  const assertSender = (event: IpcMainInvokeEvent | IpcMainEvent): void => {
    if (event.sender !== win.webContents) throw new Error('unauthorized IPC sender');
  };

  const activeRequests = new Map<string, AbortController>();

  const runCancellable = async <T>(
    requestId: string | undefined,
    fn: (signal?: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    if (!requestId) return fn();
    const controller = new AbortController();
    activeRequests.set(requestId, controller);
    try {
      return await fn(controller.signal);
    } finally {
      activeRequests.delete(requestId);
    }
  };

  ipcMain.handle(IpcChannels.cancelRequest, (event, requestId: unknown) => {
    assertSender(event);
    if (typeof requestId === 'string') {
      const controller = activeRequests.get(requestId);
      if (controller) {
        controller.abort();
      }
    }
  });

  ipcMain.handle(IpcChannels.appInfo, (event) => {
    assertSender(event);
    return { startupWarnings: [...startupWarnings] };
  });

  ipcMain.handle(IpcChannels.listProfiles, (event) => {
    assertSender(event);
    return profileStore.list();
  });

  ipcMain.handle(IpcChannels.saveProfile, (event, raw: unknown) => {
    assertSender(event);
    return profileStore.save(ConnectionProfileDraftSchema.parse(raw));
  });

  ipcMain.handle(IpcChannels.deleteProfile, (event, raw: unknown) => {
    assertSender(event);
    return profileStore.remove(DeleteProfileRequestSchema.parse(raw).profileId);
  });

  ipcMain.handle(IpcChannels.connect, (event, raw: unknown) => {
    assertSender(event);
    const request = ConnectRequestSchema.parse(raw);
    return runCancellable(request.requestId, () => transport.connect(request.profileId));
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

  ipcMain.handle(IpcChannels.fsList, (event, raw: unknown) => {
    assertSender(event);
    const request = FsPathRequestSchema.parse(raw);
    return runCancellable(request.requestId, (signal) => files.list(request.path, signal));
  });

  ipcMain.handle(IpcChannels.fsRead, async (event, raw: unknown) => {
    assertSender(event);
    const request = FsReadRequestSchema.parse(raw);
    return runCancellable(request.requestId, async (signal) => {
      return { content: await files.readText(request.path, request.maxBytes, request.offset, signal) };
    });
  });

  ipcMain.handle(IpcChannels.fsReadBytes, async (event, raw: unknown) => {
    assertSender(event);
    const request = FsPathRequestSchema.parse(raw);
    return runCancellable(request.requestId, async (signal) => {
      return { dataBase64: await files.readBytes(request.path, undefined, signal) };
    });
  });

  ipcMain.handle(IpcChannels.fsWrite, (event, raw: unknown) => {
    assertSender(event);
    const request = FsWriteRequestSchema.parse(raw);
    return runCancellable(request.requestId, (signal) => files.write(request.path, request.contentBase64, undefined, signal));
  });

  ipcMain.handle(IpcChannels.fsCreate, (event, raw: unknown) => {
    assertSender(event);
    const request = FsCreateRequestSchema.parse(raw);
    return runCancellable(request.requestId, (signal) => files.create(request.directory, request.name, request.kind, signal));
  });

  ipcMain.handle(IpcChannels.fsRename, (event, raw: unknown) => {
    assertSender(event);
    const request = FsRenameRequestSchema.parse(raw);
    return runCancellable(request.requestId, (signal) => files.rename(request.path, request.newName, signal));
  });

  ipcMain.handle(IpcChannels.fsDuplicate, async (event, raw: unknown) => {
    assertSender(event);
    const request = FsPathRequestSchema.parse(raw);
    return runCancellable(request.requestId, async (signal) => {
      return { path: await files.duplicate(request.path, signal) };
    });
  });

  ipcMain.handle(IpcChannels.fsCopy, async (event, raw: unknown) => {
    assertSender(event);
    const request = FsTransferRequestSchema.parse(raw);
    return runCancellable(request.requestId, async (signal) => {
      return { path: await files.copyTo(request.sourcePath, request.destinationDirectory, signal) };
    });
  });

  ipcMain.handle(IpcChannels.fsMove, async (event, raw: unknown) => {
    assertSender(event);
    const request = FsTransferRequestSchema.parse(raw);
    return runCancellable(request.requestId, async (signal) => {
      return { path: await files.moveTo(request.sourcePath, request.destinationDirectory, signal) };
    });
  });

  ipcMain.handle(IpcChannels.fsDelete, (event, raw: unknown) => {
    assertSender(event);
    const request = FsPathRequestSchema.parse(raw);
    return runCancellable(request.requestId, (signal) => files.remove(request.path, signal));
  });

  ipcMain.handle(IpcChannels.remoteSettingsGet, (event) => {
    assertSender(event);
    return remoteSettings.get();
  });

  ipcMain.handle(IpcChannels.remoteSettingsSet, (event, raw: unknown) => {
    assertSender(event);
    return remoteSettings.set(RemoteSettingsPatchSchema.parse(raw));
  });

  ipcMain.handle(IpcChannels.clipboardRead, (event) => {
    assertSender(event);
    return clipboard.readText();
  });

  ipcMain.handle(IpcChannels.clipboardWrite, (event, raw: unknown) => {
    assertSender(event);
    if (typeof raw !== 'string') throw new Error('clipboard payload must be a string');
    clipboard.writeText(raw);
  });

  ipcMain.handle(IpcChannels.clipboardWriteImage, (event, raw: unknown) => {
    assertSender(event);
    const attachment = AgentAttachmentUploadSchema.parse(raw);
    if (!attachment.mediaType.toLowerCase().startsWith('image/')) {
      throw new Error('clipboard image payload must use an image media type');
    }
    const image = nativeImage.createFromBuffer(
      Buffer.from(base64ToBytes(attachment.dataBase64)),
    );
    if (image.isEmpty()) {
      throw new Error(`Unable to decode clipboard image: ${attachment.name}`);
    }
    clipboardBeforeImage ??= {
      text: clipboard.readText(),
      html: clipboard.readHTML(),
      rtf: clipboard.readRTF(),
      image: clipboard.readImage(),
    };
    clipboard.writeImage(image);
    if (clipboardRestoreTimer !== null) clearTimeout(clipboardRestoreTimer);
    clipboardRestoreTimer = setTimeout(() => {
      const snapshot = clipboardBeforeImage;
      clipboardBeforeImage = null;
      clipboardRestoreTimer = null;
      if (snapshot === null) return;
      clipboard.write(snapshot);
    }, 2_000);
  });

  ipcMain.handle(IpcChannels.tmuxStatus, (event) => {
    assertSender(event);
    return tmuxProvisioner.status();
  });

  ipcMain.handle(IpcChannels.tmuxInstall, async (event) => {
    assertSender(event);
    const result = await tmuxProvisioner.install(
      (progress) => send(IpcChannels.tmuxInstallProgress, progress),
      (log) => send(IpcChannels.tmuxInstallLog, log),
    );
    send(IpcChannels.tmuxStatusChanged, result.status);
    return result;
  });

  ipcMain.handle(IpcChannels.remoteCleanup, (event, raw: unknown) => {
    assertSender(event);
    return tmuxProvisioner.cleanup(raw === true);
  });

  ipcMain.handle(IpcChannels.agentDetect, (event, raw: unknown) => {
    assertSender(event);
    if (agentCommunication === null) {
      throw new Error('Agent communication is unavailable in mock desktop mode');
    }
    return agentCommunication.detect(AgentDetectionRequestSchema.parse(raw));
  });

  ipcMain.handle(IpcChannels.agentSessionsList, (event, raw: unknown) => {
    assertSender(event);
    if (agentCommunication === null) return [];
    return agentCommunication.list(AgentSessionListRequestSchema.parse(raw));
  });

  ipcMain.handle(IpcChannels.agentSessionCreate, (event, raw: unknown) => {
    assertSender(event);
    if (agentCommunication === null) {
      throw new Error('Agent communication is unavailable in mock desktop mode');
    }
    return agentCommunication.create(CreateAgentSessionRequestSchema.parse(raw));
  });

  ipcMain.handle(IpcChannels.agentSessionRevive, (event, raw: unknown) => {
    assertSender(event);
    if (agentCommunication === null) {
      throw new Error('Agent communication is unavailable in mock desktop mode');
    }
    return agentCommunication.revive(AgentSessionRequestSchema.parse(raw));
  });

  ipcMain.handle(IpcChannels.agentAgyTranscript, (event, raw: unknown) => {
    assertSender(event);
    if (agentCommunication === null) return { turns: [] };
    return agentCommunication.readAgyTranscript(
      AgyTranscriptRequestSchema.parse(raw),
    );
  });

  ipcMain.handle(IpcChannels.agentTerminalOpen, async (event, raw: unknown) => {
    assertSender(event);
    if (agentCommunication === null) {
      throw new Error('Agent communication is unavailable in mock desktop mode');
    }
    const opened = await agentCommunication.openTerminal(
      AgentTerminalOpenRequestSchema.parse(raw),
    );
    // Include every chunk emitted before this response. The renderer already
    // subscribed, so sequence numbers prevent the replay/live overlap from
    // being applied twice.
    flushTerminalOutput();
    const replay = terminalReplayBuffers.get(opened.terminalId);
    if (replay === undefined || replay.data.length === 0) return opened;
    return {
      ...opened,
      replayDataBase64: bytesToBase64(replay.data),
      replayThroughSequence: replay.throughSequence,
    };
  });

  ipcMain.handle(IpcChannels.agentSessionRename, (event, raw: unknown) => {
    assertSender(event);
    if (agentCommunication === null) {
      throw new Error('Agent communication is unavailable in mock desktop mode');
    }
    return agentCommunication.rename(RenameAgentSessionRequestSchema.parse(raw));
  });

  ipcMain.handle(IpcChannels.agentSessionDelete, (event, raw: unknown) => {
    assertSender(event);
    if (agentCommunication === null) {
      throw new Error('Agent communication is unavailable in mock desktop mode');
    }
    return agentCommunication.delete(AgentSessionRequestSchema.parse(raw));
  });

  ipcMain.handle(IpcChannels.agentAttachmentsUpload, (event, raw: unknown) => {
    assertSender(event);
    if (agentCommunication === null) {
      throw new Error('Agent communication is unavailable in mock desktop mode');
    }
    return agentCommunication.uploadAttachments(
      UploadAgentAttachmentsRequestSchema.parse(raw),
    );
  });

  ipcMain.handle(IpcChannels.agentSessionSend, (event, raw: unknown) => {
    assertSender(event);
    if (agentCommunication === null) {
      throw new Error('Agent communication is unavailable in mock desktop mode');
    }
    return agentCommunication.send(SendAgentMessageRequestSchema.parse(raw));
  });

  ipcMain.handle(IpcChannels.agentSessionInterrupt, (event, raw: unknown) => {
    assertSender(event);
    if (agentCommunication === null) {
      throw new Error('Agent communication is unavailable in mock desktop mode');
    }
    return agentCommunication.interrupt(AgentSessionRequestSchema.parse(raw));
  });

  ipcMain.handle(IpcChannels.agentApprovalResolve, (event, raw: unknown) => {
    assertSender(event);
    if (agentCommunication === null) {
      throw new Error('Agent communication is unavailable in mock desktop mode');
    }
    return agentCommunication.resolveApproval(
      ResolveAgentApprovalRequestSchema.parse(raw),
    );
  });

  ipcMain.handle(IpcChannels.agentQuestionAnswer, (event, raw: unknown) => {
    assertSender(event);
    if (agentCommunication === null) {
      throw new Error('Agent communication is unavailable in mock desktop mode');
    }
    return agentCommunication.answerQuestion(
      AnswerAgentQuestionRequestSchema.parse(raw),
    );
  });

  ipcMain.handle(IpcChannels.agentQuestionDecline, (event, raw: unknown) => {
    assertSender(event);
    if (agentCommunication === null) {
      throw new Error('Agent communication is unavailable in mock desktop mode');
    }
    return agentCommunication.declineQuestion(
      DeclineAgentQuestionRequestSchema.parse(raw),
    );
  });

  ipcMain.handle(IpcChannels.hostKeyDecision, (event, raw: unknown) => {
    assertSender(event);
    const decision = HostKeyDecisionSchema.parse(raw);
    hostKeys?.resolve(decision.requestId, decision.accept);
  });
}

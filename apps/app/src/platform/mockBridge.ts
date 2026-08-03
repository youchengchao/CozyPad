import type {
  AgentCommunicationErrorEvent,
  AgentAttachment,
  AgentSessionChangedEvent,
  AgentSessionDeletedEvent,
  AgentSessionSummary,
  AgentTimelineChangedEvent,
  ChatItem,
  ConnectionProfile,
  ConnectionState,
  ConnectionStateChanged,
  PlatformBridge,
  RemoteSettings,
  TelemetrySnapshot,
  TmuxStatus,
  TerminalClosedEvent,
  TerminalOutputEvent,
} from '@cozypad/contracts';
import { base64ToBytes, bytesToBase64 } from '@cozypad/contracts';
import {
  MockPtyEngine,
  MockRemoteFs,
  MockTelemetryGenerator,
  mockAgentInstallState,
  mockAgentSessions,
  mockAgentTimelines,
} from '@cozypad/test-fixtures';

const MOCK_PROFILE: ConnectionProfile = {
  id: 'mock-local',
  name: 'Mock Host (browser)',
  host: 'mock.local',
  port: 22,
  username: 'cozy',
  authMethod: 'password',
  hasPassword: true,
  credentialPersisted: false,
};

const MOCK_TMUX_STATUS: TmuxStatus = {
  installed: true,
  version: '3.5a',
  path: '/usr/bin/tmux',
  userLevel: false,
  satisfiesTarget: true,
  targetVersion: '3.5a',
  canInstall: true,
  missingTools: [],
  extraBuilds: [],
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface MockBridgeExtras {
  /** 模擬非預期斷線，供重連機制的 UI 驗證用。 */
  simulateDrop(): void;
}

/** 純瀏覽器模式的 PlatformBridge：讓 UI 開發完全不需要 Electron 或真實主機。 */
export function createMockBridge(): PlatformBridge & MockBridgeExtras {
  const stateListeners = new Set<(event: ConnectionStateChanged) => void>();
  const outputListeners = new Set<(event: TerminalOutputEvent) => void>();
  const closedListeners = new Set<(event: TerminalClosedEvent) => void>();
  const telemetryListeners = new Set<(snapshot: TelemetrySnapshot) => void>();
  const agentSessionListeners = new Set<
    (event: AgentSessionChangedEvent) => void
  >();
  const agentSessionDeletedListeners = new Set<
    (event: AgentSessionDeletedEvent) => void
  >();
  const agentTimelineListeners = new Set<
    (event: AgentTimelineChangedEvent) => void
  >();
  const agentErrorListeners = new Set<
    (event: AgentCommunicationErrorEvent) => void
  >();
  const terminals = new Map<string, MockPtyEngine>();
  const remoteFs = new MockRemoteFs();
  const telemetry = new MockTelemetryGenerator();
  let profiles: ConnectionProfile[] = [MOCK_PROFILE];
  const passwords = new Map<string, string>([[MOCK_PROFILE.id, 'mock']]);
  const privateKeys = new Map<string, string>();
  let connectedProfileId: string | null = null;
  let nextTerminalId = 1;
  let nextProfileId = 1;
  let remoteSettings: RemoteSettings = { tmuxMouseMode: true, tmuxSocket: 'default' };
  let fallbackClipboard = '';
  let agentSessions: AgentSessionSummary[] = mockAgentSessions.map((session) => ({
    ...session,
  }));
  const agentTimelines: Record<string, ChatItem[]> = Object.fromEntries(
    Object.entries(mockAgentTimelines).map(([sessionId, items]) => [
      sessionId,
      items.map((item) => ({ ...item })),
    ]),
  );
  const agentAttachments = new Map<string, AgentAttachment>();
  const agentTerminals = new Map<string, string>();

  const emitState = (
    profileId: string,
    state: ConnectionState,
    error?: string,
  ): void => {
    const event: ConnectionStateChanged = {
      profileId,
      state,
      ...(error === undefined ? {} : { error }),
    };
    stateListeners.forEach((listener) => listener(event));
  };

  const closeAllTerminals = (): void => {
    for (const engine of terminals.values()) engine.close();
    terminals.clear();
  };

  const emitAgentSession = (session: AgentSessionSummary): void => {
    agentSessionListeners.forEach((listener) => listener({ session }));
  };

  const emitAgentTimeline = (sessionId: string): void => {
    agentTimelineListeners.forEach((listener) =>
      listener({ sessionId, items: [...(agentTimelines[sessionId] ?? [])] }),
    );
  };

  const openMockTerminal = (
    request: { cols: number; rows: number },
    surface: 'shell' | 'agy',
  ): { terminalId: string } => {
    if (connectedProfileId === null) throw new Error('mock bridge: not connected');
    const terminalId = `mock-term-${nextTerminalId++}`;
    const engine = new MockPtyEngine(
      {
        onData: (data) => {
          const event: TerminalOutputEvent = {
            terminalId,
            dataBase64: bytesToBase64(data),
          };
          outputListeners.forEach((listener) => listener(event));
        },
        onClose: (info) => {
          terminals.delete(terminalId);
          for (const [sessionId, mappedTerminalId] of agentTerminals) {
            if (mappedTerminalId === terminalId) agentTerminals.delete(sessionId);
          }
          const event: TerminalClosedEvent = {
            terminalId,
            exitCode: info.exitCode,
          };
          closedListeners.forEach((listener) => listener(event));
        },
      },
      { cols: request.cols, rows: request.rows },
    );
    terminals.set(terminalId, engine);
    setTimeout(() => {
      if (surface === 'agy') engine.startAgy();
      else engine.start();
    }, 30);
    return { terminalId };
  };

  return {
    kind: 'mock',

    getAppInfo: () => Promise.resolve({ mockData: true }),

    listProfiles: () => Promise.resolve([...profiles]),

    saveProfile(draft) {
      const id = draft.id ?? `mock-p${nextProfileId++}`;
      if (draft.authMethod === 'privateKey') {
        passwords.delete(id);
        if (draft.privateKey) privateKeys.set(id, draft.privateKey);
      } else {
        privateKeys.delete(id);
        if (draft.password) passwords.set(id, draft.password);
      }
      const profile: ConnectionProfile = {
        id,
        name: draft.name,
        host: draft.host,
        port: draft.port,
        username: draft.username,
        authMethod: draft.authMethod,
        hasPassword: passwords.has(id),
        hasPrivateKey: privateKeys.has(id),
        credentialPersisted:
          draft.rememberCredential &&
          (passwords.has(id) || privateKeys.has(id)),
      };
      profiles = [...profiles.filter((entry) => entry.id !== id), profile];
      return Promise.resolve(profile);
    },

    deleteProfile({ profileId }) {
      profiles = profiles.filter((profile) => profile.id !== profileId);
      passwords.delete(profileId);
      privateKeys.delete(profileId);
      return Promise.resolve();
    },

    async connect({ profileId }) {
      emitState(profileId, 'connecting');
      await delay(300);
      connectedProfileId = profileId;
      emitState(profileId, 'connected');
      telemetry.start(profileId, (snapshot) =>
        telemetryListeners.forEach((listener) => listener(snapshot)),
      );
    },

    async disconnect({ profileId }) {
      connectedProfileId = null;
      telemetry.stop();
      closeAllTerminals();
      emitState(profileId, 'disconnected');
    },

    simulateDrop() {
      if (connectedProfileId === null) return;
      const profileId = connectedProfileId;
      connectedProfileId = null;
      telemetry.stop();
      closeAllTerminals();
      emitState(profileId, 'disconnected');
    },

    onConnectionState(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },

    async openTerminal(request) {
      return openMockTerminal(request, 'shell');
    },

    writeTerminal(input) {
      terminals.get(input.terminalId)?.write(base64ToBytes(input.dataBase64));
    },

    resizeTerminal(request) {
      terminals.get(request.terminalId)?.resize(request.cols, request.rows);
      return Promise.resolve();
    },

    closeTerminal(request) {
      terminals.get(request.terminalId)?.close();
      return Promise.resolve();
    },

    onTerminalOutput(listener) {
      outputListeners.add(listener);
      return () => outputListeners.delete(listener);
    },

    onTerminalClosed(listener) {
      closedListeners.add(listener);
      return () => closedListeners.delete(listener);
    },

    onTelemetry(listener) {
      telemetryListeners.add(listener);
      return () => telemetryListeners.delete(listener);
    },

    fsList: (request) => remoteFs.list(request.path),
    fsRead: async (request) => ({
      content: await remoteFs.readText(request.path, request.maxBytes, request.offset),
    }),
    fsReadBytes: async (request) => ({ dataBase64: await remoteFs.readBytes(request.path) }),
    fsWrite: (request) => remoteFs.write(request.path, request.contentBase64),
    fsCreate: (request) => remoteFs.create(request.directory, request.name, request.kind),
    fsRename: (request) => remoteFs.rename(request.path, request.newName),
    fsDuplicate: async (request) => ({ path: await remoteFs.duplicate(request.path) }),
    fsCopy: async (request) => ({
      path: await remoteFs.copyTo(request.sourcePath, request.destinationDirectory),
    }),
    fsMove: async (request) => ({
      path: await remoteFs.moveTo(request.sourcePath, request.destinationDirectory),
    }),
    fsDelete: (request) => remoteFs.remove(request.path),

    onHostKeyPrompt() {
      return () => undefined;
    },
    respondHostKey: () => Promise.resolve(),

    getBackgroundMode: () => Promise.resolve({ supported: false, enabled: false }),
    setBackgroundMode: () => Promise.resolve(),

    async readClipboard() {
      try {
        return await navigator.clipboard.readText();
      } catch {
        return fallbackClipboard;
      }
    },
    async writeClipboard(text) {
      fallbackClipboard = text;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // 瀏覽器權限不足時只保留內部緩衝
      }
    },

    getTmuxStatus: () => Promise.resolve({ ...MOCK_TMUX_STATUS }),
    installTmux: () =>
      Promise.resolve({ ok: true, status: { ...MOCK_TMUX_STATUS }, log: '' }),
    cleanupRemote: () => Promise.resolve('mock'),
    onTmuxStatus() {
      return () => undefined;
    },
    onTmuxInstallProgress() {
      return () => undefined;
    },
    onTmuxInstallLog() {
      return () => undefined;
    },

    detectAgent: ({ agentKind }) =>
      Promise.resolve({
        agentKind,
        installed: mockAgentInstallState[agentKind] === 'installed',
        executablePath:
          mockAgentInstallState[agentKind] === 'installed'
            ? `/usr/local/bin/${agentKind}`
            : undefined,
        version: mockAgentInstallState[agentKind] === 'installed' ? 'mock' : undefined,
        supportsStructuredOutput:
          agentKind !== 'agy' && mockAgentInstallState[agentKind] === 'installed',
        supportsResume: mockAgentInstallState[agentKind] === 'installed',
        supportsInteractiveApproval:
          mockAgentInstallState[agentKind] === 'installed',
        launchModes:
          mockAgentInstallState[agentKind] === 'installed'
            ? [
                {
                  id: 'default',
                  label: 'Default',
                  description: `Use ${agentKind}'s default guarded mode.`,
                  risk: 'normal' as const,
                },
              ]
            : [],
        ...(mockAgentInstallState[agentKind] === 'not_detected'
          ? { detail: `${agentKind} is not installed in mock mode` }
          : {}),
      }),

    listAgentSessions: () =>
      Promise.resolve(
        agentSessions.map((session) => ({
          session: { ...session },
          items: [...(agentTimelines[session.id] ?? [])],
        })),
      ),

    createAgentSession: async ({
      agentKind,
      cwd,
      title,
      interactionMode = 'chat',
    }) => {
      const now = new Date().toISOString();
      const id = `mock-${agentKind}-${Date.now()}`;
      const session: AgentSessionSummary = {
        id,
        agentKind,
        title: title ?? `New ${agentKind} conversation`,
        host: 'cozy@mock.local',
        project: cwd.replace(/[\\/]+$/u, '').split(/[\\/]/u).at(-1) ?? cwd,
        cwd,
        interactionMode: agentKind === 'agy' ? 'terminal' : interactionMode,
        status: 'ready',
        unread: 0,
        slashCommands: ['clear', 'compact', 'context', 'usage'],
        updatedAt: now,
      };
      agentSessions = [session, ...agentSessions];
      agentTimelines[id] = [];
      emitAgentSession(session);
      emitAgentTimeline(id);
      return { session, items: [] };
    },

    readAgyTranscript: () => Promise.resolve({ turns: [] }),

    reviveAgentSession: ({ sessionId }) => {
      const session = agentSessions.find((candidate) => candidate.id === sessionId);
      if (session === undefined) throw new Error(`unknown mock session: ${sessionId}`);
      if (session.status === 'exited' || session.status === 'error') {
        session.status = 'ready';
        session.updatedAt = new Date().toISOString();
        emitAgentSession(session);
      }
      return Promise.resolve({
        session,
        items: agentTimelines[sessionId] ?? [],
      });
    },

    openAgentTerminal: async ({ sessionId, cols, rows }) => {
      const session = agentSessions.find((candidate) => candidate.id === sessionId);
      if (
        session === undefined ||
        session.agentKind !== 'agy' ||
        session.interactionMode !== 'terminal'
      ) {
        throw new Error('mock bridge: this session is not a native AGY terminal');
      }
      const opened = openMockTerminal({ cols, rows }, 'agy');
      agentTerminals.set(sessionId, opened.terminalId);
      return opened;
    },

    renameAgentSession: ({ sessionId, title }) => {
      agentSessions = agentSessions.map((session) =>
        session.id === sessionId
          ? { ...session, title, updatedAt: new Date().toISOString() }
          : session,
      );
      const session = agentSessions.find((candidate) => candidate.id === sessionId);
      if (session !== undefined) emitAgentSession(session);
      return Promise.resolve();
    },

    deleteAgentSession: ({ sessionId }) => {
      const session = agentSessions.find((candidate) => candidate.id === sessionId);
      if (session === undefined) throw new Error(`unknown mock session: ${sessionId}`);
      const terminalId = agentTerminals.get(sessionId);
      if (terminalId !== undefined) terminals.get(terminalId)?.close();
      agentTerminals.delete(sessionId);
      agentSessions = agentSessions.filter((candidate) => candidate.id !== sessionId);
      delete agentTimelines[sessionId];
      for (const [attachmentId, attachment] of agentAttachments) {
        if (attachment.sessionId === sessionId) agentAttachments.delete(attachmentId);
      }
      agentSessionDeletedListeners.forEach((listener) =>
        listener({ sessionId, agentKind: session.agentKind }),
      );
      return Promise.resolve();
    },

    uploadAgentAttachment: async ({ sessionId, name, mediaType, dataBase64 }) => {
      const session = agentSessions.find((candidate) => candidate.id === sessionId);
      if (session === undefined) throw new Error(`unknown mock session: ${sessionId}`);
      if (session.interactionMode === 'terminal') {
        throw new Error('This AGY session uses the native CLI; send input in its terminal');
      }
      const id = crypto.randomUUID();
      const attachment: AgentAttachment = {
        id,
        sessionId,
        name,
        mediaType,
        sizeBytes: base64ToBytes(dataBase64).byteLength,
        remotePath: `${session.cwd}/.cozypad/session-tmp/${sessionId}/attachments/${id}-${name}`,
      };
      agentAttachments.set(id, attachment);
      return attachment;
    },

    async sendAgentMessage({ sessionId, text, attachmentIds }) {
      const now = new Date().toISOString();
      const session = agentSessions.find((candidate) => candidate.id === sessionId);
      if (session === undefined) throw new Error(`unknown mock session: ${sessionId}`);
      const attachments = (attachmentIds ?? []).map((id) => agentAttachments.get(id)).filter(
        (attachment): attachment is AgentAttachment => attachment !== undefined,
      );
      const displayText =
        text === ''
          ? `Attached: ${attachments.map((attachment) => attachment.name).join(', ')}`
          : text;
      agentTimelines[sessionId] = [
        ...(agentTimelines[sessionId] ?? []),
        {
          id: `mock-user-${Date.now()}`,
          kind: 'message',
          role: 'user',
          text: displayText,
          timestamp: now,
        },
        {
          id: `mock-assistant-${Date.now()}`,
          kind: 'message',
          role: 'assistant',
          text: '（mock）訊息已經走 PlatformBridge；桌面 SSH 模式會送進 tmux 內的真實 Agent。',
          timestamp: now,
        },
      ];
      Object.assign(session, { status: 'ready', updatedAt: now });
      emitAgentSession(session);
      emitAgentTimeline(sessionId);
    },

    interruptAgentSession: ({ sessionId }) => {
      const session = agentSessions.find((candidate) => candidate.id === sessionId);
      if (session !== undefined) {
        const terminalId = agentTerminals.get(sessionId);
        if (terminalId !== undefined) {
          terminals
            .get(terminalId)
            ?.write(new Uint8Array([session.agentKind === 'agy' ? 0x1b : 0x03]));
        }
        Object.assign(session, {
          status: 'ready',
          updatedAt: new Date().toISOString(),
        });
        emitAgentSession(session);
      }
      return Promise.resolve();
    },

    resolveAgentApproval: ({ sessionId, itemId, resolution }) => {
      agentTimelines[sessionId] = (agentTimelines[sessionId] ?? []).map((item) =>
        item.id === itemId && item.kind === 'approval'
          ? { ...item, resolution }
          : item,
      );
      emitAgentTimeline(sessionId);
      return Promise.resolve();
    },

    answerAgentQuestion: ({ sessionId, itemId, optionIndex }) => {
      agentTimelines[sessionId] = (agentTimelines[sessionId] ?? []).map((item) =>
        item.id === itemId && item.kind === 'question'
          ? { ...item, selectedIndex: optionIndex }
          : item,
      );
      emitAgentTimeline(sessionId);
      return Promise.resolve();
    },

    onAgentSessionChanged(listener) {
      agentSessionListeners.add(listener);
      return () => agentSessionListeners.delete(listener);
    },
    onAgentSessionDeleted(listener) {
      agentSessionDeletedListeners.add(listener);
      return () => agentSessionDeletedListeners.delete(listener);
    },
    onAgentTimelineChanged(listener) {
      agentTimelineListeners.add(listener);
      return () => agentTimelineListeners.delete(listener);
    },
    onAgentCommunicationError(listener) {
      agentErrorListeners.add(listener);
      return () => agentErrorListeners.delete(listener);
    },

    getRemoteSettings: () => Promise.resolve({ ...remoteSettings }),
    setRemoteSettings: (patch) => {
      remoteSettings = { ...remoteSettings, ...patch };
      return Promise.resolve({ ...remoteSettings });
    },
  };
}

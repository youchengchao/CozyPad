import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  AgentAttachmentSchema,
  AgentSessionSummarySchema,
  ChatItemSchema,
  MAX_AGENT_ATTACHMENT_BYTES,
  RemoteAgentSessionRecordSchema,
  bindAgentIdentity,
  quoteShellArg,
} from '@cozypad/contracts';
import type {
  AgentCommunicationErrorEvent,
  AgentAttachment,
  AgentDetectionRequest,
  AgentInstallation,
  AgentLaunchMode,
  AgyRecoveredTurn,
  AgyTranscript,
  AgentSessionBundle,
  AgentSessionChangedEvent,
  AgentSessionDeletedEvent,
  AgentSessionListRequest,
  AgentSessionRequest,
  AgentSessionSummary,
  AgentTerminalOpenRequest,
  AgentTimelineChangedEvent,
  AnswerAgentQuestionRequest,
  ChatItem,
  CreateAgentSessionRequest,
  NormalizedAgentEvent,
  RemoteAgentSessionRecord,
  RemoteHostEnvironment,
  RenameAgentSessionRequest,
  ResolveAgentApprovalRequest,
  SendAgentMessageRequest,
  UploadAgentAttachmentRequest,
  TerminalOpened,
} from '@cozypad/contracts';
import {
  buildClaudeStreamingArgv,
  parseClaudeStreamLine,
} from '@cozypad/adapter-claude';
import type { ClaudeParseContext } from '@cozypad/adapter-claude';
import { reconcileSessions } from '@cozypad/tmux-runtime';
import type { TmuxRuntime } from '@cozypad/tmux-runtime';
import type { ProfileStorePort } from './profileStore';
import type { TransportPort } from './transport/TransportPort';
import {
  parseCodexAppServerLine,
  type CodexParseContext,
} from './adapters/codexAppServer';

interface ActiveTurn {
  id: string;
  assistantItemId?: string;
  changedPaths: string[];
}

interface PendingControlRequest {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  protocol?: 'claude' | 'codex' | 'agy';
  rpcId?: string | number;
  method?: string;
}

interface StoredAgentSession {
  record: RemoteAgentSessionRecord;
  paneId: string;
  host: string;
  project: string;
  timeline: ChatItem[];
  turnCounter: number;
  rawLines: number;
  pendingControls: Record<string, PendingControlRequest>;
  questionAnswers: Record<string, Record<string, string>>;
  slashCommands: string[];
  attachments: Record<string, AgentAttachment>;
  interactionMode: 'chat' | 'terminal';
  launchMode?: string;
  activeAgentTurnId?: string;
  activeTurn?: ActiveTurn;
  /**
   * Set when the session was relaunched onto the agent's most recent stored
   * conversation. Only such a session may present that conversation's
   * transcript as its own history.
   */
  revived?: boolean;
}

interface PersistedAgentStore {
  version: 1;
  sessions: StoredAgentSession[];
}

interface ResolvedRemoteEnvironment {
  environment: RemoteHostEnvironment;
  loginPath: string;
  homeDirectory: string;
  commandShell: string;
}

type AgentTmuxPort = Pick<
  TmuxRuntime,
  | 'socketName'
  | 'listSessions'
  | 'newSession'
  | 'respawnPane'
  | 'sendText'
  | 'interrupt'
  | 'escape'
  | 'hasSession'
  | 'killSession'
>;

export interface AgentCommunicationEvents {
  onSessionChanged(event: AgentSessionChangedEvent): void;
  onSessionDeleted(event: AgentSessionDeletedEvent): void;
  onTimelineChanged(event: AgentTimelineChangedEvent): void;
  onError(event: AgentCommunicationErrorEvent): void;
}

export interface AgentCommunicationPort {
  setEvents(events: AgentCommunicationEvents): void;
  load(): Promise<void>;
  connected(profileId: string): Promise<void>;
  disconnected(profileId: string): void;
  detect(request: AgentDetectionRequest): Promise<AgentInstallation>;
  list(request: AgentSessionListRequest): AgentSessionBundle[];
  create(request: CreateAgentSessionRequest): Promise<AgentSessionBundle>;
  revive(request: AgentSessionRequest): Promise<AgentSessionBundle>;
  readAgyTranscript(request: AgentSessionRequest): Promise<AgyTranscript>;
  openTerminal(request: AgentTerminalOpenRequest): Promise<TerminalOpened>;
  rename(request: RenameAgentSessionRequest): Promise<void>;
  delete(request: AgentSessionRequest): Promise<void>;
  uploadAttachment(request: UploadAgentAttachmentRequest): Promise<AgentAttachment>;
  send(request: SendAgentMessageRequest): Promise<void>;
  interrupt(request: AgentSessionRequest): Promise<void>;
  resolveApproval(request: ResolveAgentApprovalRequest): Promise<void>;
  answerQuestion(request: AnswerAgentQuestionRequest): Promise<void>;
}

export interface AgentCommunicationServiceOptions {
  transport: TransportPort;
  tmux: AgentTmuxPort;
  profileStore: ProfileStorePort;
  storePath: string;
  getHostFingerprint(profileId: string): string | undefined;
  /**
   * Returns a terminal a session is already running in, when the runtime owns
   * the console rather than multiplexing it. Absent for tmux, where a client
   * attaches to the pane instead.
   */
  attachExisting?(sessionId: string): string | undefined;
  /** Whether the host in use runs agents without tmux. */
  isLocalHost?(profileId: string): boolean;
  /** Told which host is active, for calls that carry no session id. */
  onHostChanged?(profileId: string): void;
  /**
   * Reads the most recent conversation out of the local AGY store, for
   * restoring a revived session's transcript. Absent on hosts without one.
   */
  readLocalAgyTranscript?(): Promise<AgyRecoveredTurn[]>;
}

const EMPTY_EVENTS: AgentCommunicationEvents = {
  onSessionChanged: () => undefined,
  onSessionDeleted: () => undefined,
  onTimelineChanged: () => undefined,
  onError: () => undefined,
};

function markerValue(output: string, marker: string): string | undefined {
  const prefix = `${marker}=`;
  const lines = output.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? '';
    if (line.startsWith(prefix)) {
      const value = line.slice(prefix.length).trim();
      return value === '' ? undefined : value;
    }
  }
  return undefined;
}

function markerBlock(output: string, marker: string): string {
  const start = `__COZYPAD_${marker}_BEGIN__`;
  const end = `__COZYPAD_${marker}_END__`;
  const startIndex = output.indexOf(start);
  if (startIndex < 0) return '';
  const contentStart = startIndex + start.length;
  const endIndex = output.indexOf(end, contentStart);
  if (endIndex < 0) return output.slice(contentStart).trim();
  return output.slice(contentStart, endIndex).trim();
}

function trimDisplayQuotes(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function buildRemoteEnvironmentProbeCommand(): string {
  return `cozypad_command_shell="$(command -v sh 2>/dev/null || true)"
cozypad_login_shell="\${SHELL:-}"
if [ -z "$cozypad_login_shell" ] && command -v getent >/dev/null 2>&1; then
  cozypad_login_shell="$(getent passwd "$(id -u)" | cut -d: -f7)"
fi
if [ -z "$cozypad_login_shell" ]; then
  cozypad_login_shell="$cozypad_command_shell"
fi
cozypad_login_env=""
if [ -n "$cozypad_login_shell" ] && [ -x "$cozypad_login_shell" ]; then
  cozypad_login_env="$("$cozypad_login_shell" -l -i -c env 2>/dev/null || true)"
fi
cozypad_login_path="$(echo "$cozypad_login_env" | sed -n 's/^PATH=//p' | tail -n 1)"
if [ -z "$cozypad_login_path" ]; then
  cozypad_login_path="$PATH"
fi
cozypad_home="$(echo "$cozypad_login_env" | sed -n 's/^HOME=//p' | tail -n 1)"
if [ -z "$cozypad_home" ]; then
  cozypad_home="$HOME"
fi
PATH="$cozypad_login_path"
export PATH
cozypad_os="$(uname -s 2>/dev/null || true)"
cozypad_kernel="$(uname -r 2>/dev/null || true)"
cozypad_arch="$(uname -m 2>/dev/null || true)"
cozypad_distribution=""
if command -v lsb_release >/dev/null 2>&1; then
  cozypad_distribution="$(lsb_release -ds 2>/dev/null || true)"
elif command -v hostnamectl >/dev/null 2>&1; then
  cozypad_distribution="$(LC_ALL=C hostnamectl status 2>/dev/null | sed -n 's/^[[:space:]]*Operating System:[[:space:]]*//p' | head -n 1)"
fi
echo "__COZYPAD_OS__=$cozypad_os"
echo "__COZYPAD_DISTRIBUTION__=$cozypad_distribution"
echo "__COZYPAD_KERNEL__=$cozypad_kernel"
echo "__COZYPAD_ARCH__=$cozypad_arch"
echo "__COZYPAD_LOGIN_SHELL__=$cozypad_login_shell"
echo "__COZYPAD_LOGIN_PATH__=$cozypad_login_path"
echo "__COZYPAD_HOME__=$cozypad_home"
echo "__COZYPAD_COMMAND_SHELL__=$cozypad_command_shell"
`;
}

export function parseRemoteEnvironmentProbe(
  output: string,
): ResolvedRemoteEnvironment {
  const osName = markerValue(output, '__COZYPAD_OS__') ?? 'unknown';
  const commandShell = markerValue(output, '__COZYPAD_COMMAND_SHELL__');
  if (commandShell === undefined) {
    throw new Error('Remote host does not expose a POSIX command shell in PATH');
  }
  const homeDirectory = markerValue(output, '__COZYPAD_HOME__');
  if (homeDirectory === undefined || homeDirectory === '/') {
    throw new Error('Remote host did not provide a safe user home directory');
  }
  const distribution = trimDisplayQuotes(
    markerValue(output, '__COZYPAD_DISTRIBUTION__'),
  );
  const kernelRelease = markerValue(output, '__COZYPAD_KERNEL__');
  const architecture = markerValue(output, '__COZYPAD_ARCH__');
  const loginShell = markerValue(output, '__COZYPAD_LOGIN_SHELL__');
  return {
    environment: {
      osName,
      ...(distribution === undefined ? {} : { distribution }),
      ...(kernelRelease === undefined ? {} : { kernelRelease }),
      ...(architecture === undefined ? {} : { architecture }),
      ...(loginShell === undefined ? {} : { loginShell }),
    },
    loginPath: markerValue(output, '__COZYPAD_LOGIN_PATH__') ?? '',
    homeDirectory,
    commandShell,
  };
}

export function buildAgentCapabilityProbeCommand(
  executable: string,
  loginPath: string,
  agentKind: CreateAgentSessionRequest['agentKind'] = 'claude',
): string {
  const pathSetup =
    loginPath === ''
      ? ''
      : `PATH=${quoteShellArg(loginPath)}
export PATH
`;
  return `${pathSetup}cozypad_executable="$(command -v ${quoteShellArg(executable)} 2>/dev/null || true)"
cozypad_which=""
if command -v which >/dev/null 2>&1; then
  cozypad_which="$(which ${quoteShellArg(executable)} 2>/dev/null | head -n 1 || true)"
fi
if [ -z "$cozypad_executable" ]; then
  echo "__COZYPAD_MISSING__=1"
  exit 0
fi
echo "__COZYPAD_EXECUTABLE__=$cozypad_executable"
echo "__COZYPAD_WHICH__=$cozypad_which"
cozypad_real_path="$cozypad_executable"
if command -v realpath >/dev/null 2>&1; then
  cozypad_real_path="$(realpath "$cozypad_executable" 2>/dev/null || echo "$cozypad_executable")"
elif command -v readlink >/dev/null 2>&1; then
  cozypad_real_path="$(readlink -f "$cozypad_executable" 2>/dev/null || echo "$cozypad_executable")"
fi
echo "__COZYPAD_REAL_PATH__=$cozypad_real_path"
cozypad_version_output="$("$cozypad_executable" --version 2>&1)"
cozypad_version_status=$?
echo "__COZYPAD_VERSION__=$(echo "$cozypad_version_output" | head -n 1)"
echo "__COZYPAD_VERSION_STATUS__=$cozypad_version_status"
echo "__COZYPAD_VERSION_OUTPUT_BEGIN__"
echo "$cozypad_version_output"
echo "__COZYPAD_VERSION_OUTPUT_END__"
cozypad_help_output="$("$cozypad_executable" --help 2>&1)"
cozypad_help_status=$?
echo "__COZYPAD_HELP_STATUS__=$cozypad_help_status"
echo "__COZYPAD_HELP_OUTPUT_BEGIN__"
echo "$cozypad_help_output"
echo "__COZYPAD_HELP_OUTPUT_END__"
cozypad_protocol_help_output=""
cozypad_protocol_help_status=0
${
  agentKind === 'codex'
    ? 'cozypad_protocol_help_output="$("$cozypad_executable" app-server --help 2>&1)"\ncozypad_protocol_help_status=$?'
    : ':'
}
echo "__COZYPAD_PROTOCOL_HELP_STATUS__=$cozypad_protocol_help_status"
echo "__COZYPAD_PROTOCOL_HELP_OUTPUT_BEGIN__"
echo "$cozypad_protocol_help_output"
echo "__COZYPAD_PROTOCOL_HELP_OUTPUT_END__"
`;
}

function isPathInsideHome(candidate: string, homeDirectory: string): boolean {
  const home = homeDirectory.replace(/\/+$/u, '');
  return home !== '' && candidate.startsWith(`${home}/`);
}

function normalizeSlashCommands(commands: readonly string[]): string[] {
  return [
    ...new Set(
      commands
        .map((command) => command.trim().replace(/^\/+/, ''))
        .filter((command) => command !== ''),
    ),
  ].sort();
}

function describeEnvironment(environment: RemoteHostEnvironment): string {
  const platform = environment.distribution ?? environment.osName;
  return [platform, environment.kernelRelease, environment.architecture]
    .filter((value): value is string => value !== undefined && value !== '')
    .join(' ');
}

const CLAUDE_BASE_LAUNCH_MODES: AgentLaunchMode[] = [
  {
    id: 'default',
    label: 'Ask when needed',
    description: 'Claude asks CozyPad before tools that need permission.',
    risk: 'normal',
  },
];

const CLAUDE_PERMISSION_MODE_LAUNCH_MODES: AgentLaunchMode[] = [
  {
    id: 'acceptEdits',
    label: 'Accept edits',
    description: 'Automatically accepts file edits but still asks for other risky tools.',
    risk: 'elevated',
  },
  {
    id: 'plan',
    label: 'Plan only',
    description: 'Read-only planning mode; Claude does not execute changes.',
    risk: 'normal',
  },
  {
    id: 'dontAsk',
    label: 'Do not ask',
    description: 'Automatically denies tools that are not already allowed.',
    risk: 'normal',
  },
];

const CODEX_LAUNCH_MODES: AgentLaunchMode[] = [
  {
    id: 'workspace-request',
    label: 'Workspace + approvals',
    description: 'Workspace-write sandbox with approval requests for risky actions.',
    risk: 'normal',
  },
  {
    id: 'read-only',
    label: 'Read only',
    description: 'Read-only sandbox; changes and commands remain constrained.',
    risk: 'normal',
  },
  {
    id: 'workspace-never',
    label: 'Workspace autonomous',
    description: 'Workspace-write sandbox without approval prompts.',
    risk: 'elevated',
  },
  {
    id: 'yolo',
    label: 'YOLO',
    description: 'Bypasses approvals and the Codex sandbox.',
    risk: 'dangerous',
  },
];

const AGY_LAUNCH_MODES: AgentLaunchMode[] = [
  {
    id: 'default',
    label: 'Respect AGY settings',
    description: 'Uses the permission behavior configured by AGY in its native TUI.',
    risk: 'normal',
  },
  {
    id: 'sandbox',
    label: 'Terminal sandbox',
    description: 'Enables AGY terminal sandbox restrictions for this conversation.',
    risk: 'normal',
  },
  {
    id: 'bypassPermissions',
    label: 'Bypass permissions',
    description: 'AGY auto-approves tool requests without prompting.',
    risk: 'dangerous',
  },
];

function launchModesFor(
  agentKind: CreateAgentSessionRequest['agentKind'],
  helpOutput: string,
): AgentLaunchMode[] {
  if (agentKind === 'codex') {
    return CODEX_LAUNCH_MODES.filter(
      (mode) =>
        mode.id !== 'yolo' ||
        helpOutput.includes('--yolo') ||
        helpOutput.includes('--dangerously-bypass-approvals-and-sandbox'),
    );
  }
  if (agentKind === 'agy') {
    return AGY_LAUNCH_MODES.filter(
      (mode) =>
        (mode.id !== 'sandbox' || helpOutput.includes('--sandbox')) &&
        (mode.id !== 'bypassPermissions' ||
          helpOutput.includes('--dangerously-skip-permissions')),
    );
  }
  const modes = [...CLAUDE_BASE_LAUNCH_MODES];
  if (helpOutput.includes('--permission-mode')) {
    modes.push(...CLAUDE_PERMISSION_MODE_LAUNCH_MODES);
  }
  if (/\bauto\b/u.test(helpOutput)) {
    modes.push({
      id: 'auto',
      label: 'Auto',
      description: 'Claude classifies permission decisions automatically.',
      risk: 'elevated',
    });
  }
  if (helpOutput.includes('bypassPermissions') || helpOutput.includes('--dangerously-skip-permissions')) {
    modes.push({
      id: 'bypassPermissions',
      label: 'Bypass permissions',
      description: 'Claude runs without permission checks.',
      risk: 'dangerous',
    });
  }
  return modes;
}

function codexPolicyForMode(mode: string): {
  approvalPolicy: 'unlessTrusted' | 'onRequest' | 'never';
  sandbox: 'readOnly' | 'workspaceWrite' | 'dangerFullAccess';
} {
  switch (mode) {
    case 'read-only':
      return { approvalPolicy: 'onRequest', sandbox: 'readOnly' };
    case 'workspace-never':
      return { approvalPolicy: 'never', sandbox: 'workspaceWrite' };
    case 'yolo':
      return { approvalPolicy: 'never', sandbox: 'dangerFullAccess' };
    default:
      return { approvalPolicy: 'unlessTrusted', sandbox: 'workspaceWrite' };
  }
}

function remoteSessionDir(sessionId: string): string {
  return `$HOME/.cozypad/sessions/${sessionId}`;
}

function agentLabelFor(agentKind: CreateAgentSessionRequest['agentKind']): string {
  return agentKind === 'claude' ? 'Claude' : agentKind === 'codex' ? 'Codex' : 'AGY';
}

function projectName(cwd: string): string {
  const normalized = cwd.replace(/[\\/]+$/u, '');
  const parts = normalized.split(/[\\/]/u).filter(Boolean);
  return parts.at(-1) ?? cwd;
}

function safeAttachmentName(name: string): string {
  const base = path.posix.basename(name.replace(/\\/gu, '/')).trim();
  const safe = base
    .replace(/[^a-zA-Z0-9.]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/-+\./gu, '.')
    .slice(0, 120)
    .replace(/^[.-]+|[.-]+$/gu, '');
  return safe === '' ? 'attachment.bin' : safe;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringRecord<T>(
  value: unknown,
  parse: (entry: unknown) => T | null,
): Record<string, T> {
  if (!isRecord(value)) return {};
  const result: Record<string, T> = {};
  for (const [key, entry] of Object.entries(value)) {
    const parsed = parse(entry);
    if (parsed !== null) result[key] = parsed;
  }
  return result;
}

function parsePendingControl(value: unknown): PendingControlRequest | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.requestId !== 'string' ||
    typeof value.toolName !== 'string' ||
    !isRecord(value.input)
  ) {
    return null;
  }
  return {
    requestId: value.requestId,
    toolName: value.toolName,
    input: value.input,
    ...(value.protocol === 'claude' ||
    value.protocol === 'codex' ||
    value.protocol === 'agy'
      ? { protocol: value.protocol }
      : {}),
    ...(typeof value.rpcId === 'string' || typeof value.rpcId === 'number'
      ? { rpcId: value.rpcId }
      : {}),
    ...(typeof value.method === 'string' ? { method: value.method } : {}),
  };
}

function parseStoredSession(value: unknown): StoredAgentSession | null {
  if (!isRecord(value)) return null;
  const record = RemoteAgentSessionRecordSchema.safeParse(value.record);
  if (
    !record.success ||
    typeof value.host !== 'string' ||
    typeof value.project !== 'string'
  ) {
    return null;
  }
  if (!Array.isArray(value.timeline)) return null;
  const timeline: ChatItem[] = [];
  for (const item of value.timeline) {
    const parsed = ChatItemSchema.safeParse(item);
    if (parsed.success) timeline.push(parsed.data);
  }
  const paneId =
    typeof value.paneId === 'string'
      ? value.paneId
      : (record.data.identity?.tmuxPaneId ??
        record.data.provisionalIdentity.tmuxSessionId);
  const turnCounter =
    typeof value.turnCounter === 'number' && Number.isInteger(value.turnCounter)
      ? Math.max(0, value.turnCounter)
      : 0;
  const rawLines =
    typeof value.rawLines === 'number' && Number.isInteger(value.rawLines)
      ? Math.max(0, value.rawLines)
      : 0;
  const pendingControls = stringRecord(value.pendingControls, parsePendingControl);
  const questionAnswers = stringRecord(value.questionAnswers, (entry) => {
    if (!isRecord(entry)) return null;
    const answers: Record<string, string> = {};
    for (const [key, answer] of Object.entries(entry)) {
      if (typeof answer === 'string') answers[key] = answer;
    }
    return answers;
  });
  const slashCommands = Array.isArray(value.slashCommands)
    ? normalizeSlashCommands(
        value.slashCommands.filter(
          (entry): entry is string => typeof entry === 'string',
        ),
      )
    : [];
  const attachments = stringRecord(value.attachments, (entry) => {
    const parsed = isRecord(entry)
      ? {
          id: entry.id,
          sessionId: entry.sessionId,
          name: entry.name,
          mediaType: entry.mediaType,
          sizeBytes: entry.sizeBytes,
          remotePath: entry.remotePath,
        }
      : null;
    if (parsed === null) return null;
    const result = AgentAttachmentSchema.safeParse(parsed);
    return result.success ? result.data : null;
  });
  let activeTurn: ActiveTurn | undefined;
  if (isRecord(value.activeTurn) && typeof value.activeTurn.id === 'string') {
    activeTurn = {
      id: value.activeTurn.id,
      changedPaths: Array.isArray(value.activeTurn.changedPaths)
        ? value.activeTurn.changedPaths.filter(
            (entry): entry is string => typeof entry === 'string',
          )
        : [],
      ...(typeof value.activeTurn.assistantItemId === 'string'
        ? { assistantItemId: value.activeTurn.assistantItemId }
        : {}),
    };
  }
  return {
    record: record.data,
    paneId,
    host: value.host,
    project: value.project,
    timeline,
    turnCounter,
    rawLines,
    pendingControls,
    questionAnswers,
    slashCommands,
    attachments,
    interactionMode:
      record.data.provisionalIdentity.agentKind === 'agy' ? 'terminal' : 'chat',
    ...(typeof value.launchMode === 'string'
      ? { launchMode: value.launchMode }
      : {}),
    ...(typeof value.activeAgentTurnId === 'string'
      ? { activeAgentTurnId: value.activeAgentTurnId }
      : {}),
    ...(activeTurn === undefined ? {} : { activeTurn }),
    ...(value.revived === true ? { revived: true } : {}),
  };
}

function parseControlRequest(line: string): PendingControlRequest | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.type !== 'control_request') return null;
  if (typeof value.request_id !== 'string' || !isRecord(value.request)) return null;
  if (value.request.subtype !== 'can_use_tool') return null;
  return {
    requestId: value.request_id,
    toolName:
      typeof value.request.tool_name === 'string'
        ? value.request.tool_name
        : 'unknown tool',
    input: isRecord(value.request.input) ? value.request.input : {},
    protocol: 'claude',
  };
}

function parseCodexControlRequest(line: string): PendingControlRequest | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    (typeof value.id !== 'string' && typeof value.id !== 'number') ||
    typeof value.method !== 'string' ||
    !isRecord(value.params)
  ) {
    return null;
  }
  // Method names come from the app-server's own generated schema
  // (`codex app-server generate-ts`), not from prose docs. `requestUserInput`
  // is namespaced under `item/` like the approvals — without the prefix the
  // question was never recognised and the turn waited for an answer forever.
  if (
    ![
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'item/permissions/requestApproval',
      'item/tool/requestUserInput',
    ].includes(value.method)
  ) {
    return null;
  }
  return {
    requestId: String(value.id),
    toolName:
      value.method === 'item/tool/requestUserInput'
        ? 'RequestUserInput'
        : value.method,
    input: value.params,
    protocol: 'codex',
    rpcId: value.id,
    method: value.method,
  };
}

function parseCodexTurnId(line: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const container =
    value.method === 'turn/started' && isRecord(value.params)
      ? value.params
      : isRecord(value.result)
        ? value.result
        : undefined;
  if (container === undefined || !isRecord(container.turn)) return undefined;
  return typeof container.turn.id === 'string' ? container.turn.id : undefined;
}

export class AgentCommunicationService implements AgentCommunicationPort {
  private events: AgentCommunicationEvents = EMPTY_EVENTS;
  private sessions = new Map<string, StoredAgentSession>();
  private activeProfileId: string | null = null;
  private persistQueue = Promise.resolve();
  private readonly following = new Set<string>();
  private readonly completing = new Set<string>();
  private readonly installations = new Map<string, AgentInstallation>();
  private readonly remoteEnvironments = new Map<
    string,
    Promise<ResolvedRemoteEnvironment>
  >();

  constructor(private readonly options: AgentCommunicationServiceOptions) {}

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.options.storePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Agent session store is corrupt');
    }
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.sessions)) {
      throw new Error('Unsupported agent session store format');
    }
    for (const value of parsed.sessions) {
      const session = parseStoredSession(value);
      if (session !== null) this.sessions.set(session.record.id, session);
    }
  }

  setEvents(events: AgentCommunicationEvents): void {
    this.events = events;
  }

  async connected(profileId: string): Promise<void> {
    this.activeProfileId = profileId;
    // Creating a session has no id to route by, so the runtime is told which
    // host is in use the moment the connection is established.
    this.options.onHostChanged?.(profileId);
    this.clearDiscovery(profileId);
    const now = new Date().toISOString();
    const records = [...this.sessions.values()]
      .filter(
        (session) =>
          session.record.provisionalIdentity.connectionProfileId === profileId,
      )
      .map((session) => session.record);
    let live;
    try {
      live = await this.options.tmux.listSessions();
    } catch (error) {
      this.events.onError({ message: this.errorMessage(error) });
      return;
    }
    const result = reconcileSessions(records, live, now);
    for (const record of result.updated) {
      const stored = this.sessions.get(record.id);
      if (stored === undefined) continue;
      stored.record = record;
      this.emitSession(stored);
    }
    const liveIds = new Set(live.map((session) => session.sessionId));
    for (const stored of this.sessions.values()) {
      if (
        stored.record.provisionalIdentity.connectionProfileId === profileId &&
        liveIds.has(stored.record.provisionalIdentity.tmuxSessionId)
      ) {
        this.followSession(stored);
      }
    }
    await this.persist();
  }

  disconnected(profileId: string): void {
    if (this.activeProfileId === profileId) this.activeProfileId = null;
    this.clearDiscovery(profileId);
    const now = new Date().toISOString();
    for (const stored of this.sessions.values()) {
      if (
        stored.record.provisionalIdentity.connectionProfileId === profileId &&
        stored.record.status !== 'exited'
      ) {
        stored.record = { ...stored.record, status: 'disconnected', updatedAt: now };
        this.emitSession(stored);
      }
    }
    void this.persist();
  }

  private clearDiscovery(profileId: string): void {
    this.remoteEnvironments.delete(profileId);
    for (const key of this.installations.keys()) {
      if (key.startsWith(`${profileId}:`)) this.installations.delete(key);
    }
  }

  private async inspectRemoteEnvironment(
    profileId: string,
  ): Promise<ResolvedRemoteEnvironment> {
    let pending = this.remoteEnvironments.get(profileId);
    if (pending === undefined) {
      pending = this.options.transport
        .exec(buildRemoteEnvironmentProbeCommand(), 12_000)
        .then(parseRemoteEnvironmentProbe);
      this.remoteEnvironments.set(profileId, pending);
    }
    try {
      return await pending;
    } catch (error) {
      this.remoteEnvironments.delete(profileId);
      throw error;
    }
  }

  async detect(request: AgentDetectionRequest): Promise<AgentInstallation> {
    this.assertConnected(request.profileId);
    const cacheKey = `${request.profileId}:${request.agentKind}`;
    const cached = this.installations.get(cacheKey);
    if (cached !== undefined) return cached;
    const executable = request.agentKind;
    const remote = await this.inspectRemoteEnvironment(request.profileId);
    let installation: AgentInstallation;
    // The Linux gate exists because remote agent support was written and
    // tested against Linux hosts. This machine is a host CozyPad already runs
    // on, so it is qualified by definition — its uname reports MINGW/MSYS.
    const localHost = this.options.isLocalHost?.(request.profileId) === true;
    if (!localHost && remote.environment.osName.toLowerCase() !== 'linux') {
      installation = {
        agentKind: request.agentKind,
        installed: false,
        installationScope: 'unknown',
        environment: remote.environment,
        supportsStructuredOutput: false,
        supportsResume: false,
        supportsInteractiveApproval: false,
        supportsDangerouslySkipPermissions: false,
        launchModes: [],
        detail: `Unsupported remote OS: ${describeEnvironment(remote.environment)}. Agent sessions currently require Linux.`,
      };
    } else {
      const output = await this.options.transport.exec(
        buildAgentCapabilityProbeCommand(
          executable,
          remote.loginPath,
          request.agentKind,
        ),
        12_000,
      );
      if (output.includes('__COZYPAD_MISSING__=1')) {
        installation = {
          agentKind: request.agentKind,
          installed: false,
          installationScope: 'unknown',
          environment: remote.environment,
          supportsStructuredOutput: false,
          supportsResume: false,
          supportsInteractiveApproval: false,
          supportsDangerouslySkipPermissions: false,
          launchModes: [],
          detail: `${executable} was not found in the PATH initialized by ${remote.environment.loginShell ?? 'the remote login shell'} (${describeEnvironment(remote.environment)})`,
        };
      } else {
        const executablePath = markerValue(output, '__COZYPAD_EXECUTABLE__');
        const realPath = markerValue(output, '__COZYPAD_REAL_PATH__');
        const whichPath = markerValue(output, '__COZYPAD_WHICH__');
        const version = markerValue(output, '__COZYPAD_VERSION__');
        const helpOutput = markerBlock(output, 'HELP_OUTPUT') || output;
        const protocolHelpOutput = markerBlock(output, 'PROTOCOL_HELP_OUTPUT');
        const versionOutput = markerBlock(output, 'VERSION_OUTPUT');
        const versionStatus = Number.parseInt(
          markerValue(output, '__COZYPAD_VERSION_STATUS__') ?? '0',
          10,
        );
        const helpStatus = Number.parseInt(
          markerValue(output, '__COZYPAD_HELP_STATUS__') ?? '0',
          10,
        );
        const protocolHelpStatus = Number.parseInt(
          markerValue(output, '__COZYPAD_PROTOCOL_HELP_STATUS__') ?? '0',
          10,
        );
        const probeError = [
          ...(versionStatus === 0 || versionOutput === '' ? [] : [versionOutput]),
          ...(helpStatus === 0 || helpOutput === '' ? [] : [helpOutput]),
        ].join('\n');
        const probeSucceeded =
          versionStatus === 0 &&
          helpStatus === 0 &&
          (request.agentKind !== 'codex' || protocolHelpStatus === 0);
        const whichMismatch =
          whichPath !== undefined &&
          whichPath.startsWith('/') &&
          whichPath !== executablePath;
        const userScoped =
          executablePath !== undefined &&
          realPath !== undefined &&
          isPathInsideHome(executablePath, remote.homeDirectory) &&
          isPathInsideHome(realPath, remote.homeDirectory) &&
          !whichMismatch;
        const nativeAgy =
          request.agentKind === 'agy' && userScoped && probeSucceeded;
        const structured =
          userScoped &&
          probeSucceeded &&
          (request.agentKind === 'claude'
            ? helpOutput.includes('--output-format') &&
              helpOutput.includes('--input-format')
            : request.agentKind === 'codex'
              ? helpOutput.includes('app-server') &&
                protocolHelpOutput.includes('--listen')
              : false);
        const compatible = nativeAgy || structured;
        const approvals =
          compatible &&
          (request.agentKind === 'claude'
            ? helpOutput.includes('--permission-prompt-tool')
            : request.agentKind === 'codex' || request.agentKind === 'agy');
        const launchModes = compatible
          ? launchModesFor(request.agentKind, `${helpOutput}\n${protocolHelpOutput}`)
          : [];
        installation = {
          agentKind: request.agentKind,
          installed: executablePath !== undefined,
          ...(executablePath === undefined ? {} : { executablePath }),
          ...(version === undefined ? {} : { version }),
          installationScope: userScoped ? 'user' : 'system',
          environment: remote.environment,
          supportsStructuredOutput: structured,
          supportsResume:
            userScoped &&
            probeSucceeded &&
            ((request.agentKind === 'claude' && helpOutput.includes('--resume')) ||
              (request.agentKind === 'agy' &&
                helpOutput.includes('--conversation'))),
          supportsInteractiveApproval: approvals,
          supportsDangerouslySkipPermissions:
            userScoped &&
            probeSucceeded &&
            (request.agentKind === 'claude'
              ? helpOutput.includes('--dangerously-skip-permissions')
              : request.agentKind === 'codex'
                ? helpOutput.includes('--yolo') ||
                  helpOutput.includes('--dangerously-bypass-approvals-and-sandbox')
                : helpOutput.includes('--dangerously-skip-permissions')),
          launchModes,
          ...(!userScoped
            ? {
                detail: `${executable} resolved to ${executablePath ?? 'an unknown executable'}, but CozyPad requires a per-user installation whose executable and real path are both under ${remote.homeDirectory}`,
              }
            : probeError !== ''
              ? { detail: `${executable} capability probe failed:\n${probeError}` }
            : !compatible
              ? {
                  detail:
                    request.agentKind === 'codex'
                      ? `${executable} does not expose the Codex app-server JSONL protocol`
                      : request.agentKind === 'agy'
                        ? `${executable} could not be launched as an interactive AGY terminal`
                        : `${executable} does not expose bidirectional stream-json mode`,
                }
              : !approvals
                ? {
                    detail:
                    `${executable} does not expose stdio permission prompts`,
                  }
                : {}),
        };
      }
    }
    this.installations.set(cacheKey, installation);
    return installation;
  }

  list(request: AgentSessionListRequest): AgentSessionBundle[] {
    return [...this.sessions.values()]
      .filter(
        (stored) =>
          stored.record.provisionalIdentity.connectionProfileId === request.profileId,
      )
      .sort((left, right) => right.record.updatedAt.localeCompare(left.record.updatedAt))
      .map((stored) => this.bundle(stored));
  }

  /**
   * The wrapper script a session's agent runs inside: PATH from the login
   * shell, exit status recorded for the follow loop, and — for chat agents —
   * stdio redirected into the session's NDJSON log. Shared by create and
   * revive so a relaunched agent runs exactly what the original did, plus the
   * resume flag when one applies.
   */
  private buildLaunchScript(options: {
    agentKind: CreateAgentSessionRequest['agentKind'];
    interactionMode: 'chat' | 'terminal';
    executablePath: string;
    launchMode: string;
    remote: ResolvedRemoteEnvironment;
    sessionId: string;
    resumeConversationId?: string;
    /** AGY only: `--continue`, resuming its most recent conversation. */
    resumeLatest?: boolean;
  }): string {
    const { agentKind, interactionMode, executablePath, launchMode, remote } =
      options;
    const argv =
      agentKind === 'claude'
        ? buildClaudeStreamingArgv({
            executable: executablePath,
            ...(options.resumeConversationId === undefined
              ? {}
              : { resumeConversationId: options.resumeConversationId }),
            ...(launchMode === 'default' || launchMode === 'bypassPermissions'
              ? {}
              : {
                  permissionMode: launchMode as
                    | 'acceptEdits'
                    | 'plan'
                    | 'auto'
                    | 'dontAsk',
                }),
            dangerouslySkipPermissions: launchMode === 'bypassPermissions',
            ...(['dontAsk', 'bypassPermissions'].includes(launchMode)
              ? {}
              : { permissionPromptTool: 'stdio' }),
          })
        : agentKind === 'codex'
          ? [executablePath, 'app-server', '--listen', 'stdio://']
          : interactionMode === 'terminal'
            ? [
                executablePath,
                ...(options.resumeConversationId !== undefined
                  ? ['--conversation', options.resumeConversationId]
                  : options.resumeLatest === true
                    ? ['--continue']
                    : []),
                ...(launchMode === 'sandbox' ? ['--sandbox'] : []),
                ...(launchMode === 'bypassPermissions'
                  ? ['--dangerously-skip-permissions']
                  : []),
              ]
            : [remote.commandShell, '-lc', 'while :; do sleep 3600; done'];
    const commandLine = argv.map((argument) => quoteShellArg(argument)).join(' ');
    const dir = remoteSessionDir(options.sessionId);
    const launchPath =
      remote.loginPath === ''
        ? ''
        : `PATH=${quoteShellArg(remote.loginPath)}
export PATH
`;
    const agentEnvironment =
      agentKind === 'claude'
        ? `unset CLAUDECODE
export CLAUDE_CODE_ENTRYPOINT=cozypad
`
        : '';
    return agentKind === 'agy'
      ? `${launchPath}status_file="${dir}/launch-status"
rm -f "$status_file"
${commandLine}
agent_status=$?
printf '%s\n' "$agent_status" > "$status_file"
chmod 600 "$status_file" 2>/dev/null || true
printf '\n[CozyPad] AGY CLI exited with status %s\n' "$agent_status"
exit "$agent_status"`
      : `${launchPath}stty -echo 2>/dev/null || true
${agentEnvironment}
status_file="${dir}/launch-status"
rm -f "$status_file"
${commandLine} >> "${dir}/raw-events.ndjson" 2>> "${dir}/stderr.log"
agent_status=$?
printf '%s\n' "$agent_status" > "$status_file"
chmod 600 "$status_file" 2>/dev/null || true
printf '\n[CozyPad] ${agentLabelFor(agentKind)} exited during startup with status %s\n' "$agent_status" >> "${dir}/stderr.log"
exit "$agent_status"`;
  }

  async create(request: CreateAgentSessionRequest): Promise<AgentSessionBundle> {
    this.assertConnected(request.profileId);
    const interactionMode =
      request.agentKind === 'agy' ? 'terminal' : (request.interactionMode ?? 'chat');
    if (interactionMode === 'terminal' && request.agentKind !== 'agy') {
      throw new Error('Native CLI sessions are currently available for AGY only');
    }
    const installation = await this.detect({
      profileId: request.profileId,
      agentKind: request.agentKind,
    });
    const defaultLaunchMode =
      request.agentKind === 'codex' ? 'workspace-request' : 'default';
    const legacyLaunchMode =
      request.permissionMode === 'dangerouslySkip'
        ? request.agentKind === 'claude'
          ? 'bypassPermissions'
          : request.agentKind === 'codex'
            ? 'yolo'
            : 'bypassPermissions'
        : request.permissionMode === 'prompt'
          ? defaultLaunchMode
          : undefined;
    const launchMode = request.launchMode ?? legacyLaunchMode ?? defaultLaunchMode;
    const selectedLaunchMode = installation.launchModes.find(
      (mode) => mode.id === launchMode,
    );
    if (
      !installation.installed ||
      (interactionMode === 'chat' && !installation.supportsStructuredOutput) ||
      installation.installationScope !== 'user' ||
      installation.executablePath === undefined ||
      selectedLaunchMode === undefined ||
      (selectedLaunchMode.risk === 'dangerous' &&
        installation.supportsDangerouslySkipPermissions !== true)
    ) {
      throw new Error(
        installation.detail ??
          `${request.agentKind} ${interactionMode === 'chat' ? 'structured communication' : 'native CLI'} mode is unavailable`,
      );
    }
    const profile = this.options.profileStore.get(request.profileId);
    if (profile === undefined) throw new Error(`unknown profile: ${request.profileId}`);

    const id = randomUUID();
    const now = new Date().toISOString();
    await this.prepareRemoteStorage(id);
    const remote = await this.inspectRemoteEnvironment(request.profileId);
    const agentLabel = agentLabelFor(request.agentKind);
    const launchScript = this.buildLaunchScript({
      agentKind: request.agentKind,
      interactionMode,
      executablePath: installation.executablePath,
      launchMode,
      remote,
      sessionId: id,
    });
    let runtime: Awaited<ReturnType<AgentTmuxPort['newSession']>>;
    try {
      runtime = await this.options.tmux.newSession({
        name: id,
        cwd: request.cwd,
        argv: [remote.commandShell, '-lc', launchScript],
      });
    } catch (error) {
      throw await this.withStartupDiagnostics(id, request.cwd, remote, error);
    }
    const record: RemoteAgentSessionRecord = {
      id,
      identity: null,
      provisionalIdentity: {
        connectionProfileId: request.profileId,
        tmuxSocket: this.options.tmux.socketName,
        tmuxSessionId: runtime.sessionId,
        agentKind: request.agentKind,
        launchNonce: randomUUID(),
      },
      projectId: request.cwd,
      cwd: request.cwd,
      title:
        request.title ??
        `New ${agentLabel} conversation`,
      status: 'starting',
      tmuxCreatedEpoch: runtime.createdEpoch,
      createdAt: now,
      updatedAt: now,
      lastEventSequence: 0,
    };
    const stored: StoredAgentSession = {
      record,
      paneId: runtime.paneId,
      host: `${profile.username}@${profile.host}`,
      project: projectName(request.cwd),
      timeline: [],
      turnCounter: 0,
      rawLines: 0,
      pendingControls: {},
      questionAnswers: {},
      slashCommands: [],
      attachments: {},
      interactionMode,
      launchMode,
    };
    this.sessions.set(id, stored);
    await this.writeRemoteMetadata(stored);
    await this.persist();
    this.emitSession(stored);
    this.emitTimeline(stored);
    this.followSession(stored);

    try {
      await this.startAgentConversation(stored, launchMode);
      await this.persist();
      this.emitSession(stored);
      return this.bundle(stored);
    } catch (error) {
      const surfacedError = await this.withStartupDiagnostics(
        id,
        request.cwd,
        remote,
        error,
      );
      stored.record = {
        ...stored.record,
        status: 'error',
        updatedAt: new Date().toISOString(),
      };
      this.appendError(stored, surfacedError);
      await this.persist();
      this.emitSession(stored);
      this.emitTimeline(stored);
      throw surfacedError;
    }
  }

  /**
   * Bring a freshly launched agent process to a usable state: the protocol
   * handshake for chat agents, and proof that the process survived startup.
   * Shared by create and revive.
   */
  private async startAgentConversation(
    stored: StoredAgentSession,
    launchMode: string,
  ): Promise<void> {
    const agentKind = stored.record.provisionalIdentity.agentKind;
    const id = stored.record.id;
    if (agentKind === 'claude') {
      await this.writeFrame(stored, {
        type: 'control_request',
        request_id: `initialize_${randomUUID()}`,
        request: { subtype: 'initialize', hooks: null },
      });
    } else if (agentKind === 'codex') {
      const policy = codexPolicyForMode(launchMode);
      await this.writeFrame(stored, {
        id: `initialize_${id}`,
        method: 'initialize',
        params: {
          clientInfo: {
            name: 'cozypad',
            title: 'CozyPad',
            version: '0.3.0',
          },
        },
      });
      await this.writeFrame(stored, { method: 'initialized', params: {} });
      await this.writeFrame(stored, {
        id: `thread_start_${id}`,
        method: 'thread/start',
        params: {
          cwd: stored.record.cwd,
          approvalPolicy: policy.approvalPolicy,
          sandbox: policy.sandbox,
          serviceName: 'cozypad',
        },
      });
    } else {
      stored.record = {
        ...stored.record,
        status: 'ready',
        updatedAt: new Date().toISOString(),
      };
    }
    await this.assertAgentStayedAlive(id, agentKind);
    if (
      !(await this.options.tmux.hasSession(
        stored.record.provisionalIdentity.tmuxSessionId,
      ))
    ) {
      throw new Error(
        `${agentKind} exited during startup; inspect the remote stderr log`,
      );
    }
    if (agentKind === 'claude') {
      stored.record = {
        ...stored.record,
        status: 'ready',
        updatedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * Relaunch an exited session's agent in place. The record, timeline, and
   * title survive; the process is new. Claude resumes its bound conversation
   * (`--resume`); Codex starts a fresh app-server thread — the old one died
   * with its process; AGY reopens its own CLI, where its conversation list
   * offers the previous session.
   */
  async revive(request: AgentSessionRequest): Promise<AgentSessionBundle> {
    const stored = this.requireSession(request.sessionId);
    const profileId = stored.record.provisionalIdentity.connectionProfileId;
    this.assertConnected(profileId);
    if (stored.record.status !== 'exited' && stored.record.status !== 'error') {
      return this.bundle(stored);
    }
    const agentKind = stored.record.provisionalIdentity.agentKind;
    const installation = await this.detect({ profileId, agentKind });
    if (
      !installation.installed ||
      installation.installationScope !== 'user' ||
      installation.executablePath === undefined
    ) {
      throw new Error(
        installation.detail ?? `${agentKind} is no longer available on this host`,
      );
    }
    const launchMode =
      stored.launchMode ?? (agentKind === 'codex' ? 'workspace-request' : 'default');
    const remote = await this.inspectRemoteEnvironment(profileId);
    const id = stored.record.id;
    // An errored launch can leave its runtime session behind, and the local
    // runtime keeps a dead session's name until it is killed — either would
    // block the relaunch.
    await this.options.tmux
      .killSession(stored.record.provisionalIdentity.tmuxSessionId)
      .catch(() => undefined);
    await this.prepareRemoteStorage(id);
    // The logs were just truncated; the dead run's stream state goes with them.
    stored.rawLines = 0;
    stored.pendingControls = {};
    stored.questionAnswers = {};
    stored.activeTurn = undefined;
    stored.activeAgentTurnId = undefined;
    const resumeConversationId =
      agentKind === 'claude' && installation.supportsResume
        ? stored.record.identity?.agentConversationId
        : undefined;
    // AGY's conversation id is never learned from its TUI, but the CLI itself
    // remembers: `--continue` reopens the most recent conversation, which for
    // a revived session is the one this record was following.
    const resumeLatest = agentKind === 'agy' && installation.supportsResume;
    if (resumeLatest) stored.revived = true;
    const launchScript = this.buildLaunchScript({
      agentKind,
      interactionMode: stored.interactionMode,
      executablePath: installation.executablePath,
      launchMode,
      remote,
      sessionId: id,
      ...(resumeConversationId === undefined ? {} : { resumeConversationId }),
      ...(resumeLatest ? { resumeLatest: true } : {}),
    });
    let runtime: Awaited<ReturnType<AgentTmuxPort['newSession']>>;
    try {
      runtime = await this.options.tmux.newSession({
        name: id,
        cwd: stored.record.cwd,
        argv: [remote.commandShell, '-lc', launchScript],
      });
    } catch (error) {
      throw await this.withStartupDiagnostics(id, stored.record.cwd, remote, error);
    }
    stored.paneId = runtime.paneId;
    stored.record = {
      ...stored.record,
      provisionalIdentity: {
        ...stored.record.provisionalIdentity,
        tmuxSocket: this.options.tmux.socketName,
        tmuxSessionId: runtime.sessionId,
        launchNonce: randomUUID(),
      },
      status: 'starting',
      tmuxCreatedEpoch: runtime.createdEpoch,
      updatedAt: new Date().toISOString(),
    };
    await this.writeRemoteMetadata(stored).catch(() => undefined);
    await this.persist();
    this.emitSession(stored);
    this.followSession(stored);
    try {
      await this.startAgentConversation(stored, launchMode);
      await this.persist();
      this.emitSession(stored);
      return this.bundle(stored);
    } catch (error) {
      const surfacedError = await this.withStartupDiagnostics(
        id,
        stored.record.cwd,
        remote,
        error,
      );
      stored.record = {
        ...stored.record,
        status: 'error',
        updatedAt: new Date().toISOString(),
      };
      this.appendError(stored, surfacedError);
      await this.persist();
      this.emitSession(stored);
      this.emitTimeline(stored);
      throw surfacedError;
    }
  }

  /**
   * The transcript of a revived AGY session, from AGY's own store. Guarded to
   * revived sessions on the local host: a fresh conversation showing someone
   * else's history would be far worse than showing none.
   */
  async readAgyTranscript(request: AgentSessionRequest): Promise<AgyTranscript> {
    const stored = this.requireSession(request.sessionId);
    const profileId = stored.record.provisionalIdentity.connectionProfileId;
    if (
      stored.record.provisionalIdentity.agentKind !== 'agy' ||
      stored.revived !== true ||
      this.activeProfileId !== profileId ||
      this.options.isLocalHost?.(profileId) !== true ||
      this.options.readLocalAgyTranscript === undefined
    ) {
      return { turns: [] };
    }
    try {
      return { turns: await this.options.readLocalAgyTranscript() };
    } catch {
      return { turns: [] };
    }
  }

  async rename(request: RenameAgentSessionRequest): Promise<void> {
    const stored = this.requireSession(request.sessionId);
    stored.record = {
      ...stored.record,
      title: request.title,
      updatedAt: new Date().toISOString(),
    };
    await this.persist();
    this.emitSession(stored);
    await this.writeRemoteMetadata(stored).catch(() => undefined);
  }

  async delete(request: AgentSessionRequest): Promise<void> {
    const stored = this.requireSession(request.sessionId);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(stored.record.id)) {
      throw new Error('Refusing to delete a session with an unsafe identifier');
    }
    const profileId = stored.record.provisionalIdentity.connectionProfileId;
    // Forget the session before touching the host. Killing its tmux session
    // ends the follow stream, whose completion handlers report the death as an
    // error and emit one last update — arriving after the UI had already
    // dropped the row and putting it straight back. Their `sessions.get()`
    // guard only works if the record is gone first.
    this.sessions.delete(stored.record.id);
    this.following.delete(stored.record.id);
    this.completing.delete(stored.record.id);
    await this.persist();
    this.events.onSessionDeleted({
      sessionId: stored.record.id,
      agentKind: stored.record.provisionalIdentity.agentKind,
    });

    // Deleting must always clear the local record. Sessions outlive a
    // connection, so refusing while the host is unreachable leaves entries the
    // user can never get rid of. Remote cleanup is attempted whenever it can
    // be, and reported when it cannot.
    if (this.activeProfileId === profileId) {
      try {
        await this.options.tmux.killSession(
          stored.record.provisionalIdentity.tmuxSessionId,
        );
        await this.removeRemoteSessionStorage(stored);
      } catch (error) {
        this.events.onError({
          sessionId: stored.record.id,
          message: `Removed locally, but the remote session could not be cleaned up: ${this.errorMessage(error)}`,
        });
      }
      return;
    }
    this.events.onError({
      sessionId: stored.record.id,
      message:
        'Removed locally. Its tmux session is still on the host — reconnect with that profile to clean it up.',
    });
  }

  async openTerminal(request: AgentTerminalOpenRequest): Promise<TerminalOpened> {
    const stored = this.requireSession(request.sessionId);
    this.assertSessionConnected(stored);
    if (
      stored.record.provisionalIdentity.agentKind !== 'agy' ||
      stored.interactionMode !== 'terminal'
    ) {
      throw new Error('This session does not expose a native AGY terminal');
    }
    const profileId = stored.record.provisionalIdentity.connectionProfileId;
    // A local session already owns a pseudo-console — there is nothing to
    // attach to, and spawning a second one would start a second agent.
    const existing = this.options.attachExisting?.(
      stored.record.provisionalIdentity.tmuxSessionId,
    );
    if (existing !== undefined) return { terminalId: existing };
    // A local session IS its console; with the console gone there is nothing
    // to attach to, and the tmux command below would just fail in the shell.
    if (this.options.isLocalHost?.(profileId) === true) {
      throw new Error(
        'This session\'s process has ended — select the session again to wake it.',
      );
    }

    const tmux =
      this.options.tmux.socketName === 'default'
        ? 'tmux'
        : `tmux -L ${quoteShellArg(this.options.tmux.socketName)} -f /dev/null`;
    const target = quoteShellArg(
      stored.record.provisionalIdentity.tmuxSessionId,
    );
    // Start tmux as the PTY channel's command. Typing `exec tmux ...` into a
    // login shell races shell startup and, on some SSH servers, leaves tmux
    // connected to a non-TTY stdin even though a shell channel was requested.
    //
    // The status line is turned off first. CozyPad parses this screen as AGY's
    // UI, so tmux's own row would both be read as agent output and push AGY's
    // prompt out of the bottom rows the parser inspects.
    const terminalId = await this.options.transport.openTerminal(
      {
        profileId,
        cols: request.cols,
        rows: request.rows,
      },
      `${tmux} set-option -t ${target} status off >/dev/null 2>&1; exec ${tmux} attach-session -t ${target}`,
    );
    return { terminalId };
  }

  async uploadAttachment(
    request: UploadAgentAttachmentRequest,
  ): Promise<AgentAttachment> {
    const stored = this.requireSession(request.sessionId);
    this.assertSessionConnected(stored);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(request.dataBase64)) {
      throw new Error('Attachment payload is not valid base64');
    }
    const bytes = Buffer.from(request.dataBase64, 'base64');
    if (bytes.byteLength > MAX_AGENT_ATTACHMENT_BYTES) {
      throw new Error(
        `Attachment is too large (${bytes.byteLength} bytes, limit ${MAX_AGENT_ATTACHMENT_BYTES} bytes)`,
      );
    }
    const id = randomUUID();
    const directory = await this.prepareAttachmentDirectory(stored);
    const remotePath = `${directory}/${id}-${safeAttachmentName(request.name)}`;
    await this.options.transport.writeFile(remotePath, bytes);
    const attachment = AgentAttachmentSchema.parse({
      id,
      sessionId: stored.record.id,
      name: request.name,
      mediaType: request.mediaType,
      sizeBytes: bytes.byteLength,
      remotePath,
    });
    stored.attachments[id] = attachment;
    await this.persist();
    return attachment;
  }

  async send(request: SendAgentMessageRequest): Promise<void> {
    const stored = this.requireSession(request.sessionId);
    this.assertSessionConnected(stored);
    if (stored.interactionMode === 'terminal') {
      throw new Error('This AGY session uses the native CLI; send input in its terminal');
    }
    if (
      stored.activeTurn !== undefined ||
      stored.record.status === 'running' ||
      stored.record.status === 'waiting_approval'
    ) {
      throw new Error('Agent is waiting for the current turn to finish');
    }
    const attachments = (request.attachmentIds ?? []).map((attachmentId) => {
      const attachment = stored.attachments[attachmentId];
      if (attachment === undefined || attachment.sessionId !== stored.record.id) {
        throw new Error(`Unknown attachment for this session: ${attachmentId}`);
      }
      return attachment;
    });
    const attachmentText =
      attachments.length === 0
        ? ''
        : [
            'The user attached these files. They were uploaded into this session workspace; use the Read tool on the exact remote paths when you need their contents:',
            ...attachments.map(
              (attachment) =>
                `- ${attachment.name} (${attachment.mediaType}, ${attachment.sizeBytes} bytes): ${attachment.remotePath}`,
            ),
          ].join('\n');
    const messageText = [request.text.trim(), attachmentText]
      .filter((part) => part !== '')
      .join('\n\n');
    const timelineText =
      request.text.trim() === ''
        ? `Attached: ${attachments.map((attachment) => attachment.name).join(', ')}`
        : request.text;
    const now = new Date().toISOString();
    const codexLocalCommand =
      stored.record.provisionalIdentity.agentKind === 'codex' &&
      attachments.length === 0
        ? request.text.trim()
        : '';
    if (codexLocalCommand === '/status' || codexLocalCommand === '/diff') {
      stored.timeline.push({
        id: `user-${randomUUID()}`,
        kind: 'message',
        role: 'user',
        text: codexLocalCommand,
        timestamp: now,
      });
      if (codexLocalCommand === '/status') {
        stored.timeline.push({
          id: `assistant-${randomUUID()}`,
          kind: 'message',
          role: 'assistant',
          text: [
            `Agent: Codex`,
            `Status: ${stored.record.status}`,
            `Workspace: ${stored.record.cwd}`,
            `Thread: ${stored.record.identity?.agentConversationId ?? 'initializing'}`,
          ].join('\n'),
          timestamp: now,
        });
      } else {
        const diff = await this.options.transport.exec(
          `cd ${quoteShellArg(stored.record.cwd)} 2>/dev/null || exit 0
git diff --no-ext-diff --unified=3 2>/dev/null || true
`,
          10_000,
        );
        if (diff.trim() === '') {
          stored.timeline.push({
            id: `assistant-${randomUUID()}`,
            kind: 'message',
            role: 'assistant',
            text: 'No unstaged working-tree changes.',
            timestamp: now,
          });
        } else {
          const lines = diff.split('\n');
          stored.timeline.push({
            id: `diff-${randomUUID()}`,
            kind: 'file_diff',
            path: 'working-tree.diff',
            additions: lines.filter(
              (line) => line.startsWith('+') && !line.startsWith('+++'),
            ).length,
            deletions: lines.filter(
              (line) => line.startsWith('-') && !line.startsWith('---'),
            ).length,
            diff,
            timestamp: now,
          });
        }
      }
      stored.record = { ...stored.record, updatedAt: now };
      await this.persist();
      this.emitSession(stored);
      this.emitTimeline(stored);
      return;
    }
    stored.turnCounter += 1;
    stored.activeTurn = {
      id: String(stored.turnCounter).padStart(6, '0'),
      changedPaths: [],
    };
    stored.timeline.push({
      id: `user-${randomUUID()}`,
      kind: 'message',
      role: 'user',
      text: timelineText,
      timestamp: now,
    });
    if (/^New (?:Claude|Codex|AGY) conversation$/u.test(stored.record.title)) {
      stored.record.title = timelineText.slice(0, 64);
    }
    stored.record = { ...stored.record, status: 'running', updatedAt: now };
    await this.persist();
    this.emitSession(stored);
    this.emitTimeline(stored);

    try {
      if (stored.record.provisionalIdentity.agentKind === 'claude') {
        await this.writeFrame(stored, {
          type: 'user',
          message: { role: 'user', content: messageText },
          parent_tool_use_id: null,
          session_id: 'default',
        });
      } else if (stored.record.provisionalIdentity.agentKind === 'codex') {
        const threadId = stored.record.identity?.agentConversationId;
        if (threadId === undefined) {
          throw new Error('Codex app-server is still creating its thread');
        }
        if (codexLocalCommand === '/compact') {
          await this.writeFrame(stored, {
            id: `compact_${stored.record.id}_${stored.turnCounter}`,
            method: 'thread/compact/start',
            params: { threadId },
          });
        } else if (codexLocalCommand === '/review') {
          await this.writeFrame(stored, {
            id: `review_${stored.record.id}_${stored.turnCounter}`,
            method: 'review/start',
            params: {
              threadId,
              delivery: 'inline',
              target: { type: 'uncommittedChanges' },
            },
          });
        } else {
          await this.writeFrame(stored, {
            id: `turn_start_${stored.record.id}_${stored.turnCounter}`,
            method: 'turn/start',
            params: {
              threadId,
              cwd: stored.record.cwd,
              input: [
                { type: 'text', text: messageText },
                ...attachments.flatMap((attachment) =>
                  attachment.mediaType.startsWith('image/')
                    ? [{ type: 'localImage', path: attachment.remotePath }]
                    : [],
                ),
              ],
            },
          });
        }
      } else {
        throw new Error('AGY prompts must be entered in its native terminal');
      }
    } catch (error) {
      stored.activeTurn = undefined;
      stored.record = {
        ...stored.record,
        status: 'error',
        updatedAt: new Date().toISOString(),
      };
      this.appendError(stored, error);
      await this.persist();
      this.emitSession(stored);
      this.emitTimeline(stored);
      throw error;
    }
  }

  async interrupt(request: AgentSessionRequest): Promise<void> {
    const stored = this.requireSession(request.sessionId);
    this.assertSessionConnected(stored);
    if (stored.record.provisionalIdentity.agentKind === 'codex') {
      const threadId = stored.record.identity?.agentConversationId;
      if (threadId === undefined || stored.activeAgentTurnId === undefined) {
        throw new Error('Codex has no active turn to interrupt');
      }
      await this.writeFrame(stored, {
        id: `interrupt_${randomUUID()}`,
        method: 'turn/interrupt',
        params: { threadId, turnId: stored.activeAgentTurnId },
      });
    } else if (stored.record.provisionalIdentity.agentKind === 'claude') {
      await this.writeFrame(stored, {
        type: 'control_request',
        request_id: `interrupt_${randomUUID()}`,
        request: { subtype: 'interrupt' },
      });
    } else if (stored.record.provisionalIdentity.agentKind === 'agy') {
      await this.options.tmux.escape(stored.paneId);
    } else {
      await this.options.tmux.interrupt(stored.paneId);
    }
  }

  async resolveApproval(request: ResolveAgentApprovalRequest): Promise<void> {
    const stored = this.requireSession(request.sessionId);
    this.assertSessionConnected(stored);
    const item = stored.timeline.find(
      (candidate): candidate is Extract<ChatItem, { kind: 'approval' }> =>
        candidate.id === request.itemId && candidate.kind === 'approval',
    );
    if (item === undefined || item.resolution !== 'pending') {
      throw new Error('Pending approval request not found');
    }
    const requestId = request.itemId.replace(/^approval-/u, '');
    const pending = stored.pendingControls[requestId];
    if (pending === undefined) throw new Error('Approval control request has expired');
    if (pending.protocol === 'codex') {
      await this.writeFrame(stored, {
        id: pending.rpcId ?? requestId,
        result: {
          decision: request.resolution === 'allowed' ? 'accept' : 'decline',
        },
      });
    } else {
      const response =
        request.resolution === 'allowed'
          ? { behavior: 'allow', updatedInput: pending.input }
          : { behavior: 'deny', message: 'Denied by the CozyPad user' };
      await this.writeControlResponse(stored, requestId, response);
    }
    delete stored.pendingControls[requestId];
    item.resolution = request.resolution;
    stored.record = {
      ...stored.record,
      status: 'running',
      updatedAt: new Date().toISOString(),
    };
    await this.persist();
    this.emitSession(stored);
    this.emitTimeline(stored);
  }

  async answerQuestion(request: AnswerAgentQuestionRequest): Promise<void> {
    const stored = this.requireSession(request.sessionId);
    this.assertSessionConnected(stored);
    const item = stored.timeline.find(
      (candidate): candidate is Extract<ChatItem, { kind: 'question' }> =>
        candidate.id === request.itemId && candidate.kind === 'question',
    );
    if (item === undefined || item.selectedIndex !== null) {
      throw new Error('Pending agent question not found');
    }
    const option = item.options[request.optionIndex];
    if (option === undefined) throw new Error('Question option not found');
    const rawQuestionId = request.itemId.replace(/^question-/u, '');
    const separator = rawQuestionId.lastIndexOf(':');
    if (separator < 1) throw new Error('Question control request is invalid');
    const requestId = rawQuestionId.slice(0, separator);
    const questionIndex = Number.parseInt(rawQuestionId.slice(separator + 1), 10);
    const pending = stored.pendingControls[requestId];
    if (
      pending === undefined ||
      !['AskUserQuestion', 'RequestUserInput'].includes(pending.toolName)
    ) {
      throw new Error('Question control request has expired');
    }
    const questions = Array.isArray(pending.input.questions)
      ? pending.input.questions
      : [];
    const rawQuestion = questions[questionIndex];
    if (!isRecord(rawQuestion) || typeof rawQuestion.question !== 'string') {
      throw new Error('Question payload is invalid');
    }
    item.selectedIndex = request.optionIndex;
    const answers = (stored.questionAnswers[requestId] ??= {});
    const answerKey =
      pending.protocol === 'codex' && typeof rawQuestion.id === 'string'
        ? rawQuestion.id
        : rawQuestion.question;
    answers[answerKey] = option.label;

    const relatedItems = stored.timeline.filter(
      (candidate): candidate is Extract<ChatItem, { kind: 'question' }> =>
        candidate.kind === 'question' &&
        candidate.id.startsWith(`question-${requestId}:`),
    );
    if (relatedItems.every((candidate) => candidate.selectedIndex !== null)) {
      if (pending.protocol === 'codex') {
        await this.writeFrame(stored, {
          id: pending.rpcId ?? requestId,
          result: {
            answers: Object.fromEntries(
              Object.entries(answers).map(([key, answer]) => [
                key,
                { answers: [answer] },
              ]),
            ),
          },
        });
      } else {
        await this.writeControlResponse(stored, requestId, {
          behavior: 'allow',
          updatedInput: { ...pending.input, answers },
        });
      }
      delete stored.pendingControls[requestId];
      delete stored.questionAnswers[requestId];
      stored.record = {
        ...stored.record,
        status: 'running',
        updatedAt: new Date().toISOString(),
      };
    }
    await this.persist();
    this.emitSession(stored);
    this.emitTimeline(stored);
  }

  private followSession(stored: StoredAgentSession): void {
    if (this.following.has(stored.record.id)) return;
    this.following.add(stored.record.id);
    const id = stored.record.id;
    const dir = remoteSessionDir(id);
    const startLine = stored.rawLines + 1;
    const tmux =
      this.options.tmux.socketName === 'default'
        ? 'tmux'
        : `tmux -L ${quoteShellArg(this.options.tmux.socketName)}`;
    const target = quoteShellArg(stored.record.provisionalIdentity.tmuxSessionId);
    // Liveness has a different witness per host. Remotely tmux is what keeps
    // the agent alive, so its session is the thing to watch. Locally there is
    // no tmux: the launch wrapper writes launch-status the moment the agent
    // exits, and the log file disappearing means the session's storage was
    // deleted out from under us — either way the stream is over.
    const liveGuard = this.options.isLocalHost?.(
      stored.record.provisionalIdentity.connectionProfileId,
    )
      ? `[ -f "$log" ] && [ ! -s "${dir}/launch-status" ]`
      : `${tmux} has-session -t ${target} 2>/dev/null`;
    const processExitCheck = `  if [ -s "${dir}/launch-status" ]; then break; fi
`;
    const command = `log="${dir}/raw-events.ndjson"
next=${startLine}
emit_new_lines() {
  if [ -f "$log" ]; then
    total=$(wc -l < "$log")
    if [ "$total" -ge "$next" ]; then
      sed -n "\${next},\${total}p" "$log"
      next=$((total + 1))
    fi
  fi
}
while ${liveGuard}; do
  emit_new_lines
${processExitCheck}  sleep 0.2
done
emit_new_lines
printf '__COZYPAD_AGENT_EXIT__\\n'
`;
    let exited = false;
    let sequence = stored.record.lastEventSequence;
    const context: ClaudeParseContext | CodexParseContext = {
      localSessionId: id,
      ...(stored.record.identity === null
        ? {}
        : { agentConversationId: stored.record.identity.agentConversationId }),
      nextSequence: () => ++sequence,
      nextEventId: () => randomUUID(),
      now: () => new Date().toISOString(),
    };
    void this.options.transport
      .execStream(
        command,
        (line) => {
          if (line === '__COZYPAD_AGENT_EXIT__') {
            exited = true;
            return;
          }
          const current = this.sessions.get(id);
          if (current === undefined) return;
          current.rawLines += 1;
          const agentKind = current.record.provisionalIdentity.agentKind;
          if (agentKind === 'agy') return;
          const control =
            agentKind === 'codex'
              ? parseCodexControlRequest(line)
              : agentKind === 'claude'
                ? parseControlRequest(line)
                : null;
          if (control !== null) current.pendingControls[control.requestId] = control;
          if (agentKind === 'codex') {
            const turnId = parseCodexTurnId(line);
            if (turnId !== undefined) current.activeAgentTurnId = turnId;
          }
          const events =
            agentKind === 'codex'
              ? parseCodexAppServerLine(line, context)
              : parseClaudeStreamLine(line, context, agentKind);
          for (const event of events) this.applyNormalizedEvent(current, event);
          void this.persist();
        },
        0,
        false,
      )
      .catch(async (error: unknown) => {
        const current = this.sessions.get(id);
        if (
          current === undefined ||
          this.activeProfileId !==
            current.record.provisionalIdentity.connectionProfileId
        ) {
          return;
        }
        const alive = await this.options.tmux
          .hasSession(current.record.provisionalIdentity.tmuxSessionId)
          .catch(() => false);
        if (alive) return;
        current.record = {
          ...current.record,
          status: 'error',
          updatedAt: new Date().toISOString(),
        };
        this.appendError(current, await this.withRemoteStderr(id, error));
        await this.persist();
        this.emitSession(current);
        this.emitTimeline(current);
      })
      .finally(async () => {
        this.following.delete(id);
        const current = this.sessions.get(id);
        if (current === undefined) return;
        if (exited) {
          const stderr = await this.readRemoteStderr(id);
          if (stderr !== '') {
            this.appendError(current, new Error(`Remote agent stderr:\n${stderr}`));
          }
          current.record = {
            ...current.record,
            status: 'exited',
            updatedAt: new Date().toISOString(),
          };
          current.activeTurn = undefined;
          await this.persist();
          this.emitSession(current);
          return;
        }
        if (
          this.activeProfileId ===
            current.record.provisionalIdentity.connectionProfileId
        ) {
          const alive = await this.options.tmux
            .hasSession(current.record.provisionalIdentity.tmuxSessionId)
            .catch(() => false);
          if (alive) this.followSession(current);
        }
      });
  }

  private applyNormalizedEvent(
    stored: StoredAgentSession,
    event: NormalizedAgentEvent,
  ): void {
    stored.record = {
      ...stored.record,
      lastEventSequence: event.sequence,
      updatedAt: event.timestamp,
    };
    const activeTurn = stored.activeTurn;
    switch (event.kind) {
      case 'session_initialized': {
        if (event.slashCommands !== undefined) {
          stored.slashCommands = normalizeSlashCommands(event.slashCommands);
        }
        if (event.agentConversationId === undefined) break;
        if (stored.record.status === 'starting') {
          stored.record = { ...stored.record, status: 'ready' };
        }
        const profileId = stored.record.provisionalIdentity.connectionProfileId;
        const fingerprint = this.options.getHostFingerprint(profileId);
        if (fingerprint === undefined) {
          this.events.onError({
            sessionId: stored.record.id,
            message: 'Cannot bind agent identity without a trusted host fingerprint',
          });
          break;
        }
        try {
          stored.record = bindAgentIdentity(stored.record, {
            agentConversationId: event.agentConversationId,
            remoteHostFingerprint: fingerprint,
            tmuxPaneId: stored.paneId,
            now: event.timestamp,
          });
        } catch {
          // A revived agent can open a NEW conversation — Codex threads die
          // with their process, and Claude's --resume may fork. The binding's
          // whole job is to find this session's conversation again, so it
          // follows the agent rather than pinning the record to a dead id.
          stored.record = bindAgentIdentity(
            { ...stored.record, identity: null },
            {
              agentConversationId: event.agentConversationId,
              remoteHostFingerprint: fingerprint,
              tmuxPaneId: stored.paneId,
              now: event.timestamp,
            },
          );
        }
        void this.writeRemoteMetadata(stored).catch(() => undefined);
        break;
      }
      case 'assistant_message_started': {
        if (activeTurn === undefined || activeTurn.assistantItemId !== undefined) break;
        const id = `assistant-${event.eventId}`;
        activeTurn.assistantItemId = id;
        stored.timeline.push({
          id,
          kind: 'message',
          role: 'assistant',
          text: '',
          streaming: true,
          timestamp: event.timestamp,
        });
        break;
      }
      case 'assistant_text_delta': {
        if (activeTurn === undefined) break;
        if (activeTurn.assistantItemId === undefined) {
          activeTurn.assistantItemId = `assistant-${event.eventId}`;
          stored.timeline.push({
            id: activeTurn.assistantItemId,
            kind: 'message',
            role: 'assistant',
            text: event.text,
            streaming: true,
            timestamp: event.timestamp,
          });
        } else {
          const item = stored.timeline.find(
            (candidate) => candidate.id === activeTurn.assistantItemId,
          );
          if (item?.kind === 'message') item.text += event.text;
        }
        break;
      }
      case 'assistant_message_completed': {
        const current =
          activeTurn?.assistantItemId === undefined
            ? undefined
            : stored.timeline.find(
                (candidate) => candidate.id === activeTurn.assistantItemId,
              );
        if (current?.kind === 'message') {
          current.text = event.text;
          current.streaming = false;
        } else {
          stored.timeline.push({
            id: `assistant-${event.eventId}`,
            kind: 'message',
            role: 'assistant',
            text: event.text,
            timestamp: event.timestamp,
          });
        }
        if (activeTurn !== undefined) activeTurn.assistantItemId = undefined;
        break;
      }
      case 'tool_call_started': {
        stored.timeline.push({
          id: `tool-${event.toolCallId}`,
          kind: 'tool_call',
          name: event.name,
          summary: event.inputSummary,
          status: 'running',
          timestamp: event.timestamp,
        });
        const changedPath = this.pathFromToolInput(event.name, event.inputSummary);
        if (
          changedPath !== null &&
          activeTurn !== undefined &&
          !activeTurn.changedPaths.includes(changedPath)
        ) {
          activeTurn.changedPaths.push(changedPath);
        }
        break;
      }
      case 'tool_call_updated': {
        const item = stored.timeline.find(
          (candidate) => candidate.id === `tool-${event.toolCallId}`,
        );
        if (item?.kind === 'tool_call') item.output = event.update;
        break;
      }
      case 'tool_call_completed': {
        const item = stored.timeline.find(
          (candidate) => candidate.id === `tool-${event.toolCallId}`,
        );
        if (item?.kind === 'tool_call') {
          item.status = event.isError ? 'error' : 'completed';
          item.output = event.output;
        }
        break;
      }
      case 'approval_requested':
        stored.timeline.push({
          id: `approval-${event.approvalId}`,
          kind: 'approval',
          command: event.command,
          cwd: stored.record.cwd,
          riskSummary: event.riskSummary,
          resolution: 'pending',
          timestamp: event.timestamp,
        });
        stored.record = { ...stored.record, status: 'waiting_approval' };
        break;
      case 'approval_resolved': {
        const item = stored.timeline.find(
          (candidate) => candidate.id === `approval-${event.approvalId}`,
        );
        if (item?.kind === 'approval') item.resolution = event.resolution;
        break;
      }
      case 'question_requested':
        stored.timeline.push({
          id: `question-${event.questionId}`,
          kind: 'question',
          prompt: event.prompt,
          options: event.options,
          selectedIndex: null,
          timestamp: event.timestamp,
        });
        stored.record = { ...stored.record, status: 'waiting_approval' };
        break;
      case 'question_resolved': {
        const item = stored.timeline.find(
          (candidate) => candidate.id === `question-${event.questionId}`,
        );
        if (item?.kind === 'question') item.selectedIndex = event.selectedIndex;
        break;
      }
      case 'file_diff':
        stored.timeline.push({
          id: `diff-${event.eventId}`,
          kind: 'file_diff',
          path: event.path,
          additions: event.additions,
          deletions: event.deletions,
          diff: event.diff,
          timestamp: event.timestamp,
        });
        break;
      case 'usage':
        stored.timeline.push({
          id: `usage-${event.eventId}`,
          kind: 'usage',
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          timestamp: event.timestamp,
        });
        break;
      case 'agent_error':
        this.appendError(stored, new Error(event.message), event.timestamp);
        break;
      case 'turn_completed':
        void this.completeTurn(stored);
        break;
      case 'activity':
      case 'command_output':
      case 'user_message':
        break;
    }
    this.emitSession(stored);
    this.emitTimeline(stored);
  }

  private async completeTurn(stored: StoredAgentSession): Promise<void> {
    if (this.completing.has(stored.record.id)) return;
    this.completing.add(stored.record.id);
    try {
      await this.collectChangedFiles(stored);
      stored.activeTurn = undefined;
      stored.activeAgentTurnId = undefined;
      stored.record = {
        ...stored.record,
        status: 'ready',
        updatedAt: new Date().toISOString(),
      };
      await this.persist();
      this.emitSession(stored);
      this.emitTimeline(stored);
    } finally {
      this.completing.delete(stored.record.id);
    }
  }

  private async collectChangedFiles(stored: StoredAgentSession): Promise<void> {
    const paths = stored.activeTurn?.changedPaths ?? [];
    for (const changedPath of paths) {
      const relative = this.relativeProjectPath(stored.record.cwd, changedPath);
      if (relative === null) continue;
      const cwd = quoteShellArg(stored.record.cwd);
      const file = quoteShellArg(relative);
      const output = await this.options.transport
        .exec(
          `cd ${cwd} 2>/dev/null || exit 0
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then exit 0; fi
if git ls-files --error-unmatch -- ${file} >/dev/null 2>&1; then
  git diff --no-ext-diff --unified=3 -- ${file}
elif [ -f ${file} ]; then
  git diff --no-ext-diff --no-index --unified=3 -- /dev/null ${file} || true
fi
`,
          10_000,
        )
        .catch(() => '');
      if (output.trim() === '') continue;
      const lines = output.split('\n');
      stored.timeline.push({
        id: `diff-${randomUUID()}`,
        kind: 'file_diff',
        path: relative,
        additions: lines.filter(
          (line) => line.startsWith('+') && !line.startsWith('+++'),
        ).length,
        deletions: lines.filter(
          (line) => line.startsWith('-') && !line.startsWith('---'),
        ).length,
        diff: output,
        timestamp: new Date().toISOString(),
      });
    }
  }

  private pathFromToolInput(toolName: string, summary: string): string | null {
    const normalizedToolName = toolName.replace(/[^a-z]/giu, '').toLowerCase();
    if (
      !['edit', 'write', 'writefile', 'replace', 'notebookedit'].includes(
        normalizedToolName,
      )
    ) {
      return null;
    }
    try {
      const input = JSON.parse(summary) as Record<string, unknown>;
      for (const key of ['file_path', 'notebook_path', 'path']) {
        if (typeof input[key] === 'string') return input[key];
      }
    } catch {
      // Truncated tool input cannot be used safely as a path.
    }
    return null;
  }

  private relativeProjectPath(cwd: string, candidate: string): string | null {
    const normalizedCwd = cwd.replace(/\\/gu, '/').replace(/\/$/u, '');
    const normalized = candidate.replace(/\\/gu, '/');
    const relative = normalized.startsWith(`${normalizedCwd}/`)
      ? normalized.slice(normalizedCwd.length + 1)
      : normalized;
    if (relative.startsWith('/') || relative === '..' || relative.startsWith('../')) {
      return null;
    }
    return relative;
  }

  private async prepareRemoteStorage(sessionId: string): Promise<void> {
    const dir = remoteSessionDir(sessionId);
    await this.options.transport.exec(
      `session_dir="${dir}"
mkdir -p "$session_dir"
: > "$session_dir/raw-events.ndjson"
: > "$session_dir/stderr.log"
rm -f "$session_dir/launch-status"
chmod 700 "$session_dir"
chmod 600 "$session_dir/raw-events.ndjson" "$session_dir/stderr.log"
`,
      8000,
    );
  }

  private async removeRemoteSessionStorage(
    stored: StoredAgentSession,
  ): Promise<void> {
    const sessionId = quoteShellArg(stored.record.id);
    const cwd = quoteShellArg(stored.record.cwd);
    await this.options.transport.exec(
      `session_id=${sessionId}
case "$session_id" in
  ''|*[!A-Za-z0-9_-]*) echo "__ERROR__\tunsafe session id"; exit 1 ;;
esac
session_root="$HOME/.cozypad/sessions"
session_dir="$session_root/$session_id"
case "$session_dir" in
  "$session_root"/*) rm -rf -- "$session_dir" ;;
  *) echo "__ERROR__\tunsafe session directory"; exit 1 ;;
esac
cwd=${cwd}
case "$cwd" in
  '~') cwd="$HOME" ;;
  '~/'*) cwd="$HOME/\${cwd#~/}" ;;
esac
if [ -d "$cwd" ]; then
  cwd_real="$(cd "$cwd" 2>/dev/null && pwd -P)"
  attachment_root="$cwd_real/.cozypad/session-tmp"
  attachment_dir="$attachment_root/$session_id"
  case "$attachment_dir" in
    "$attachment_root"/*) rm -rf -- "$attachment_dir" ;;
    *) echo "__ERROR__\tunsafe attachment directory"; exit 1 ;;
  esac
fi
printf '__OK__\n'
`,
      10_000,
    );
  }

  private async prepareAttachmentDirectory(
    stored: StoredAgentSession,
  ): Promise<string> {
    const cwd = quoteShellArg(stored.record.cwd);
    const sessionId = quoteShellArg(stored.record.id);
    const output = await this.options.transport.exec(
      `cwd=${cwd}
case "$cwd" in
  '~') cwd="$HOME" ;;
  '~/'*) cwd="$HOME/\${cwd#~/}" ;;
esac
if [ ! -d "$cwd" ]; then
  echo "__ERROR__\tWorking directory does not exist: $cwd"
  exit 0
fi
cd "$cwd" 2>/dev/null || {
  echo "__ERROR__\tWorking directory is not accessible: $cwd"
  exit 0
}
# On the local Windows host the shell is MSYS: pwd -P prints /d/... paths that
# neither Node's fs nor a Windows agent can open. pwd -W prints the drive-style
# path; elsewhere the flag does not exist and pwd -P is used as before.
cwd_real="$(pwd -W 2>/dev/null || pwd -P)"
session_id=${sessionId}
attachment_dir="$cwd_real/.cozypad/session-tmp/$session_id/attachments"
mkdir -p -- "$attachment_dir" || {
  echo "__ERROR__\tUnable to create the session attachment directory"
  exit 0
}
attachment_real="$(cd "$attachment_dir" 2>/dev/null && (pwd -W 2>/dev/null || pwd -P))"
case "$attachment_real" in
  "$cwd_real"/*) ;;
  *)
    echo "__ERROR__\tAttachment directory resolves outside the selected workspace"
    exit 0
    ;;
esac
chmod 700 -- "$cwd_real/.cozypad/session-tmp/$session_id" "$attachment_real" 2>/dev/null || true
printf '__COZYPAD_ATTACHMENT_DIR__=%s\n' "$(printf '%s' "$attachment_real" | base64 | tr -d '\\n')"
`,
      10_000,
    );
    const errorLine = output
      .split(/\r?\n/u)
      .find((line) => line.startsWith('__ERROR__'));
    if (errorLine !== undefined) {
      throw new Error(errorLine.split('\t').slice(1).join('\t') || 'Attachment directory setup failed');
    }
    const encoded = markerValue(output, '__COZYPAD_ATTACHMENT_DIR__');
    if (encoded === undefined) {
      throw new Error('Remote host did not return the session attachment directory');
    }
    const directory = Buffer.from(encoded, 'base64').toString('utf8');
    // Absolute POSIX path, or drive-style on the local Windows host.
    if (!/^(?:[A-Za-z]:)?\//u.test(directory)) {
      throw new Error('Remote host returned an invalid session attachment directory');
    }
    return directory;
  }

  private async readRemoteStderr(sessionId: string): Promise<string> {
    try {
      const output = await this.options.transport.exec(
        `tail -n 80 "$HOME/.cozypad/sessions/${sessionId}/stderr.log" 2>/dev/null || true
`,
        5000,
      );
      return output.trim();
    } catch {
      return '';
    }
  }

  private async withRemoteStderr(
    sessionId: string,
    error: unknown,
  ): Promise<Error> {
    const message = this.errorMessage(error);
    const stderr = await this.readRemoteStderr(sessionId);
    return new Error(stderr === '' ? message : `${message}\n\nRemote stderr:\n${stderr}`);
  }

  private async assertAgentStayedAlive(
    sessionId: string,
    agentKind: 'claude' | 'codex' | 'agy',
  ): Promise<void> {
    const dir = remoteSessionDir(sessionId);
    const output = await this.options.transport.exec(
      `status_file="${dir}/launch-status"
attempt=0
while [ "$attempt" -lt 10 ]; do
  if [ -s "$status_file" ]; then
    status="$(head -n 1 "$status_file" 2>/dev/null || true)"
    printf '__COZYPAD_AGENT_STATUS__=%s\n' "\${status:-unknown}"
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 0.1
done
printf '__COZYPAD_AGENT_STATUS__=running\n'
`,
      3000,
    );
    const status = markerValue(output, '__COZYPAD_AGENT_STATUS__');
    if (status === undefined) {
      throw new Error('Remote agent startup probe returned no status');
    }
    if (status !== 'running') {
      const label =
        agentKind === 'claude' ? 'Claude' : agentKind === 'codex' ? 'Codex' : 'AGY';
      throw new Error(`${label} exited during startup with status ${status}`);
    }
  }

  private async withStartupDiagnostics(
    sessionId: string,
    cwd: string,
    remote: ResolvedRemoteEnvironment,
    error: unknown,
  ): Promise<Error> {
    const surfaced = await this.withRemoteStderr(sessionId, error);
    if (surfaced.message.includes('\n\nRemote stderr:\n')) return surfaced;

    const diagnostics = await this.readRemoteStartupDiagnostics(cwd, remote);
    return new Error(
      diagnostics === ''
        ? surfaced.message
        : `${surfaced.message}\n\nRemote startup diagnostics:\n${diagnostics}`,
    );
  }

  private async readRemoteStartupDiagnostics(
    cwd: string,
    remote: ResolvedRemoteEnvironment,
  ): Promise<string> {
    try {
      const output = await this.options.transport.exec(
        `cwd=${quoteShellArg(cwd.trim() === '' ? '~' : cwd.trim())}
case "$cwd" in
  '~') cwd="$HOME" ;;
  '~/'*) cwd="$HOME/\${cwd#~/}" ;;
esac
tmux_path="$(command -v tmux 2>/dev/null || true)"
tmux_version="$(tmux -V 2>&1)"
tmux_version_status=$?
user_name="$(id -un 2>/dev/null || whoami 2>/dev/null || printf unknown)"
user_id="$(id -u 2>/dev/null || printf unknown)"
tmp_base="\${TMUX_TMPDIR:-/tmp}"
printf '__COZYPAD_STARTUP_DIAGNOSTICS__\n'
printf 'bridge: isolated-tmux-v2\n'
printf 'remote: %s / %s / %s\n' ${quoteShellArg(remote.environment.distribution ?? 'unknown distribution')} ${quoteShellArg(remote.environment.kernelRelease ?? 'unknown kernel')} ${quoteShellArg(remote.environment.architecture ?? 'unknown architecture')}
printf 'user: %s (uid %s)\n' "$user_name" "$user_id"
printf 'shell: %s\n' ${quoteShellArg(remote.commandShell)}
printf 'tmux: %s; version: %s; version exit: %s; socket: %s\n' "\${tmux_path:-not found}" "\${tmux_version:-unavailable}" "$tmux_version_status" ${quoteShellArg(this.options.tmux.socketName)}
if [ -d "$cwd" ]; then
  if [ -x "$cwd" ] && [ -r "$cwd" ]; then cwd_state=accessible; else cwd_state=not-accessible; fi
else
  cwd_state=missing
fi
printf 'working directory: %s (%s)\n' "$cwd" "$cwd_state"
if [ -d "$tmp_base" ] && [ -w "$tmp_base" ] && [ -x "$tmp_base" ]; then
  tmp_state=usable
else
  tmp_state=not-usable
fi
printf 'tmux temp base: %s (%s)\n' "$tmp_base" "$tmp_state"
`,
        5000,
      );
      const marker = '__COZYPAD_STARTUP_DIAGNOSTICS__\n';
      const markerIndex = output.indexOf(marker);
      return (markerIndex < 0 ? output : output.slice(markerIndex + marker.length)).trim();
    } catch (diagnosticError) {
      return `diagnostic command failed: ${this.errorMessage(diagnosticError)}`;
    }
  }

  private async writeRemoteMetadata(stored: StoredAgentSession): Promise<void> {
    const dir = remoteSessionDir(stored.record.id);
    const metadata = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        localSessionId: stored.record.id,
        agentKind: stored.record.provisionalIdentity.agentKind,
        tmuxSocket: stored.record.provisionalIdentity.tmuxSocket,
        tmuxSessionId: stored.record.provisionalIdentity.tmuxSessionId,
        tmuxPaneId: stored.paneId,
        agentConversationId: stored.record.identity?.agentConversationId ?? null,
        cwd: stored.record.cwd,
        title: stored.record.title,
        createdAt: stored.record.createdAt,
      }),
      'utf8',
    ).toString('base64');
    await this.options.transport.exec(
      `session_dir="${dir}"
mkdir -p "$session_dir"
printf '%s' ${quoteShellArg(metadata)} | base64 -d > "$session_dir/metadata.json.tmp"
chmod 600 "$session_dir/metadata.json.tmp"
mv "$session_dir/metadata.json.tmp" "$session_dir/metadata.json"
`,
      8000,
    );
  }

  private writeFrame(
    stored: StoredAgentSession,
    frame: Record<string, unknown>,
  ): Promise<void> {
    return this.options.tmux.sendText(stored.paneId, JSON.stringify(frame));
  }

  private writeControlResponse(
    stored: StoredAgentSession,
    requestId: string,
    response: Record<string, unknown>,
  ): Promise<void> {
    return this.writeFrame(stored, {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response,
      },
    });
  }

  private appendError(
    stored: StoredAgentSession,
    error: unknown,
    timestamp = new Date().toISOString(),
  ): void {
    const message = this.errorMessage(error);
    stored.timeline.push({
      id: `error-${randomUUID()}`,
      kind: 'message',
      role: 'assistant',
      text: `Agent error: ${message}`,
      timestamp,
    });
    this.events.onError({ sessionId: stored.record.id, message });
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private bundle(stored: StoredAgentSession): AgentSessionBundle {
    return { session: this.summary(stored), items: [...stored.timeline] };
  }

  private summary(stored: StoredAgentSession): AgentSessionSummary {
    return AgentSessionSummarySchema.parse({
      id: stored.record.id,
      agentKind: stored.record.provisionalIdentity.agentKind,
      title: stored.record.title,
      host: stored.host,
      project: stored.project,
      cwd: stored.record.cwd,
      interactionMode: stored.interactionMode,
      status: stored.record.status,
      unread: 0,
      slashCommands: normalizeSlashCommands(stored.slashCommands),
      updatedAt: stored.record.updatedAt,
    });
  }

  private emitSession(stored: StoredAgentSession): void {
    this.events.onSessionChanged({ session: this.summary(stored) });
  }

  private emitTimeline(stored: StoredAgentSession): void {
    this.events.onTimelineChanged({
      sessionId: stored.record.id,
      items: [...stored.timeline],
    });
  }

  private assertConnected(profileId: string): void {
    if (this.activeProfileId !== profileId) {
      throw new Error('The requested SSH profile is not connected');
    }
  }

  private assertSessionConnected(stored: StoredAgentSession): void {
    this.assertConnected(stored.record.provisionalIdentity.connectionProfileId);
    if (stored.record.status === 'exited') {
      throw new Error('Agent tmux session has exited');
    }
  }

  private requireSession(sessionId: string): StoredAgentSession {
    const stored = this.sessions.get(sessionId);
    if (stored === undefined) throw new Error(`unknown agent session: ${sessionId}`);
    return stored;
  }

  private persist(): Promise<void> {
    const payload: PersistedAgentStore = {
      version: 1,
      sessions: [...this.sessions.values()],
    };
    const raw = JSON.stringify(payload, null, 2);
    this.persistQueue = this.persistQueue.then(async () => {
      await fs.mkdir(path.dirname(this.options.storePath), { recursive: true });
      const temp = `${this.options.storePath}.tmp`;
      await fs.writeFile(temp, raw, 'utf8');
      await fs.rename(temp, this.options.storePath);
    });
    return this.persistQueue;
  }
}

import { randomUUID } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  AgentAttachmentSchema,
  AgentConfigOptionSchema,
  AgentSessionSummarySchema,
  ChatItemSchema,
  MAX_AGENT_ATTACHMENT_BYTES,
  MAX_AGENT_ATTACHMENTS,
  RemoteAgentSessionRecordSchema,
  bindAgentIdentity,
  quoteShellArg,
} from '@cozypad/contracts';
import type {
  AgentCommunicationErrorEvent,
  AgentAttachment,
  ArchiveAgentSessionRequest,
  AgentDetectionRequest,
  AgentInstallation,
  AgentLaunchMode,
  AgyRecoveredTurn,
  AgentSessionBundle,
  AgentSessionChangedEvent,
  AgentSessionDeletedEvent,
  AgentSessionListRequest,
  AgentSessionRequest,
  AgentSessionSummary,
  AgentTimelineChangedEvent,
  AnswerAgentQuestionRequest,
  ChatItem,
  CreateAgentSessionRequest,
  DeclineAgentQuestionRequest,
  DeleteAgentSessionResult,
  RemoteAgentSessionRecord,
  RemoteHostEnvironment,
  RenameAgentSessionRequest,
  ResolveAgentApprovalRequest,
  SendAgentMessageRequest,
  SetAgentSessionConfigOptionRequest,
  UploadAgentAttachmentsRequest,
} from '@cozypad/contracts';
import { AGY_CONVERSATION_META_KEY } from '@cozypad/adapter-agy';
import { reconcileSessions } from '@cozypad/tmux-runtime';
import type { TmuxRuntime } from '@cozypad/tmux-runtime';
import type {
  AcpDiscoveredSession,
  AcpSessionContinuation,
} from './acp/acpAgentRuntime';
import type { ProfileStorePort } from './profileStore';
import type { TransportPort } from './transport/TransportPort';

interface ActiveTurn {
  id: string;
  assistantItemId?: string;
  changedPaths: string[];
}

interface StoredAgentSession {
  record: RemoteAgentSessionRecord;
  paneId: string;
  host: string;
  project: string;
  timeline: ChatItem[];
  turnCounter: number;
  slashCommands: string[];
  /** Per-command help, shown next to the name in the composer's menu. */
  slashCommandDescriptions?: Record<string, string>;
  /**
   * What the agent said it can be configured with (model, codex effort),
   * verbatim from the last session open or set_config_option response.
   * Runtime state: refreshed on every start, so never persisted.
   */
  configOptions?: unknown;
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
  /**
   * How the last Resume relates to the native conversation (SPEC 3.4.5
   * requires the header to say): continued the bound one, assumed a guessed
   * one, or started new. Revoked to 'new' if the agent then binds a
   * different conversation id.
   */
  resumeContinuity?: 'continued' | 'new' | 'assumed';
  /** Deterministic tie-breaker for same-millisecond cross-client updates. */
  registryMutationId?: string;
}

interface SessionTombstone {
  deletedAt: string;
  mutationId: string;
}

interface PersistedAgentStore {
  version: 2;
  sessions: StoredAgentSession[];
  tombstones?: Record<string, SessionTombstone>;
}

interface ResolvedRemoteEnvironment {
  environment: RemoteHostEnvironment;
  loginPath: string;
  homeDirectory: string;
  commandShell: string;
}

type AgentTmuxPort = Pick<
  TmuxRuntime,
  'socketName' | 'listSessions' | 'newSession' | 'hasSession' | 'killSession'
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
  list(
    request: AgentSessionListRequest,
  ): AgentSessionBundle[] | Promise<AgentSessionBundle[]>;
  create(request: CreateAgentSessionRequest): Promise<AgentSessionBundle>;
  revive(request: AgentSessionRequest): Promise<AgentSessionBundle>;
  archive(request: ArchiveAgentSessionRequest): Promise<AgentSessionBundle>;
  restore(request: AgentSessionRequest): Promise<AgentSessionBundle>;
  rename(request: RenameAgentSessionRequest): Promise<void>;
  delete(request: AgentSessionRequest): Promise<DeleteAgentSessionResult>;
  uploadAttachments(
    request: UploadAgentAttachmentsRequest,
  ): Promise<AgentAttachment[]>;
  send(request: SendAgentMessageRequest): Promise<void>;
  interrupt(request: AgentSessionRequest): Promise<void>;
  setConfigOption(request: SetAgentSessionConfigOptionRequest): Promise<void>;
  resolveApproval(request: ResolveAgentApprovalRequest): Promise<void>;
  answerQuestion(request: AnswerAgentQuestionRequest): Promise<void>;
  declineQuestion(request: DeclineAgentQuestionRequest): Promise<void>;
}

export interface AgentCommunicationServiceOptions {
  transport: TransportPort;
  tmux: AgentTmuxPort;
  profileStore: ProfileStorePort;
  storePath: string;
  /** The store is physically scoped to one target host (for remote host RPC). */
  hostScopedStore?: boolean;
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
  /** Most recently active local AGY conversation, used to bind legacy sessions. */
  getLatestLocalAgyConversationId?(window?: {
    notBefore?: number;
    notAfter?: number;
  }): Promise<string | undefined>;
  /**
   * Reads one conversation out of the local AGY store, for restoring a
   * revived session's transcript. Absent on hosts without one.
   */
  readLocalAgyTranscript?(conversationId?: string): Promise<AgyRecoveredTurn[]>;
  /** Enumerates native history from the target host's own home directory. */
  discoverStoredSessions?(
    agentKind: string,
    homeDirectory: string,
  ): Promise<AcpDiscoveredSession[]>;
  /**
   * Called when the session store could not be read and was moved aside.
   *
   * Startup uses this to tell the user, because the alternative — an app that
   * silently forgot every session — is the failure mode people report as data
   * loss. `backupPath` is null when even the rename failed.
   */
  onStoreRecovered?(info: { reason: string; backupPath: string | null }): void;
  /**
   * The ACP runtime, for agents driven by a protocol rather than a terminal.
   * Optional so tests can construct the service without spawning anything.
   */
  acp?: {
    has(sessionId: string): boolean;
    discover?(
      agentKind: string,
      cwd: string,
      remote?: boolean,
    ): Promise<AcpDiscoveredSession[]>;
    start(
      sessionId: string,
      cwd: string,
      agentKind: string,
      continuation?: AcpSessionContinuation,
      desiredModeId?: string,
      remote?: boolean,
    ): Promise<{
      acpSessionId: string;
      continued: boolean;
      configOptions: unknown;
      modes: {
        currentModeId?: string;
        availableModes: readonly { id: string; name?: string }[];
      };
      appliedModeId?: string;
    }>;
    setConfigOption(
      sessionId: string,
      configId: string,
      value: string,
    ): Promise<unknown>;
    prompt(sessionId: string, text: string): Promise<string>;
    cancel(sessionId: string): Promise<void>;
    /**
     * Answers a permission or elicitation request the agent is waiting on.
     * `null` declines. ACP models both as requests, so the answer is a return
     * value the runtime is holding open, not a frame written back.
     */
    resolveControl(sessionId: string, requestId: string, optionId?: string | null): void;
    stop(sessionId: string): void;
  };
}

/**
 * The session store layout this build reads and writes.
 *
 * Named rather than inlined because {@link AgentCommunicationService.load}
 * reports it to the user when a store does not match, and a number that appears
 * in a message and in a comparison must not be able to drift apart.
 */
export const STORE_VERSION = 2;

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
cozypad_optional() {
  if command -v timeout >/dev/null 2>&1; then
    timeout 3s "$cozypad_executable" "$@" 2>&1
    return $?
  fi
  return 124
}
${
  agentKind === 'agy'
    ? 'cozypad_version_output=""\ncozypad_version_status=124'
    : 'cozypad_version_output="$(cozypad_optional --version)"\ncozypad_version_status=$?'
}
echo "__COZYPAD_VERSION__=$(echo "$cozypad_version_output" | head -n 1)"
echo "__COZYPAD_VERSION_STATUS__=$cozypad_version_status"
echo "__COZYPAD_VERSION_OUTPUT_BEGIN__"
echo "$cozypad_version_output"
echo "__COZYPAD_VERSION_OUTPUT_END__"
${
  agentKind === 'agy'
    ? 'cozypad_help_output=""\ncozypad_help_status=124'
    : 'cozypad_help_output="$(cozypad_optional --help)"\ncozypad_help_status=$?'
}
echo "__COZYPAD_HELP_STATUS__=$cozypad_help_status"
echo "__COZYPAD_HELP_OUTPUT_BEGIN__"
echo "$cozypad_help_output"
echo "__COZYPAD_HELP_OUTPUT_END__"
cozypad_protocol_help_output=""
cozypad_protocol_help_status=0
${
  agentKind === 'codex'
    ? 'cozypad_protocol_help_output="$(cozypad_optional app-server --help)"\ncozypad_protocol_help_status=$?'
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

// Values are the kebab-case variants from `codex app-server generate-ts`
// (v2 AskForApproval / SandboxMode, verified live against codex 0.146.0).
// The camelCase spellings were rejected with -32600 at thread/start, which
// made every Codex session fail before it could bind a thread.
function codexPolicyForMode(mode: string): {
  approvalPolicy: 'untrusted' | 'on-request' | 'never';
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
} {
  switch (mode) {
    case 'read-only':
      return { approvalPolicy: 'on-request', sandbox: 'read-only' };
    case 'workspace-never':
      return { approvalPolicy: 'never', sandbox: 'workspace-write' };
    case 'yolo':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
    default:
      return { approvalPolicy: 'untrusted', sandbox: 'workspace-write' };
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

function attachmentStorageName(id: string, originalName: string): string {
  const safe = safeAttachmentName(originalName);
  const availableBytes = 100 - id.length - 1;
  if (Buffer.byteLength(safe, 'utf8') <= availableBytes) return `${id}-${safe}`;
  const extension = path.posix.extname(safe).slice(0, 16);
  const stemLength = Math.max(1, availableBytes - extension.length);
  const stem = safe.slice(0, stemLength).replace(/[.-]+$/gu, '') || 'attachment';
  return `${id}-${stem}${extension}`;
}

function writeTarOctal(
  header: Buffer,
  offset: number,
  length: number,
  value: number,
): void {
  const octal = Math.max(0, value).toString(8).padStart(length - 1, '0');
  header.write(octal.slice(-(length - 1)), offset, length - 1, 'ascii');
  header[offset + length - 1] = 0;
}

/** Build the small ustar archive sent through the transport's single file write. */
export function createAttachmentArchive(
  entries: Array<{ name: string; data: Buffer }>,
): Buffer {
  const blocks: Buffer[] = [];
  const timestamp = Math.floor(Date.now() / 1000);
  for (const entry of entries) {
    if (Buffer.byteLength(entry.name, 'utf8') > 100) {
      throw new Error('Attachment archive name exceeds the tar header limit');
    }
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, 'utf8');
    writeTarOctal(header, 100, 8, 0o600);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, entry.data.byteLength);
    writeTarOctal(header, 136, 12, timestamp);
    header.fill(0x20, 148, 156);
    header[156] = '0'.charCodeAt(0);
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    header.write('cozypad', 265, 7, 'ascii');
    header.write('cozypad', 297, 7, 'ascii');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0').slice(-6), 148, 6, 'ascii');
    header[154] = 0;
    header[155] = 0x20;
    blocks.push(header, entry.data);
    const padding = (512 - (entry.data.byteLength % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

export function buildAttachmentUnpackScript(
  directory: string,
  archivePath: string,
  landedPaths: string[],
): string {
  return `attachment_dir=${quoteShellArg(directory)}
archive=${quoteShellArg(archivePath)}
case "$archive" in
  "$attachment_dir"/*) ;;
  *) echo "__ERROR__\tUnsafe attachment archive path"; exit 0 ;;
esac
if ! command -v tar >/dev/null 2>&1; then
  rm -f -- "$archive"
  echo "__ERROR__\tThe selected machine needs tar to unpack attachment batches"
  exit 0
fi
# GNU tar treats the colon in a Windows drive path as remote-host syntax
# (D:/file.tar -> host D). Git Bash supplies cygpath, so translate only for the
# shell tools; CozyPad and the agent continue to receive the drive-style path.
archive_for_tar="$archive"
attachment_dir_for_tar="$attachment_dir"
case "$archive" in
  [A-Za-z]:/*)
    if ! command -v cygpath >/dev/null 2>&1; then
      rm -f -- "$archive"
      echo "__ERROR__\tUnable to unpack a Windows attachment batch because cygpath is unavailable"
      exit 0
    fi
    archive_for_tar="$(cygpath -u "$archive")"
    attachment_dir_for_tar="$(cygpath -u "$attachment_dir")"
    ;;
esac
tar_output=''
if ! tar_output="$(tar -xf "$archive_for_tar" -C "$attachment_dir_for_tar" 2>&1)"; then
  rm -f -- "$archive"
  tar_detail="$(printf '%s' "$tar_output" | tr '\r\n\t' '   ' | cut -c 1-400)"
  printf '__ERROR__\tUnable to unpack the attachment batch%s%s\n' \
    "\${tar_detail:+: }" "$tar_detail"
  exit 0
fi
rm -f -- "$archive"
chmod 600 -- ${landedPaths.map(quoteShellArg).join(' ')} 2>/dev/null || true
printf '__COZYPAD_ATTACHMENT_BATCH__=ok\n'
`;
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
    slashCommands,
    attachments,
    // Persisted sessions load as chat too. An agy session stored before the ACP
    // cutover would otherwise come back in a mode whose UI no longer exists,
    // with an enabled composer that throws the moment you press send.
    interactionMode: 'chat',
    ...(typeof value.launchMode === 'string'
      ? { launchMode: value.launchMode }
      : {}),
    ...(typeof value.activeAgentTurnId === 'string'
      ? { activeAgentTurnId: value.activeAgentTurnId }
      : {}),
    ...(activeTurn === undefined ? {} : { activeTurn }),
    ...(value.revived === true ? { revived: true } : {}),
    ...(typeof value.registryMutationId === 'string'
      ? { registryMutationId: value.registryMutationId }
      : {}),
  };
}


export class AgentCommunicationService implements AgentCommunicationPort {
  private events: AgentCommunicationEvents = EMPTY_EVENTS;
  private sessions = new Map<string, StoredAgentSession>();
  private activeProfileId: string | null = null;
  private persistQueue = Promise.resolve();
  private readonly persistedSnapshots = new Map<string, string>();
  private readonly tombstones = new Map<string, SessionTombstone>();
  private readonly pendingDeletions = new Set<string>();
  private readonly completing = new Set<string>();
  private readonly installations = new Map<string, AgentInstallation>();
  private readonly nativeDiscoveryInFlight = new Map<string, Promise<void>>();
  private readonly leaseOwner = `${process.pid}-${randomUUID()}`;
  private readonly heldSessionLeases = new Set<string>();
  private readonly managedSessionIds = new Set<string>();
  private leaseHeartbeat: NodeJS.Timeout | null = null;
  private leaseHeartbeatRunning = false;
  private leaseReleaseQueue = Promise.resolve();
  private readonly remoteEnvironments = new Map<
    string,
    Promise<ResolvedRemoteEnvironment>
  >();

  constructor(private readonly options: AgentCommunicationServiceOptions) {}

  /**
   * Reads the session store, and **never throws because of its contents**.
   *
   * It used to throw on a corrupt file or an unrecognised `version`, and the
   * only caller is `createServices()` in main.ts, which runs in the same `try`
   * as `registerIpc()`. So an unreadable session store did not degrade the
   * agent page — it stopped `window.cozypad` from ever being defined, and files,
   * terminal, monitor and settings all went with it. The user saw one dialog and
   * an app with nothing in it.
   *
   * That is a live hazard rather than a hypothetical one: this store's schema is
   * about to change for the ACP cutover, and a downgrade — running an older
   * build once against a newer store — is exactly the "unsupported version" case.
   *
   * So an unusable store is moved aside instead. The reason is reported through
   * {@link AgentCommunicationServiceOptions.onStoreRecovered} so startup can
   * surface it, and the file is kept: a session list is worth trying to recover
   * by hand, and silently deleting one would be worse than not reading it.
   */
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
      await this.quarantineStore('the file is not valid JSON');
      return;
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.sessions)) {
      await this.quarantineStore('the file has no session list');
      return;
    }
    if (parsed.version !== 1 && parsed.version !== STORE_VERSION) {
      await this.quarantineStore(
        `it was written by a different version of CozyPad (store version ${String(parsed.version)}, this build reads ${STORE_VERSION})`,
      );
      return;
    }
    for (const value of parsed.sessions) {
      const session = parseStoredSession(value);
      if (session !== null) {
        this.sessions.set(session.record.id, session);
        this.persistedSnapshots.set(session.record.id, JSON.stringify(session));
      }
    }
    if (isRecord(parsed.tombstones)) {
      for (const [sessionId, value] of Object.entries(parsed.tombstones)) {
        if (
          isRecord(value) &&
          typeof value.deletedAt === 'string' &&
          typeof value.mutationId === 'string'
        ) {
          this.tombstones.set(sessionId, {
            deletedAt: value.deletedAt,
            mutationId: value.mutationId,
          });
          this.sessions.delete(sessionId);
          this.persistedSnapshots.delete(sessionId);
        }
      }
    }
  }

  /**
   * Renames an unusable store aside and starts empty.
   *
   * The suffix is derived from the store's own path rather than a timestamp so
   * the result is deterministic and testable; an existing backup is overwritten
   * because the second failure of the same store is not more interesting than
   * the first, and an unbounded pile of `.bak` files is its own problem.
   */
  private async quarantineStore(reason: string): Promise<void> {
    const backup = `${this.options.storePath}.unreadable.bak`;
    let moved = false;
    try {
      await fs.rename(this.options.storePath, backup);
      moved = true;
    } catch {
      // A store that cannot even be renamed (locked, read-only, gone) must
      // still not take the whole app down. Starting empty is the point.
    }
    this.options.onStoreRecovered?.({ reason, backupPath: moved ? backup : null });
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
    const hostId = this.hostIdFor(profileId);
    let identityMigrated = false;
    for (const stored of this.sessions.values()) {
      const legacyMatch =
        stored.record.provisionalIdentity.connectionProfileId === profileId;
      const hostMatch = stored.record.provisionalIdentity.hostId === hostId;
      if (!legacyMatch && !hostMatch && this.options.hostScopedStore !== true) {
        continue;
      }
      const provisionalIdentity = {
        ...stored.record.provisionalIdentity,
        hostId,
        ...(this.options.hostScopedStore === true
          ? { connectionProfileId: profileId }
          : {}),
      };
      const identity =
        stored.record.identity === null
          ? null
          : {
              ...stored.record.identity,
              hostId,
              ...(this.options.hostScopedStore === true
                ? { connectionProfileId: profileId }
                : {}),
            };
      if (
        stored.record.provisionalIdentity.hostId !== hostId ||
        (this.options.hostScopedStore === true && !legacyMatch) ||
        stored.record.identity?.hostId !== identity?.hostId
      ) {
        stored.record = { ...stored.record, provisionalIdentity, identity };
        identityMigrated = true;
      }
      try {
        const canonicalCwd = await this.options.transport.fsRealpath(
          stored.record.cwd,
        );
        if (
          canonicalCwd !== stored.record.cwd ||
          stored.record.projectId !== canonicalCwd
        ) {
          stored.record = {
            ...stored.record,
            cwd: canonicalCwd,
            projectId: canonicalCwd,
          };
          stored.project = projectName(canonicalCwd);
          identityMigrated = true;
        }
      } catch {
        // A removed or temporarily inaccessible workspace must not make every
        // other session disappear. Revive will surface the filesystem error.
      }
    }
    const now = new Date().toISOString();
    const records = [...this.sessions.values()]
      .filter((session) => this.belongsToProfile(session, profileId))
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
    if (identityMigrated || result.updated.length > 0) await this.persist();
  }

  disconnected(profileId: string): void {
    if (this.activeProfileId === profileId) this.activeProfileId = null;
    this.clearDiscovery(profileId);
    const now = new Date().toISOString();
    for (const stored of this.sessions.values()) {
      if (
        this.belongsToProfile(stored, profileId) &&
        (this.managedSessionIds.has(stored.record.id) ||
          this.heldSessionLeases.has(stored.record.id)) &&
        stored.record.status !== 'exited'
      ) {
        // Leaving the host ends its agents; the bound conversation survives
        // and Resume continues it.
        this.options.acp?.stop(stored.record.id);
        this.releaseSessionLeaseSoon(stored.record.id);
        this.finalizeInFlightItems(stored);
        this.expirePendingInteractions(stored);
        stored.activeTurn = undefined;
        stored.activeAgentTurnId = undefined;
        stored.record = { ...stored.record, status: 'disconnected', updatedAt: now };
        this.emitSession(stored);
      }
      this.managedSessionIds.delete(stored.record.id);
    }
    void this.persist().catch(() => undefined);
  }

  /** Flushes ownership and registry state before a target host bridge exits. */
  async shutdown(profileId: string): Promise<void> {
    this.disconnected(profileId);
    await Promise.all([
      this.leaseReleaseQueue.catch(() => undefined),
      this.persistQueue.catch(() => undefined),
    ]);
  }

  private clearDiscovery(profileId: string): void {
    this.remoteEnvironments.delete(profileId);
    for (const key of this.installations.keys()) {
      if (key.startsWith(`${profileId}:`)) {
        this.installations.delete(key);
        this.nativeDiscoveryInFlight.delete(key);
      }
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
    if (cached !== undefined) {
      await this.refreshNativeDiscovery(request.profileId, request.agentKind, cached);
      return cached;
    }
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
        // Finding the executable and proving that both its entry point and
        // real path live under the user's home establishes installation.
        // Version/help calls are bounded, optional capability enrichment.
        const capabilityProbeSucceeded =
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
        const nativeAgy = request.agentKind === 'agy' && userScoped;
        const structured =
          userScoped &&
          capabilityProbeSucceeded &&
          (request.agentKind === 'claude'
            ? helpOutput.includes('--output-format') &&
              helpOutput.includes('--input-format')
            : request.agentKind === 'codex'
              ? helpOutput.includes('app-server') &&
                protocolHelpOutput.includes('--listen')
              : // agy. `false` used to be right: its own CLI has no structured
                // mode a client can drive, which is why CozyPad read its TUI
                // off a terminal instead. It does now, through
                // packages/adapter-agy — `-p --output-format stream-json`
                // translated to ACP. The capability is the adapter's, not the
                // binary's, so it does not depend on the help text.
                helpOutput.includes('--print') ||
                helpOutput.includes('--output-format'));
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
          // AGY's structured protocol is supplied by packages/adapter-agy;
          // its CLI help text is not the source of that capability.
          supportsStructuredOutput: compatible,
          supportsResume:
            userScoped &&
            ((request.agentKind === 'codex' && capabilityProbeSucceeded) ||
              (request.agentKind === 'claude' &&
                capabilityProbeSucceeded &&
                helpOutput.includes('--resume')) ||
              request.agentKind === 'agy'),
          supportsInteractiveApproval: approvals,
          supportsDangerouslySkipPermissions:
            userScoped &&
            capabilityProbeSucceeded &&
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
            : request.agentKind !== 'agy' && probeError !== ''
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
    await this.refreshNativeDiscovery(request.profileId, request.agentKind, installation);
    return installation;
  }

  private async refreshNativeDiscovery(
    profileId: string,
    agentKind: CreateAgentSessionRequest['agentKind'],
    installation: AgentInstallation,
  ): Promise<void> {
    const cacheKey = `${profileId}:${agentKind}`;
    const current = this.nativeDiscoveryInFlight.get(cacheKey);
    if (current !== undefined) return current;
    const pending = this.discoverNativeSessions(
      profileId,
      agentKind,
      installation.installed && installation.supportsStructuredOutput,
    )
      .catch((error) => {
        this.events.onError({
          message: `Unable to discover ${agentLabelFor(agentKind)} native conversations: ${this.errorMessage(error)}`,
        });
      })
      .finally(() => {
        if (this.nativeDiscoveryInFlight.get(cacheKey) === pending) {
          this.nativeDiscoveryInFlight.delete(cacheKey);
        }
      });
    this.nativeDiscoveryInFlight.set(cacheKey, pending);
    return pending;
  }

  private async discoverNativeSessions(
    profileId: string,
    agentKind: CreateAgentSessionRequest['agentKind'],
    includeAcp: boolean,
  ): Promise<void> {
    const remote = await this.inspectRemoteEnvironment(profileId);
    const sources: Array<Promise<AcpDiscoveredSession[]>> = [];
    const acp = this.options.acp;
    // AGY does not implement ACP session/list. Starting its adapter only to
    // learn that fact adds latency and used to leave every native DB invisible.
    if (includeAcp && agentKind !== 'agy' && acp?.discover !== undefined) {
      // Keep the runtime as the receiver. AcpAgentRuntime.discover reads private
      // spawn fields through `this`; extracting it as a bare callback makes
      // `this` undefined and turns native discovery into a misleading error.
      sources.push(
        acp.discover(
          agentKind,
          remote.homeDirectory,
          this.options.isLocalHost?.(profileId) !== true,
        ),
      );
    }
    if (this.options.discoverStoredSessions !== undefined) {
      sources.push(
        this.options.discoverStoredSessions(agentKind, remote.homeDirectory),
      );
    }
    if (sources.length === 0) return;
    const settled = await Promise.allSettled(sources);
    const successful = settled.filter(
      (result): result is PromiseFulfilledResult<AcpDiscoveredSession[]> =>
        result.status === 'fulfilled',
    );
    if (successful.length === 0) {
      throw (settled[0] as PromiseRejectedResult).reason;
    }
    const merged = new Map<string, AcpDiscoveredSession>();
    for (const result of successful) {
      for (const session of result.value) {
        const previous = merged.get(session.sessionId);
        merged.set(session.sessionId, {
          ...previous,
          ...session,
          title: session.title ?? previous?.title,
          updatedAt: session.updatedAt ?? previous?.updatedAt,
        });
      }
    }
    const sessions = [...merged.values()];
    // Disconnect is a hard access boundary. A slow native scan that completes
    // afterwards must not repopulate the registry or emit late host data.
    if (this.activeProfileId !== profileId) return;
    if (sessions.length === 0) return;
    const profile = this.options.profileStore.get(profileId);
    const fingerprint = this.options.getHostFingerprint(profileId);
    if (profile === undefined || fingerprint === undefined) return;
    const hostId = this.hostIdFor(profileId);
    let changed = false;
    for (const native of sessions) {
      const alreadyRegistered = [...this.sessions.values()].find(
        (stored) =>
          this.belongsToProfile(stored, profileId) &&
          stored.record.provisionalIdentity.agentKind === agentKind &&
          stored.record.identity?.agentConversationId === native.sessionId,
      );
      if (alreadyRegistered !== undefined) {
        if (
          native.updatedAt !== undefined &&
          Number.isFinite(Date.parse(native.updatedAt)) &&
          native.updatedAt.localeCompare(alreadyRegistered.record.updatedAt) > 0
        ) {
          alreadyRegistered.record = {
            ...alreadyRegistered.record,
            updatedAt: new Date(native.updatedAt).toISOString(),
          };
          alreadyRegistered.registryMutationId = randomUUID();
          changed = true;
        }
        continue;
      }
      let cwd = native.cwd;
      try {
        cwd = await this.options.transport.fsRealpath(native.cwd);
      } catch {
        // Native history can outlive its workspace. Keep it discoverable and
        // let Resume report that the path must be restored or changed.
      }
      const now = new Date().toISOString();
      const updatedAt =
        native.updatedAt !== undefined &&
        Number.isFinite(Date.parse(native.updatedAt))
          ? new Date(native.updatedAt).toISOString()
          : now;
      const id = randomUUID();
      const runtimeId = `native-${agentKind}-${id}`;
      const record: RemoteAgentSessionRecord = {
        id,
        identity: {
          hostId,
          connectionProfileId: profileId,
          remoteHostFingerprint: fingerprint,
          tmuxSocket: this.options.tmux.socketName,
          tmuxSessionId: runtimeId,
          agentKind,
          agentConversationId: native.sessionId,
        },
        provisionalIdentity: {
          hostId,
          connectionProfileId: profileId,
          tmuxSocket: this.options.tmux.socketName,
          tmuxSessionId: runtimeId,
          agentKind,
          launchNonce: randomUUID(),
        },
        projectId: cwd,
        cwd,
        title:
          native.title ?? `Imported ${agentLabelFor(agentKind)} conversation`,
        status: 'exited',
        archivedAt: null,
        tmuxCreatedEpoch: null,
        createdAt: updatedAt,
        updatedAt,
        lastEventSequence: 0,
      };
      this.sessions.set(id, {
        record,
        paneId: runtimeId,
        host: `${profile.username}@${profile.host}`,
        project: projectName(cwd),
        timeline: [
          {
            kind: 'notice',
            id: `notice-imported-${randomUUID()}`,
            timestamp: updatedAt,
            text: `Imported from ${agentLabelFor(agentKind)} native history. Resume loads the original conversation when the agent still supports it.`,
          },
        ],
        turnCounter: 0,
        slashCommands: [],
        attachments: {},
        interactionMode: 'chat',
        launchMode: agentKind === 'codex' ? 'workspace-request' : 'default',
        registryMutationId: randomUUID(),
      });
      changed = true;
    }
    if (!changed) return;
    await this.persist();
    for (const stored of this.sessions.values()) {
      if (!this.belongsToProfile(stored, profileId)) continue;
      this.emitSession(stored);
      this.emitTimeline(stored);
    }
  }

  list(request: AgentSessionListRequest): AgentSessionBundle[] {
    // Disconnect is an access boundary, not an offline-preview mode. In
    // particular, do not refresh the desktop registry from disk for a host the
    // user is no longer connected to.
    if (this.activeProfileId !== request.profileId) return [];
    this.refreshFromDiskSync();
    const archive = request.archive ?? 'active';
    return [...this.sessions.values()]
      .filter((stored) => this.belongsToProfile(stored, request.profileId))
      .filter((stored) =>
        request.projectId === undefined
          ? true
          : stored.record.projectId === request.projectId,
      )
      .filter((stored) => {
        if (archive === 'all') return true;
        const archived = stored.record.archivedAt !== null;
        return archive === 'archived' ? archived : !archived;
      })
      .sort((left, right) => right.record.updatedAt.localeCompare(left.record.updatedAt))
      .map((stored) => this.bundle(stored));
  }

  /** Raw, lossless records used only to migrate the former desktop-local index. */
  exportHostSessions(profileId: string): unknown[] {
    this.refreshFromDiskSync();
    return [...this.sessions.values()]
      .filter((stored) => this.belongsToProfile(stored, profileId))
      .map((stored) => JSON.parse(JSON.stringify(stored)) as unknown);
  }

  async importHostSessions(
    profileId: string,
    entries: readonly unknown[],
  ): Promise<number> {
    this.assertConnected(profileId);
    let imported = 0;
    const hostId = this.hostIdFor(profileId);
    for (const entry of entries) {
      const stored = parseStoredSession(entry);
      if (stored === null || this.tombstones.has(stored.record.id)) continue;
      const existing = this.sessions.get(stored.record.id);
      if (existing !== undefined && this.compareStored(existing, stored) >= 0) {
        continue;
      }
      let canonicalCwd = stored.record.cwd;
      try {
        canonicalCwd = await this.options.transport.fsRealpath(canonicalCwd);
      } catch {
        // Preserve a removed workspace so its conversation can still be read
        // and archived; Resume will report the concrete path failure.
      }
      stored.record = {
        ...stored.record,
        cwd: canonicalCwd,
        projectId: canonicalCwd,
        status:
          stored.record.status === 'exited' || stored.record.status === 'error'
            ? stored.record.status
            : 'disconnected',
        provisionalIdentity: {
          ...stored.record.provisionalIdentity,
          hostId,
          connectionProfileId: profileId,
        },
        identity:
          stored.record.identity === null
            ? null
            : {
                ...stored.record.identity,
                hostId,
                connectionProfileId: profileId,
              },
      };
      stored.project = projectName(canonicalCwd);
      stored.registryMutationId = randomUUID();
      this.sessions.set(stored.record.id, stored);
      imported += 1;
    }
    if (imported > 0) {
      await this.persist();
      for (const stored of this.sessions.values()) {
        if (this.belongsToProfile(stored, profileId)) {
          this.emitSession(stored);
          this.emitTimeline(stored);
        }
      }
    }
    return imported;
  }

  async forgetMigratedHostSessions(profileId: string): Promise<void> {
    const ids = [...this.sessions.values()]
      .filter((stored) => this.belongsToProfile(stored, profileId))
      .map((stored) => stored.record.id);
    if (ids.length === 0) return;
    for (const sessionId of ids) {
      this.sessions.delete(sessionId);
      this.tombstones.set(sessionId, {
        deletedAt: new Date().toISOString(),
        mutationId: randomUUID(),
      });
      this.pendingDeletions.add(sessionId);
    }
    await this.persist();
  }

  /**
   * What a session's pane runs. The agent itself is the ACP child
   * {@link startAcpAgent} spawns; the pane only keeps the session's runtime
   * entry alive for the reconciler, so it does nothing, forever, cheaply.
   */
  private buildLaunchScript(): string {
    return 'while :; do sleep 3600; done';
  }

  async create(request: CreateAgentSessionRequest): Promise<AgentSessionBundle> {
    this.assertConnected(request.profileId);
    const canonicalCwd = await this.options.transport.fsRealpath(request.cwd);
    // Every agent is a chat session now. agy used to be forced to `terminal`,
    // which meant CozyPad drove its TUI and read the answer back off a 120x40
    // screen — the path that concatenated prompts, lost their first character,
    // and turned quoted phrases in prose into a fake option menu. It speaks ACP
    // through packages/adapter-agy instead.
    const interactionMode = 'chat' as const;
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
    const launchScript = this.buildLaunchScript();
    let runtime: Awaited<ReturnType<AgentTmuxPort['newSession']>>;
    try {
      runtime = await this.options.tmux.newSession({
        name: id,
        cwd: canonicalCwd,
        argv: [remote.commandShell, '-lc', launchScript],
      });
    } catch (error) {
      throw await this.withStartupDiagnostics(id, canonicalCwd, remote, error);
    }
    const record: RemoteAgentSessionRecord = {
      id,
      identity: null,
      provisionalIdentity: {
        hostId: this.hostIdFor(request.profileId),
        connectionProfileId: request.profileId,
        tmuxSocket: this.options.tmux.socketName,
        tmuxSessionId: runtime.sessionId,
        agentKind: request.agentKind,
        launchNonce: randomUUID(),
      },
      projectId: canonicalCwd,
      cwd: canonicalCwd,
      title:
        request.title ??
        `New ${agentLabel} conversation`,
      status: 'starting',
      archivedAt: null,
      tmuxCreatedEpoch: runtime.createdEpoch,
      createdAt: now,
      updatedAt: now,
      lastEventSequence: 0,
    };
    const stored: StoredAgentSession = {
      record,
      paneId: runtime.paneId,
      host: `${profile.username}@${profile.host}`,
      project: projectName(canonicalCwd),
      timeline: [],
      turnCounter: 0,
      slashCommands: [],
      attachments: {},
      interactionMode,
      launchMode,
    };
    this.sessions.set(id, stored);
    this.managedSessionIds.add(id);
    await this.writeRemoteMetadata(stored);
    await this.persist();
    this.emitSession(stored);
    this.emitTimeline(stored);

    try {
      // "Ready" has to mean the agent answered, not that a process was
      // spawned: initialize and session/new both returned, which is also when
      // the model list becomes available.
      const started = await this.startAcpAgent(stored);
      if (
        stored.launchMode !== undefined &&
        stored.launchMode !== 'default' &&
        started.appliedModeId === undefined
      ) {
        // A permission mode the user believes is in force and is not would be
        // the worst kind of silence.
        stored.timeline.push({
          kind: 'notice',
          id: `notice-mode-${randomUUID()}`,
          timestamp: new Date().toISOString(),
          text: `此 agent 未提供「${stored.launchMode}」對應的 session 模式，本次以其預設權限執行。`,
        });
      }
      stored.record = {
        ...stored.record,
        status: 'ready',
        updatedAt: new Date().toISOString(),
      };
      await this.persist();
      this.emitSession(stored);
      this.emitTimeline(stored);
      return this.bundle(stored);
    } catch (error) {
      const surfacedError = await this.withStartupDiagnostics(
        id,
        canonicalCwd,
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
   * Starts the session's ACP agent, continuing the given conversation when one
   * is offered. Returns whether the agent actually continued it.
   *
   * Shared by create, revive and the lazy start in send, so a session cannot
   * lose its context just because of which door the restart came through.
   */
  private async startAcpAgent(
    stored: StoredAgentSession,
    continuation?: AcpSessionContinuation,
  ): Promise<{ continued: boolean; appliedModeId?: string }> {
    if (this.options.acp === undefined) return { continued: false };
    await this.claimSessionLease(stored.record.id);
    this.managedSessionIds.add(stored.record.id);
    const agentKind = stored.record.provisionalIdentity.agentKind;
    const launchMode = stored.launchMode;
    let started: Awaited<ReturnType<NonNullable<AgentCommunicationServiceOptions['acp']>['start']>>;
    try {
      started = await this.options.acp.start(
        stored.record.id,
        stored.record.cwd,
        agentKind,
        continuation,
        // 'default' means "whatever the agent starts in"; anything else is a
        // choice the agent must be asked to honour.
        launchMode === undefined || launchMode === 'default' ? undefined : launchMode,
        this.options.isLocalHost?.(
          this.profileIdForSession(stored),
        ) !== true,
      );
    } catch (error) {
      await this.releaseSessionLease(stored.record.id);
      throw error;
    }
    // Claude and Codex return the native conversation id as the ACP session
    // id. Persisting it lets a later revive continue the same backend thread.
    // AGY reports its id in the first prompt response's `_meta` instead.
    if (agentKind === 'claude' || agentKind === 'codex') {
      this.bindAgentConversation(stored, started.acpSessionId);
    }
    stored.configOptions = started.configOptions;
    // agy's single session mode is 'always-proceed': tools run without ever
    // asking. The adapter says so on every session open; the user is told
    // once per session record.
    if (
      started.modes.currentModeId === 'always-proceed' &&
      !stored.timeline.some(
        (item) => item.kind === 'notice' && item.id.startsWith('notice-permission-'),
      )
    ) {
      stored.timeline.push({
        kind: 'notice',
        id: `notice-permission-${randomUUID()}`,
        timestamp: new Date().toISOString(),
        text: '此 agent 不會請求審批：工具呼叫全部自動執行，且不受工作區範圍限制。',
      });
    }
    return {
      continued: started.continued,
      ...(started.appliedModeId === undefined
        ? {}
        : { appliedModeId: started.appliedModeId }),
    };
  }

  /**
   * What a session hands the ACP runtime to continue its old conversation.
   *
   * The bound identity is the source of truth; revive passes a disk-guessed
   * AGY id when no binding exists yet. `undefined` means there is nothing to
   * continue and the agent starts fresh.
   */
  private acpContinuationFor(
    stored: StoredAgentSession,
    conversationId = stored.record.identity?.agentConversationId,
  ): AcpSessionContinuation | undefined {
    if (conversationId === undefined || conversationId === null) return undefined;
    const agentKind = stored.record.provisionalIdentity.agentKind;
    return {
      acpSessionId: conversationId,
      ...(agentKind === 'agy'
        ? { resumeMeta: { [AGY_CONVERSATION_META_KEY]: conversationId } }
        : {}),
      history: [...stored.timeline],
    };
  }

  /**
   * Binds the conversation the agent is actually in.
   *
   * A revived agent can end up in a NEW conversation — Claude's `--resume` may
   * fork, a guessed AGY id may miss — and the binding's whole job is to find
   * this session's conversation again, so it follows the agent rather than
   * pinning the record to a dead id (SPEC 275-278).
   */
  private bindAgentConversation(
    stored: StoredAgentSession,
    agentConversationId: string,
  ): void {
    if (stored.record.identity?.agentConversationId === agentConversationId) return;
    const profileId = this.profileIdForSession(stored);
    const fingerprint = this.options.getHostFingerprint(profileId);
    if (fingerprint === undefined) {
      this.events.onError({
        sessionId: stored.record.id,
        message: 'Cannot bind agent identity without a trusted host fingerprint',
      });
      return;
    }
    const binding = {
      agentConversationId,
      remoteHostFingerprint: fingerprint,
      tmuxPaneId: stored.paneId,
      now: new Date().toISOString(),
    };
    try {
      stored.record = bindAgentIdentity(stored.record, binding);
    } catch {
      stored.record = bindAgentIdentity({ ...stored.record, identity: null }, binding);
      stored.resumeContinuity = 'new';
    }
  }

  /**
   * Learns the conversation id an agent reported in a turn's `_meta`.
   *
   * AGY names its conversation this way on every prompt response; binding it
   * is what lets a later Resume reopen the same conversation instead of
   * guessing from the disk.
   */
  /**
   * Records that a session's agent process ended on its own.
   *
   * The runtime has already dropped the child, so everything still waiting on
   * it — the active turn, pending approvals — can never finish and is closed
   * out here rather than left dangling until the next app restart.
   */
  noteAgentExit(sessionId: string, detail: string): void {
    this.releaseSessionLeaseSoon(sessionId);
    const stored = this.sessions.get(sessionId);
    if (stored === undefined) return;
    const status = stored.record.status;
    if (status === 'exited' || status === 'error' || status === 'disconnected') {
      return;
    }
    this.finalizeInFlightItems(stored);
    this.expirePendingInteractions(stored);
    stored.activeTurn = undefined;
    stored.activeAgentTurnId = undefined;
    stored.record = {
      ...stored.record,
      status: 'exited',
      updatedAt: new Date().toISOString(),
    };
    stored.timeline.push({
      kind: 'notice',
      id: `notice-exit-${randomUUID()}`,
      timestamp: new Date().toISOString(),
      text: `Agent 程序已結束（${detail}）。按 Resume 重新啟動。`,
    });
    void this.persist();
    this.emitSession(stored);
    this.emitTimeline(stored);
  }

  notePromptMeta(sessionId: string, meta: Readonly<Record<string, unknown>>): void {
    const conversationId = meta[AGY_CONVERSATION_META_KEY];
    if (typeof conversationId !== 'string' || conversationId === '') return;
    const stored = this.sessions.get(sessionId);
    if (stored === undefined) return;
    if (stored.record.identity?.agentConversationId === conversationId) return;
    this.bindAgentConversation(stored, conversationId);
    stored.record = { ...stored.record, updatedAt: new Date().toISOString() };
    void this.persist();
    this.emitSession(stored);
  }

  /**
   * Relaunch an exited session's agent in place. The record, timeline, and
   * title survive; the process is new. Claude resumes its bound conversation
   * (`--resume`); Codex resumes its stored app-server thread; AGY reopens its
   * own CLI, where its conversation list offers the previous session.
   */
  async revive(request: AgentSessionRequest): Promise<AgentSessionBundle> {
    const stored = this.requireSession(request.sessionId);
    if (stored.record.archivedAt !== null) {
      throw new Error('Restore this archived conversation before resuming it');
    }
    const profileId = this.profileIdForSession(stored);
    this.assertConnected(profileId);
    if (
      stored.record.status !== 'exited' &&
      stored.record.status !== 'error' &&
      stored.record.status !== 'disconnected'
    ) {
      return this.bundle(stored);
    }
    if (
      stored.record.status === 'error' ||
      stored.record.status === 'disconnected'
    ) {
      const runtimeAlive = await this.options.tmux
        .hasSession(stored.record.provisionalIdentity.tmuxSessionId)
        .catch(() => false);
      if (runtimeAlive) {
        await this.claimSessionLease(stored.record.id);
        this.managedSessionIds.add(stored.record.id);
        stored.activeTurn = undefined;
        stored.activeAgentTurnId = undefined;
        stored.record = {
          ...stored.record,
          status: 'ready',
          updatedAt: new Date().toISOString(),
        };
        await this.persist();
        this.emitSession(stored);
        return this.bundle(stored);
      }
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
    await this.assertNoForeignSessionLease(id);
    // An errored launch can leave its runtime session behind, and the local
    // runtime keeps a dead session's name until it is killed — either would
    // block the relaunch.
    await this.options.tmux
      .killSession(stored.record.provisionalIdentity.tmuxSessionId)
      .catch(() => undefined);
    await this.prepareRemoteStorage(id);
    // The logs were just truncated; the dead run's stream state goes with them.
    // The new process is a new execution generation; whatever the old one
    // was still asking or running can never finish now.
    this.finalizeInFlightItems(stored);
    this.expirePendingInteractions(stored);
    stored.activeTurn = undefined;
    stored.activeAgentTurnId = undefined;
    const boundConversationId = stored.record.identity?.agentConversationId;
    // A guessed conversation must at least have been written around this
    // session's own last activity; the conversations directory is global,
    // so the unfiltered "latest" is simply whoever used AGY most recently.
    const lastActivityMs = Date.parse(stored.record.updatedAt);
    const resumeConversationId =
      installation.supportsResume && (agentKind === 'claude' || agentKind === 'codex')
        ? boundConversationId
        : installation.supportsResume && agentKind === 'agy'
          ? boundConversationId ??
            (this.options.isLocalHost?.(profileId) === true
              ? await this.options.getLatestLocalAgyConversationId?.(
                  Number.isFinite(lastActivityMs)
                    ? {
                        notBefore: lastActivityMs - 30 * 60_000,
                        notAfter: lastActivityMs + 30 * 60_000,
                      }
                    : undefined,
                )
              : undefined)
          : undefined;
    // Legacy and remote AGY sessions may not have exposed an identity yet.
    // Their CLI fallback remains `--continue`; once a local id is discovered,
    // the record is bound below and every later Resume uses `--conversation`.
    const resumeLatest =
      agentKind === 'agy' &&
      installation.supportsResume &&
      resumeConversationId === undefined;
    if (agentKind === 'agy' && installation.supportsResume) stored.revived = true;
    // SPEC 274-278: 'continued' only when the same bound conversation is
    // reopened; a disk-guessed id or `--continue` is honest-labelled
    // 'assumed', and everything else starts a new native conversation.
    stored.resumeContinuity =
      boundConversationId !== undefined &&
      resumeConversationId === boundConversationId
        ? 'continued'
        : resumeConversationId !== undefined || resumeLatest
          ? 'assumed'
          : 'new';
    if (stored.resumeContinuity === 'assumed') {
      stored.timeline.push({
        id: `notice-${randomUUID()}`,
        kind: 'notice',
        text: '已嘗試接回最近的原生對話，但無法確認是否為同一段；分隔線之前的內容 AGY 不一定記得。',
        timestamp: new Date().toISOString(),
      });
    }
    const launchScript = this.buildLaunchScript();
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
    if (agentKind === 'agy' && resumeConversationId !== undefined) {
      const fingerprint = this.options.getHostFingerprint(profileId);
      if (fingerprint !== undefined) {
        stored.record = bindAgentIdentity(stored.record, {
          agentConversationId: resumeConversationId,
          remoteHostFingerprint: fingerprint,
          tmuxPaneId: runtime.paneId,
          now: stored.record.updatedAt,
        });
      }
    }
    await this.writeRemoteMetadata(stored).catch(() => undefined);
    await this.persist();
    this.emitSession(stored);
    try {
      const { continued } = await this.startAcpAgent(
        stored,
        this.acpContinuationFor(stored, resumeConversationId),
      );
      // The labels above were computed from what this side hoped for; the
      // agent has now said what it could actually do (SPEC 274-278).
      if (!continued && stored.resumeContinuity !== 'new') {
        stored.resumeContinuity = 'new';
        stored.timeline.push({
          id: `notice-${randomUUID()}`,
          kind: 'notice',
          text: '接不回先前的原生對話，這次是新的對話；分隔線之前的內容 agent 不記得。',
          timestamp: new Date().toISOString(),
        });
      }
      stored.record = {
        ...stored.record,
        status: 'ready',
        updatedAt: new Date().toISOString(),
      };
      await this.persist();
      this.emitSession(stored);
      this.emitTimeline(stored);
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

  async archive(
    request: ArchiveAgentSessionRequest,
  ): Promise<AgentSessionBundle> {
    const stored = this.requireSession(request.sessionId);
    if (stored.record.archivedAt !== null) return this.bundle(stored);

    const inFlight =
      stored.record.status === 'starting' ||
      stored.record.status === 'running' ||
      stored.record.status === 'waiting_approval';
    if (inFlight && request.stopActive !== true) {
      throw new Error('Stop the active Agent execution before archiving this session');
    }
    await this.assertNoForeignSessionLease(stored.record.id);

    const profileId = this.profileIdForSession(stored);
    const connected =
      this.activeProfileId !== null &&
      this.belongsToProfile(stored, this.activeProfileId);
    // `disconnected` means the ACP owner left; the durable tmux placeholder
    // may still be alive. Reconnect before archiving so it can be verified and
    // removed instead of leaking a hidden host process.
    const runtimeMayBeAlive = stored.record.status !== 'exited';
    if (runtimeMayBeAlive) {
      if (!connected) {
        throw new Error('Reconnect to the session host before archiving its live process');
      }
      this.options.acp?.stop(stored.record.id);
      await this.releaseSessionLease(stored.record.id);
      this.finalizeInFlightItems(stored);
      this.expirePendingInteractions(stored);
      stored.activeTurn = undefined;
      stored.activeAgentTurnId = undefined;
      const target = stored.record.provisionalIdentity.tmuxSessionId;
      const alive = await this.options.tmux.hasSession(target).catch(() => false);
      if (alive) await this.options.tmux.killSession(target);
      stored.record = { ...stored.record, status: 'exited' };
    }

    const now = new Date().toISOString();
    stored.record = {
      ...stored.record,
      archivedAt: now,
      updatedAt: now,
      provisionalIdentity: {
        ...stored.record.provisionalIdentity,
        connectionProfileId: profileId,
      },
    };
    await this.releaseSessionLease(stored.record.id);
    this.managedSessionIds.delete(stored.record.id);
    await this.persist();
    this.emitSession(stored);
    this.emitTimeline(stored);
    return this.bundle(stored);
  }

  async restore(request: AgentSessionRequest): Promise<AgentSessionBundle> {
    const stored = this.requireSession(request.sessionId);
    if (stored.record.archivedAt === null) return this.bundle(stored);
    stored.record = {
      ...stored.record,
      archivedAt: null,
      updatedAt: new Date().toISOString(),
    };
    await this.persist();
    this.emitSession(stored);
    return this.bundle(stored);
  }

  /**
   * Reads canonical Markdown from AGY's own local store. A revived or already
   * bound session can read directly. A fresh session must supply its exact
   * submitted prompt; only a newly written conversation whose latest prompt
   * matches is accepted and bound. This keeps unrelated AGY history private.
   */
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

  async delete(request: AgentSessionRequest): Promise<DeleteAgentSessionResult> {
    const stored = this.requireSession(request.sessionId);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(stored.record.id)) {
      throw new Error('Refusing to delete a session with an unsafe identifier');
    }
    await this.assertNoForeignSessionLease(stored.record.id);
    const profileId = this.profileIdForSession(stored);
    // Forget the session before touching the host. Killing its tmux session
    // ends the follow stream, whose completion handlers report the death as an
    // error and emit one last update — arriving after the UI had already
    // dropped the row and putting it straight back. Their `sessions.get()`
    // guard only works if the record is gone first.
    this.tombstones.set(stored.record.id, {
      deletedAt: new Date().toISOString(),
      mutationId: randomUUID(),
    });
    this.pendingDeletions.add(stored.record.id);
    this.sessions.delete(stored.record.id);
    this.completing.delete(stored.record.id);
    // The ACP child is a local process the tmux teardown below never touches;
    // without this, every deleted session left its agent running until quit.
    this.options.acp?.stop(stored.record.id);
    await this.releaseSessionLease(stored.record.id);
    this.managedSessionIds.delete(stored.record.id);
    await this.persist();
    this.events.onSessionDeleted({
      sessionId: stored.record.id,
      agentKind: stored.record.provisionalIdentity.agentKind,
    });

    // Deleting must always clear the local record — sessions outlive a
    // connection, so refusing while the host is unreachable leaves entries
    // the user can never get rid of. Every other scope reports its own
    // outcome (SPEC 1509-1513): a partial failure must never present as
    // complete, and skipped remote scopes list what remains on the host.
    const tmuxSessionId = stored.record.provisionalIdentity.tmuxSessionId;
    const remoteEventsPath = `~/.cozypad/sessions/${stored.record.id}`;
    const remoteAttachmentsPath = `${stored.record.cwd}/.cozypad/session-tmp/${stored.record.id}`;
    const scopes: DeleteAgentSessionResult['scopes'] = [
      { scope: 'localIndex', outcome: 'done' },
      // No agent exposes native-conversation deletion; SPEC 1502 wants the
      // scope shown as unavailable rather than silently absent.
      {
        scope: 'nativeConversation',
        outcome: 'unsupported',
        detail: 'The agent keeps its native conversation in its own store',
      },
    ];
    if (this.activeProfileId === profileId) {
      try {
        await this.options.tmux.killSession(tmuxSessionId);
        scopes.push({ scope: 'process', outcome: 'done' });
      } catch (error) {
        scopes.push({
          scope: 'process',
          outcome: 'failed',
          detail: this.errorMessage(error),
          residualPath: `tmux session ${tmuxSessionId}`,
        });
      }
      try {
        await this.removeRemoteSessionStorage(stored);
        scopes.push({ scope: 'remoteEvents', outcome: 'done' });
        scopes.push({ scope: 'remoteAttachments', outcome: 'done' });
      } catch (error) {
        const detail = this.errorMessage(error);
        scopes.push({
          scope: 'remoteEvents',
          outcome: 'failed',
          detail,
          residualPath: remoteEventsPath,
        });
        scopes.push({
          scope: 'remoteAttachments',
          outcome: 'failed',
          detail,
          residualPath: remoteAttachmentsPath,
        });
      }
      return { scopes };
    }
    const reconnect = 'Reconnect this machine to clean it up';
    scopes.push(
      {
        scope: 'process',
        outcome: 'skipped',
        detail: reconnect,
        residualPath: `tmux session ${tmuxSessionId}`,
      },
      {
        scope: 'remoteEvents',
        outcome: 'skipped',
        detail: reconnect,
        residualPath: remoteEventsPath,
      },
      {
        scope: 'remoteAttachments',
        outcome: 'skipped',
        detail: reconnect,
        residualPath: remoteAttachmentsPath,
      },
    );
    return { scopes };
  }

  async uploadAttachments(
    request: UploadAgentAttachmentsRequest,
  ): Promise<AgentAttachment[]> {
    const stored = this.requireSession(request.sessionId);
    this.assertSessionConnected(stored);
    if (
      request.attachments.length === 0 ||
      request.attachments.length > MAX_AGENT_ATTACHMENTS
    ) {
      throw new Error(
        `An attachment batch needs between 1 and ${MAX_AGENT_ATTACHMENTS} files`,
      );
    }
    const staged = request.attachments.map((requestAttachment) => {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(requestAttachment.dataBase64)) {
        throw new Error(`Attachment payload is not valid base64: ${requestAttachment.name}`);
      }
      const bytes = Buffer.from(requestAttachment.dataBase64, 'base64');
      if (bytes.byteLength > MAX_AGENT_ATTACHMENT_BYTES) {
        throw new Error(
          `${requestAttachment.name} is too large (${bytes.byteLength} bytes, limit ${MAX_AGENT_ATTACHMENT_BYTES} bytes)`,
        );
      }
      const id = randomUUID();
      return {
        id,
        request: requestAttachment,
        bytes,
        storageName: attachmentStorageName(id, requestAttachment.name),
      };
    });
    const directory = await this.prepareAttachmentDirectory(stored);
    const archivePath = `${directory}/.cozypad-attachment-batch-${randomUUID()}.tar`;
    const archive = createAttachmentArchive(
      staged.map((attachment) => ({
        name: attachment.storageName,
        data: attachment.bytes,
      })),
    );
    await this.options.transport.writeFile(archivePath, archive);
    try {
      const output = await this.options.transport.exec(
        buildAttachmentUnpackScript(
          directory,
          archivePath,
          staged.map(
            (attachment) => `${directory}/${attachment.storageName}`,
          ),
        ),
        30_000,
      );
      const errorLine = output
        .split(/\r?\n/u)
        .find((line) => line.startsWith('__ERROR__'));
      if (errorLine !== undefined) {
        throw new Error(
          errorLine.split('\t').slice(1).join('\t') || 'Attachment batch unpack failed',
        );
      }
      if (markerValue(output, '__COZYPAD_ATTACHMENT_BATCH__') !== 'ok') {
        throw new Error('Selected machine did not confirm the attachment batch');
      }
    } catch (error) {
      const cleanupPaths = [
        archivePath,
        ...staged.map((attachment) => `${directory}/${attachment.storageName}`),
      ];
      await this.options.transport
        .exec(`rm -f -- ${cleanupPaths.map(quoteShellArg).join(' ')} 2>/dev/null || true\n`, 10_000)
        .catch(() => undefined);
      throw error;
    }
    const attachments = staged.map(({ id, request: requestAttachment, bytes, storageName }) =>
      AgentAttachmentSchema.parse({
        id,
        sessionId: stored.record.id,
        name: requestAttachment.name,
        mediaType: requestAttachment.mediaType,
        sizeBytes: bytes.byteLength,
        remotePath: `${directory}/${storageName}`,
      }),
    );
    attachments.forEach((attachment) => {
      stored.attachments[attachment.id] = attachment;
    });
    await this.persist();
    return attachments;
  }

  async send(request: SendAgentMessageRequest): Promise<void> {
    const stored = this.requireSession(request.sessionId);
    this.assertSessionConnected(stored);
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
            'The user attached these files. Each @path is part of this prompt: inspect the file at that exact session-local path before responding when its contents are relevant.',
            ...attachments.map(
              (attachment) =>
                `- @${attachment.remotePath} (original name: ${attachment.name}; ${attachment.mediaType}; ${attachment.sizeBytes} bytes)`,
            ),
          ].join('\n');
    const messageText = [request.text.trim(), attachmentText]
      .filter((part) => part !== '')
      .join('\n\n');
    const timelineText = request.text.trim();
    const attachmentTimelineItems = attachments.map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      mediaType: attachment.mediaType,
      sizeBytes: attachment.sizeBytes,
      remotePath: attachment.remotePath,
    }));
    const now = new Date().toISOString();
    const previousTitle = stored.record.title;
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
    const userItemId = `user-${randomUUID()}`;
    stored.timeline.push({
      id: userItemId,
      kind: 'message',
      role: 'user',
      text: timelineText,
      ...(attachmentTimelineItems.length === 0
        ? {}
        : { attachments: attachmentTimelineItems }),
      timestamp: now,
    });
    if (/^New (?:Claude|Codex|AGY) conversation$/u.test(stored.record.title)) {
      stored.record.title = (
        timelineText === ''
          ? attachments.map((attachment) => attachment.name).join(', ')
          : timelineText
      ).slice(0, 64);
    }
    stored.record = { ...stored.record, status: 'running', updatedAt: now };
    await this.persist();
    this.emitSession(stored);
    this.emitTimeline(stored);

    try {
      // One protocol for every agent. claude went through a frame written
      // into a tmux pane's stdin, codex through JSON-RPC to its app-server,
      // agy through a terminal CozyPad read off a screen. All three speak
      // ACP now, so only the launch spec differs — measured by
      // scripts/probe-acp-agent.mts, which drives all three through one
      // client and one code path.
      //
      // The agents still manage their own context: claude-agent-acp spawns
      // the real Claude Code CLI and codex-acp bundles @openai/codex. ACP
      // changed how CozyPad listens, not how an agent thinks.
      if (this.options.acp === undefined) {
        throw new Error('No ACP runtime is available for this agent');
      }
      if (!this.options.acp.has(stored.record.id)) {
        // The app restarted since this session last spoke: the agent process
        // is gone, but the bound conversation is not. Continuing it here is
        // what makes "reopen the app and keep talking" work.
        await this.startAcpAgent(stored, this.acpContinuationFor(stored));
      }
      const stopReason = await this.options.acp.prompt(stored.record.id, messageText);
      // The turn is over, so the session is usable again.
      //
      // `followSession` used to do this by watching for a result event, and
      // deleting it took the transition with it: status stayed 'running'
      // forever and the guard at the top of this method rejected every message
      // after the first with "Agent is waiting for the current turn to finish".
      // `session/prompt` resolving *is* the end of the turn — that is what the
      // protocol means by it — so there is nothing to watch for any more.
      stored.activeTurn = undefined;
      stored.activeAgentTurnId = undefined;
      stored.record = {
        ...stored.record,
        status: 'ready',
        updatedAt: new Date().toISOString(),
      };
      if (stopReason === 'cancelled') {
        stored.timeline.push({
          kind: 'notice',
          id: `notice-cancelled-${randomUUID()}`,
          timestamp: new Date().toISOString(),
          text: '已中斷這一輪。',
        });
      }
      await this.persist();
      this.emitSession(stored);
      this.emitTimeline(stored);
    } catch (error) {
      stored.activeTurn = undefined;
      // The renderer keeps the draft and its local attachment buffer when
      // sending rejects. Remove the optimistic timeline copy as well so a
      // retry cannot create a duplicate user turn.
      stored.timeline = stored.timeline.filter((item) => item.id !== userItemId);
      stored.record.title = previousTitle;
      const runtimeAlive = await this.options.tmux
        .hasSession(stored.record.provisionalIdentity.tmuxSessionId)
        .catch(() => true);
      stored.record = {
        ...stored.record,
        // A rejected frame is a turn-level delivery failure. Only a tmux
        // liveness check that proves the runtime is gone may poison the whole
        // session; otherwise it remains ready for an immediate retry. An
        // 'exited' verdict is stronger than either: the agent's own death was
        // observed, and the placeholder pane being alive must not veto it.
        status:
          stored.record.status === 'exited'
            ? 'exited'
            : runtimeAlive
              ? 'ready'
              : 'error',
        updatedAt: new Date().toISOString(),
      };
      this.appendError(stored, error);
      await this.persist();
      this.emitSession(stored);
      this.emitTimeline(stored);
      throw error;
    }
  }

  /**
   * Asks the agent to stop the turn it is on.
   *
   * `session/cancel` rather than a signal or an escape key: the in-flight
   * `session/prompt` resolves with stopReason 'cancelled', so the UI learns
   * the agent actually handed control back instead of assuming it did.
   */
  async interrupt(request: AgentSessionRequest): Promise<void> {
    const stored = this.requireSession(request.sessionId);
    this.assertSessionConnected(stored);
    if (this.options.acp === undefined) {
      throw new Error('No ACP runtime is available for this agent');
    }
    await this.options.acp.cancel(stored.record.id);
    if (this.options.acp.has(stored.record.id)) {
      // The turn ends when the agent honours the cancel: `session/prompt`
      // resolves with `stopReason: 'cancelled'` and the send path flips the
      // status and clears the turn. Declaring 'ready' here while `activeTurn`
      // was still set left a session that refused every send and hid the Stop
      // button that could have retried the cancel.
      return;
    }
    // No agent process — after an app restart there is no turn to cancel,
    // only stale state to clear.
    stored.activeTurn = undefined;
    stored.activeAgentTurnId = undefined;
    stored.record = {
      ...stored.record,
      status: 'ready',
      updatedAt: new Date().toISOString(),
    };
    await this.persist();
    this.emitSession(stored);
  }

  /**
   * Changes one of the settings the agent advertised — the model picker.
   * The agent answers with its refreshed option set, which replaces ours:
   * setting one option can change what is available on another.
   */
  async setConfigOption(
    request: SetAgentSessionConfigOptionRequest,
  ): Promise<void> {
    const stored = this.requireSession(request.sessionId);
    this.assertSessionConnected(stored);
    if (this.options.acp === undefined) {
      throw new Error('No ACP runtime is available for this agent');
    }
    stored.configOptions = await this.options.acp.setConfigOption(
      stored.record.id,
      request.configId,
      request.value,
    );
    stored.record = { ...stored.record, updatedAt: new Date().toISOString() };
    await this.persist();
    this.emitSession(stored);
  }

  /**
   * Answers a permission request the agent is blocked on.
   *
   * ACP models permission as a *request*, so the agent is genuinely waiting
   * on a return value — the runtime is holding the promise, keyed by this
   * item id, and this resolves it.
   *
   * The bridge still carries allow/deny while the UI does, so the choice is
   * mapped onto the options the agent actually offered. That mapping is
   * lossy and deliberately temporary: claude offers `Always Allow / Allow /
   * Reject`, and "always" has no allow/deny equivalent. Once the card sends
   * an optionId, this collapses to passing it through.
   */
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

    const options = item.options ?? [];
    const exactKind = (kind: string): string | undefined =>
      options.find((option) => option.kind === kind)?.optionId;
    const byKind = (prefix: string): string | undefined =>
      options.find((option) => option.kind?.startsWith(prefix) === true)?.optionId;
    // The card's own option wins when it names one. The fallback maps the
    // two-button resolution to the *narrowest* matching kind first: claude
    // lists `allow_always` before `allow_once`, so a bare prefix match would
    // grant a standing permission the user never chose.
    const optionId =
      (request.optionId !== undefined &&
      options.some((option) => option.optionId === request.optionId)
        ? request.optionId
        : undefined) ??
      (request.resolution === 'allowed'
        ? (exactKind('allow_once') ?? byKind('allow') ?? options[0]?.optionId ?? null)
        : (exactKind('reject_once') ?? byKind('reject') ?? byKind('deny') ?? null));

    this.options.acp?.resolveControl(stored.record.id, item.id, optionId);

    stored.timeline = stored.timeline.map((candidate) =>
      candidate.id === request.itemId && candidate.kind === 'approval'
        ? {
            ...candidate,
            resolution: request.resolution,
            ...(optionId === null ? {} : { selectedOptionId: optionId }),
          }
        : candidate,
    );
    // The agent is unblocked, so the turn is running again until the prompt
    // resolves; the session list must stop saying it needs input.
    if (stored.record.status === 'waiting_approval') {
      stored.record = { ...stored.record, status: 'running' };
    }
    stored.record = { ...stored.record, updatedAt: new Date().toISOString() };
    await this.persist();
    this.emitTimeline(stored);
    this.emitSession(stored);
  }

  async answerQuestion(request: AnswerAgentQuestionRequest): Promise<void> {
    const stored = this.requireSession(request.sessionId);
    this.assertSessionConnected(stored);
    const item = this.requirePendingQuestion(stored, request.itemId);
    if (item.options[request.optionIndex] === undefined) {
      throw new Error('Question option not found');
    }
    // The runtime holds the elicitation promise keyed by the card's id; the
    // answer rides back as the option index, and the runtime updates the
    // timeline it owns — which lands here again via replaceTimeline.
    this.options.acp?.resolveControl(
      stored.record.id,
      item.id,
      String(request.optionIndex),
    );
  }

  /**
   * Refuse a whole question request (SPEC 3.4.6): the fallback for questions
   * CozyPad cannot represent.
   */
  async declineQuestion(request: DeclineAgentQuestionRequest): Promise<void> {
    const stored = this.requireSession(request.sessionId);
    this.assertSessionConnected(stored);
    const item = this.requirePendingQuestion(stored, request.itemId);
    this.options.acp?.resolveControl(stored.record.id, item.id, null);
  }

  private requirePendingQuestion(
    stored: StoredAgentSession,
    itemId: string,
  ): Extract<ChatItem, { kind: 'question' }> {
    const item = stored.timeline.find(
      (candidate): candidate is Extract<ChatItem, { kind: 'question' }> =>
        candidate.id === itemId && candidate.kind === 'question',
    );
    if (
      item === undefined ||
      item.selectedIndex !== null ||
      item.expired === true ||
      item.declined === true
    ) {
      throw new Error('Pending agent question not found');
    }
    return item;
  }

  /**
   * SPEC 3.4.12: when the execution generation that asked is gone, a pending
   * Approval/Question becomes Expired — content kept, options disabled —
   * instead of a zombie card whose buttons can only throw. Runs when the
   * process exits, errors out, or is relaunched.
   */
  /**
   * SPEC 1321-1325: a generation that ends without End events leaves its
   * streaming message marked interrupted and its running tools marked
   * result-unknown — an Exited session must never show items still running.
   */
  private finalizeInFlightItems(stored: StoredAgentSession): void {
    for (const item of stored.timeline) {
      if (item.kind === 'message' && item.streaming === true) {
        item.streaming = false;
        item.interrupted = true;
      } else if (item.kind === 'tool_call' && item.status === 'running') {
        item.status = 'unknown';
      }
    }
  }

  private expirePendingInteractions(stored: StoredAgentSession): void {
    for (const item of stored.timeline) {
      if (item.kind === 'approval' && item.resolution === 'pending') {
        item.resolution = 'expired';
      } else if (item.kind === 'question' && item.selectedIndex === null) {
        item.expired = true;
      }
    }
  }


  private async prepareRemoteStorage(sessionId: string): Promise<void> {
    const dir = remoteSessionDir(sessionId);
    await this.options.transport.exec(
      `session_dir="${dir}"
mkdir -p "$session_dir"
: > "$session_dir/stderr.log"
chmod 700 "$session_dir"
chmod 600 "$session_dir/stderr.log"
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
    const agentKind = stored.record.provisionalIdentity.agentKind;
    const slashCommands = normalizeSlashCommands(stored.slashCommands);
    // Whatever the agent sent that parses; a malformed entry drops alone
    // instead of taking the whole summary down.
    const configOptions = Array.isArray(stored.configOptions)
      ? stored.configOptions.flatMap((option) => {
          const parsed = AgentConfigOptionSchema.safeParse(option);
          return parsed.success ? [parsed.data] : [];
        })
      : [];
    return AgentSessionSummarySchema.parse({
      ...(configOptions.length === 0 ? {} : { configOptions }),
      id: stored.record.id,
      agentKind,
      title: stored.record.title,
      host: stored.host,
      project: stored.project,
      cwd: stored.record.cwd,
      projectId: stored.record.projectId,
      archivedAt: stored.record.archivedAt,
      interactionMode: stored.interactionMode,
      status: stored.record.status,
      unread: 0,
      slashCommands,
      // The agent's own help text, so the menu can say what each does rather
      // than listing 56 bare names — which is what codex announces.
      ...(stored.slashCommandDescriptions === undefined
        ? {}
        : { slashCommandDescriptions: stored.slashCommandDescriptions }),
      // SPEC 1445: /status and /diff are completed by CozyPad itself (no
      // agent turn); the menu must be able to say which side runs a command.
      ...(agentKind === 'codex' && slashCommands.length > 0
        ? {
            slashCommandOwners: Object.fromEntries(
              slashCommands.map((name) => [
                name,
                ['status', 'diff'].includes(name) ? 'cozypad' : 'agent',
              ]),
            ),
          }
        : {}),
      conversationBound:
        stored.record.identity !== null && stored.record.identity !== undefined,
      ...(stored.resumeContinuity === undefined
        ? {}
        : { resumeContinuity: stored.resumeContinuity }),
      updatedAt: stored.record.updatedAt,
    });
  }

  private emitSession(stored: StoredAgentSession): void {
    this.events.onSessionChanged({ session: this.summary(stored) });
  }

  /**
   * Replaces a session's transcript with what the ACP runtime folded.
   *
   * The runtime owns the timeline for agents it drives — it holds the reducer
   * state and is the only thing that knows how a chunk joins the message before
   * it. This copies the result in so the store persists it and the renderer
   * sees one stream of updates, whichever runtime produced them.
   */
  replaceTimeline(sessionId: string, items: readonly ChatItem[]): void {
    const stored = this.sessions.get(sessionId);
    if (stored === undefined) return;
    stored.timeline = [...items];
    stored.record = { ...stored.record, updatedAt: new Date().toISOString() };
    // The timeline is where a blocked agent shows: a pending approval means
    // the agent is waiting on the user, not working. Derived here — the one
    // place every runtime's items pass through — so the "needs input" state
    // cannot depend on which code path produced the card.
    const blocked = items.some(
      (item) => item.kind === 'approval' && item.resolution === 'pending',
    );
    if (blocked && stored.record.status === 'running') {
      stored.record = { ...stored.record, status: 'waiting_approval' };
      this.emitSession(stored);
    } else if (!blocked && stored.record.status === 'waiting_approval') {
      stored.record = { ...stored.record, status: 'running' };
      this.emitSession(stored);
    }
    this.emitTimeline(stored);
    void this.persist();
  }

  /**
   * Records the slash commands an agent announced.
   *
   * Replaces rather than merges: the agent sends the whole set each time, and
   * a mode switch can remove commands as well as add them — keeping a stale
   * one offers the user something the agent will reject.
   */
  setSlashCommands(
    sessionId: string,
    commands: readonly { name: string; description?: string }[],
  ): void {
    const stored = this.sessions.get(sessionId);
    if (stored === undefined) return;
    stored.slashCommands = commands.map((command) => command.name);
    const descriptions: Record<string, string> = {};
    for (const command of commands) {
      if (command.description !== undefined && command.description !== '') {
        descriptions[command.name] = command.description;
      }
    }
    stored.slashCommandDescriptions = descriptions;
    stored.record = { ...stored.record, updatedAt: new Date().toISOString() };
    void this.persist();
    this.emitSession(stored);
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
    if (stored.record.archivedAt !== null) {
      throw new Error('Restore this archived conversation before using it');
    }
    const profileId = this.profileIdForSession(stored);
    this.assertConnected(profileId);
    if (stored.record.status === 'exited') {
      throw new Error('Agent tmux session has exited');
    }
    if (
      stored.record.status === 'disconnected' ||
      stored.record.status === 'error'
    ) {
      throw new Error('Resume this Agent session before using it');
    }
  }

  private requireSession(sessionId: string): StoredAgentSession {
    this.refreshFromDiskSync();
    const stored = this.sessions.get(sessionId);
    if (stored === undefined) throw new Error(`unknown agent session: ${sessionId}`);
    return stored;
  }

  private hostIdFor(profileId: string): string {
    const profile = this.options.profileStore.get(profileId);
    if (profile === undefined) throw new Error(`unknown profile: ${profileId}`);
    const fingerprint =
      this.options.getHostFingerprint(profileId) ?? `${profile.host}:${profile.port}`;
    return `${profile.username}@${fingerprint}`;
  }

  private belongsToProfile(stored: StoredAgentSession, profileId: string): boolean {
    const storedHostId = stored.record.provisionalIdentity.hostId;
    return storedHostId === undefined
      ? stored.record.provisionalIdentity.connectionProfileId === profileId
      : storedHostId === this.hostIdFor(profileId);
  }

  private profileIdForSession(stored: StoredAgentSession): string {
    if (
      this.activeProfileId !== null &&
      this.belongsToProfile(stored, this.activeProfileId)
    ) {
      return this.activeProfileId;
    }
    return stored.record.provisionalIdentity.connectionProfileId;
  }

  private decodeStore(value: unknown): {
    sessions: Map<string, StoredAgentSession>;
    tombstones: Map<string, SessionTombstone>;
  } | null {
    if (
      !isRecord(value) ||
      (value.version !== 1 && value.version !== STORE_VERSION) ||
      !Array.isArray(value.sessions)
    ) {
      return null;
    }
    const sessions = new Map<string, StoredAgentSession>();
    for (const entry of value.sessions) {
      const parsed = parseStoredSession(entry);
      if (parsed !== null) sessions.set(parsed.record.id, parsed);
    }
    const tombstones = new Map<string, SessionTombstone>();
    if (isRecord(value.tombstones)) {
      for (const [sessionId, entry] of Object.entries(value.tombstones)) {
        if (
          isRecord(entry) &&
          typeof entry.deletedAt === 'string' &&
          typeof entry.mutationId === 'string'
        ) {
          tombstones.set(sessionId, {
            deletedAt: entry.deletedAt,
            mutationId: entry.mutationId,
          });
          sessions.delete(sessionId);
        }
      }
    }
    return { sessions, tombstones };
  }

  private compareStored(
    left: StoredAgentSession,
    right: StoredAgentSession,
  ): number {
    const time = left.record.updatedAt.localeCompare(right.record.updatedAt);
    if (time !== 0) return time;
    return (left.registryMutationId ?? '').localeCompare(
      right.registryMutationId ?? '',
    );
  }

  /**
   * Pulls atomically-written changes from another client before list or a
   * session mutation. Locally dirty records stay in memory until their queued
   * write runs; clean records adopt the newest host copy.
   */
  private refreshFromDiskSync(): void {
    let decoded: ReturnType<AgentCommunicationService['decodeStore']>;
    try {
      decoded = this.decodeStore(
        JSON.parse(readFileSync(this.options.storePath, 'utf8')) as unknown,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.events.onError({
        message: `Unable to refresh the host session registry: ${this.errorMessage(error)}`,
      });
      return;
    }
    if (decoded === null) {
      this.events.onError({
        message: 'Unable to refresh the host session registry because its format is invalid',
      });
      return;
    }
    for (const [sessionId, tombstone] of decoded.tombstones) {
      this.tombstones.set(sessionId, tombstone);
      this.sessions.delete(sessionId);
      this.persistedSnapshots.delete(sessionId);
    }
    for (const [sessionId, remote] of decoded.sessions) {
      if (this.tombstones.has(sessionId)) continue;
      const local = this.sessions.get(sessionId);
      const localDirty =
        local !== undefined &&
        this.persistedSnapshots.get(sessionId) !== JSON.stringify(local);
      if (
        local === undefined ||
        (!localDirty && this.compareStored(remote, local) > 0)
      ) {
        this.sessions.set(sessionId, remote);
        this.persistedSnapshots.set(sessionId, JSON.stringify(remote));
      }
    }
  }

  private sessionLeasePath(sessionId: string): string {
    const safeName = Buffer.from(sessionId, 'utf8').toString('base64url');
    return path.join(`${this.options.storePath}.leases`, `${safeName}.json`);
  }

  /**
   * Gives one CozyPad host process exclusive ownership of a live ACP child.
   * The registry lock protects disk updates; this separate lease prevents two
   * clients from sending turns to two processes bound to the same conversation.
   */
  private async claimSessionLease(sessionId: string): Promise<void> {
    if (this.heldSessionLeases.has(sessionId)) return;
    const leasePath = this.sessionLeasePath(sessionId);
    await fs.mkdir(path.dirname(leasePath), { recursive: true });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
      try {
        handle = await fs.open(leasePath, 'wx');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      if (handle !== null) {
        let written = false;
        try {
          await handle.writeFile(
            JSON.stringify({
              owner: this.leaseOwner,
              pid: process.pid,
              sessionId,
              acquiredAt: new Date().toISOString(),
            }),
            'utf8',
          );
          written = true;
        } finally {
          await handle.close();
          if (!written) await fs.rm(leasePath, { force: true }).catch(() => undefined);
        }
        this.heldSessionLeases.add(sessionId);
        this.startLeaseHeartbeat();
        return;
      }

      const lease = await this.readSessionLease(sessionId);
      if (lease?.owner === this.leaseOwner) {
        this.heldSessionLeases.add(sessionId);
        this.startLeaseHeartbeat();
        return;
      }
      if (lease !== null && Date.now() - lease.mtimeMs <= 30_000) {
        throw new Error(
          'This Agent session is active in another CozyPad client. Disconnect or stop it there before continuing here.',
        );
      }
      // A crashed host cannot release its lease. Only reap it after a second
      // stat proves no heartbeat arrived while we were inspecting it.
      try {
        const before = await fs.stat(leasePath);
        await new Promise((resolve) => setTimeout(resolve, 25));
        const after = await fs.stat(leasePath);
        if (before.mtimeMs !== after.mtimeMs) continue;
        await fs.rm(leasePath, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    throw new Error('Unable to acquire ownership of this Agent session');
  }

  private async assertNoForeignSessionLease(sessionId: string): Promise<void> {
    if (this.heldSessionLeases.has(sessionId)) return;
    const lease = await this.readSessionLease(sessionId);
    if (lease === null || Date.now() - lease.mtimeMs > 30_000) return;
    if (lease.owner !== this.leaseOwner) {
      throw new Error(
        'This Agent session is active in another CozyPad client. Disconnect or stop it there before continuing here.',
      );
    }
  }

  private async readSessionLease(
    sessionId: string,
  ): Promise<{ owner?: string; mtimeMs: number } | null> {
    const leasePath = this.sessionLeasePath(sessionId);
    try {
      const [raw, stat] = await Promise.all([
        fs.readFile(leasePath, 'utf8'),
        fs.stat(leasePath),
      ]);
      let owner: string | undefined;
      try {
        const parsed = JSON.parse(raw) as { owner?: unknown };
        if (typeof parsed.owner === 'string') owner = parsed.owner;
      } catch {
        // An invalid live lease still belongs to somebody until it becomes
        // stale; treating it as free would defeat exclusivity.
      }
      return { ...(owner === undefined ? {} : { owner }), mtimeMs: stat.mtimeMs };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private startLeaseHeartbeat(): void {
    if (this.leaseHeartbeat !== null) return;
    this.leaseHeartbeat = setInterval(() => {
      void this.heartbeatSessionLeases();
    }, 10_000);
    this.leaseHeartbeat.unref();
  }

  private async heartbeatSessionLeases(): Promise<void> {
    if (this.leaseHeartbeatRunning) return;
    this.leaseHeartbeatRunning = true;
    try {
      const now = new Date();
      for (const sessionId of [...this.heldSessionLeases]) {
        try {
          const lease = await this.readSessionLease(sessionId);
          if (lease?.owner !== this.leaseOwner) {
            this.heldSessionLeases.delete(sessionId);
            this.options.acp?.stop(sessionId);
            this.events.onError({
              sessionId,
              message: 'This Agent session lost its cross-client ownership lease and was stopped.',
            });
            continue;
          }
          await fs.utimes(this.sessionLeasePath(sessionId), now, now);
        } catch {
          this.heldSessionLeases.delete(sessionId);
          this.options.acp?.stop(sessionId);
          this.events.onError({
            sessionId,
            message: 'Unable to renew this Agent session ownership; the process was stopped to prevent duplicate clients.',
          });
        }
      }
    } finally {
      this.leaseHeartbeatRunning = false;
      if (this.heldSessionLeases.size === 0 && this.leaseHeartbeat !== null) {
        clearInterval(this.leaseHeartbeat);
        this.leaseHeartbeat = null;
      }
    }
  }

  private async releaseSessionLease(sessionId: string): Promise<void> {
    if (!this.heldSessionLeases.delete(sessionId)) return;
    const lease = await this.readSessionLease(sessionId).catch(() => null);
    if (lease?.owner === this.leaseOwner) {
      await fs.rm(this.sessionLeasePath(sessionId), { force: true }).catch(() => undefined);
    }
    if (this.heldSessionLeases.size === 0 && this.leaseHeartbeat !== null) {
      clearInterval(this.leaseHeartbeat);
      this.leaseHeartbeat = null;
    }
  }

  private releaseSessionLeaseSoon(sessionId: string): void {
    this.leaseReleaseQueue = this.leaseReleaseQueue
      .catch(() => undefined)
      .then(() => this.releaseSessionLease(sessionId));
    void this.leaseReleaseQueue.catch(() => undefined);
  }

  private async acquireStoreLock(): Promise<() => Promise<void>> {
    const lockPath = `${this.options.storePath}.lock`;
    const deadline = Date.now() + 10_000;
    while (true) {
      try {
        await fs.mkdir(lockPath);
        return async () => {
          await fs.rmdir(lockPath).catch(() => undefined);
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          const stat = await fs.stat(lockPath);
          if (Date.now() - stat.mtimeMs > 30_000) {
            await fs.rmdir(lockPath);
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error('Timed out waiting for the host session registry lock');
        }
        await new Promise((resolve) => setTimeout(resolve, 25 + Math.random() * 50));
      }
    }
  }

  private persist(): Promise<void> {
    this.persistQueue = this.persistQueue
      // One failed write must not poison the chain: `.then` on a rejected
      // promise never runs, so without this every later persist would fail.
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(path.dirname(this.options.storePath), { recursive: true });
        const changed = new Set<string>();
        for (const [sessionId, stored] of this.sessions) {
          if (this.persistedSnapshots.get(sessionId) === JSON.stringify(stored)) {
            continue;
          }
          stored.registryMutationId = randomUUID();
          changed.add(sessionId);
        }

        const release = await this.acquireStoreLock();
        try {
          let disk = {
            sessions: new Map<string, StoredAgentSession>(),
            tombstones: new Map<string, SessionTombstone>(),
          };
          try {
            const raw = await fs.readFile(this.options.storePath, 'utf8');
            const decoded = this.decodeStore(JSON.parse(raw) as unknown);
            if (decoded === null) {
              throw new Error(
                'Refusing to overwrite an invalid host session registry',
              );
            }
            disk = decoded;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }

          for (const [sessionId, tombstone] of disk.tombstones) {
            if (!this.tombstones.has(sessionId)) {
              this.tombstones.set(sessionId, tombstone);
            }
          }
          for (const sessionId of this.pendingDeletions) {
            if (!this.tombstones.has(sessionId)) {
              this.tombstones.set(sessionId, {
                deletedAt: new Date().toISOString(),
                mutationId: randomUUID(),
              });
            }
          }

          const merged = new Map(disk.sessions);
          for (const [sessionId, local] of this.sessions) {
            if (this.tombstones.has(sessionId)) continue;
            const remote = merged.get(sessionId);
            if (
              remote === undefined ||
              changed.has(sessionId) ||
              this.compareStored(local, remote) >= 0
            ) {
              merged.set(sessionId, local);
            }
          }
          for (const sessionId of this.tombstones.keys()) {
            merged.delete(sessionId);
          }

          const payload: PersistedAgentStore = {
            version: STORE_VERSION,
            sessions: [...merged.values()],
            tombstones: Object.fromEntries(this.tombstones),
          };
          const temp = `${this.options.storePath}.tmp-${process.pid}-${randomUUID()}`;
          let committed = false;
          try {
            await fs.writeFile(temp, JSON.stringify(payload, null, 2), 'utf8');
            try {
              await fs.rename(temp, this.options.storePath);
            } catch {
              await new Promise((resolve) => setTimeout(resolve, 50));
              await fs.rename(temp, this.options.storePath);
            }
            committed = true;
          } finally {
            if (!committed) await fs.rm(temp, { force: true }).catch(() => undefined);
          }

          this.sessions = merged;
          this.persistedSnapshots.clear();
          for (const [sessionId, stored] of merged) {
            this.persistedSnapshots.set(sessionId, JSON.stringify(stored));
          }
          this.pendingDeletions.clear();
        } finally {
          await release();
        }
      });
    return this.persistQueue;
  }
}

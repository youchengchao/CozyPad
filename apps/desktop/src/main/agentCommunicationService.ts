import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  AgentAttachmentSchema,
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
  AgentDetectionRequest,
  AgentInstallation,
  AgentLaunchMode,
  AgyRecoveredTurn,
  AgyTranscript,
  AgyTranscriptRequest,
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
  DeclineAgentQuestionRequest,
  DeleteAgentSessionResult,
  NormalizedAgentEvent,
  RemoteAgentSessionRecord,
  RemoteHostEnvironment,
  RenameAgentSessionRequest,
  ResolveAgentApprovalRequest,
  SendAgentMessageRequest,
  UploadAgentAttachmentsRequest,
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
  CODEX_CONTROL_METHODS,
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
  /** Per-command help, shown next to the name in the composer's menu. */
  slashCommandDescriptions?: Record<string, string>;
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
  readAgyTranscript(request: AgyTranscriptRequest): Promise<AgyTranscript>;
  openTerminal(request: AgentTerminalOpenRequest): Promise<TerminalOpened>;
  rename(request: RenameAgentSessionRequest): Promise<void>;
  delete(request: AgentSessionRequest): Promise<DeleteAgentSessionResult>;
  uploadAttachments(
    request: UploadAgentAttachmentsRequest,
  ): Promise<AgentAttachment[]>;
  send(request: SendAgentMessageRequest): Promise<void>;
  interrupt(request: AgentSessionRequest): Promise<void>;
  resolveApproval(request: ResolveAgentApprovalRequest): Promise<void>;
  answerQuestion(request: AnswerAgentQuestionRequest): Promise<void>;
  declineQuestion(request: DeclineAgentQuestionRequest): Promise<void>;
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
    start(sessionId: string, cwd: string, agentKind: string): Promise<unknown>;
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
export const STORE_VERSION = 1;

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

function sameAgyPrompt(actual: string, expected: string): boolean {
  const normalize = (value: string) => value.replace(/\r\n?/gu, '\n').trim();
  return normalize(actual) === normalize(expected);
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
  // The whitelist is shared with the adapter that renders the cards, so a
  // method can never be registered as a pending control without also having
  // a card that answers it.
  if (!(CODEX_CONTROL_METHODS as readonly string[]).includes(value.method)) {
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
  /**
   * The launch generation currently being followed for each CozyPad session.
   * A session id survives Resume, while its runtime does not; keying only by
   * session id lets a late old follower overwrite the replacement runtime.
   */
  private readonly following = new Map<string, string>();
  private readonly completing = new Set<string>();
  private readonly installations = new Map<string, AgentInstallation>();
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
    if (parsed.version !== STORE_VERSION) {
      await this.quarantineStore(
        `it was written by a different version of CozyPad (store version ${String(parsed.version)}, this build reads ${STORE_VERSION})`,
      );
      return;
    }
    for (const value of parsed.sessions) {
      const session = parseStoredSession(value);
      if (session !== null) this.sessions.set(session.record.id, session);
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
    void this.persist().catch(() => undefined);
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
          supportsStructuredOutput: structured,
          supportsResume:
            userScoped &&
            probeSucceeded &&
            ((request.agentKind === 'claude' && helpOutput.includes('--resume')) ||
              (request.agentKind === 'agy' &&
                helpOutput.includes('--conversation'))),
          // Codex can always be resumed in the SPEC 268 sense — the process
          // relaunches — but its thread dies with the process, so the resume
          // opens a new native conversation and the UI must say so.
          ...(request.agentKind === 'codex'
            ? { resumeStartsNewConversation: true }
            : {}),
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

    try {
      await this.startAgentConversation();
      // "Ready" has to mean the agent answered, not that a process was
      // spawned. followSession used to decide this by watching the agent's
      // output stream; the ACP equivalent is that initialize and session/new
      // both returned, which is also when the model list becomes available.
      // Only on this machine. `acp.start` spawns a child here, in this cwd —
      // a remote session's cwd belongs to the other host and does not exist
      // locally. Running the agent over SSH is a separate transport that does
      // not exist yet, so a remote session says so rather than failing at a
      // spawn with a message about the wrong thing.
      this.assertAcpSupported(stored);
      if (this.options.acp !== undefined) {
        await this.options.acp.start(
          stored.record.id,
          stored.record.cwd,
          stored.record.provisionalIdentity.agentKind,
        );
      }
      stored.record = {
        ...stored.record,
        status: 'ready',
        updatedAt: new Date().toISOString(),
      };
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
  /**
   * The handshake belongs to the runtime now, not to the service.
   *
   * This used to write an agent-specific initialize frame into a tmux pane:
   * a `control_request` for claude, a JSON-RPC `initialize` for codex. Both
   * are `initialize` + `session/new` over ACP, performed when the runtime
   * starts a session, so there is nothing left to send from here.
   */
  private async startAgentConversation(): Promise<void> {
    return Promise.resolve();
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
    // An errored launch can leave its runtime session behind, and the local
    // runtime keeps a dead session's name until it is killed — either would
    // block the relaunch.
    await this.options.tmux
      .killSession(stored.record.provisionalIdentity.tmuxSessionId)
      .catch(() => undefined);
    await this.prepareRemoteStorage(id);
    // The logs were just truncated; the dead run's stream state goes with them.
    stored.rawLines = 0;
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
      installation.supportsResume && agentKind === 'claude'
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
      await this.startAgentConversation();
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
   * Reads canonical Markdown from AGY's own local store. A revived or already
   * bound session can read directly. A fresh session must supply its exact
   * submitted prompt; only a newly written conversation whose latest prompt
   * matches is accepted and bound. This keeps unrelated AGY history private.
   */
  async readAgyTranscript(request: AgyTranscriptRequest): Promise<AgyTranscript> {
    const stored = this.requireSession(request.sessionId);
    const profileId = stored.record.provisionalIdentity.connectionProfileId;
    const isLocal = this.options.isLocalHost?.(profileId) === true;
    const conversationId = stored.record.identity?.agentConversationId ?? undefined;
    const isActiveRevived =
      stored.revived === true && this.activeProfileId === profileId;

    if (
      stored.record.provisionalIdentity.agentKind !== 'agy' ||
      !isLocal ||
      this.options.readLocalAgyTranscript === undefined
    ) {
      return { turns: [] };
    }

    try {
      let resolvedConversationId = conversationId;
      let turns: AgyRecoveredTurn[];
      if (resolvedConversationId !== undefined) {
        turns = await this.options.readLocalAgyTranscript(resolvedConversationId);
      } else if (isActiveRevived) {
        // Preserve restart recovery: revive() already scopes the native store
        // to the conversation selected for this session.
        turns = await this.options.readLocalAgyTranscript();
      } else {
        if (
          request.expectedPrompt === undefined ||
          this.activeProfileId !== profileId ||
          this.options.getLatestLocalAgyConversationId === undefined
        ) {
          return { turns: [] };
        }
        const launchMs =
          stored.record.tmuxCreatedEpoch == null
            ? Date.parse(stored.record.createdAt)
            : stored.record.tmuxCreatedEpoch * 1000;
        const now = Date.now();
        resolvedConversationId = await this.options.getLatestLocalAgyConversationId({
          notBefore: (Number.isFinite(launchMs) ? launchMs : now) - 5_000,
          notAfter: now + 5_000,
        });
        if (resolvedConversationId === undefined) return { turns: [] };
        turns = await this.options.readLocalAgyTranscript(resolvedConversationId);
      }

      const latest = turns.at(-1);
      if (
        request.expectedPrompt !== undefined &&
        (latest === undefined || !sameAgyPrompt(latest.prompt, request.expectedPrompt))
      ) {
        return { turns: [] };
      }

      if (conversationId === undefined && resolvedConversationId !== undefined) {
        const fingerprint = this.options.getHostFingerprint(profileId);
        if (fingerprint !== undefined) {
          const now = new Date().toISOString();
          stored.record = bindAgentIdentity(stored.record, {
            agentConversationId: resolvedConversationId,
            remoteHostFingerprint: fingerprint,
            tmuxPaneId: stored.paneId,
            now,
          });
          await this.persist();
          this.emitSession(stored);
          await this.writeRemoteMetadata(stored).catch(() => undefined);
        }
      }

      return { turns };
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

  async delete(request: AgentSessionRequest): Promise<DeleteAgentSessionResult> {
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
      this.assertAcpSupported(stored);
      if (!this.options.acp.has(stored.record.id)) {
        await this.options.acp.start(
          stored.record.id,
          stored.record.cwd,
          stored.record.provisionalIdentity.agentKind,
        );
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
        // session; otherwise it remains ready for an immediate retry.
        status: runtimeAlive ? 'ready' : 'error',
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
    stored.record = {
      ...stored.record,
      status: 'ready',
      updatedAt: new Date().toISOString(),
    };
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
    const byKind = (prefix: string): string | undefined =>
      options.find((option) => option.kind?.startsWith(prefix) === true)?.optionId;
    const optionId =
      request.resolution === 'allowed'
        ? (byKind('allow') ?? options[0]?.optionId ?? null)
        : (byKind('reject') ?? byKind('deny') ?? null);

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
    stored.record = { ...stored.record, updatedAt: new Date().toISOString() };
    await this.persist();
    this.emitTimeline(stored);
  }

  async answerQuestion(request: AnswerAgentQuestionRequest): Promise<void> {
    const stored = this.requireSession(request.sessionId);
    this.assertSessionConnected(stored);
    const item = stored.timeline.find(
      (candidate): candidate is Extract<ChatItem, { kind: 'question' }> =>
        candidate.id === request.itemId && candidate.kind === 'question',
    );
    if (
      item === undefined ||
      item.selectedIndex !== null ||
      item.expired === true ||
      item.declined === true
    ) {
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
    // The agent's request is the denominator, not the surviving cards: when a
    // question could not be rendered, `every` over the cards alone became
    // true early and a *partial* answer set was sent as the final result.
    if (
      relatedItems.length === questions.length &&
      relatedItems.every((candidate) => candidate.selectedIndex !== null)
    ) {
      if (pending.protocol === 'codex') {
        // Answered through ACP's own return value; see AcpAgentRuntime.
        this.options.acp?.resolveControl(stored.record.id, requestId ?? '');
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

  /**
   * Refuse a whole question request (SPEC 3.4.6): the fallback for questions
   * CozyPad cannot represent. One reply answers the entire JSON-RPC request /
   * control request, so every sibling card of the batch closes with it.
   */
  async declineQuestion(request: DeclineAgentQuestionRequest): Promise<void> {
    const stored = this.requireSession(request.sessionId);
    this.assertSessionConnected(stored);
    const item = stored.timeline.find(
      (candidate): candidate is Extract<ChatItem, { kind: 'question' }> =>
        candidate.id === request.itemId && candidate.kind === 'question',
    );
    if (
      item === undefined ||
      item.selectedIndex !== null ||
      item.expired === true ||
      item.declined === true
    ) {
      throw new Error('Pending agent question not found');
    }
    const rawQuestionId = request.itemId.replace(/^question-/u, '');
    const separator = rawQuestionId.lastIndexOf(':');
    if (separator < 1) throw new Error('Question control request is invalid');
    const requestId = rawQuestionId.slice(0, separator);
    const pending = stored.pendingControls[requestId];
    if (
      pending === undefined ||
      !['AskUserQuestion', 'RequestUserInput'].includes(pending.toolName)
    ) {
      throw new Error('Question control request has expired');
    }
    if (pending.protocol === 'codex') {
      // Answered through ACP's own return value; see AcpAgentRuntime.
      this.options.acp?.resolveControl(stored.record.id, requestId ?? '');
    } else {
      await this.writeControlResponse(stored, requestId, {
        behavior: 'deny',
        message: 'Declined by the CozyPad user',
      });
    }
    delete stored.pendingControls[requestId];
    delete stored.questionAnswers[requestId];
    for (const candidate of stored.timeline) {
      if (
        candidate.kind === 'question' &&
        candidate.id.startsWith(`question-${requestId}:`) &&
        candidate.selectedIndex === null
      ) {
        candidate.declined = true;
      }
    }
    stored.record = {
      ...stored.record,
      status: 'running',
      updatedAt: new Date().toISOString(),
    };
    await this.persist();
    this.emitSession(stored);
    this.emitTimeline(stored);
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
    stored.pendingControls = {};
    stored.questionAnswers = {};
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
          // The old timeline stays, but it is CozyPad history now, not agent
          // memory (SPEC 275-278): mark the boundary where the new native
          // conversation begins, in the agent's own terms.
          stored.resumeContinuity = 'new';
          stored.timeline.push({
            id: `notice-${event.eventId}`,
            kind: 'notice',
            text:
              stored.record.provisionalIdentity.agentKind === 'codex'
                ? '以下開始新的原生對話：Codex 不記得這條分隔線之前的內容。'
                : `無法確認是否延續同一原生對話：${agentLabelFor(
                    stored.record.provisionalIdentity.agentKind,
                  )} 可能不記得這條分隔線之前的內容。`,
            timestamp: event.timestamp,
          });
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
          machine: stored.host,
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
      case 'question_requested': {
        // `id:index` is the shared question-id shape of both protocols; the
        // prefix groups one agent request's cards into a batch (SPEC 3.4.6).
        const separator = event.questionId.lastIndexOf(':');
        stored.timeline.push({
          id: `question-${event.questionId}`,
          kind: 'question',
          prompt: event.prompt,
          options: event.options,
          selectedIndex: null,
          ...(separator > 0
            ? { batchId: event.questionId.slice(0, separator) }
            : {}),
          ...(event.unrepresentable === true ? { unrepresentable: true } : {}),
          timestamp: event.timestamp,
        });
        stored.record = { ...stored.record, status: 'waiting_approval' };
        break;
      }
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
      case 'usage': {
        // Codex streams several tokenUsage updates within one turn;
        // consecutive rows collapse so the timeline keeps a turn's final
        // figures once instead of a ladder of intermediate counts.
        const lastItem = stored.timeline.at(-1);
        if (lastItem?.kind === 'usage') {
          lastItem.inputTokens = event.inputTokens;
          lastItem.outputTokens = event.outputTokens;
          lastItem.timestamp = event.timestamp;
          break;
        }
        stored.timeline.push({
          id: `usage-${event.eventId}`,
          kind: 'usage',
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          timestamp: event.timestamp,
        });
        break;
      }
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


  private writeControlResponse(
    stored: StoredAgentSession,
    requestId: string,
    response: Record<string, unknown>,
  ): Promise<void> {
    // ACP answers a control request by returning a value, so this resolves
    // the promise the runtime is holding rather than writing a frame back.
    this.options.acp?.resolveControl(
      stored.record.id,
      requestId,
      typeof response['optionId'] === 'string' ? response['optionId'] : null,
    );
    return Promise.resolve();
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
    return AgentSessionSummarySchema.parse({
      id: stored.record.id,
      agentKind,
      title: stored.record.title,
      host: stored.host,
      project: stored.project,
      cwd: stored.record.cwd,
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

  /**
   * Refuses work the local ACP runtime cannot do.
   *
   * Split out so both `create` and `send` refuse identically: a session that
   * was created remotely must not become sendable later just because the check
   * lived in only one of them.
   */
  private assertAcpSupported(stored: StoredAgentSession): void {
    const profileId = stored.record.provisionalIdentity.connectionProfileId;
    if (this.options.isLocalHost?.(profileId) === true) return;
    throw new Error(
      'Agent sessions on a remote host are not available yet. ' +
        'CozyPad now runs agents over the Agent Client Protocol as a local ' +
        'child process; running one on the other end of an SSH connection is a ' +
        'separate transport that has not been built. Open this session on ' +
        '"This computer" instead.',
    );
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
      version: STORE_VERSION,
      sessions: [...this.sessions.values()],
    };
    const raw = JSON.stringify(payload, null, 2);
    this.persistQueue = this.persistQueue
      // One failed write must not poison the chain: `.then` on a rejected
      // promise never runs, so without this every later persist would fail
      // forever after a single transient error.
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(path.dirname(this.options.storePath), { recursive: true });
        const temp = `${this.options.storePath}.tmp`;
        await fs.writeFile(temp, raw, 'utf8');
        try {
          await fs.rename(temp, this.options.storePath);
        } catch {
          // Windows: a virus scanner or indexer briefly holding either file
          // makes rename throw EPERM; one retry after a beat resolves it.
          await new Promise((resolve) => setTimeout(resolve, 50));
          await fs.rename(temp, this.options.storePath);
        }
      });
    return this.persistQueue;
  }
}

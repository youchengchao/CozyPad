import type {
  CompleteElicitationNotification,
  CreateElicitationRequest,
  CreateElicitationResponse,
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk';
import type { AcpSessionEvent } from './sessionEvents';

/**
 * `fs/read_text_file` and `fs/write_text_file`.
 *
 * Wire these to CozyPad's RoutingTransport so a local session and an SSH
 * session answer the agent the same way. Each is advertised independently in
 * `ClientCapabilities.fs`, so supplying only one is legitimate.
 */
export interface AcpFileSystemHandlers {
  readTextFile?(params: ReadTextFileRequest): Promise<ReadTextFileResponse>;
  writeTextFile?(params: WriteTextFileRequest): Promise<WriteTextFileResponse>;
}

/**
 * `terminal/*`, wired to CozyPad's PTY runtime.
 *
 * Every method is required, because ACP advertises terminal support as one
 * boolean — "whether the Client supports **all** `terminal/*` methods". A
 * partial implementation cannot be advertised honestly, so the type refuses to
 * let you build one.
 */
export interface AcpTerminalHandlers {
  create(params: CreateTerminalRequest): Promise<CreateTerminalResponse>;
  output(params: TerminalOutputRequest): Promise<TerminalOutputResponse>;
  release(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse>;
  waitForExit(
    params: WaitForTerminalExitRequest,
  ): Promise<WaitForTerminalExitResponse>;
  kill(params: KillTerminalRequest): Promise<KillTerminalResponse>;
}

/**
 * ACP's extension channel.
 *
 * ⚠️ **This changed meaning between libraries.** Under
 * `@zed-industries/agent-client-protocol@0.4.5` these handlers saw *only*
 * methods whose name began with `_`, and saw the name with that underscore
 * removed. Under `@agentclientprotocol/sdk` they are the **catch-all for every
 * method the SDK does not recognise**, and `method` is the name exactly as it
 * arrived, `_` included.
 *
 * Two consequences, both deliberate and both pinned by tests:
 *
 * - Do not strip or re-add the underscore yourself; match on the literal name.
 * - Supplying `method` opts out of `method not found` for anything unknown,
 *   including spec methods newer than the installed SDK. Leave it off unless
 *   you really want to answer for everything.
 */
export interface AcpExtensionHandlers {
  method?(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  notification?(
    method: string,
    params: Record<string, unknown>,
  ): Promise<void>;
}

/**
 * `elicitation/create` and `elicitation/complete` — the question card.
 *
 * This used to be a CozyPad invention. Against
 * `@zed-industries/agent-client-protocol@0.4.5` there was no elicitation at all
 * (`CLIENT_METHODS` stopped at `fs/*`, `terminal/*`,
 * `session/request_permission` and `session/update`), so an agent had to ask
 * through the extension method `_elicitation/create` with an untyped payload
 * that no real agent would ever send. `@agentclientprotocol/sdk` ships the
 * method for real — `CLIENT_METHODS.elicitation_create` is literally
 * `"elicitation/create"` — so the workaround is gone and this is the spec
 * method, with the spec's own types.
 *
 * It is marked **UNSTABLE** in the SDK (hence its `unstable_` prefix on the
 * `Client` object). The shape may change; the method name is the one agents
 * actually call.
 */
export interface AcpElicitationHandlers {
  /**
   * Which modes the UI can actually render.
   *
   * Declared rather than inferred, and that is the one place this package asks
   * for something it could have guessed. `create` is a single function that
   * receives `mode: 'form' | 'url' | <custom>`; nothing about it reveals which
   * of those the UI can draw. Advertising both would invite an agent to send a
   * URL elicitation to a client that can only render a form, and the agent
   * would then wait on an answer that cannot come.
   */
  readonly modes: { readonly form?: boolean; readonly url?: boolean };
  create(params: CreateElicitationRequest): Promise<CreateElicitationResponse>;
  /**
   * `elicitation/complete` — a notification that a URL elicitation finished
   * out of band (the user completed a flow in a browser). Only meaningful
   * alongside `modes.url`.
   */
  complete?(params: CompleteElicitationNotification): Promise<void>;
}

/**
 * Which kinds of ACP authentication method the UI can actually carry out.
 *
 * **An agent offers no login at all unless this is declared.** Measured against
 * `@agentclientprotocol/claude-agent-acp`: with the capabilities this package
 * derived before, the `InitializeResponse` came back with `authMethods: []`;
 * adding `auth: { terminal: true }` produced
 * `{ id: 'claude-login', type: 'terminal', args: ['--cli'],
 * name: 'Log in with Claude' }`. So a user with no credentials got a failed
 * `session/new` and **no way to fix it** — not a missing button, a missing
 * option on the wire.
 *
 * Declared rather than inferred, like {@link AcpElicitationHandlers.modes} and
 * for the same reason: nothing about having a `terminal/*` handler says the UI
 * is willing to run the agent's binary interactively so a person can type a
 * password into it, and claiming otherwise makes the agent offer a method that
 * then goes unanswered.
 *
 * ⚠️ Marked **UNSTABLE** in the SDK.
 */
export interface AcpAuthCapabilities {
  /**
   * Whether the UI can run an `AuthMethodTerminal`.
   *
   * That method type means "run the agent's own binary with these extra args
   * and let the user complete the login in the terminal it appears in" — so
   * this is a promise about the UI having somewhere to show that, not about
   * the `terminal/*` handlers, which are a different thing entirely.
   */
  readonly terminal?: boolean;
}

/**
 * Everything the agent is allowed to ask CozyPad to do.
 *
 * Nothing here is hard-wired to a runtime — no `node:fs`, no PTY, no UI. The
 * desktop main process injects implementations; tests inject fakes.
 *
 * Omitting an optional group is meaningful, not lazy: the corresponding
 * methods are left off the ACP `Client` object entirely and the matching
 * capability is advertised as `false` (or omitted), which is how ACP expresses
 * "this client cannot do that".
 */
export interface AcpClientHandlers {
  /** Called for every `session/update` notification. Required. */
  onSessionUpdate(event: AcpSessionEvent): void | Promise<void>;

  /**
   * `session/request_permission` — the approval card. Required, because ACP
   * makes it mandatory for clients: an agent may ask at any time, and a client
   * that cannot answer would stall the turn.
   */
  requestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse>;

  fs?: AcpFileSystemHandlers;
  terminal?: AcpTerminalHandlers;
  ext?: AcpExtensionHandlers;
  elicitation?: AcpElicitationHandlers;
  /**
   * Which login flows the UI can run. Omitting this asks the agent for none —
   * see {@link AcpAuthCapabilities}, which is the only reason it is stated
   * here rather than inferred.
   */
  auth?: AcpAuthCapabilities;
}

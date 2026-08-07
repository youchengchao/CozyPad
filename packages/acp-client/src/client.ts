import type {
  AuthCapabilities,
  Client,
  ClientCapabilities,
  ElicitationCapabilities,
} from '@agentclientprotocol/sdk';
import type { AcpClientHandlers } from './handlers';
import { normalizeSessionNotification } from './sessionEvents';

/**
 * The elicitation modes to advertise, or `undefined` when there is no handler.
 *
 * ACP reads an omitted sub-capability and an explicit `null` the same way, and
 * `{}` means "supported" — so a mode is present as `{}` or absent entirely,
 * never `false`.
 */
function elicitationCapabilities(
  handlers: AcpClientHandlers,
): ElicitationCapabilities | undefined {
  const elicitation = handlers.elicitation;
  if (elicitation === undefined) return undefined;
  return {
    ...(elicitation.modes.form === true ? { form: {} } : {}),
    ...(elicitation.modes.url === true ? { url: {} } : {}),
  };
}

/**
 * The auth method types to advertise, or `undefined` when none are declared.
 *
 * Unlike `elicitation`, ACP spells this group's members as booleans
 * (`AuthCapabilities.terminal?: boolean`), not as `{}`. Absent and `false` mean
 * the same thing, and the group is omitted entirely when nothing is declared —
 * an empty `auth: {}` would say "I support authentication, but no kind of it",
 * which is a sentence with no meaning on the wire.
 */
function authCapabilities(
  handlers: AcpClientHandlers,
): AuthCapabilities | undefined {
  const auth = handlers.auth;
  if (auth === undefined) return undefined;
  return { terminal: auth.terminal === true };
}

/**
 * Derives the `ClientCapabilities` that match a set of handlers.
 *
 * Capabilities and implementations cannot drift apart if the former is
 * computed from the latter, which is why {@link connectAcpAgent} calls this
 * rather than taking capabilities as a separate argument.
 *
 * `fs` and `terminal` are always written out rather than left absent: `false`
 * and "not mentioned" mean the same thing to an agent, and being explicit
 * makes the handshake readable in a protocol log. The unstable groups are
 * omitted when unsupported instead, because there `{}` is the "yes" and there
 * is no `false` to write.
 *
 * `auth` is the exception that proves that rule, and it is the one capability
 * whose absence silently removes a user-visible feature: an agent lists no
 * `authMethods` unless the client says which kinds it can run, so a user with
 * no credentials gets a failed `session/new` and no login path. See
 * {@link AcpAuthCapabilities}.
 */
export function deriveClientCapabilities(
  handlers: AcpClientHandlers,
): ClientCapabilities {
  const elicitation = elicitationCapabilities(handlers);
  const auth = authCapabilities(handlers);
  return {
    fs: {
      readTextFile: handlers.fs?.readTextFile !== undefined,
      writeTextFile: handlers.fs?.writeTextFile !== undefined,
    },
    terminal: handlers.terminal !== undefined,
    ...(elicitation === undefined ? {} : { elicitation }),
    ...(auth === undefined ? {} : { auth }),
  };
}

/**
 * Builds the ACP `Client` object that `ClientSideConnection` dispatches
 * incoming agent requests to.
 *
 * Optional methods backed by no handler are **left off the object**. They are
 * not stubs that throw: the connection registers a handler only for the
 * methods present on this object, so absence is the protocol-level way to say
 * "unsupported", and it lines up with the `false` that
 * {@link deriveClientCapabilities} advertises for the same handler.
 */
export function createAcpClient(handlers: AcpClientHandlers): Client {
  const client: Client = {
    sessionUpdate: async (params) => {
      await handlers.onSessionUpdate(normalizeSessionNotification(params));
    },
    requestPermission: (params) => handlers.requestPermission(params),
  };

  const fs = handlers.fs;
  if (fs?.readTextFile !== undefined) {
    client.readTextFile = fs.readTextFile.bind(fs);
  }
  if (fs?.writeTextFile !== undefined) {
    client.writeTextFile = fs.writeTextFile.bind(fs);
  }

  const terminal = handlers.terminal;
  if (terminal !== undefined) {
    client.createTerminal = terminal.create.bind(terminal);
    client.terminalOutput = terminal.output.bind(terminal);
    client.releaseTerminal = terminal.release.bind(terminal);
    client.waitForTerminalExit = terminal.waitForExit.bind(terminal);
    client.killTerminal = terminal.kill.bind(terminal);
  }

  const elicitation = handlers.elicitation;
  if (elicitation !== undefined) {
    client.unstable_createElicitation = elicitation.create.bind(elicitation);
    if (elicitation.complete !== undefined) {
      client.unstable_completeElicitation =
        elicitation.complete.bind(elicitation);
    }
  }

  const ext = handlers.ext;
  if (ext?.method !== undefined) {
    client.extMethod = ext.method.bind(ext);
  }
  if (ext?.notification !== undefined) {
    client.extNotification = ext.notification.bind(ext);
  }

  return client;
}

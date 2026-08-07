/**
 * `agy` as an ACP agent.
 *
 * The protocol library is `@agentclientprotocol/sdk`, and it must stay the same
 * one `packages/acp-client` uses. `@zed-industries/agent-client-protocol` is the
 * old name of this package ("renamed to @agentclientprotocol/sdk", npm's own
 * words), frozen at 0.4.5, and several of its types are narrower than the spec —
 * `rawInput`/`rawOutput` are `Record<string, unknown>` where ACP says `unknown`,
 * and its `session/update` union is missing five variants. Those gaps are not
 * cosmetic: a client on 0.4.5 was measured dropping every terminal tool update
 * whose `rawOutput` was a string or an array. CozyPad's client and CozyPad's own
 * agent speaking different versions would put that same defect inside our own
 * stack, so this package tracks the client's dependency exactly.
 */
export * from './wire.js';
export * from './mapper.js';
export * from './transport.js';
export * from './cliTransport.js';
export * from './agent.js';
export * from './serve.js';

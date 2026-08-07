/**
 * A healthy agent that completes the handshake and then answers
 * `session/prompt` after `argv[2]` milliseconds — or never, if `argv[2]` is
 * omitted.
 *
 * One fixture rather than two on purpose. "Wedged" and "merely slow" differ
 * here by a single command-line argument and by nothing else — same code, same
 * reads, same stdout, same process — which is the strongest available statement
 * of the thing this fixture exists to demonstrate: that from the client's side
 * the two are the same picture until the reply lands. See `AcpConnectionStatus`
 * in ../../src/connect.ts for the measured table.
 *
 * It reads its stdin normally, unlike `deafAgent.mjs`. That matters: a wedged
 * agent is not a deaf one, the request is received and understood, and
 * `writePendingMs` is `null` for both because the transport did its job.
 */

const replyAfterMs = process.argv[2] === undefined ? null : Number(process.argv[2]);

let buffered = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffered += chunk;
  for (;;) {
    const newline = buffered.indexOf('\n');
    if (newline === -1) break;
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    if (line.trim() !== '') dispatch(JSON.parse(line));
  }
});

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function dispatch(request) {
  const { id, method, params } = request;
  switch (method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params.protocolVersion,
          agentCapabilities: { loadSession: false },
          authMethods: [],
        },
      });
      return;
    case 'session/new':
      send({ jsonrpc: '2.0', id, result: { sessionId: 'paced-session' } });
      return;
    case 'session/prompt':
      if (replyAfterMs === null) return; // wedged: read, understood, unanswered
      setTimeout(() => {
        send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
      }, replyAfterMs);
      return;
    default:
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `method not found: ${method}` },
      });
  }
}

// Stays alive whatever it decided above, so "it never answered" is never
// confused with "it exited".
setInterval(() => {}, 1000);

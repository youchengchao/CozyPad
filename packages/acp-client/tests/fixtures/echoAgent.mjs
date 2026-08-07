/**
 * A minimal, well-behaved ACP agent, spawned as a real child process.
 *
 * Hand-written newline-delimited JSON-RPC rather than
 * `AgentSideConnection`, so a bug in the client cannot be cancelled out by the
 * same bug on the agent side. It answers and then stays alive: when it dies is
 * the test's decision, not its own.
 */

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
      send({ jsonrpc: '2.0', id, result: { sessionId: 'fixture-session' } });
      return;
    case 'session/prompt':
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'pong' },
          },
        },
      });
      send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
      return;
    default:
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `method not found: ${method}` },
      });
  }
}

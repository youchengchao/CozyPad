/**
 * An agent that closes its stdout and keeps running.
 *
 * The shape `connectAcpAgentProcess` claims to cover with "stdout ending or
 * breaking", and the reason that claim needed a real child to check. On
 * Windows / Node 24 the parent's `child.stdout` emits **nothing** when this
 * happens — no `end`, no `close`, no `error`, `readableEnded` stays `false` —
 * for as long as the child stays alive. The `SilentChild` `PassThrough` stub in
 * connectProcess.test.ts does not reproduce that, because `PassThrough.end()`
 * emits `end` at once and a real OS pipe does not.
 *
 * It announces itself on **stderr** first, so a test can wait for a real
 * readiness signal rather than sleeping, and so the stdout close is known to
 * have happened before any assertion runs.
 *
 * Reads stdin so the parent's writes never block; a stdin that stops being
 * read is the *other* blind spot and has its own fixture.
 */

process.stdin.resume();
process.stdin.on('data', () => {});
process.stdin.on('error', () => {});

process.stdout.end();
process.stderr.write('stdout closed\n');

setInterval(() => {}, 1000);

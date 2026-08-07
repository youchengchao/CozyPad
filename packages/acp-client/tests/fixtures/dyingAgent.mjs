/**
 * An ACP agent that dies on the first request without answering it.
 *
 * This is the failure that motivated the liveness in src/connect.ts: a real
 * agent that cannot start (bad flag, expired auth, OOM) accepts the handshake
 * bytes, complains on stderr and exits. Nothing ever comes back on stdout.
 *
 * Pass `--silent` to die without saying anything, which is the case where the
 * exit status is the only diagnostic there is.
 *
 * The exit is deliberately deferred until after stderr has flushed *and* one
 * more timer tick, so the parent has certainly received the text before the
 * `exit` event. The production code treats the stderr tail as best effort; the
 * test must not be the thing that makes it look flaky.
 */

const silent = process.argv.includes('--silent');
const EXIT_CODE = 17;

process.stdin.resume();
process.stdin.once('data', () => {
  if (silent) {
    process.exit(EXIT_CODE);
    return;
  }
  process.stderr.write(
    'dyingAgent: fatal: could not reach the model backend\ndyingAgent: run `agy login` and retry\n',
    () => {
      setTimeout(() => process.exit(EXIT_CODE), 20);
    },
  );
});

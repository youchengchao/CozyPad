/**
 * An agent that is already dead by the time anyone connects to it.
 *
 * This is what `agy` does when it is not logged in: it writes a line to stderr
 * and exits, in single-digit milliseconds, without reading a byte of stdin.
 * `dyingAgent.mjs` cannot stand in for it — that one waits for the first
 * request, so the parent is always attached before anything terminal happens.
 *
 * The distinction is the whole point. A parent that spawns this and then awaits
 * anything at all before connecting (a readiness check, a `once('spawn')`, a
 * config read) finds a process whose stdout has *already* ended and whose
 * `exit` event has *already* fired. Measured: a 25 ms gap is enough, and after
 * it not one event fires again.
 */

process.stderr.write(
  'deadOnArrival: fatal: not logged in\ndeadOnArrival: run `agy login` and retry\n',
);
process.exit(17);

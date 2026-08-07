/**
 * An agent that is alive, reads everything, and answers nothing.
 *
 * Its stdout stays open and empty, so no EOF ever arrives; it never exits, so
 * no exit code ever arrives. Every liveness signal built on the agent *going
 * away* is blind to it by construction, which makes it the fixture for the two
 * cases that are not about death at all: a stdin that breaks under a healthy
 * process, and a request that is simply never answered.
 *
 * It holds the event loop open with an interval rather than by reading stdin,
 * so it survives its stdin being destroyed from the parent side.
 */

process.stdin.resume();
process.stdin.on('data', () => {});
process.stdin.on('error', () => {});
setInterval(() => {}, 1000);

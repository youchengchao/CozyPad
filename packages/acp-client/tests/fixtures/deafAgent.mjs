/**
 * An agent that is alive, healthy-looking, and never reads its stdin.
 *
 * The second Windows blind spot. Measured against a child exactly like this
 * one: the parent's writes are simply buffered — no `EPIPE`, no `error`, no
 * `close`, `errored` `null`, `destroyed` `false`.
 *
 * What decides whether a write completes is the **OS pipe buffer**, ~64 KiB,
 * and nothing else:
 *
 * | written here | called back? |
 * |---|---|
 * | 200 B, ×3 and ×5 consecutively | yes, all of them, in 0–1 ms |
 * | 65 536 B in one write | yes, in 0 ms |
 * | 73 728 B in one write | no |
 * | 200 B × 327, then the 328th | yes ×327 (65 400 B), then no |
 * | 150 B × 436, then the 437th | yes ×436 (65 400 B), then no |
 * | 2 MB in one write | no — `writableLength` 2 097 152 for 8 s |
 *
 * The header this replaces said "the first 200-byte write called back in 2 ms,
 * the next two never called back at all". Every re-run contradicts it: the
 * write index is irrelevant, the byte count is everything.
 *
 * So there is nothing to turn into a disconnect, and — the part that matters
 * for a UI — nothing to turn into a *diagnosis* either. This agent is deaf, and
 * for the first ~437 ACP-sized requests it is indistinguishable from one that
 * is merely busy: `AcpRequestStatus.writePendingMs` stays `null` throughout.
 * See `AcpConnectionStatus` in ../../src/connect.ts.
 *
 * `stdin.pause()` is explicit rather than implied. Node does not start reading
 * a stdio stream until something asks it to, but saying so here is what stops a
 * future edit from adding a listener and quietly deleting the whole fixture.
 */

process.stdin.pause();

// Stdout stays open and silent: every death-shaped signal this package has is
// blind to this agent by construction, which is the point of it.
process.stderr.write('deaf\n');

setInterval(() => {}, 1000);

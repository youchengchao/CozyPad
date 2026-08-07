// Is `stream.resume()` in drainWriteHalfReadSide load-bearing, or dead weight?
//
// The whole suite passes with that line deleted (mutant H1-resume-first
// SURVIVED). This file asks whether that is because the line is redundant or
// because no test produces the shape it covers.
//
// Measured premise (resumeprobe.mjs): attaching on('data') restarts the flow on
// a socket whose readableFlowing is null, and does NOT restart it on one that
// was explicitly .pause()d. Every existing test uses the former. A caller that
// hands over an explicitly paused socket — an SSH library that pauses a channel
// between multiplexed reads — gets the latter.
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { writableToNodeStream } from '../src/nodeStreams';

const openServers: net.Server[] = [];
const openSockets: net.Socket[] = [];
afterEach(() => {
  for (const s of openSockets.splice(0)) s.destroy();
  for (const s of openServers.splice(0)) s.close();
});

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function socketPair(): Promise<{ ours: net.Socket; peer: net.Socket }> {
  let announce!: (socket: net.Socket) => void;
  const peerReady = new Promise<net.Socket>((resolve) => { announce = resolve; });
  const server = net.createServer((socket) => { socket.resume(); announce(socket); });
  openServers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as net.AddressInfo).port);
    });
  });
  const ours = await new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
  const peer = await peerReady;
  openSockets.push(ours, peer);
  ours.on('error', () => undefined);
  peer.on('error', () => undefined);
  return { ours, peer };
}

describe('drainWriteHalfReadSide: an explicitly paused write half', () => {
  it(
    'still reports a peer FIN when the caller handed over a paused socket',
    async () => {
      const { ours, peer } = await socketPair();
      peer.write('unconsumed-inbound!!\n');
      await sleep(120);

      // The shape no existing test produces. `readableFlowing` is now `false`
      // rather than `null`, so a `data` listener alone will NOT restart the
      // flow — only `resume()` will.
      ours.pause();
      expect(ours.readableFlowing).toBe(false);

      let reported: string | null = null;
      const stream = writableToNodeStream(ours, {
        onError: (error) => { reported ??= error.message; },
      });
      const writer = stream.getWriter();
      const closed = writer.closed.then(
        () => 'resolved',
        (error: unknown) => (error as Error).message,
      );
      await writer.write(new TextEncoder().encode('{"id":1}\n'));

      peer.end();

      const outcome = await Promise.race([
        closed,
        sleep(5_000).then(() => 'HUNG'),
      ]);
      expect(outcome).not.toBe('HUNG');
      expect(reported).not.toBeNull();
    },
    10_000,
  );

  it(
    'still reports a peer destroy when the caller handed over a paused socket',
    async () => {
      const { ours, peer } = await socketPair();
      peer.write('unconsumed-inbound!!\n');
      await sleep(120);
      ours.pause();

      let reported: string | null = null;
      const stream = writableToNodeStream(ours, {
        onError: (error) => { reported ??= error.message; },
      });
      const writer = stream.getWriter();
      const closed = writer.closed.then(
        () => 'resolved',
        (error: unknown) => (error as Error).message,
      );
      await writer.write(new TextEncoder().encode('{"id":1}\n'));

      peer.destroy();

      const outcome = await Promise.race([
        closed,
        sleep(5_000).then(() => 'HUNG'),
      ]);
      expect(outcome).not.toBe('HUNG');
      expect(reported).not.toBeNull();
    },
    10_000,
  );
});

// npm run play -- --topology <name> [--seed N] [--speed X] [--record FILE]
// npm run play -- --replay FILE
// Attaches this terminal, in raw mode, to a simulated machine. Virtual time follows the wall
// clock. vim, vi and nano open the real $VISUAL or $EDITOR (default vi) on a temporary copy, and
// what is saved there is written back into the simulated file system. The session's inputs are
// recorded (default data/play/<time>-<topology>-seed<N>.json); --replay plays a recording back
// into a fresh world and checks that it reaches the same world hash. Ctrl-] leaves the player.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { ENGINE_VERSION, type SessionLog } from '@simlab/kernel';
import { KUBERNETES_TAG } from '@simlab/k8s';
import { parseArgs, parseSeed } from './args.ts';
import { createPlayer, replaySession } from './player.ts';
import { editInRealEditor, say } from './terminal.ts';
import { topologyNames, UsageError } from './world.ts';

const USAGE = `usage: npm run play -- --topology NAME [--seed N] [--speed X] [--record FILE]
       npm run play -- --replay FILE
Topologies: ${topologyNames().join(', ')}
`;

/** Ctrl-]: the player's own escape key, as in telnet and docker attach. Never sent to the machine. */
const ESCAPE = '\x1d';

function play(topology: string, seed: number, speed: number, record: string): Promise<number> {
  const decoder = new StringDecoder('utf8');
  const out = process.stdout;
  const player = createPlayer(
    { topology, seed, speed, cols: out.columns || 80, rows: out.rows || 24 },
    {
      write: (data) => out.write(data),
      note: (m) => say(m),
      edit: editInRealEditor,
      gap(g) {
        mkdirSync('data', { recursive: true });
        appendFileSync('data/gaps.jsonl', `${JSON.stringify({ ...g, at: new Date().toISOString(), engine: { version: ENGINE_VERSION, kubernetes: KUBERNETES_TAG } })}\n`);
      },
      now: () => performance.now(),
    },
  );
  say(`topology ${topology}, seed ${seed}; Ctrl-] leaves`);
  return new Promise((resolve) => {
    let done = false;
    const end = (why: string): void => {
      if (done) return;
      done = true;
      clearInterval(timer);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      const log: SessionLog = player.finish();
      mkdirSync(dirname(record), { recursive: true });
      writeFileSync(record, `${JSON.stringify(log)}\n`);
      say(`${why}; session recorded to ${record} (${log.inputs.length} inputs, world hash ${log.checkpoints[log.checkpoints.length - 1]?.hash ?? '?'})`);
      resolve(0);
    };
    const timer = setInterval(() => {
      player.tick();
      if (player.ended) end('the shell exited');
    }, 10);
    process.stdin.setRawMode(true);
    process.stdin.on('data', (buf: Buffer) => {
      const text = decoder.write(buf);
      const esc = text.indexOf(ESCAPE);
      if (esc >= 0) {
        if (esc > 0) player.keys(text.slice(0, esc));
        end('left with Ctrl-]');
        return;
      }
      if (text !== '') player.keys(text);
      if (player.ended) end('the shell exited');
    });
    out.on('resize', () => player.resize(out.columns, out.rows));
    process.stdin.resume();
  });
}

function main(argv: string[]): Promise<number> | number {
  const a = parseArgs(argv, ['topology', 'seed', 'speed', 'record', 'replay'], ['help']);
  if (a.flags.has('help')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const replayFile = a.values.get('replay');
  if (replayFile !== undefined) {
    const log = JSON.parse(readFileSync(replayFile, 'utf8')) as SessionLog;
    const r = replaySession(log, (d) => process.stdout.write(d));
    process.stdout.write('\r\n');
    if (r.divergedAt !== undefined) {
      say(`the replay diverged at virtual time ${r.divergedAt}: world hash ${r.hash}, recorded ${r.recorded ?? '?'}`);
      return 1;
    }
    say(`replayed ${log.inputs.length} inputs; world hash ${r.hash} ${r.hash === r.recorded ? 'matches the recording' : `differs from the recording (${r.recorded ?? 'none'})`}`);
    return r.hash === r.recorded ? 0 : 1;
  }
  const topology = a.values.get('topology');
  if (topology === undefined) throw new UsageError('--topology is required');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new UsageError('play needs a terminal; to run commands without one, use npm run sim');
  const seed = parseSeed(a.values.get('seed'));
  const speed = Number(a.values.get('speed') ?? 1);
  if (!(speed > 0)) throw new UsageError('--speed must be a positive number');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const record = a.values.get('record') ?? join('data', 'play', `${stamp}-${topology}-seed${seed}.json`);
  return play(topology, seed, speed, record);
}

Promise.resolve()
  .then(() => main(process.argv.slice(2)))
  .then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      if (e instanceof UsageError) {
        process.stderr.write(`play: ${e.message}\n${USAGE}`);
        process.exitCode = 2;
      } else throw e;
    },
  );

// npm run lab -- <item-id> [--seed N] [--speed X] [--record FILE]
// npm run lab -- --list
// npm run lab -- --replay FILE
// Plays a content item in this terminal: the ticket, then a shell on the item's world as the
// terminal player gives it (play.ts), and the lab's own commands outside the simulated shell:
// Ctrl-] opens the lab prompt (check, hint, ticket, debrief, solution, reset, quit), an empty
// line returns to the shell. Each attempt is recorded under data/lab/ and can be replayed.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { ENGINE_VERSION, type SessionLog } from '@simlab/kernel';
import { KUBERNETES_TAG } from '@simlab/k8s';
import { loadPacks } from '@simlab/content';
import { startSession } from '@simlab/learn';
import { parseArgs, parseSeed } from './args.ts';
import { editInRealEditor, say } from './terminal.ts';
import { replaySession } from './player.ts';
import { baselineFor, createLabSession } from './labsession.ts';
import { UsageError } from './world.ts';

const USAGE = `usage: npm run lab -- ITEM [--seed N] [--speed X] [--record FILE]
       npm run lab -- --list
       npm run lab -- --replay FILE
`;

/** Ctrl-]: opens and closes the lab prompt. Never sent to the machine. */
const ESCAPE = '\x1d';
const PROMPT = '\x1b[1;35mlab>\x1b[0m ';

function lab(id: string, seed: number, speed: number, record: string): Promise<number> {
  const out = process.stdout;
  const crlf = (text: string): string => text.replace(/\r?\n/g, '\r\n');
  say(`building the world for ${id}, seed ${seed}…`);
  // An interactive session starts at the real current time (docs/SCENARIO_FORMAT.md §5.2).
  const startTime = Math.floor(Date.now() / 1000) * 1000;
  const session = createLabSession(
    { item: id, seed, startTime, speed, cols: out.columns || 80, rows: out.rows || 24 },
    {
      write: (data) => out.write(data),
      note: (m) => say(m),
      edit: editInRealEditor,
      gap(g) {
        mkdirSync('data', { recursive: true });
        appendFileSync('data/gaps.jsonl', `${JSON.stringify({ ...g, item: id, at: new Date().toISOString(), engine: { version: ENGINE_VERSION, kubernetes: KUBERNETES_TAG } })}\n`);
      },
      now: () => performance.now(),
    },
  );
  out.write(`\r\n${crlf(session.intro())}\r\n\r\n`);
  return new Promise((resolve) => {
    const decoder = new StringDecoder('utf8');
    let done = false;
    let prompt: string | undefined;
    const end = (why: string): void => {
      if (done) return;
      done = true;
      clearInterval(timer);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      const logs: SessionLog[] = session.finish();
      mkdirSync(dirname(record), { recursive: true });
      const files = logs.map((log, i) => {
        const file = logs.length === 1 ? record : record.replace(/\.json$/, `-${i + 1}.json`);
        writeFileSync(file, `${JSON.stringify(log)}\n`);
        return file;
      });
      say(`${why}; ${files.length === 1 ? 'recorded to' : 'attempts recorded to'} ${files.join(', ')}`);
      resolve(0);
    };
    const openPrompt = (): void => {
      prompt = '';
      out.write(`\r\n${PROMPT}`);
    };
    const runPrompt = (): void => {
      const line = prompt ?? '';
      prompt = undefined;
      out.write('\r\n');
      if (line.trim() === '') {
        // Back to the shell: an empty line makes it print a fresh prompt.
        session.player.keys('\r');
        return;
      }
      const text = session.command(line);
      if (session.quit) {
        end('left the lab');
        return;
      }
      if (text !== '') out.write(`${crlf(text)}\r\n`);
      openPrompt();
    };
    const promptKeys = (text: string): void => {
      for (const ch of text) {
        if (prompt === undefined) return;
        if (ch === '\r' || ch === '\n') runPrompt();
        else if (ch === '\x7f' || ch === '\b') {
          if (prompt.length > 0) {
            prompt = prompt.slice(0, -1);
            out.write('\b \b');
          }
        } else if (ch === '\x03') {
          prompt = '';
          out.write('^C');
          runPrompt();
        } else if (ch === ESCAPE) {
          prompt = '';
          runPrompt();
        } else if (ch >= ' ') {
          prompt += ch;
          out.write(ch);
        }
      }
    };
    const timer = setInterval(() => {
      session.player.tick();
      if (session.player.ended) end('the shell exited');
    }, 10);
    process.stdin.setRawMode(true);
    process.stdin.on('data', (buf: Buffer) => {
      let text = decoder.write(buf);
      while (text !== '' && !done) {
        if (prompt !== undefined) {
          promptKeys(text);
          return;
        }
        const esc = text.indexOf(ESCAPE);
        if (esc < 0) {
          session.player.keys(text);
          break;
        }
        if (esc > 0) session.player.keys(text.slice(0, esc));
        openPrompt();
        text = text.slice(esc + 1);
      }
      if (session.player.ended) end('the shell exited');
    });
    out.on('resize', () => session.player.resize(out.columns, out.rows));
    process.stdin.resume();
  });
}

function main(argv: string[]): Promise<number> | number {
  const a = parseArgs(argv, ['seed', 'speed', 'record', 'replay'], ['help', 'list']);
  if (a.flags.has('help')) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (a.flags.has('list')) {
    for (const p of loadPacks()) for (const i of p.items) process.stdout.write(`${i.fileId}\t${String((i.raw as { title?: string }).title ?? '')}\n`);
    return 0;
  }
  const replayFile = a.values.get('replay');
  if (replayFile !== undefined) {
    const log = JSON.parse(readFileSync(replayFile, 'utf8')) as SessionLog;
    const r = replaySession(log, (d) => process.stdout.write(d), (h, ports) => startSession(baselineFor(h), ports).kernel);
    process.stdout.write('\r\n');
    if (r.divergedAt !== undefined) {
      say(`the replay diverged at virtual time ${r.divergedAt}: world hash ${r.hash}, recorded ${r.recorded ?? '?'}`);
      return 1;
    }
    say(`replayed ${log.inputs.length} inputs; world hash ${r.hash} ${r.hash === r.recorded ? 'matches the recording' : `differs from the recording (${r.recorded ?? 'none'})`}`);
    return r.hash === r.recorded ? 0 : 1;
  }
  const id = a.positionals[0];
  if (id === undefined) throw new UsageError('name a content item (npm run lab -- --list)');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new UsageError('lab needs a terminal');
  const seed = parseSeed(a.values.get('seed'));
  const speed = Number(a.values.get('speed') ?? 1);
  if (!(speed > 0)) throw new UsageError('--speed must be a positive number');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const record = a.values.get('record') ?? join('data', 'lab', `${stamp}-${id}-seed${seed}.json`);
  return lab(id, seed, speed, record);
}

Promise.resolve()
  .then(() => main(process.argv.slice(2)))
  .then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      if (e instanceof UsageError) {
        process.stderr.write(`lab: ${e.message}\n${USAGE}`);
        process.exitCode = 2;
      } else throw e;
    },
  );

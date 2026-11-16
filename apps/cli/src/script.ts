// Script mode (`npm run sim`): commands typed into a simulated machine without a human, the way
// Claude sessions and tests exercise behavior. Each line is typed with Enter, and virtual time runs
// until the shell waits for input again (or the timeout passes). Directives start with `@`:
//
//   @advance 30s          let 30 s of virtual time pass
//   @keys \x03            type raw keys without Enter (\xHH, \e, \t, \r, \n, \\ escapes)
//   @resize 100x30        resize the terminal
//   @editor <<EOF         the content to save when the next editor (vim, nano, kubectl
//   ...                   edit's) opens; without one, the editor closes without saving
//   EOF
//   @editor :q!           the next editor closes without saving (as in a transcript)
//
// Output is the terminal's screen with its scrollback (`screen`), the bytes the terminal received
// (`raw`), or transcript format (`transcript`: a plain session, see docs/TRANSCRIPTS.md).

import { HOUR, type GapEvent } from '@simlab/kernel';
import { captureOutput, createScreen, formatOutput, openSession, placeFile, type Session } from '@simlab/host';
import { boot, header, UsageError } from './world.ts';
import { parseDuration } from './args.ts';

export interface ScriptOptions {
  topology: string;
  seed: number;
  cols: number;
  rows: number;
  /** Virtual time to let pass after each command. */
  step: number;
  /** How long a command may run before the script moves on. */
  timeout: number;
  mode: 'screen' | 'raw' | 'transcript';
  machine?: string;
  user?: string;
  /**
   * Files put into the session user's home directory before the session, as if the user had
   * written them: manifests for `kubectl apply -f`, scripts. `name` is the path below the home.
   */
  files?: { name: string; text: string }[];
}

export interface ScriptResult {
  output: string;
  /** Remarks about the run itself: commands still running, editors closed without content. */
  notes: string[];
  gaps: GapEvent[];
  /** World hash at the end. */
  hash: string;
}

/** Turns `@keys` escapes into bytes. */
export function unescapeKeys(text: string): string {
  return text.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|e|t|r|n|\\)/g, (_m, e: string) => {
    if (e === 'e') return '\x1b';
    if (e === 't') return '\t';
    if (e === 'r') return '\r';
    if (e === 'n') return '\n';
    if (e === '\\') return '\\';
    return String.fromCharCode(parseInt(e.slice(1), 16));
  });
}

export function runScript(lines: readonly string[], opts: ScriptOptions): ScriptResult {
  const cap = captureOutput();
  const gaps: GapEvent[] = [];
  const { kernel, info } = boot(header(opts.topology, opts.seed), { ...cap.ports, gap: (g) => gaps.push(g) });
  const machine = opts.machine ?? info.entry.machine;
  const user = opts.user ?? info.entry.user;
  for (const f of opts.files ?? []) kernel.act('sim-file', (ctx) => placeFile(ctx, machine, user, f.name, f.text));
  const s: Session = openSession(kernel, cap, {
    machine,
    user,
    cols: opts.cols,
    rows: opts.rows,
    terminal: opts.mode !== 'transcript',
  });
  const notes: string[] = [];
  const editors: (string | null)[] = [];
  s.onEditor((req) => {
    const content = editors.shift();
    if (content === undefined) notes.push(`editor for ${req.path} closed without saving (no @editor content)`);
    return content ?? undefined;
  });
  const screen = createScreen(opts.cols, opts.rows);
  let raw = '';
  const transcript: string[] = [];
  let continuing = false;
  const collect = (): void => {
    const out = s.takeRaw();
    raw += out;
    screen.write(out);
  };
  collect();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const directive = /^@(\w+)\s*(.*)$/.exec(line);
    if (directive) {
      const [, name, arg = ''] = directive;
      if (name === 'advance') {
        kernel.advance(parseDuration(arg));
      } else if (name === 'keys') {
        s.type(unescapeKeys(arg));
        if (!s.wait(Math.min(opts.timeout, 1000))) kernel.advance(0);
      } else if (name === 'resize') {
        const m = /^(\d+)x(\d+)$/.exec(arg);
        if (!m) throw new UsageError(`line ${i + 1}: @resize COLSxROWS`);
        kernel.input({ kind: 'tty.resize', tty: s.tty, cols: Number(m[1]), rows: Number(m[2]) });
        screen.resize(Number(m[1]), Number(m[2]));
      } else if (name === 'editor' && arg.trim() === ':q!') {
        editors.push(null);
      } else if (name === 'editor') {
        const m = /^<<\s*'?(\w+)'?$/.exec(arg);
        if (!m) throw new UsageError(`line ${i + 1}: @editor <<TAG, then the content, then TAG (or @editor :q!)`);
        const body: string[] = [];
        for (i++; i < lines.length && lines[i] !== m[1]; i++) body.push(lines[i] as string);
        if (i >= lines.length) throw new UsageError(`@editor: no closing ${m[1]}`);
        editors.push(body.map((l) => `${l}\n`).join(''));
      } else throw new UsageError(`line ${i + 1}: unknown directive @${name}`);
      collect();
      continue;
    }
    if (opts.mode === 'transcript') {
      const r = s.run(line, { timeout: opts.timeout });
      transcript.push(`${continuing ? '>' : '$'} ${line}`, ...(r.continuation ? (r.output === '' ? [] : formatOutput(r.output, 0)) : formatOutput(r.output, r.status)));
      continuing = r.continuation;
      if (!r.finished) notes.push(`still running after ${opts.timeout / 1000} s of virtual time: ${line}`);
      if (r.exited) break;
    } else {
      s.type(`${line}\r`);
      if (!s.wait(opts.timeout)) notes.push(`still running after ${opts.timeout / 1000} s of virtual time: ${line}`);
      collect();
    }
    if (opts.step > 0) kernel.advance(opts.step);
    collect();
  }
  collect();
  const output = opts.mode === 'raw' ? raw : opts.mode === 'transcript' ? `${transcript.join('\n')}\n` : `${screen.text()}\n`;
  return { output, notes, gaps, hash: kernel.hash() };
}

export const DEFAULT_TIMEOUT = HOUR;

// The terminal's line discipline (Linux n_tty) and the line editor that runs in it while a program
// reads a line with editing (docs/ARCHITECTURE.md §3.6). Input bytes arrive as `tty.bytes` inputs;
// output leaves through the output port. Everything here is an event handler over world data.
//
//   docs: termios(3) (ICANON, ECHO, ECHOE, ECHOK, ECHOKE, ECHOCTL, ISIG, ICRNL, ONLCR, VEOF, VERASE,
//         VKILL, VWERASE, VINTR, VQUIT, VSUSP); `stty -a` on the workstation lists the defaults
//         (erase = ^?, kill = ^U, werase = ^W, eof = ^D, intr = ^C, quit = ^\, susp = ^Z), 2026-11-16
//   reference: fixtures/reference/bash/readline.json (`ctrl-c-cat`, `ctrl-d-cat`,
//         `ctrl-c-pending-input-blocking`: the echo of a canonical read and of typeahead)

import { put, type Ctx, type Json } from '@simlab/kernel';
import { getMachine, hostSlice } from '../machine.ts';
import { ttyTopic } from '../proc/descriptors.ts';
import { simNotice, styleNotice } from '../proc/notice.ts';
import { signalGroup } from '../proc/runtime.ts';
import { SIGHUP, SIGINT } from '../proc/signals.ts';
import type { EditRequest, LineEditorState, Tty } from '../proc/types.ts';
import { wcwidth } from '../programs/lib/wcwidth.ts';
import { COMPLETION, type CompleterSpec } from './complete.ts';
import { feed, interrupt, resize, startEditor, type EditorIo } from './editor.ts';


export function getTty(ctx: Ctx, id: string): Tty {
  const t = hostSlice(ctx).ttys[id];
  if (!t) throw new Error(`no tty ${id}`);
  return t;
}

function store(ctx: Ctx, t: Tty): Tty {
  return put(hostSlice(ctx).ttys, t.id, t);
}

function emit(ctx: Ctx, id: string, data: string): void {
  if (data !== '') ctx.output({ kind: 'tty', tty: id, data });
}

/** Output post-processing `onlcr` (termios(3)): a newline reaches the terminal as CR LF. */
export function ttyWrite(ctx: Ctx, id: string, data: string): void {
  const t = getTty(ctx, id);
  if (t.closed) return;
  emit(ctx, id, data.replace(/\n/g, '\r\n'));
}

/** What ECHOCTL shows for a character: `^X` for control characters other than tab and newline. */
function echoOf(ch: string): string {
  const c = ch.charCodeAt(0);
  if (ch === '\t' || ch === '\n') return ch;
  if (c === 0x7f) return '^?';
  if (c < 0x20) return `^${String.fromCharCode(c + 0x40)}`;
  return ch;
}

/** Visual erasure of one character (ECHOE): back over its width, blank it, back again. */
function eraseEcho(ch: string): string {
  const w = Math.max(1, ch.charCodeAt(0) < 0x20 || ch === '\x7f' ? 2 : wcwidth(ch));
  return '\b \b'.repeat(w);
}

/** Canonical (or raw) processing of input that no line editor takes. Returns the echo. */
function cook(t: Tty, data: string, echo: boolean): { t: Tty; out: string } {
  let { input, line } = t;
  const eof = [...t.eof];
  let out = '';
  const doEcho = echo && t.mode.echo;
  for (const raw of data) {
    const ch = raw === '\r' ? '\n' : raw; // ICRNL
    if (!t.mode.icanon) {
      input += ch;
      if (doEcho) out += echoOf(ch) === '\n' ? '\r\n' : echoOf(ch);
      continue;
    }
    if (ch === '\n') {
      input += `${line}\n`;
      line = '';
      if (doEcho) out += '\r\n';
    } else if (ch === '\x04') {
      // VEOF: what was typed becomes readable without a newline; on an empty line, end of file.
      input += line;
      line = '';
      eof.push(input.length);
    } else if (ch === '\x7f') {
      if (line === '') continue;
      const chars = Array.from(line);
      const last = chars.pop() as string;
      line = chars.join('');
      if (doEcho) out += eraseEcho(last);
    } else if (ch === '\x15') {
      // VKILL with ECHOKE: every character of the line is erased on the screen.
      if (doEcho) for (const c of Array.from(line).reverse()) out += eraseEcho(c);
      line = '';
    } else if (ch === '\x17') {
      const chars = Array.from(line);
      let n = chars.length;
      while (n > 0 && /\s/.test(chars[n - 1] as string)) n--;
      while (n > 0 && !/\s/.test(chars[n - 1] as string)) n--;
      if (doEcho) for (const c of chars.slice(n).reverse()) out += eraseEcho(c);
      line = chars.slice(0, n).join('');
    } else if (ch === '\x12') {
      // VREPRINT: the line typed so far, again on a new line.
      if (doEcho) out += `^R\r\n${line}`;
    } else {
      line += ch;
      if (doEcho) out += echoOf(ch);
    }
  }
  return { t: { ...t, input, line, eof }, out };
}

/** The reader's line editor input/output: completion through the registry, notices, readline state. */
function editorIo(ctx: Ctx, t: Tty, ed: { pid: string; completer?: { name: string; data: Json } } | undefined): EditorIo {
  const readline = { ...t.readline };
  return {
    cols: t.cols,
    rows: t.rows,
    readline,
    complete(line, point, word) {
      const name = ed?.completer?.name;
      if (name === undefined || ed === undefined) return undefined;
      const spec = ctx.registry.get<CompleterSpec>(COMPLETION, name);
      if (!spec) return undefined;
      const req = { ctx, machine: t.machine, pid: ed.pid, line, point, start: word.start, word: word.word, data: ed.completer?.data ?? null };
      return spec.complete(word.quote ? { ...req, quote: word.quote } : req);
    },
    unsupported(what) {
      ctx.gap({ kind: 'behavior', program: 'bash', what, commandLine: '', machine: t.machine });
      return styleNotice(simNotice('bash', what));
    },
  };
}

/** Bytes typed at a terminal. */
export function ttyInput(ctx: Ctx, id: string, data: string): void {
  let t = getTty(ctx, id);
  if (t.closed) return;
  // ISIG characters act when they arrive, whoever reads (n_tty_receive_signal_char).
  let seg = '';
  const flush = (): void => {
    if (seg !== '') take(ctx, id, seg);
    seg = '';
  };
  for (const ch of data) {
    t = getTty(ctx, id);
    if (t.mode.isig && (ch === '\x03' || ch === '\x1c' || ch === '\x1a')) {
      flush();
      signalChar(ctx, id, ch);
      continue;
    }
    seg += ch;
  }
  flush();
}

/** Input other than signal characters: to the line editor if one is reading, else the discipline. */
function take(ctx: Ctx, id: string, data: string): void {
  const t = getTty(ctx, id);
  const ed = liveEditor(ctx, t);
  if (ed && !ed.done) {
    const io = editorIo(ctx, t, ed);
    const step = feed(ed, data, io);
    emit(ctx, id, step.out);
    store(ctx, { ...getTty(ctx, id), editor: step.state, readline: io.readline, typeahead: t.typeahead + step.rest });
    if (step.state.done) ctx.publish(ttyTopic(id));
    return;
  }
  if (ed?.done) {
    store(ctx, { ...t, typeahead: t.typeahead + data });
    return;
  }
  const cooked = cook(t, data, true);
  emit(ctx, id, cooked.out);
  store(ctx, cooked.t);
  ctx.publish(ttyTopic(id));
}

function signalChar(ctx: Ctx, id: string, ch: string): void {
  const t = getTty(ctx, id);
  const ed = liveEditor(ctx, t);
  if (ch === '\x03') {
    // VINTR: discards pending input and sends SIGINT to the foreground process group.
    let out = '';
    if (ed && !ed.done) out = interrupt();
    else if (t.mode.echo) out = '^C';
    const { editor: _e, ...rest } = t;
    store(ctx, { ...rest, input: '', line: '', eof: [], typeahead: '' });
    emit(ctx, id, out);
    signalGroup(ctx, t.machine, t.foreground, SIGINT);
    ctx.publish(ttyTopic(id));
    return;
  }
  // Ctrl-\ and Ctrl-Z. At the prompt bash ignores SIGQUIT and SIGTSTP, so nothing happens. A
  // foreground job would dump core or stop: job control and core dumps are not simulated.
  if (ed && !ed.done) return;
  const what = ch === '\x1a' ? 'job control (Ctrl-Z, SIGTSTP)' : 'Ctrl-\\ (SIGQUIT)';
  ctx.gap({ kind: 'behavior', program: 'bash', what, commandLine: '', machine: t.machine });
  emit(ctx, id, (t.mode.echo ? echoOf(ch) : '') + '\r\n' + styleNotice(simNotice('bash', what)).replace(/\n/g, '\r\n'));
}

/** The editor, unless its reader has gone (then it is dropped). */
function liveEditor(ctx: Ctx, t: Tty): LineEditorState | undefined {
  const ed = t.editor;
  if (!ed) return undefined;
  const p = getMachine(ctx, t.machine).procs[ed.pid];
  if (!p || p.state !== 'running') {
    const { editor: _e, ...rest } = t;
    store(ctx, rest);
    return undefined;
  }
  return ed;
}

export type TtyReadResult = { value: string | null } | { block: string };

/**
 * A read from the terminal. With `edit`, the line editor reads the line: it starts with whatever
 * was typed ahead, draws the prompt, and the read completes when the line is accepted. Without, a
 * canonical read returns one line, or what precedes an end-of-file mark (end of file when nothing does).
 */
export function ttyRead(ctx: Ctx, id: string, pid: string, max: number | undefined, edit: EditRequest | undefined): TtyReadResult {
  let t = getTty(ctx, id);
  if (t.closed) return { value: null };
  const ed = liveEditor(ctx, t);
  t = getTty(ctx, id);
  if (edit) {
    if (ed && ed.pid === pid) {
      if (!ed.done) return { block: ttyTopic(id) };
      const { editor: _e, ...rest } = t;
      store(ctx, rest);
      return { value: ed.done.line };
    }
    if (ed) return { block: ttyTopic(id) };
    // What was typed while no editor read (echoed by the discipline) becomes the editor's input.
    let pending = '';
    let last = 0;
    for (const e of t.eof) {
      pending += `${t.input.slice(last, e)}\x04`;
      last = e;
    }
    pending += t.input.slice(last) + t.line + t.typeahead;
    const io = editorIo(ctx, t, { pid, ...(edit.completer ? { completer: edit.completer } : {}) });
    const step = startEditor(edit, pid, pending, io);
    emit(ctx, id, step.out);
    const base = { ...t, input: '', line: '', eof: [], typeahead: step.rest, readline: io.readline };
    if (step.state.done) {
      store(ctx, base);
      return { value: step.state.done.line };
    }
    store(ctx, { ...base, editor: step.state });
    return { block: ttyTopic(id) };
  }
  if (ed) return { block: ttyTopic(id) };
  if (t.typeahead !== '') {
    // Bytes that arrived while echo was off are not echoed now.
    t = store(ctx, cook({ ...t, typeahead: '' }, t.typeahead, false).t);
  }
  if (!t.mode.icanon) {
    // Non-canonical: whatever has arrived (VMIN 1, VTIME 0).
    if (t.input === '') return { block: ttyTopic(id) };
    const n = max === undefined ? t.input.length : Math.min(max, t.input.length);
    store(ctx, { ...t, input: t.input.slice(n) });
    return { value: t.input.slice(0, n) };
  }
  const nl = t.input.indexOf('\n');
  const eof = t.eof[0];
  let n: number;
  let consumeEof = false;
  if (eof !== undefined && (nl < 0 || eof <= nl)) {
    n = eof;
    consumeEof = true;
  } else if (nl >= 0) {
    n = nl + 1;
  } else {
    return { block: ttyTopic(id) };
  }
  if (max !== undefined && max < n) {
    n = max;
    consumeEof = false;
  }
  const out = t.input.slice(0, n);
  const rest = consumeEof ? t.eof.slice(1) : t.eof;
  store(ctx, { ...t, input: t.input.slice(n), eof: rest.map((e) => e - n) });
  return { value: consumeEof && out === '' ? null : out };
}

/** The terminal changed size (`tty.resize`): a line being edited is redrawn for the new width. */
export function ttyResize(ctx: Ctx, id: string, cols: number, rows: number): void {
  const t = getTty(ctx, id);
  const ed = liveEditor(ctx, t);
  const sized = { ...getTty(ctx, id), cols, rows };
  if (ed && !ed.done && !ed.ask) {
    const io = editorIo(ctx, sized, ed);
    const step = resize(ed, t.cols, io);
    emit(ctx, id, step.out);
    store(ctx, { ...sized, editor: step.state });
    return;
  }
  store(ctx, sized);
}

/** The terminal went away (`tty.close`): the session gets SIGHUP; reads see end of file. */
export function ttyClose(ctx: Ctx, id: string): void {
  const t = getTty(ctx, id);
  if (t.closed) return;
  const { editor: _e, ...rest } = t;
  store(ctx, { ...rest, closed: true, input: '', line: '', eof: [], typeahead: '' });
  const leader = getMachine(ctx, t.machine).procs[t.session];
  if (leader) signalGroup(ctx, t.machine, leader.pgid, SIGHUP);
  if (t.foreground !== leader?.pgid) signalGroup(ctx, t.machine, t.foreground, SIGHUP);
  ctx.publish(ttyTopic(id));
}

export function setForeground(ctx: Ctx, ttyId: string, pgid: string): void {
  store(ctx, { ...getTty(ctx, ttyId), foreground: pgid });
}

/** stty-style mode change by a program (tcsetattr). */
export function setTtyMode(ctx: Ctx, ttyId: string, mode: Partial<Tty['mode']>): void {
  const t = getTty(ctx, ttyId);
  store(ctx, { ...t, mode: { ...t.mode, ...mode } });
}

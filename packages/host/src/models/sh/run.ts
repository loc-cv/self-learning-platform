// The container shell as a resumable machine. The script is compiled to a flat instruction list
// (jumps for `&&`, `||`, loops and `if`), so the whole execution state is a program counter, the
// variables, the loop stack and the traps: plain data, stored by the runtime between wake-ups.
// A child that blocks (sleep) ends the step with a wake-up; output within a step is instantaneous.
//
// Signals: a signal with a trap is held until the foreground child finishes, then the trap runs
// (dash and ash wait for the child first, XCU 2.11); without a trap the default action applies,
// which the runtime ignores for PID 1.

import type { Json } from '@simlab/kernel';
import type { Executable, ModelGap, ModelStep, Next, Output, ProcessInput, Signal, OutputStream } from '../types.ts';
import { runUtility, echoUtility, printfUtility } from '../utilities.ts';
import type { AndOr, List, SimpleCommand, Word } from './ast.ts';
import { evaluateArith } from './arith.ts';
import { parse } from './parse.ts';
import * as text from './variant.ts';
import type { ShellVariant } from './variant.ts';

type Ins =
  | { op: 'cmd'; cmd: SimpleCommand; checked: boolean; last: boolean }
  | { op: 'jmp'; to: number }
  | { op: 'jz'; to: number }
  | { op: 'jnz'; to: number }
  | { op: 'not' }
  | { op: 'status'; v: number }
  | { op: 'forInit'; words: Word[] | null }
  | { op: 'forNext'; name: string; end: number }
  | { op: 'push' }
  | { op: 'pop' };

export interface ShState {
  src: string;
  arg0: string;
  positional: string[];
  pc: number;
  status: number;
  vars: Record<string, string>;
  exported: string[];
  loops: { items: string[]; i: number }[];
  saved: { vars: Record<string, string>; exported: string[] }[];
  traps: Record<string, string>;
  pending: string[];
  errexit: boolean;
  /** The script came from `-c`. */
  inline: boolean;
  /** Blocked in a child until this time; -1 for ever. */
  until?: number;
}

/** Instructions run in one step without the clock moving before the shell is treated as spinning. */
const SPIN_LIMIT = 20_000;

function compile(list: List): Ins[] | { unsupported: string } {
  const code: Ins[] = [];
  try {
    emitList(code, list, false);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('unsupported:')) return { unsupported: e.message.slice('unsupported:'.length) };
    throw e;
  }
  // Mark the script's final simple command, which dash and ash exec rather than fork.
  const lastCmd = code.length > 0 ? code[code.length - 1] : undefined;
  if (lastCmd?.op === 'cmd') lastCmd.last = true;
  return code;
}

function emitList(code: Ins[], list: List, checked: boolean): void {
  list.items.forEach((item, i) => {
    if (item.background) throw new Error('unsupported:background job (&)');
    emitAndOr(code, item.andOr, checked && i === list.items.length - 1);
  });
}

function emitAndOr(code: Ins[], a: AndOr, checked: boolean): void {
  const parts = [{ op: '' as string, pipeline: a.first }, ...a.rest.map((r) => ({ op: r.op as string, pipeline: r.pipeline }))];
  const patches: number[] = [];
  parts.forEach((part, i) => {
    if (i > 0) {
      // Skip this pipeline unless the previous status allows it.
      patches.push(code.length);
      code.push({ op: part.op === '&&' ? 'jnz' : 'jz', to: -1 });
    }
    const isLast = i === parts.length - 1;
    const p = part.pipeline;
    if (p.commands.length > 1) throw new Error('unsupported:pipeline');
    const cmd = p.commands[0];
    if (!cmd) return;
    const chk = checked || !isLast || p.negate;
    switch (cmd.kind) {
      case 'simple':
        code.push({ op: 'cmd', cmd, checked: chk, last: false });
        break;
      case 'group':
        if (cmd.subshell) code.push({ op: 'push' });
        emitList(code, cmd.body, chk);
        if (cmd.subshell) code.push({ op: 'pop' });
        break;
      case 'while': {
        const top = code.length;
        emitList(code, cmd.cond, true);
        const exit = code.length;
        code.push({ op: cmd.until ? 'jz' : 'jnz', to: -1 });
        emitList(code, cmd.body, chk);
        code.push({ op: 'jmp', to: top });
        (code[exit] as { to: number }).to = code.length;
        code.push({ op: 'status', v: 0 });
        break;
      }
      case 'for': {
        code.push({ op: 'forInit', words: cmd.words });
        const top = code.length;
        code.push({ op: 'forNext', name: cmd.name, end: -1 });
        emitList(code, cmd.body, chk);
        code.push({ op: 'jmp', to: top });
        (code[top] as { end: number }).end = code.length;
        break;
      }
      case 'if': {
        const ends: number[] = [];
        for (const c of cmd.clauses) {
          emitList(code, c.cond, true);
          const skip = code.length;
          code.push({ op: 'jnz', to: -1 });
          emitList(code, c.body, chk);
          ends.push(code.length);
          code.push({ op: 'jmp', to: -1 });
          (code[skip] as { to: number }).to = code.length;
        }
        if (cmd.otherwise) emitList(code, cmd.otherwise, chk);
        else code.push({ op: 'status', v: 0 });
        for (const e of ends) (code[e] as { to: number }).to = code.length;
        break;
      }
    }
    if (p.negate) code.push({ op: 'not' });
  });
  for (const at of patches) {
    // A skipped pipeline continues with the next operator's test, which reads the same status.
    const ins = code[at] as { to: number };
    let target = code.length;
    for (let j = at + 1; j < code.length; j++) {
      if (patches.includes(j)) {
        target = j;
        break;
      }
    }
    ins.to = target;
  }
}

/** A step's result while running. */
interface Run {
  output: Output[];
  gaps: ModelGap[];
}

interface CmdResult {
  status: number;
  next?: Next;
  /** Blocks this long (ms; Infinity for ever) before continuing. */
  sleep?: number;
}

export class ShellError extends Error {}

/** An error that ends the shell (an expansion error in a non-interactive shell, XCU 2.8.1). */
class ShellExit extends Error {
  readonly status: number;
  readonly text: string;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.text = message;
  }
}

/** BusyBox ash reports line 0 for everything in a `-c` string. */
function lineOf(st: ShState, v: ShellVariant, line: number): number {
  return v === 'busybox' && st.inline ? 0 : line;
}

/** Starts `sh` with its argv. */
export function startShell(p: ProcessInput): ModelStep {
  const v = text.shellVariant(p.exe.variant);
  const arg0 = p.argv[0] ?? 'sh';
  const args = p.argv.slice(1);
  let errexit = false;
  let i = 0;
  let src: string | undefined;
  let scriptArg0 = arg0;
  let inline = false;
  let positional: string[] = [];
  const gaps: ModelGap[] = [];
  for (; i < args.length; i++) {
    const a = args[i] as string;
    if (a === '-c') {
      src = args[i + 1] ?? '';
      inline = true;
      scriptArg0 = args[i + 2] ?? arg0;
      positional = args.slice(i + 3);
      if (args[i + 1] === undefined) {
        // dash: "sh: 0: -c requires an argument"
        return { output: [{ stream: 'stderr', text: v === 'busybox' ? `${arg0}: -c requires an argument\n` : v === 'dash' ? `${arg0}: 0: -c requires an argument\n` : `${arg0}: -c: option requires an argument\n` }], next: { exit: 2 } };
      }
      break;
    }
    if (a === '-e') errexit = true;
    else if (/^-[a-z]+$/.test(a) && a !== '-') gaps.push({ what: `sh ${a}`, detail: 'shell option not modeled' });
    else {
      // `sh script [args]`
      const file = p.file(a);
      if (file === undefined) return { output: [{ stream: 'stderr', text: text.cannotOpen(v, arg0, a) }], next: { exit: text.cannotOpenStatus(v) } };
      src = file;
      scriptArg0 = a;
      positional = args.slice(i + 1);
      break;
    }
  }
  // No script: commands come from stdin, which is /dev/null in a container without `stdin: true`.
  if (src === undefined) return { next: { exit: 0 }, ...(gaps.length ? { gaps } : {}) };
  const vars: Record<string, string> = {};
  for (const [k, val] of p.env) vars[k] = val;
  const st: ShState = { src, arg0: scriptArg0, positional, pc: 0, status: 0, vars, exported: p.env.map(([k]) => k), loops: [], saved: [], traps: {}, pending: [], errexit, inline };
  const r = parse(src);
  if ('syntax' in r) return { output: [{ stream: 'stderr', text: text.syntaxError(v, scriptArg0, r.syntax.line, r.syntax.token, r.syntax.expecting, src, r.syntax.text) }], next: { exit: 2 } };
  if ('unterminated' in r) return { output: [{ stream: 'stderr', text: text.unterminatedQuote(v, scriptArg0, r.unterminated.line, r.unterminated.quote) }], next: { exit: 2 } };
  if ('unsupported' in r) return { gaps: [...gaps, { what: `shell syntax: ${r.unsupported}`, detail: src }], next: { wait: true, state: null } };
  const step = execute(p, st, v);
  return gaps.length ? { ...step, gaps: [...gaps, ...(step.gaps ?? [])] } : step;
}

export function resumeShell(p: ProcessInput, state: Json): ModelStep {
  if (state === null) return { next: { wait: true, state: null } };
  const st = JSON.parse(JSON.stringify(state)) as ShState;
  delete st.until;
  const v = text.shellVariant(p.exe.variant);
  const run: Run = { output: [], gaps: [] };
  const trapped = runPendingTraps(p, st, v, run);
  if (trapped) return finish(run, trapped);
  const step = execute(p, st, v);
  return { ...step, output: [...run.output, ...(step.output ?? [])], gaps: [...run.gaps, ...(step.gaps ?? [])] };
}

export function signalShell(p: ProcessInput, state: Json, signal: Signal): ModelStep | 'default' {
  if (state === null) return 'default';
  const st = JSON.parse(JSON.stringify(state)) as ShState;
  const name = signal.slice(3);
  const trap = st.traps[name];
  if (trap === undefined) return 'default';
  if (trap === '') return { next: st.until === -1 ? { wait: true, state: st as unknown as Json } : { wake: Math.max(0, (st.until ?? p.now) - p.now), state: st as unknown as Json } };
  if (!st.pending.includes(name)) st.pending.push(name);
  // The trap runs once the foreground child returns.
  if (st.until === -1) return { next: { wait: true, state: st as unknown as Json } };
  return { next: { wake: Math.max(0, (st.until ?? p.now) - p.now), state: st as unknown as Json } };
}

function finish(run: Run, next: Next): ModelStep {
  return { ...(run.output.length ? { output: run.output } : {}), ...(run.gaps.length ? { gaps: run.gaps } : {}), next };
}

/** Runs pending traps; returns the step's end if a trap ended the shell. */
function runPendingTraps(p: ProcessInput, st: ShState, v: ShellVariant, run: Run): Next | undefined {
  while (st.pending.length > 0) {
    const sig = st.pending.shift() as string;
    const handler = st.traps[sig] ?? '';
    const r = parse(handler);
    if (!('ok' in r)) {
      run.gaps.push({ what: `trap handler for ${sig}`, detail: handler });
      continue;
    }
    const code = compile(r.ok);
    if ('unsupported' in code) {
      run.gaps.push({ what: `trap handler: ${code.unsupported}`, detail: handler });
      continue;
    }
    const sub: ShState = { ...st, pc: 0, loops: [] };
    const res = runCode(p, sub, v, code, run, true);
    st.vars = sub.vars;
    st.status = sub.status;
    if (res && 'exit' in res) return res;
  }
  return undefined;
}

function execute(p: ProcessInput, st: ShState, v: ShellVariant): ModelStep {
  const r = parse(st.src);
  if (!('ok' in r)) return { next: { exit: 2 } };
  const code = compile(r.ok);
  if ('unsupported' in code) return { gaps: [{ what: `shell syntax: ${code.unsupported}`, detail: st.src }], next: { wait: true, state: null } };
  const run: Run = { output: [], gaps: [] };
  const next = runCode(p, st, v, code, run, false) ?? { exit: st.status };
  return finish(run, next);
}

/**
 * Runs instructions until the program blocks, exits or ends. Returns the step's end, or undefined
 * when the code ran to its end (the caller decides: exit with $?, or continue after a trap).
 */
function runCode(p: ProcessInput, st: ShState, v: ShellVariant, code: Ins[], run: Run, sync: boolean): Next | undefined {
  let budget = SPIN_LIMIT;
  while (st.pc < code.length) {
    if (--budget < 0) {
      run.gaps.push({ what: 'a shell loop that never waits', detail: 'the loop would run without pause; the simulated process keeps running without output' });
      return { wait: true, state: null };
    }
    const ins = code[st.pc] as Ins;
    switch (ins.op) {
      case 'jmp':
        st.pc = ins.to;
        continue;
      case 'jz':
        st.pc = st.status === 0 ? ins.to : st.pc + 1;
        continue;
      case 'jnz':
        st.pc = st.status !== 0 ? ins.to : st.pc + 1;
        continue;
      case 'not':
        st.status = st.status === 0 ? 1 : 0;
        st.pc++;
        continue;
      case 'status':
        st.status = ins.v;
        st.pc++;
        continue;
      case 'forInit': {
        const items = ins.words === null ? [...st.positional] : ins.words.flatMap((w) => expandWord(p, st, v, w, run));
        st.loops.push({ items, i: 0 });
        st.pc++;
        continue;
      }
      case 'forNext': {
        const loop = st.loops[st.loops.length - 1];
        if (!loop || loop.i >= loop.items.length) {
          st.loops.pop();
          if (loop && loop.items.length === 0) st.status = 0;
          st.pc = ins.end;
          continue;
        }
        st.vars[ins.name] = loop.items[loop.i] as string;
        loop.i++;
        st.pc++;
        continue;
      }
      case 'push':
        st.saved.push({ vars: { ...st.vars }, exported: [...st.exported] });
        st.pc++;
        continue;
      case 'pop': {
        const s = st.saved.pop();
        if (s) {
          st.vars = s.vars;
          st.exported = s.exported;
        }
        st.pc++;
        continue;
      }
      case 'cmd': {
        let res: CmdResult;
        try {
          res = runSimple(p, st, v, ins.cmd, run, ins.last && !sync);
        } catch (e) {
          if (!(e instanceof ShellExit)) throw e;
          run.output.push({ stream: 'stderr', text: e.text });
          return { exit: e.status };
        }
        st.pc++;
        if (res.next) return res.next;
        st.status = res.status;
        if (res.sleep !== undefined && res.sleep > 0) {
          if (sync) {
            run.gaps.push({ what: 'a command that waits inside a command substitution or trap', detail: 'the wait is skipped' });
          } else if (res.sleep === Infinity) {
            st.until = -1;
            return { wait: true, state: st as unknown as Json };
          } else {
            const ms = Math.round(res.sleep);
            st.until = p.now + ms;
            return { wake: ms, state: st as unknown as Json };
          }
        }
        if (st.errexit && !ins.checked && st.status !== 0) return { exit: st.status };
        continue;
      }
    }
  }
  return undefined;
}

/** Expands a word into fields: parameters, arithmetic, command substitution, then field splitting. */
function expandWord(p: ProcessInput, st: ShState, v: ShellVariant, word: Word, run: Run): string[] {
  const fields: string[] = [];
  let cur = '';
  let have = false;
  const pushSplit = (s: string): void => {
    const parts = s.split(/[ \t\n]+/);
    parts.forEach((part, i) => {
      if (i > 0) {
        if (have || cur !== '') fields.push(cur);
        cur = '';
        have = false;
      }
      cur += part;
      if (part !== '') have = true;
    });
  };
  for (const part of word) {
    if (part.t === 'lit') {
      cur += part.v;
      have = true;
      continue;
    }
    let value: string;
    if (part.t === 'param') {
      if (part.name === '@' && part.q && word.length === 1) return [...st.positional];
      value = param(p, st, part.name);
    } else if (part.t === 'arith') {
      const expanded = part.expr.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*|[0-9?#$])\}?/g, (_, n: string) => param(p, st, n));
      const r = evaluateArith(expanded, (n) => st.vars[n]);
      if ('error' in r) {
        const trailing = /[-+*/%<>=&|^!~]\s*$/.test(expanded);
        if (!trailing) {
          run.gaps.push({ what: `arithmetic $((${part.expr}))` });
          value = '0';
        } else {
          const op = (/([-+*/%<>=&|^!~])\s*$/.exec(expanded) as RegExpExecArray)[1] as string;
          throw new ShellExit(v === 'bash' ? 1 : 2, text.arithmeticError(v, st.arg0, lineOf(st, v, 1), expanded.trim(), op));
        }
      } else value = String(r.value);
    } else {
      value = commandSubstitution(p, st, v, part.src, run);
    }
    if (part.q) {
      cur += value;
      have = true;
    } else pushSplit(value);
  }
  if (have || cur !== '') fields.push(cur);
  return fields;
}

function param(p: ProcessInput, st: ShState, name: string): string {
  switch (name) {
    case '?':
      return String(st.status);
    case '$':
      return String(p.pid);
    case '#':
      return String(st.positional.length);
    case '0':
      return st.arg0;
    case '@':
    case '*':
      return st.positional.join(' ');
    case '!':
      return '';
    case '-':
      return st.errexit ? 'e' : '';
  }
  if (/^[0-9]+$/.test(name)) return st.positional[Number(name) - 1] ?? '';
  return st.vars[name] ?? '';
}

function commandSubstitution(p: ProcessInput, st: ShState, v: ShellVariant, src: string, run: Run): string {
  const r = parse(src);
  if (!('ok' in r)) {
    run.gaps.push({ what: 'command substitution', detail: src });
    return '';
  }
  const code = compile(r.ok);
  if ('unsupported' in code) {
    run.gaps.push({ what: `command substitution: ${code.unsupported}`, detail: src });
    return '';
  }
  const sub: ShState = JSON.parse(JSON.stringify({ ...st, pc: 0, loops: [] })) as ShState;
  const inner: Run = { output: [], gaps: [] };
  runCode(p, sub, v, code, inner, true);
  st.status = sub.status;
  run.gaps.push(...inner.gaps);
  let captured = '';
  for (const o of inner.output) {
    if (o.stream === 'stdout') captured += o.text;
    else run.output.push(o);
  }
  return captured.replace(/\n+$/, '');
}

type Sink = OutputStream | 'null';

/** Applies a command's redirections: where its stdout and stderr go. */
function redirections(p: ProcessInput, st: ShState, v: ShellVariant, cmd: SimpleCommand, run: Run): Record<1 | 2, Sink> {
  const fds: Record<1 | 2, Sink> = { 1: 'stdout', 2: 'stderr' };
  for (const r of cmd.redirects) {
    const target = expandWord(p, st, v, r.target, run).join(' ');
    if (r.op === '<' || r.op === '<&') {
      if (target !== '/dev/null') run.gaps.push({ what: `input redirection from ${target}` });
      continue;
    }
    const fd = r.fd === 2 ? 2 : r.fd === 1 ? 1 : undefined;
    if (fd === undefined) {
      run.gaps.push({ what: `redirection of file descriptor ${r.fd}` });
      continue;
    }
    if (r.op === '>&') {
      if (target === '1' || target === '2') fds[fd] = fds[Number(target) as 1 | 2];
      else run.gaps.push({ what: `redirection >&${target}` });
      continue;
    }
    if (target === '/dev/null') fds[fd] = 'null';
    else {
      run.gaps.push({ what: `writing to ${target} from a container`, detail: 'container filesystems are not modeled yet; the output is discarded' });
      fds[fd] = 'null';
    }
  }
  return fds;
}

function emit(run: Run, fds: Record<1 | 2, Sink>, outs: Output[]): void {
  for (const o of outs) {
    const sink = fds[o.stream === 'stdout' ? 1 : 2];
    if (sink !== 'null') run.output.push({ stream: sink, text: o.text });
  }
}

const BUILTINS = new Set(['echo', 'printf', 'test', '[', 'true', 'false', ':', 'exit', 'export', 'unset', 'cd', 'set', 'trap', 'exec', 'read', 'wait', 'shift', 'pwd']);

function runSimple(p: ProcessInput, st: ShState, v: ShellVariant, cmd: SimpleCommand, run: Run, last: boolean): CmdResult {
  const argv = cmd.words.flatMap((w) => expandWord(p, st, v, w, run));
  const assigns = cmd.assigns.map((a) => [a.name, expandWord(p, st, v, a.value, run).join(' ')] as [string, string]);
  const fds = redirections(p, st, v, cmd, run);
  if (argv.length === 0) {
    for (const [k, val] of assigns) st.vars[k] = val;
    return { status: cmd.words.length === 0 && cmd.assigns.some((a) => a.value.some((x) => x.t === 'cmdsub')) ? st.status : 0 };
  }
  const name = argv[0] as string;
  const args = argv.slice(1);
  const out: Output[] = [];
  const say = (stream: OutputStream, t: string): void => {
    out.push({ stream, text: t });
  };
  const done = (status: number, extra: Partial<CmdResult> = {}): CmdResult => {
    emit(run, fds, out);
    return { status, ...extra };
  };
  if (BUILTINS.has(name)) {
    switch (name) {
      case 'echo':
        out.push(...echoUtility(args, v).output);
        return done(0);
      case 'printf': {
        const r = printfUtility(args, name);
        out.push(...r.output);
        run.gaps.push(...(r.gaps ?? []));
        return done(r.status);
      }
      case 'true':
      case ':':
      case 'cd':
      case 'wait':
        return done(0);
      case 'false':
        return done(1);
      case 'pwd':
        say('stdout', '/\n');
        return done(0);
      case 'read':
        // stdin is /dev/null: end of file.
        return done(1);
      case 'shift':
        st.positional = st.positional.slice(Number(args[0] ?? 1));
        return done(0);
      case 'export':
        for (const a of args) {
          const eq = a.indexOf('=');
          const k = eq < 0 ? a : a.slice(0, eq);
          if (eq >= 0) st.vars[k] = a.slice(eq + 1);
          if (!st.exported.includes(k)) st.exported.push(k);
        }
        return done(0);
      case 'unset':
        for (const a of args) {
          delete st.vars[a];
          st.exported = st.exported.filter((k) => k !== a);
        }
        return done(0);
      case 'set':
        for (const a of args) {
          if (a === '-e') st.errexit = true;
          else if (a === '+e') st.errexit = false;
          else run.gaps.push({ what: `set ${a}` });
        }
        return done(0);
      case 'trap': {
        if (args.length < 2) {
          run.gaps.push({ what: `trap ${args.join(' ')}` });
          return done(0);
        }
        const handler = args[0] as string;
        for (const s of args.slice(1)) {
          const sig = s.replace(/^SIG/, '').toUpperCase();
          const named = /^[0-9]+$/.test(sig) ? ({ '1': 'HUP', '2': 'INT', '3': 'QUIT', '15': 'TERM', '0': 'EXIT' } as Record<string, string>)[sig] : sig;
          if (!named) continue;
          if (handler === '-') delete st.traps[named];
          else st.traps[named] = handler;
        }
        return done(0);
      }
      case 'exit': {
        const a = args[0];
        if (a !== undefined && !/^[0-9]+$/.test(a)) {
          say('stderr', text.illegalNumber(v, st.arg0, lineOf(st, v, cmd.line), 'exit', a));
          emit(run, fds, out);
          return { status: 2, next: { exit: 2 } };
        }
        const code = a === undefined ? st.status : Number(a) & 255;
        emit(run, fds, out);
        return { status: code, next: { exit: code } };
      }
      case 'test':
      case '[': {
        const r = testBuiltin(p, st, v, name, args, cmd.line);
        if (r.error) say('stderr', r.error);
        return done(r.status);
      }
      case 'exec': {
        if (args.length === 0) return done(0);
        const exe = p.which(args[0] as string);
        if (!exe) {
          say('stderr', text.execNotFound(v, st.arg0, lineOf(st, v, cmd.line), args[0] as string));
          emit(run, fds, out);
          return { status: 127, next: { exit: 127 } };
        }
        emit(run, fds, out);
        return { status: 0, next: { exec: { exe, argv: args, env: childEnv(st, assigns) } } };
      }
    }
  }
  const exe = p.which(name);
  if (!exe) {
    say('stderr', text.notFound(v, st.arg0, cmd.line, name));
    return done(127);
  }
  return runExternal(p, st, v, exe, argv, assigns, run, fds, last, out);
}

function childEnv(st: ShState, assigns: [string, string][]): [string, string][] {
  const env: [string, string][] = st.exported.filter((k) => st.vars[k] !== undefined).map((k) => [k, st.vars[k] as string]);
  for (const [k, val] of assigns) {
    const i = env.findIndex(([x]) => x === k);
    if (i >= 0) env[i] = [k, val];
    else env.push([k, val]);
  }
  return env;
}

function runExternal(p: ProcessInput, st: ShState, v: ShellVariant, exe: Executable, argv: string[], assigns: [string, string][], run: Run, fds: Record<1 | 2, Sink>, last: boolean, out: Output[]): CmdResult {
  const env = childEnv(st, assigns);
  // BusyBox ash runs NOFORK applets (sleep among them) inside the shell: their errors carry its name.
  const prog = exe.variant === 'busybox' && v === 'busybox' ? st.arg0 : exe.model;
  const nofork = exe.variant === 'busybox' && v === 'busybox' && exe.model === 'sleep';
  const r = nofork && argv.length === 1 ? { output: [{ stream: 'stderr' as const, text: `${st.arg0}: sleep: missing operand\n` }], status: 1 } : runUtility(exe.model, exe.variant, argv.slice(1), env, p, prog);
  if (r && nofork && r.status !== 0 && argv.length > 1) {
    // A failing NOFORK applet ends ash itself (xfunc_die): the script does not continue.
    out.push(...r.output);
    emit(run, fds, out);
    throw new ShellExit(r.status, '');
  }
  if (r) {
    out.push(...r.output);
    run.gaps.push(...(r.gaps ?? []));
    emit(run, fds, out);
    return { status: r.status, ...(r.sleep !== undefined ? { sleep: r.sleep } : {}) };
  }
  emit(run, fds, out);
  // A long-running program as the script's last command: dash and ash exec it.
  if (last) return { status: 0, next: { exec: { exe, argv, env } } };
  run.gaps.push({ what: `running ${exe.path} as a child of the shell`, detail: 'only the last command of a script may be a program other than the modeled utilities' });
  return { status: 0 };
}

/** test and [ (XCU test), with the file tests answered from the image's files. */
function testBuiltin(p: ProcessInput, st: ShState, v: ShellVariant, name: string, args: string[], line: number): { status: number; error?: string } {
  let a = args;
  if (name === '[') {
    if (a[a.length - 1] !== ']') {
      return { status: 2, error: v === 'dash' ? `${st.arg0}: ${line}: [: missing ]\n` : v === 'busybox' ? `${st.arg0}: missing ]\n` : `${st.arg0}: line ${line}: [: missing \`]'\n` };
    }
    a = a.slice(0, -1);
  }
  let pos = 0;
  const int = (s: string): number => {
    if (!/^\s*[+-]?[0-9]+\s*$/.test(s)) throw new ShellError(text.testBadNumber(v, st.arg0, line, s));
    return Number(s);
  };
  const unary = (op: string, x: string): boolean => {
    switch (op) {
      case '-z': return x === '';
      case '-n': return x !== '';
      case '-e':
      case '-f':
      case '-r':
      case '-s':
        return p.file(x) !== undefined || p.which(x)?.path === x;
      case '-x':
        return p.which(x)?.path === x;
      default:
        return false;
    }
  };
  const UNARY = new Set(['-z', '-n', '-e', '-f', '-r', '-s', '-x', '-d', '-w', '-L', '-h']);
  const BIN = new Set(['=', '!=', '==', '-eq', '-ne', '-lt', '-le', '-gt', '-ge']);
  const primary = (): boolean => {
    const t = a[pos];
    if (t === undefined) return false;
    if (t === '!' && pos + 1 < a.length) {
      pos++;
      return !primary();
    }
    if (t === '(' ) {
      pos++;
      const r = orExpr();
      pos++;
      return r;
    }
    if (BIN.has(a[pos + 1] ?? '') && pos + 2 < a.length) {
      const l = t;
      const op = a[pos + 1] as string;
      const r = a[pos + 2] as string;
      pos += 3;
      switch (op) {
        case '=':
        case '==': return l === r;
        case '!=': return l !== r;
        case '-eq': return int(l) === int(r);
        case '-ne': return int(l) !== int(r);
        case '-lt': return int(l) < int(r);
        case '-le': return int(l) <= int(r);
        case '-gt': return int(l) > int(r);
        default: return int(l) >= int(r);
      }
    }
    if (UNARY.has(t) && pos + 1 < a.length) {
      pos += 2;
      return unary(t, a[pos - 1] as string);
    }
    pos++;
    return t !== '';
  };
  const andExpr = (): boolean => {
    let r = primary();
    while (a[pos] === '-a') {
      pos++;
      const x = primary();
      r = r && x;
    }
    return r;
  };
  const orExpr = (): boolean => {
    let r = andExpr();
    while (a[pos] === '-o') {
      pos++;
      const x = andExpr();
      r = r || x;
    }
    return r;
  };
  try {
    if (a.length === 0) return { status: 1 };
    return { status: orExpr() ? 0 : 1 };
  } catch (e) {
    if (e instanceof ShellError) return { status: 2, error: e.message };
    throw e;
  }
}

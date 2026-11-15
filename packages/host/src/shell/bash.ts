// The `bash` program: invocation, startup state and the read–parse–execute loop.
//   docs: bash(1) 5.2 INVOCATION, Shell Variables, PROMPTING (phase 03 draws the prompt)
//   reference: bash 5.2.21 invocation errors, initial variables and `$-`, captured 2026-11-16
//
// Not read yet: /etc/profile, ~/.profile, ~/.bashrc. They need `if` and `for` (phase 22a); until
// then a login shell starts as `bash --noprofile --norc` would (STATUS.md, temporary shortcuts).

import type { Json } from '@simlab/kernel';
import type { Command, List } from './ast.ts';
import { BUILTINS } from './builtins/index.ts';
import { parseCommandLine } from './parse.ts';
import { AbortLine, createShell, ShellExit, type Shell, type SubshellData } from './shell.ts';
import { cloneState, exportVar, getVar, setVar, stateToJson, type ShellState } from './state.ts';
import { getMachine } from '../machine.ts';
import type { Op, ProcApi, ProgramSpec, Syscall } from '../proc/program.ts';
import { userByUid } from '../users.ts';
import { isFsError, strerror } from '../vfs/errno.ts';

/** bash 5.2.21 `$BASH_VERSION` on Ubuntu 24.04 (bash 5.2.21-2ubuntu4). */
export const BASH_VERSION = '5.2.21(1)-release';

const USAGE =
  'Usage:\tbash [GNU long option] [option] ...\n\tbash [GNU long option] [option] script-file ...\nGNU long options:\n' +
  ['--debug', '--debugger', '--dump-po-strings', '--dump-strings', '--help', '--init-file', '--login', '--noediting', '--noprofile', '--norc', '--posix', '--pretty-print', '--rcfile', '--restricted', '--verbose', '--version']
    .map((o) => `\t${o}\n`)
    .join('') +
  'Shell options:\n\t-ilrsD or -c command or -O shopt_option\t\t(invocation only)\n\t-abefhkmnptuvxBCEHPT or -o option\n';

interface Invocation {
  login: boolean;
  interactiveFlag: boolean;
  command?: string;
  rest: string[];
  stdinFlag: boolean;
}

function* parseInvocation(p: ProcApi): Op<Invocation | number> {
  const argv = p.argv;
  const inv: Invocation = { login: (argv[0] ?? '').startsWith('-'), interactiveFlag: false, rest: [], stdinFlag: false };
  let wantCommand = false;
  let i = 1;
  const invalid = function* (opt: string): Op<number> {
    yield* p.write(2, `bash: ${opt}: invalid option\n${USAGE}`);
    return 2;
  };
  for (; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--' || a === '-') {
      i++;
      break;
    }
    if (a.startsWith('--')) {
      if (a === '--login') inv.login = true;
      else if (a === '--noprofile' || a === '--norc' || a === '--noediting') continue;
      else if (['--debug', '--debugger', '--dump-po-strings', '--dump-strings', '--help', '--init-file', '--posix', '--pretty-print', '--rcfile', '--restricted', '--verbose', '--version'].includes(a)) {
        return yield* p.unsupported({ kind: 'flag', what: `the option ${a}` });
      } else return yield* invalid(a);
      continue;
    }
    if (!a.startsWith('-') || a.length < 2) break;
    for (const ch of a.slice(1)) {
      if (ch === 'c') wantCommand = true;
      else if (ch === 'i') inv.interactiveFlag = true;
      else if (ch === 'l') inv.login = true;
      else if (ch === 's') inv.stdinFlag = true;
      else if ('abefhkmnptuvxBCEHPTrDO'.includes(ch)) return yield* p.unsupported({ kind: 'flag', what: `the option -${ch}` });
      else return yield* invalid(`-${ch}`);
    }
  }
  if (wantCommand) {
    if (i >= argv.length) {
      yield* p.write(2, 'bash: -c: option requires an argument\n');
      return 2;
    }
    inv.command = argv[i++] as string;
  }
  inv.rest = argv.slice(i);
  return inv;
}

/** The variables a new shell starts with: the environment, then the shell's own. */
function initialState(p: ProcApi, inv: Invocation, interactive: boolean, source: ShellState['source'], arg0: string): ShellState {
  const state: ShellState = {
    vars: {},
    varSeq: 0,
    aliases: {},
    arg0,
    positional: [],
    status: 0,
    pipestatus: [0],
    interactive,
    login: inv.login,
    source,
    history: [],
    hash: {},
    shellPid: p.pid,
    ppid: p.proc.ppid,
    startedAt: p.now,
  };
  for (const [k, v] of Object.entries(p.env)) {
    if (k === '_' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    setVar(state, k, v, { export: true });
  }
  const shlvl = Number(getVar(state, 'SHLVL') ?? '0');
  setVar(state, 'SHLVL', String(Number.isInteger(shlvl) && shlvl >= 0 ? shlvl + 1 : 1), { export: true });
  if (getVar(state, 'PWD') !== p.cwd) setVar(state, 'PWD', p.cwd, { export: true });
  if (state.vars['OLDPWD'] === undefined) exportVar(state, 'OLDPWD');
  const user = userByUid(p.ctx, p.machine, p.cred.uid);
  const a0 = (p.argv[0] ?? 'bash').replace(/^-/, '');
  // $BASH: the path the shell was run by; a login shell named without a slash reports the user's
  // shell from /etc/passwd (bash 5.2.21 get_bash_name, observed 2026-11-16).
  const bashPath = a0.includes('/') ? a0 : inv.login && user ? user.shell : '/usr/bin/bash';
  const own: [string, string][] = [
    ['BASH', bashPath],
    ['BASH_VERSION', BASH_VERSION],
    ['HOSTNAME', getMachine(p.ctx, p.machine).hostname],
    ['HOSTTYPE', 'x86_64'],
    ['MACHTYPE', 'x86_64-pc-linux-gnu'],
    ['OSTYPE', 'linux-gnu'],
    ['IFS', ' \t\n'],
    ['PS2', '> '],
    ['PS4', '+ '],
    ['PPID', p.proc.ppid],
    ['UID', String(p.cred.uid)],
    ['EUID', String(p.cred.uid)],
    ['OPTIND', '1'],
  ];
  if (interactive) {
    own.push(['PS1', '\\s-\\v\\$ '], ['HISTFILE', `${getVar(state, 'HOME') ?? ''}/.bash_history`], ['HISTSIZE', '500'], ['HISTFILESIZE', '500']);
  }
  for (const [k, v] of own) if (getVar(state, k) === undefined || k === 'PPID' || k === 'UID' || k === 'EUID') setVar(state, k, v);
  return state;
}

function* main(p: ProcApi): Generator<Syscall, number, unknown> {
  const data = p.spawnData as SubshellData | undefined;
  if (data?.kind === 'subshell') {
    const state = cloneState(data.state as unknown as ShellState);
    const sh = createShell(p, state, BUILTINS, true);
    return yield* guard(sh, () => sh.runNode(data.node as unknown as Command | List, data.stage ?? false));
  }
  if (data?.kind === 'script') return yield* runScript(p, { login: false, interactiveFlag: false, rest: [], stdinFlag: false }, data.path, p.argv.slice(1));

  const inv = yield* parseInvocation(p);
  if (typeof inv === 'number') return inv;
  if (inv.command !== undefined) {
    const arg0 = inv.rest[0] ?? (p.argv[0] ?? 'bash');
    const state = initialState(p, inv, false, 'c', arg0);
    state.positional = inv.rest.slice(1);
    const sh = createShell(p, state, BUILTINS, false);
    const command = inv.command;
    return yield* guard(sh, () => sh.runSource(command, { line: 1 }));
  }
  if (inv.rest.length > 0 && !inv.stdinFlag) return yield* runScript(p, inv, inv.rest[0] as string, inv.rest.slice(1));
  const interactive = inv.interactiveFlag || (p.isatty(0) && p.isatty(2));
  const state = initialState(p, inv, interactive, 'stdin', p.argv[0] ?? 'bash');
  state.positional = inv.rest;
  if (interactive) {
    // An interactive shell ignores SIGTERM and SIGQUIT, and catches SIGINT (bash(1) SIGNALS).
    p.trap(15, 'ignore');
    p.trap(3, 'ignore');
    p.trap(2, 'interrupt');
  }
  return yield* readLoop(createShell(p, state, BUILTINS, false));
}

function* runScript(p: ProcApi, inv: Invocation, path: string, args: string[]): Op<number> {
  let text: string;
  try {
    text = p.fs().readFile(path);
  } catch (e) {
    if (isFsError(e, 'EISDIR')) {
      yield* p.write(2, `${path}: ${path}: ${strerror('EISDIR')}\n`);
      return 126;
    }
    if (isFsError(e)) {
      yield* p.write(2, `bash: ${path}: ${strerror(e.code)}\n`);
      return e.code === 'ENOENT' ? 127 : 126;
    }
    throw e;
  }
  const state = initialState(p, inv, false, 'script', path);
  state.positional = args;
  const sh = createShell(p, state, BUILTINS, false);
  return yield* guard(sh, () => sh.runSource(text, { line: 1 }));
}

/** Runs `body`, turning `exit` into the shell's status. */
function* guard(sh: Shell, body: () => Op<number>): Op<number> {
  try {
    return yield* body();
  } catch (e) {
    if (e instanceof ShellExit) return e.code;
    if (e instanceof AbortLine) return e.status;
    throw e;
  }
}

/**
 * Reads commands from standard input: the interactive loop, or a non-interactive shell reading a
 * pipe. At each prompt the interactive shell is at a restart point: its whole state is data.
 */
function* readLoop(sh: Shell): Op<number> {
  const { p, state } = sh;
  let line = 1;
  for (;;) {
    if (state.interactive) p.setResume(stateToJson(state));
    let buf = '';
    let eof = false;
    let result: ReturnType<typeof parseCommandLine> | undefined;
    for (;;) {
      let chunk: string | null;
      try {
        chunk = yield* p.read(0, { line: true });
      } catch (e) {
        // Ctrl-C at the prompt discards the line (phase 03 redraws the prompt).
        if (e instanceof Error && e.name === 'Interrupted') {
          buf = '';
          continue;
        }
        throw e;
      }
      if (state.interactive) p.setResume(undefined);
      if (chunk === null) {
        eof = true;
        if (buf === '') break;
      } else buf += chunk;
      result = parseCommandLine(buf, 0, {
        aliases: state.aliases,
        expandAliases: state.interactive,
        history: state.interactive,
        line,
        final: eof,
      });
      if (result.kind !== 'incomplete') break;
    }
    if (eof && buf === '') {
      if (state.interactive) yield* p.write(2, state.login ? 'logout\n' : 'exit\n');
      return state.status;
    }
    if (!result || result.kind === 'incomplete') continue;
    if (state.interactive && buf.trim() !== '') state.history.push(buf.replace(/\n$/, ''));
    const lines = buf.split('\n').length - (buf.endsWith('\n') ? 1 : 0);
    try {
      if (result.kind === 'ok') {
        for (const w of result.warnings) yield* sh.diag(w);
        if (result.list) state.status = yield* sh.runList(result.list);
        // Whatever follows the first complete command line in `buf` (a multi-line paste) is run next.
        if (result.end < result.src.length) state.status = yield* sh.runSource(result.src.slice(result.end), { line: line + 1 });
      } else if (result.kind === 'unsupported') {
        state.status = yield* sh.notice(result.what, 'syntax', result.src.replace(/\n$/, ''));
      } else {
        sh.line = result.line;
        if (state.interactive) yield* p.write(2, `${state.arg0}: ${result.message}\n`);
        else {
          yield* p.write(2, `${state.arg0}: line ${result.line}: ${result.message}\n`);
          if (result.lineText !== '') yield* p.write(2, `${state.arg0}: line ${result.line}: \`${result.lineText}'\n`);
          return 2;
        }
        state.status = 2;
      }
    } catch (e) {
      if (e instanceof ShellExit) return e.code;
      if (e instanceof AbortLine) state.status = e.status;
      else throw e;
    }
    line += lines;
    if (eof) return state.status;
  }
}

function* restart(p: ProcApi, resume: Json): Generator<Syscall, number, unknown> {
  const state = cloneState(resume as unknown as ShellState);
  return yield* readLoop(createShell(p, state, BUILTINS, false));
}

export const bashProgram: ProgramSpec = { name: 'bash', main, restart };

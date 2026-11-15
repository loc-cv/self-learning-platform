// The shell executor: runs parsed command lines against the process runtime.
//   docs: bash(1) 5.2 SIMPLE COMMAND EXPANSION, COMMAND EXECUTION, COMMAND EXECUTION ENVIRONMENT,
//         Pipelines, Lists, REDIRECTION, EXIT STATUS
//   reference: bash 5.2.21 messages and statuses, captured 2026-11-16 (packages/host/transcripts/shell/)
//
// Builtins run inside the shell process. External commands are found through PATH in the VFS and
// run as child processes. Each stage of a multi-stage pipeline runs in a subshell process; when the
// stage is an external command, the subshell execs it, as bash does.

import type { Json } from '@simlab/kernel';
import type { Command, List, Pipeline, Redir, SimpleCommand } from './ast.ts';
import { ExpansionError, expandAssignment, expandHeredoc, expandRedirTarget, expandWords, type ExpandEnv } from './expand.ts';
import type { GlobFs } from './glob.ts';
import { parseCommandLine } from './parse.ts';
import { exportOrder, getVar, setVar, stateToJson, unsetVar, type ShellState } from './state.ts';
import type { Op, ProcApi } from '../proc/program.ts';
import { resolveExec } from '../proc/exec.ts';
import { simNotice, SIM_STATUS, styleNotice } from '../proc/notice.ts';
import { SIGINT, SIGPIPE, strsignal } from '../proc/signals.ts';
import type { ExitStatus } from '../proc/types.ts';
import { userByName } from '../users.ts';
import { isFsError, strerror, UnsupportedError } from '../vfs/errno.ts';
import type { GapKind } from '@simlab/kernel';

/** Thrown by `exit` (and by fatal errors in a non-interactive shell) to end the shell. */
export class ShellExit extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

/** Abandons the rest of the command line in an interactive shell (after an expansion error). */
export class AbortLine extends Error {
  readonly status: number;
  constructor(status: number) {
    super('abort');
    this.status = status;
  }
}

export type Builtin = (sh: Shell, argv: string[]) => Op<number>;

/** What a subshell process receives as spawn data. */
export type SubshellData =
  | { kind: 'subshell'; state: Json; node: Json; stage?: boolean }
  | { kind: 'script'; path: string };

/** Every bash builtin and reserved word: a name here is never "command not found". bash(1) SHELL BUILTIN COMMANDS */
export const BASH_BUILTINS = [
  '.', ':', '[', 'alias', 'bg', 'bind', 'break', 'builtin', 'caller', 'cd', 'command', 'compgen', 'complete',
  'compopt', 'continue', 'declare', 'dirs', 'disown', 'echo', 'enable', 'eval', 'exec', 'exit', 'export',
  'false', 'fc', 'fg', 'getopts', 'hash', 'help', 'history', 'jobs', 'kill', 'let', 'local', 'logout',
  'mapfile', 'popd', 'printf', 'pushd', 'pwd', 'read', 'readarray', 'readonly', 'return', 'set', 'shift',
  'shopt', 'source', 'suspend', 'test', 'times', 'trap', 'true', 'type', 'typeset', 'ulimit', 'umask',
  'unalias', 'unset', 'wait',
];
export const BASH_KEYWORDS = [
  '!', 'case', 'coproc', 'do', 'done', 'elif', 'else', 'esac', 'fi', 'for', 'function', 'if', 'in',
  'select', 'then', 'time', 'until', 'while', '{', '}', '[[', ']]',
];

export interface Shell {
  readonly p: ProcApi;
  readonly state: ShellState;
  readonly builtins: Readonly<Record<string, Builtin>>;
  /** A subshell: no job control, no history. */
  readonly subshell: boolean;
  /** Line of the command being run, for diagnostics. */
  line: number;
  out(s: string): Op<void>;
  err(s: string): Op<void>;
  /** Writes `<prefix><msg>` and a newline to standard error, the way bash words its errors. */
  diag(msg: string): Op<void>;
  /** Prints a `[sim]` notice for the shell and records the gap. Returns 250. */
  notice(what: string, kind: GapKind, commandLine: string): Op<number>;
  expandEnv: ExpandEnv;
  /** Runs shell source (a `-c` string, a script, a sourced file) one command line at a time. */
  runSource(src: string, opts: { line: number }): Op<number>;
  runList(list: List): Op<number>;
  /** Runs the node a subshell process was spawned for; `stage` lets an external command be exec'd. */
  runNode(node: Command | List, stage: boolean): Op<number>;
  /** The environment a program started now receives. */
  environment(extra?: Record<string, string>): Record<string, string>;
  /** Finds a command in PATH (and the hash table). */
  findCommand(name: string, opts?: { remember?: boolean; ignoreHash?: boolean }): string | undefined;
  /** Sets PWD/OLDPWD bookkeeping and the process's working directory. */
  chdir(logical: string): void;
}

export function statusOf(st: ExitStatus): number {
  return 'code' in st ? st.code : 128 + st.signal;
}

export function createShell(p: ProcApi, state: ShellState, builtins: Record<string, Builtin>, subshell: boolean): Shell {
  /** Descriptors the shell holds for itself (saved originals, pipe ends): never inherited. */
  const internal = new Set<number>();
  let lastSubstStatus: number | undefined;

  const prefix = (): string => (state.interactive && state.source === 'stdin' ? `${state.arg0}: ` : `${state.arg0}: line ${sh.line}: `);

  const childFds = (): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const k of Object.keys(p.proc.fds)) if (!internal.has(Number(k))) out[k] = Number(k);
    return out;
  };

  const freeFd = (): number => {
    let n = 10;
    while (p.fd(n) !== undefined) n++;
    return n;
  };

  const globFs: GlobFs = {
    readdir(path) {
      try {
        return p.fs().readdir(path);
      } catch {
        return undefined;
      }
    },
    exists(path) {
      try {
        p.fs().lstat(path);
        return true;
      } catch {
        return false;
      }
    },
    isDir(path) {
      try {
        return p.fs().stat(path).type === 'dir';
      } catch {
        return false;
      }
    },
  };

  const flags = (): string => {
    if (state.interactive) return 'himBHs';
    if (state.source === 'c') return 'hBc';
    if (state.source === 'stdin') return 'hBs';
    return 'hB';
  };

  const expandEnv: ExpandEnv = {
    get(name) {
      switch (name) {
        case '?':
          return String(state.status);
        case '$':
          return state.shellPid;
        case '#':
          return String(state.positional.length);
        case '0':
          return state.arg0;
        case '-':
          return flags();
        case '!':
          return undefined;
        case 'RANDOM':
          return String(p.random('host.bash.random').int(32768));
        case 'SECONDS':
          return String(Math.floor((p.now - state.startedAt) / 1000));
        case 'EPOCHSECONDS':
          return String(Math.floor(p.now / 1000));
        case 'LINENO':
          return String(sh.line);
        case 'BASHPID':
          return p.pid;
        case 'PIPESTATUS':
          // An array in bash; without arrays, $PIPESTATUS is its element 0 (bash(1) Arrays).
          return String(state.pipestatus[0] ?? 0);
      }
      if (/^[0-9]+$/.test(name)) return state.positional[Number(name) - 1];
      return getVar(state, name);
    },
    set(name, value) {
      setVar(state, name, value);
    },
    positional: () => state.positional,
    home(user) {
      if (user === '') return getVar(state, 'HOME');
      return userByName(p.ctx, p.machine, user)?.home;
    },
    *commandSubstitution(body) {
      const [r, w] = p.pipe();
      internal.add(r);
      internal.add(w);
      const fds = childFds();
      fds['1'] = w;
      const pid = p.spawn({
        program: 'bash',
        argv: [...p.argv],
        data: { kind: 'subshell', state: stateToJson(state), node: body as unknown as Json },
        fds,
      });
      p.close(w);
      internal.delete(w);
      let out = '';
      for (;;) {
        const chunk = yield* p.read(r);
        if (chunk === null) break;
        out += chunk;
      }
      p.close(r);
      internal.delete(r);
      lastSubstStatus = statusOf(yield* p.waitpid(pid));
      // Expansion runs left to right: `echo $(false) $?` prints 1 (bash 5.2.21, captured 2026-11-16).
      state.status = lastSubstStatus;
      return out;
    },
    glob: globFs,
  };

  // ---- redirections ------------------------------------------------------------------------------

  type Undo = () => void;

  /** Applies redirections to the shell's own descriptors; the returned function restores them. */
  function* applyRedirs(redirs: readonly Redir[]): Op<Undo | undefined> {
    const saved: { fd: number; slot?: number }[] = [];
    const undo: Undo = () => {
      for (const s of [...saved].reverse()) {
        if (s.slot !== undefined) {
          p.dup2(s.slot, s.fd);
          p.close(s.slot);
          internal.delete(s.slot);
        } else p.close(s.fd);
      }
    };
    const save = (fd: number): void => {
      if (saved.some((s) => s.fd === fd)) return;
      if (p.fd(fd) !== undefined) {
        const slot = freeFd();
        p.dup2(fd, slot);
        internal.add(slot);
        saved.push({ fd, slot });
      } else saved.push({ fd });
    };
    const fail = function* (msg: string): Op<undefined> {
      undo();
      yield* sh.diag(msg);
      return undefined;
    };
    for (const r of redirs) {
      const input = r.op === '<' || r.op === '<<' || r.op === '<<-' || r.op === '<<<' || r.op === '<>' || r.op === '<&';
      const fd = r.fd ?? (input ? 0 : 1);
      if (r.op === '<<' || r.op === '<<-') {
        const h = r.heredoc ?? { parts: [], quoted: true };
        const body = h.quoted ? h.parts.map((x) => (x.t === 'q' ? x.v : '')).join('') : yield* expandHeredoc(h.parts, expandEnv);
        save(fd);
        p.openData(fd, body);
        continue;
      }
      let word: string | undefined;
      try {
        word = r.op === '<<<' ? (yield* expandWords([r.target], expandEnv)).join(' ') : yield* expandRedirTarget(r.target, expandEnv);
      } catch (e) {
        if (e instanceof ExpansionError) return yield* fail(e.message);
        throw e;
      }
      if (word === undefined) return yield* fail(`${r.target.text}: ambiguous redirect`);
      if (r.op === '<<<') {
        save(fd);
        p.openData(fd, `${word}\n`);
        continue;
      }
      if ((r.op === '>&' || r.op === '<&') && (/^[0-9]+$/.test(word) || word === '-')) {
        save(fd);
        if (word === '-') {
          p.close(fd);
          continue;
        }
        if (p.fd(Number(word)) === undefined || internal.has(Number(word))) return yield* fail(`${word}: Bad file descriptor`);
        p.dup2(Number(word), fd);
        continue;
      }
      if (r.op === '<&') return yield* fail(`${word}: ambiguous redirect`);
      const both = r.op === '&>' || r.op === '&>>' || (r.op === '>&' && r.fd === undefined);
      const append = r.op === '>>' || r.op === '&>>';
      try {
        save(fd);
        if (input && r.op === '<') p.openAt(fd, word, { read: true });
        else if (r.op === '<>') p.openAt(fd, word, { read: true, write: true, create: true });
        else p.openAt(fd, word, { write: true, create: true, ...(append ? { append: true } : { truncate: true }) });
        if (both) {
          save(2);
          p.dup2(fd, 2);
        }
      } catch (e) {
        if (isFsError(e)) return yield* fail(`${word}: ${strerror(e.code)}`);
        if (e instanceof UnsupportedError) {
          undo();
          yield* sh.notice(e.what, 'behavior', r.target.text);
          return undefined;
        }
        throw e;
      }
    }
    return undo;
  }

  // ---- commands ----------------------------------------------------------------------------------

  function* waitForeground(pids: string[], pgid: string | undefined): Op<number[]> {
    const control = state.interactive && !subshell && pgid !== undefined;
    if (control) p.setForeground(pgid as string);
    const statuses: number[] = [];
    let last: ExitStatus | undefined;
    for (const pid of pids) {
      last = yield* p.waitpid(pid);
      statuses.push(statusOf(last));
    }
    if (control) p.setForeground(p.proc.pgid);
    // An interactive shell reports a foreground job killed by a signal (bash 5.2.21: a newline for
    // SIGINT, nothing for SIGPIPE, strsignal(3) otherwise).
    if (control && last && 'signal' in last && last.signal !== SIGPIPE) {
      yield* sh.err(last.signal === SIGINT ? '\n' : `${strsignal(last.signal)}\n`);
    }
    return statuses;
  }

  function* expansionFailed(e: ExpansionError): Op<number> {
    yield* sh.diag(e.message);
    if (!state.interactive) throw new ShellExit(127);
    throw new AbortLine(1);
  }

  /**
   * Runs an external command found at `path`, or reports why it cannot run. As in bash, where the
   * child applies its redirections before exec, the diagnostics go to the redirected stderr.
   */
  function* runExternal(argv: string[], path: string | undefined, env: Record<string, string>, stage: boolean, redirs: readonly Redir[]): Op<number> {
    const name = argv[0] as string;
    const undo = yield* applyRedirs(redirs);
    if (!undo) return 1;
    const failed = function* (msg: string, status: number): Op<number> {
      yield* sh.diag(msg);
      undo();
      return status;
    };
    if (path === undefined) {
      p.ctx.gap({ kind: 'unknown-command', program: name, what: name, commandLine: argv.join(' '), machine: p.machine });
      return yield* failed(`${name}: command not found`, 127);
    }
    const target = resolveExec(p.fs(), path, argv);
    if (target.kind === 'error') {
      if (target.code === 'ENOENT') return yield* failed(`${name}: ${strerror('ENOENT')}`, 127);
      let isDir = false;
      try {
        isDir = p.fs().stat(path).type === 'dir';
      } catch {
        // Reported as the exec error below.
      }
      return yield* failed(`${name}: ${isDir ? strerror('EISDIR') : strerror(target.code)}`, 126);
    }
    if (target.kind === 'bad-interpreter') return yield* failed(`${name}: ${target.interpreter}: bad interpreter: ${strerror(target.code)}`, 126);
    const childEnv = { ...env };
    delete childEnv['_'];
    childEnv['_'] = path;
    const req =
      target.kind === 'program'
        ? { program: target.program, argv: target.argv, env: childEnv }
        : { program: 'bash', argv: target.argv, env: childEnv, data: { kind: 'script', path: target.path } as Json };
    if (stage) {
      for (const n of [...internal]) p.close(n);
      p.exec(req);
    }
    const control = state.interactive && !subshell;
    const pid = p.spawn({ ...req, fds: childFds(), ...(control ? { pgid: 'new' } : {}) });
    undo();
    const [status] = yield* waitForeground([pid], control ? pid : undefined);
    return status as number;
  }

  function* runSimple(cmd: SimpleCommand, stage: boolean): Op<number> {
    sh.line = cmd.line;
    lastSubstStatus = undefined;
    let argv: string[];
    const assigns: [string, string][] = [];
    try {
      argv = yield* expandWords(cmd.words, expandEnv);
      for (const a of cmd.assigns) {
        const v = yield* expandAssignment(a.value, expandEnv);
        assigns.push([a.name, a.append ? (getVar(state, a.name) ?? '') + v : v]);
      }
    } catch (e) {
      if (e instanceof ExpansionError) return yield* expansionFailed(e);
      throw e;
    }

    if (argv.length === 0) {
      for (const [n, v] of assigns) setVar(state, n, v);
      if (cmd.redirs.length > 0) {
        const undo = yield* applyRedirs(cmd.redirs);
        if (!undo) return 1;
        undo();
      }
      return lastSubstStatus ?? 0;
    }

    const name = argv[0] as string;
    const builtin = builtins[name];
    if (builtin || BASH_BUILTINS.includes(name)) {
      if (!builtin) return yield* sh.notice(`the builtin "${name}"`, 'command', argv.join(' '));
      const undo = yield* applyRedirs(cmd.redirs);
      if (!undo) return 1;
      // Assignments before a builtin last for that builtin only.
      const saved = assigns.map(([n]) => [n, state.vars[n] ? { ...state.vars[n] } : undefined] as const);
      for (const [n, v] of assigns) setVar(state, n, v);
      try {
        return yield* builtin(sh, argv);
      } catch (e) {
        // A builtin whose output cannot be written reports it like bash does.
        if (isFsError(e) && (e.syscall === 'fd' || e.syscall === 'write')) {
          yield* sh.diag(`${name}: write error: ${strerror(e.code)}`);
          return 1;
        }
        throw e;
      } finally {
        for (const [n, old] of saved) {
          if (old) state.vars[n] = old;
          else unsetVar(state, n);
        }
        undo();
      }
    }

    const extra: Record<string, string> = {};
    for (const [n, v] of assigns) extra[n] = v;
    const path = sh.findCommand(name, { remember: true });
    return yield* runExternal(argv, path, sh.environment(extra), stage, cmd.redirs);
  }

  function spawnSubshell(node: Command | List, fds: Record<string, number>, pgid: string | undefined, stage: boolean): string {
    return p.spawn({
      program: 'bash',
      argv: [...p.argv],
      data: { kind: 'subshell', state: stateToJson(state), node: node as unknown as Json, ...(stage ? { stage: true } : {}) },
      fds,
      ...(pgid !== undefined ? { pgid } : {}),
    });
  }

  function* runCommand(cmd: Command, stage: boolean): Op<number> {
    switch (cmd.t) {
      case 'simple':
        return yield* runSimple(cmd, stage);
      case 'group': {
        sh.line = cmd.line;
        const undo = yield* applyRedirs(cmd.redirs);
        if (!undo) return 1;
        try {
          return yield* sh.runList(cmd.body);
        } finally {
          undo();
        }
      }
      case 'subshell': {
        sh.line = cmd.line;
        const undo = yield* applyRedirs(cmd.redirs);
        if (!undo) return 1;
        const control = state.interactive && !subshell;
        const pid = spawnSubshell(cmd.body, childFds(), control ? 'new' : undefined, false);
        undo();
        const [status] = yield* waitForeground([pid], control ? pid : undefined);
        return status as number;
      }
    }
  }

  function* runPipeline(pl: Pipeline): Op<number> {
    let status: number;
    if (pl.cmds.length === 1) {
      status = yield* runCommand(pl.cmds[0] as Command, false);
      state.pipestatus = [status];
    } else {
      const control = state.interactive && !subshell;
      const pipes: [number, number][] = [];
      for (let i = 0; i < pl.cmds.length - 1; i++) {
        const pair = p.pipe();
        internal.add(pair[0]);
        internal.add(pair[1]);
        pipes.push(pair);
      }
      const pids: string[] = [];
      let pgid: string | undefined;
      for (let i = 0; i < pl.cmds.length; i++) {
        const fds = childFds();
        if (i > 0) fds['0'] = (pipes[i - 1] as [number, number])[0];
        if (i < pl.cmds.length - 1) {
          fds['1'] = (pipes[i] as [number, number])[1];
          if (pl.stderr[i]) fds['2'] = fds['1'];
        }
        const pid = spawnSubshell(pl.cmds[i] as Command, fds, control ? (pgid ?? 'new') : undefined, true);
        pgid ??= pid;
        pids.push(pid);
      }
      for (const [r, w] of pipes) {
        p.close(r);
        p.close(w);
        internal.delete(r);
        internal.delete(w);
      }
      const statuses = yield* waitForeground(pids, control ? pgid : undefined);
      state.pipestatus = statuses;
      status = statuses[statuses.length - 1] as number;
    }
    return pl.bang ? (status === 0 ? 1 : 0) : status;
  }

  const sh: Shell = {
    p,
    state,
    builtins,
    subshell,
    line: 1,
    *out(s) {
      yield* p.write(1, s);
    },
    *err(s) {
      yield* p.write(2, s);
    },
    *diag(msg) {
      yield* p.write(2, `${prefix()}${msg}\n`);
    },
    *notice(what, kind, commandLine) {
      p.ctx.gap({ kind, program: 'bash', what, commandLine, machine: p.machine });
      yield* p.write(2, p.isatty(2) ? styleNotice(simNotice('bash', what)) : simNotice('bash', what));
      return SIM_STATUS;
    },
    expandEnv,
    *runSource(src, opts) {
      let text = src;
      let pos = 0;
      while (pos < text.length) {
        // Line numbers count from the start of the source (`opts.line` is the first line's).
        const r = parseCommandLine(text, pos, {
          aliases: state.aliases,
          expandAliases: state.interactive,
          history: false,
          line: opts.line,
          final: true,
        });
        if (r.kind === 'ok') {
          for (const w of r.warnings) {
            sh.line = opts.line + countNewlines(r.src, 0, r.end);
            yield* sh.diag(w);
          }
          if (r.list) state.status = yield* sh.runList(r.list);
          text = r.src;
          pos = r.end;
          continue;
        }
        if (r.kind === 'unsupported') {
          state.status = yield* sh.notice(r.what, 'syntax', r.src.slice(pos, r.end).replace(/\n$/, ''));
          text = r.src;
          pos = r.end;
          continue;
        }
        if (r.kind === 'error') {
          sh.line = r.line;
          const where = state.source === 'c' ? `${state.arg0}: -c: line ${r.line}: ` : `${state.arg0}: line ${r.line}: `;
          yield* p.write(2, `${where}${r.message}\n`);
          if (r.lineText !== '') yield* p.write(2, `${where}\`${r.lineText}'\n`);
          state.status = 2;
          // A syntax error ends a non-interactive shell.
          return 2;
        }
        break;
      }
      return state.status;
    },
    *runList(list) {
      let status = state.status;
      for (const item of list.items) {
        status = yield* runPipeline(item.first);
        state.status = status;
        for (const r of item.rest) {
          if ((r.op === '&&') === (status === 0)) {
            status = yield* runPipeline(r.pipeline);
            state.status = status;
          }
        }
      }
      return status;
    },
    *runNode(node, stage) {
      return node.t === 'list' ? yield* sh.runList(node) : yield* runCommand(node, stage);
    },
    environment(extra = {}) {
      const env: Record<string, string> = {};
      for (const n of exportOrder(state)) env[n] = getVar(state, n) as string;
      for (const n of Object.keys(extra)) {
        delete env[n];
        env[n] = extra[n] as string;
      }
      return env;
    },
    findCommand(name, opts = {}) {
      if (name.includes('/')) return name;
      const hit = state.hash[name];
      if (hit && !opts.ignoreHash) {
        if (opts.remember) hit.hits++;
        return hit.path;
      }
      const fs = p.fs();
      let fallback: string | undefined;
      for (const dir of (getVar(state, 'PATH') ?? '').split(':')) {
        const path = `${dir === '' ? '.' : dir}/${name}`;
        try {
          const st = fs.stat(path);
          if (st.type === 'dir') continue;
          try {
            fs.access(path, 1);
          } catch {
            fallback ??= path;
            continue;
          }
          if (opts.remember) state.hash[name] = { path, hits: 1 };
          return path;
        } catch {
          continue;
        }
      }
      return fallback;
    },
    chdir(logical) {
      const old = getVar(state, 'PWD');
      if (old !== undefined) setVar(state, 'OLDPWD', old);
      setVar(state, 'PWD', logical);
      p.setCwd(logical);
    },
  };

  return sh;
}

function countNewlines(s: string, from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to && i < s.length; i++) if (s[i] === '\n') n++;
  return n;
}


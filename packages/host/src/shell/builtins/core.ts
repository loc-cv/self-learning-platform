// bash builtins: echo, true, false, :, cd, pwd, exit, export, unset, alias, unalias, type, history,
// source and `.`.
//   docs: bash(1) 5.2 SHELL BUILTIN COMMANDS
//   reference: bash 5.2.21 output, errors and usage lines, captured 2026-11-16
//              (packages/host/transcripts/shell/builtins-*.t)

import type { Builtin, Shell } from '../shell.ts';
import { AbortLine, BASH_BUILTINS, BASH_KEYWORDS, ShellExit } from '../shell.ts';
import { exportVar, getVar, setVar, unsetVar } from '../state.ts';
import { isFsError, strerror } from '../../vfs/errno.ts';
import type { Op } from '../../proc/program.ts';
import { byteChar, decodeBytes } from '../../text/bytes.ts';

const isName = (s: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);

/** Splits leading options for builtins that take only the letters in `allowed`. */
function* options(sh: Shell, argv: string[], allowed: string, usage: string): Op<{ opts: Set<string>; args: string[] } | number> {
  const opts = new Set<string>();
  let i = 1;
  for (; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--') {
      i++;
      break;
    }
    if (!a.startsWith('-') || a === '-') break;
    for (const ch of a.slice(1)) {
      if (!allowed.includes(ch)) {
        yield* sh.diag(`${argv[0]}: -${ch}: invalid option`);
        yield* sh.err(`${argv[0]}: usage: ${usage}\n`);
        return 2;
      }
      opts.add(ch);
    }
  }
  return { opts, args: argv.slice(i) };
}

/** echo [-neE] [arg ...]: options end at the first argument that is not one. xpg_echo is off. */
const echo: Builtin = function* (sh, argv) {
  let i = 1;
  let newline = true;
  let escapes = false;
  for (; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!/^-[neE]+$/.test(a)) break;
    for (const ch of a.slice(1)) {
      if (ch === 'n') newline = false;
      else if (ch === 'e') escapes = true;
      else escapes = false;
    }
  }
  let out = argv.slice(i).join(' ');
  if (escapes) {
    const r = expandEchoEscapes(out);
    out = r.text;
    if (r.stop) newline = false;
  }
  yield* sh.out(newline ? `${out}\n` : out);
  return 0;
};

/** Backslash escapes of `echo -e` (bash(1) echo); `\c` suppresses further output. */
export function expandEchoEscapes(s: string): { text: string; stop: boolean } {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (c !== '\\' || i + 1 >= s.length) {
      out += c;
      continue;
    }
    const e = s[++i] as string;
    const simple: Record<string, string> = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\' };
    if (e in simple) out += simple[e];
    else if (e === 'c') return { text: decodeBytes(out), stop: true };
    else if (e === '0') {
      let d = '';
      while (d.length < 3 && /[0-7]/.test(s[i + 1] ?? '')) d += s[++i];
      out += byteChar(parseInt(d || '0', 8) & 0xff);
    } else if (e === 'x' && /[0-9a-fA-F]/.test(s[i + 1] ?? '')) {
      let d = '';
      while (d.length < 2 && /[0-9a-fA-F]/.test(s[i + 1] ?? '')) d += s[++i];
      out += byteChar(parseInt(d, 16));
    } else if ((e === 'u' || e === 'U') && /[0-9a-fA-F]/.test(s[i + 1] ?? '')) {
      let d = '';
      while (d.length < (e === 'u' ? 4 : 8) && /[0-9a-fA-F]/.test(s[i + 1] ?? '')) d += s[++i];
      out += String.fromCodePoint(parseInt(d, 16));
    } else out += `\\${e}`;
  }
  return { text: decodeBytes(out), stop: false };
}

// eslint-disable-next-line require-yield -- a builtin is a generator even when it never blocks
const trueB: Builtin = function* () {
  return 0;
};
// eslint-disable-next-line require-yield -- as above
const falseB: Builtin = function* () {
  return 1;
};

/** Lexical canonicalization of a logical path: `.` and `..` removed, no symlinks resolved. */
function canonical(path: string): string {
  const out: string[] = [];
  for (const c of path.split('/')) {
    if (c === '' || c === '.') continue;
    if (c === '..') out.pop();
    else out.push(c);
  }
  return `/${out.join('/')}`;
}

const cd: Builtin = function* (sh, argv) {
  const o = yield* options(sh, argv, 'LPe@', 'cd [-L|[-P [-e]] [-@]] [dir]');
  if (typeof o === 'number') return o;
  if (o.opts.has('@')) return yield* sh.notice('the option cd -@', 'flag', argv.join(' '));
  if (o.args.length > 1) {
    yield* sh.diag('cd: too many arguments');
    return 1;
  }
  const { state, p } = sh;
  let dir = o.args[0];
  let print = false;
  if (dir === undefined) {
    dir = getVar(state, 'HOME');
    if (dir === undefined) {
      yield* sh.diag('cd: HOME not set');
      return 1;
    }
  } else if (dir === '-') {
    dir = getVar(state, 'OLDPWD');
    if (dir === undefined) {
      yield* sh.diag('cd: OLDPWD not set');
      return 1;
    }
    print = true;
  }
  if (dir === '') return 0;
  const physical = o.opts.has('P');
  const pwd = getVar(state, 'PWD') ?? p.cwd;
  let target = dir.startsWith('/') ? dir : `${pwd}/${dir}`;
  if (!physical) target = canonical(target);
  const fs = p.fs();
  try {
    const st = fs.stat(target);
    if (st.type !== 'dir') {
      yield* sh.diag(`cd: ${dir}: ${strerror('ENOTDIR')}`);
      return 1;
    }
    fs.access(target, 1);
    if (physical) target = fs.realpath(target);
  } catch (e) {
    if (isFsError(e)) {
      yield* sh.diag(`cd: ${dir}: ${strerror(e.code)}`);
      return 1;
    }
    throw e;
  }
  sh.chdir(target);
  if (print) yield* sh.out(`${target}\n`);
  return 0;
};

const pwd: Builtin = function* (sh, argv) {
  const o = yield* options(sh, argv, 'LP', 'pwd [-LP]');
  if (typeof o === 'number') return o;
  const logical = getVar(sh.state, 'PWD') ?? sh.p.cwd;
  yield* sh.out(`${o.opts.has('P') ? sh.p.fs().realpath(logical) : logical}\n`);
  return 0;
};

const exit: Builtin = function* (sh, argv) {
  const { state } = sh;
  if (state.interactive && !sh.subshell) yield* sh.err(state.login ? 'logout\n' : 'exit\n');
  if (argv.length > 2) {
    // bash 5.2.21 abandons the rest of the command line and keeps $? (captured 2026-11-16).
    yield* sh.diag('exit: too many arguments');
    if (state.interactive) throw new AbortLine(state.status);
    return 1;
  }
  const a = argv[1];
  if (a === undefined) throw new ShellExit(state.status);
  if (!/^[-+]?[0-9]+$/.test(a.trim())) {
    yield* sh.diag(`exit: ${a}: numeric argument required`);
    throw new ShellExit(2);
  }
  throw new ShellExit(Number(a.trim()) & 0xff);
};

/** `declare -x NAME="value"` with ", \, $ and ` escaped, as `export -p` prints (bash(1) export). */
function declareLine(name: string, value: string | undefined): string {
  if (value === undefined) return `declare -x ${name}\n`;
  return `declare -x ${name}="${value.replace(/([\\"$`])/g, '\\$1')}"\n`;
}

const exportB: Builtin = function* (sh, argv) {
  const o = yield* options(sh, argv, 'fnp', 'export [-fn] [name[=value] ...] or export -p');
  if (typeof o === 'number') return o;
  if (o.opts.has('f')) return yield* sh.notice('the option export -f', 'flag', argv.join(' '));
  const { state } = sh;
  if (o.args.length === 0) {
    for (const n of Object.keys(state.vars).sort()) {
      const v = state.vars[n];
      if (v?.exported) yield* sh.out(declareLine(n, v.value));
    }
    return 0;
  }
  let status = 0;
  for (const a of o.args) {
    const eq = a.indexOf('=');
    const name = eq < 0 ? a : a.slice(0, eq);
    if (!isName(name)) {
      yield* sh.diag(`export: \`${a}': not a valid identifier`);
      status = 1;
      continue;
    }
    if (o.opts.has('n')) {
      const v = state.vars[name];
      if (v) delete v.exported;
      continue;
    }
    if (eq >= 0) setVar(state, name, a.slice(eq + 1), { export: true });
    else exportVar(state, name);
  }
  return status;
};

const unset: Builtin = function* (sh, argv) {
  const o = yield* options(sh, argv, 'fvn', 'unset [-f] [-v] [-n] [name ...]');
  if (typeof o === 'number') return o;
  if (o.opts.has('f') || o.opts.has('n')) return yield* sh.notice(`the option unset -${o.opts.has('f') ? 'f' : 'n'}`, 'flag', argv.join(' '));
  for (const name of o.args) {
    // bash 5.2.21 ignores a name that is not an identifier, with status 0 (`unset 1a`, `unset a=b`,
    // captured 2026-11-16).
    if (isName(name)) unsetVar(sh.state, name);
  }
  return 0;
};

const quoteAlias = (v: string): string => `'${v.replace(/'/g, "'\\''")}'`;

const alias: Builtin = function* (sh, argv) {
  const o = yield* options(sh, argv, 'p', 'alias [-p] [name[=value] ... ]');
  if (typeof o === 'number') return o;
  const { state } = sh;
  if (o.args.length === 0 || o.opts.has('p')) {
    for (const n of Object.keys(state.aliases).sort()) yield* sh.out(`alias ${n}=${quoteAlias(state.aliases[n] as string)}\n`);
    if (o.args.length === 0) return 0;
  }
  let status = 0;
  for (const a of o.args) {
    const eq = a.indexOf('=');
    if (eq < 0) {
      const v = state.aliases[a];
      if (v === undefined) {
        yield* sh.diag(`alias: ${a}: not found`);
        status = 1;
      } else yield* sh.out(`alias ${a}=${quoteAlias(v)}\n`);
      continue;
    }
    const name = a.slice(0, eq);
    // bash(1) ALIASES: the name may not contain /, $, `, =, any metacharacter or quoting character.
    if (name === '' || /[\s/$`='"\\|&;()<>]/.test(name)) {
      yield* sh.diag(`alias: \`${name}': invalid alias name`);
      status = 1;
      continue;
    }
    state.aliases[name] = a.slice(eq + 1);
  }
  return status;
};

const unalias: Builtin = function* (sh, argv) {
  const o = yield* options(sh, argv, 'a', 'unalias [-a] name [name ...]');
  if (typeof o === 'number') return o;
  if (o.opts.has('a')) {
    for (const n of Object.keys(sh.state.aliases)) delete sh.state.aliases[n];
    return 0;
  }
  if (o.args.length === 0) {
    yield* sh.err('unalias: usage: unalias [-a] name [name ...]\n');
    return 2;
  }
  let status = 0;
  for (const n of o.args) {
    if (sh.state.aliases[n] === undefined) {
      yield* sh.diag(`unalias: ${n}: not found`);
      status = 1;
    } else delete sh.state.aliases[n];
  }
  return status;
};

/** Every executable named `name` in PATH, in order (for `type -a`). */
function allInPath(sh: Shell, name: string): string[] {
  const out: string[] = [];
  const fs = sh.p.fs();
  for (const dir of (getVar(sh.state, 'PATH') ?? '').split(':')) {
    const path = `${dir === '' ? '.' : dir}/${name}`;
    try {
      if (fs.stat(path).type === 'dir') continue;
      fs.access(path, 1);
      out.push(path);
    } catch {
      // not here
    }
  }
  return out;
}

const type: Builtin = function* (sh, argv) {
  const o = yield* options(sh, argv, 'afptP', 'type [-afptP] name [name ...]');
  if (typeof o === 'number') return o;
  const { state } = sh;
  const all = o.opts.has('a');
  const terse = o.opts.has('t');
  const pathOnly = o.opts.has('p') || o.opts.has('P');
  const forcePath = o.opts.has('P');
  let status = 0;
  for (const name of o.args) {
    let found = false;
    if (!forcePath) {
      const a = state.aliases[name];
      if (a !== undefined) {
        found = true;
        if (!pathOnly) yield* sh.out(terse ? 'alias\n' : `${name} is aliased to \`${a}'\n`);
      }
      if ((!found || all) && BASH_KEYWORDS.includes(name)) {
        found = true;
        if (!pathOnly) yield* sh.out(terse ? 'keyword\n' : `${name} is a shell keyword\n`);
      }
      if ((!found || all) && BASH_BUILTINS.includes(name)) {
        found = true;
        if (!pathOnly) yield* sh.out(terse ? 'builtin\n' : `${name} is a shell builtin\n`);
        if (!all && o.opts.has('p')) continue;
      }
      if (found && !all) continue;
    }
    const hashed = state.hash[name];
    if (hashed && !all && !name.includes('/')) {
      yield* sh.out(terse ? 'file\n' : pathOnly ? `${hashed.path}\n` : `${name} is hashed (${hashed.path})\n`);
      continue;
    }
    const paths = name.includes('/') ? (isExecutable(sh, name) ? [name] : []) : allInPath(sh, name);
    for (const path of all ? paths : paths.slice(0, 1)) {
      found = true;
      yield* sh.out(terse ? 'file\n' : pathOnly ? `${path}\n` : `${name} is ${path}\n`);
    }
    if (!found) {
      status = 1;
      if (!terse && !pathOnly) yield* sh.diag(`type: ${name}: not found`);
    }
  }
  return status;
};

function isExecutable(sh: Shell, path: string): boolean {
  try {
    const fs = sh.p.fs();
    if (fs.stat(path).type === 'dir') return false;
    fs.access(path, 1);
    return true;
  } catch {
    return false;
  }
}

const history: Builtin = function* (sh, argv) {
  const o = yield* options(sh, argv, 'cdanrwps', 'history [-c] [-d offset] [n] or history -anrw [filename] or history -ps arg [arg...]');
  if (typeof o === 'number') return o;
  const { state } = sh;
  if (o.opts.has('c')) {
    state.history = [];
    return 0;
  }
  for (const f of ['d', 'a', 'n', 'r', 'w', 'p', 's']) if (o.opts.has(f)) return yield* sh.notice(`the option history -${f}`, 'flag', argv.join(' '));
  let entries = state.history.map((h, i) => [i + 1, h] as const);
  if (o.args[0] !== undefined) {
    if (!/^[0-9]+$/.test(o.args[0])) {
      yield* sh.diag(`history: ${o.args[0]}: numeric argument required`);
      return 1;
    }
    entries = entries.slice(Math.max(0, entries.length - Number(o.args[0])));
  }
  for (const [n, h] of entries) yield* sh.out(`${String(n).padStart(5)}  ${h}\n`);
  return 0;
};

/** source FILE [ARGS] and `.`: runs a file in the current shell; a name without a slash is looked up in PATH first. */
const source: Builtin = function* (sh, argv) {
  const name = argv[0] as string;
  const args = argv[1] === '--' ? argv.slice(2) : argv.slice(1);
  const file = args[0];
  if (file === undefined) {
    yield* sh.diag(`${name}: filename argument required`);
    yield* sh.err(`${name}: usage: ${name} filename [arguments]\n`);
    return 2;
  }
  const fs = sh.p.fs();
  let path = file;
  if (!file.includes('/')) {
    for (const dir of (getVar(sh.state, 'PATH') ?? '').split(':')) {
      const cand = `${dir === '' ? '.' : dir}/${file}`;
      try {
        if (fs.stat(cand).type === 'file') {
          path = cand;
          break;
        }
      } catch {
        // keep looking; fall back to the current directory
      }
    }
  }
  let text: string;
  try {
    if (fs.stat(path).type === 'dir') {
      yield* sh.diag(`${name}: ${file}: is a directory`);
      return 1;
    }
    text = fs.readFile(path);
  } catch (e) {
    if (isFsError(e)) {
      yield* sh.diag(`${file}: ${strerror(e.code)}`);
      return 1;
    }
    throw e;
  }
  const { state } = sh;
  const savedPositional = state.positional;
  if (args.length > 1) state.positional = args.slice(1);
  try {
    return yield* sh.runSource(text, { line: 1 });
  } finally {
    if (args.length > 1) state.positional = savedPositional;
  }
};

export const CORE_BUILTINS: Record<string, Builtin> = {
  echo,
  true: trueB,
  false: falseB,
  ':': trueB,
  cd,
  pwd,
  exit,
  export: exportB,
  unset,
  alias,
  unalias,
  type,
  history,
  source,
  '.': source,
};

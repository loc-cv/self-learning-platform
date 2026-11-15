// test and [ — check file types and compare values. GNU coreutils 9.4 (not the bash builtins,
// which run unless the binary is named: `env test`, `/usr/bin/[`, `find -exec test`).
//   docs: [ --help and test(1) of coreutils 9.4
//   upstream: coreutils src/test.c main, posixtest, two_arguments, three_arguments, expr, or,
//             and, term, binary_operator, unary_operator, find_int, beyond
//   reference: coreutils 9.4 test and [, captured 2026-11-16 (packages/host/transcripts/coreutils/test.t)
// Differs from bash's: no < > -v -o -R operators, integers of any size (with surrounding blanks
// allowed), -l STRING as an integer, messages "missing argument after ‘x’" and "extra argument".
// Status 0 true, 1 false, 2 error.

import type { ProcApi, ProgramSpec, Syscall } from '../../proc/program.ts';
import { isFsError } from '../../vfs/errno.ts';
import type { Stat } from '../../vfs/types.ts';
import { quote } from '../lib/quote.ts';
import { utf8Length } from '../../utf8.ts';

/** `[ --help` (it names test whatever the program name). reference: coreutils 9.4, captured 2026-11-16 */
const HELP = "Usage: test EXPRESSION\n  or:  test\n  or:  [ EXPRESSION ]\n  or:  [ ]\n  or:  [ OPTION\nExit with the status determined by EXPRESSION.\n\n      --help        display this help and exit\n      --version     output version information and exit\n\nAn omitted EXPRESSION defaults to false.  Otherwise,\nEXPRESSION is true or false and sets exit status.  It is one of:\n\n  ( EXPRESSION )               EXPRESSION is true\n  ! EXPRESSION                 EXPRESSION is false\n  EXPRESSION1 -a EXPRESSION2   both EXPRESSION1 and EXPRESSION2 are true\n  EXPRESSION1 -o EXPRESSION2   either EXPRESSION1 or EXPRESSION2 is true\n\n  -n STRING            the length of STRING is nonzero\n  STRING               equivalent to -n STRING\n  -z STRING            the length of STRING is zero\n  STRING1 = STRING2    the strings are equal\n  STRING1 != STRING2   the strings are not equal\n\n  INTEGER1 -eq INTEGER2   INTEGER1 is equal to INTEGER2\n  INTEGER1 -ge INTEGER2   INTEGER1 is greater than or equal to INTEGER2\n  INTEGER1 -gt INTEGER2   INTEGER1 is greater than INTEGER2\n  INTEGER1 -le INTEGER2   INTEGER1 is less than or equal to INTEGER2\n  INTEGER1 -lt INTEGER2   INTEGER1 is less than INTEGER2\n  INTEGER1 -ne INTEGER2   INTEGER1 is not equal to INTEGER2\n\n  FILE1 -ef FILE2   FILE1 and FILE2 have the same device and inode numbers\n  FILE1 -nt FILE2   FILE1 is newer (modification date) than FILE2\n  FILE1 -ot FILE2   FILE1 is older than FILE2\n\n  -b FILE     FILE exists and is block special\n  -c FILE     FILE exists and is character special\n  -d FILE     FILE exists and is a directory\n  -e FILE     FILE exists\n  -f FILE     FILE exists and is a regular file\n  -g FILE     FILE exists and is set-group-ID\n  -G FILE     FILE exists and is owned by the effective group ID\n  -h FILE     FILE exists and is a symbolic link (same as -L)\n  -k FILE     FILE exists and has its sticky bit set\n  -L FILE     FILE exists and is a symbolic link (same as -h)\n  -N FILE     FILE exists and has been modified since it was last read\n  -O FILE     FILE exists and is owned by the effective user ID\n  -p FILE     FILE exists and is a named pipe\n  -r FILE     FILE exists and the user has read access\n  -s FILE     FILE exists and has a size greater than zero\n  -S FILE     FILE exists and is a socket\n  -t FD       file descriptor FD is opened on a terminal\n  -u FILE     FILE exists and its set-user-ID bit is set\n  -w FILE     FILE exists and the user has write access\n  -x FILE     FILE exists and the user has execute (or search) access\n\nExcept for -h and -L, all FILE-related tests dereference symbolic links.\nBeware that parentheses need to be escaped (e.g., by backslashes) for shells.\nINTEGER may also be -l STRING, which evaluates to the length of STRING.\n\nNOTE: Binary -a and -o are inherently ambiguous.  Use 'test EXPR1 && test\nEXPR2' or 'test EXPR1 || test EXPR2' instead.\n\nNOTE: [ honors the --help and --version options, but test does not.\ntest treats each of those as it treats any other nonempty STRING.\n\nNOTE: your shell may have its own version of test and/or [, which usually supersedes\nthe version described here.  Please refer to your shell's documentation\nfor details about the options it supports.\n\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nReport any translation bugs to <https://translationproject.org/team/>\nFull documentation <https://www.gnu.org/software/coreutils/test>\nor available locally via: info '(coreutils) test invocation'\n";

class SyntaxError2 extends Error {}
class Unsupported extends Error {}

const BINOPS = new Set(['=', '!=', '==', '-nt', '-ot', '-ef', '-eq', '-ne', '-lt', '-le', '-gt', '-ge']);

/** upstream find_int: blanks, an optional sign, digits, blanks; the digits with any '-' sign. */
function findInt(s: string): bigint {
  const m = /^[ \t]*(?:\+|(-))?([0-9]+)[ \t]*$/.exec(s);
  if (!m) throw new SyntaxError2(`invalid integer ${quote(s)}`);
  return BigInt(`${m[1] ?? ''}${m[2] as string}`);
}

/** The test expression evaluator over `argv` (without the program name and the closing ]). */
function evaluate(p: ProcApi, argv: readonly string[]): boolean {
  const argc = argv.length;
  let pos = 0;
  const arg = (i: number): string => argv[i] as string;
  const beyond = (): never => {
    throw new SyntaxError2(`missing argument after ${quote(arg(argc - 1))}`);
  };
  const advance = (f: boolean): void => {
    pos++;
    if (f && pos >= argc) beyond();
  };
  const unaryAdvance = (): void => {
    advance(true);
    pos++;
  };
  const stat = (path: string, follow = true): Stat | undefined => {
    try {
      return follow ? p.fs().stat(path) : p.fs().lstat(path);
    } catch (e) {
      if (isFsError(e)) return undefined;
      throw e;
    }
  };
  const access = (path: string, mode: number): boolean => {
    try {
      p.fs().access(path, mode);
      return true;
    } catch (e) {
      if (isFsError(e)) return false;
      throw e;
    }
  };

  const binaryOperator = (lIsL: boolean): boolean => {
    if (lIsL) advance(false);
    const op = pos + 1;
    let rIsL = false;
    if (op + 2 < argc && arg(op + 1) === '-l') {
      rIsL = true;
      advance(false);
    }
    const o = arg(op);
    if (o.startsWith('-')) {
      if (/^-(?:lt|le|gt|ge|eq|ne)$/.test(o)) {
        const l = lIsL ? BigInt(utf8Length(arg(op - 1))) : findInt(arg(op - 1));
        const r = rIsL ? BigInt(utf8Length(arg(op + 2))) : findInt(arg(op + 1));
        pos += 3;
        switch (o) {
          case '-lt':
            return l < r;
          case '-le':
            return l <= r;
          case '-gt':
            return l > r;
          case '-ge':
            return l >= r;
          case '-eq':
            return l === r;
          default:
            return l !== r;
        }
      }
      if (o === '-nt' || o === '-ot' || o === '-ef') {
        pos += 3;
        if (lIsL || rIsL) throw new SyntaxError2(`${o} does not accept -l`);
        const a = stat(arg(op - 1));
        const b = stat(arg(op + 1));
        if (o === '-nt') return a !== undefined && (b === undefined || a.mtime > b.mtime);
        if (o === '-ot') return b !== undefined && (a === undefined || a.mtime < b.mtime);
        return a !== undefined && b !== undefined && a.ino === b.ino;
      }
    }
    // = == !=: the strings on either side of the operator.
    const value = o === '!=' ? arg(pos) !== arg(pos + 2) : arg(pos) === arg(pos + 2);
    pos += 3;
    return value;
  };

  const unaryOperator = (): boolean => {
    const op = arg(pos);
    const t = op[1] as string;
    if (!'erwxNOGfdsScbpLhugktnz'.includes(t) || op.length !== 2) throw new SyntaxError2(`${quote(op)}: unary operator expected`);
    unaryAdvance();
    const a = arg(pos - 1);
    switch (t) {
      case 'e':
        return stat(a) !== undefined;
      case 'r':
        return access(a, 4);
      case 'w':
        return access(a, 2);
      case 'x':
        return access(a, 1);
      case 'N':
        // Files have no access time in the simulator.
        throw new Unsupported('the test operator -N');
      case 'O':
        return stat(a)?.uid === p.cred.uid;
      case 'G':
        return stat(a)?.gid === p.cred.gid;
      case 'f':
        return stat(a)?.type === 'file';
      case 'd':
        return stat(a)?.type === 'dir';
      case 's':
        return (stat(a)?.size ?? 0) > 0;
      case 'c':
        return stat(a)?.type === 'char';
      // No sockets, block devices or FIFOs exist in the simulated file system.
      case 'S':
      case 'b':
      case 'p':
        return false;
      case 'L':
      case 'h':
        return stat(a, false)?.type === 'symlink';
      case 'u':
        return ((stat(a)?.mode ?? 0) & 0o4000) !== 0;
      case 'g':
        return ((stat(a)?.mode ?? 0) & 0o2000) !== 0;
      case 'k':
        return ((stat(a)?.mode ?? 0) & 0o1000) !== 0;
      case 't': {
        const fd = findInt(a);
        return fd >= 0n && fd <= 2147483647n && p.isatty(Number(fd));
      }
      case 'n':
        return a !== '';
      default:
        return a === '';
    }
  };

  const term = (): boolean => {
    let negated = false;
    while (pos < argc && arg(pos) === '!') {
      advance(true);
      negated = !negated;
    }
    if (pos >= argc) beyond();
    let value: boolean;
    if (arg(pos) === '(') {
      advance(true);
      let nargs = 1;
      for (; pos + nargs < argc && arg(pos + nargs) !== ')'; nargs++) {
        if (nargs === 4) {
          nargs = argc - pos;
          break;
        }
      }
      value = posixtest(nargs);
      if (pos >= argc) throw new SyntaxError2(`${quote(')')} expected`);
      if (arg(pos) !== ')') throw new SyntaxError2(`${quote(')')} expected, found ${quote(arg(pos))}`);
      advance(false);
    } else if (argc - pos >= 4 && arg(pos) === '-l' && BINOPS.has(arg(pos + 2))) value = binaryOperator(true);
    else if (argc - pos >= 3 && BINOPS.has(arg(pos + 1))) value = binaryOperator(false);
    else if (arg(pos).startsWith('-') && arg(pos).length === 2) value = unaryOperator();
    else {
      value = arg(pos) !== '';
      advance(false);
    }
    return negated !== value;
  };
  const and = (): boolean => {
    let value = true;
    for (;;) {
      value = term() && value;
      if (!(pos < argc && arg(pos) === '-a')) return value;
      advance(false);
    }
  };
  const or = (): boolean => {
    let value = false;
    for (;;) {
      value = and() || value;
      if (!(pos < argc && arg(pos) === '-o')) return value;
      advance(false);
    }
  };
  const expr = (): boolean => {
    if (pos >= argc) beyond();
    return or();
  };
  const oneArgument = (): boolean => arg(pos++) !== '';
  const twoArguments = (): boolean => {
    if (arg(pos) === '!') {
      advance(false);
      return !oneArgument();
    }
    if (arg(pos).startsWith('-') && arg(pos).length === 2) return unaryOperator();
    return beyond();
  };
  const threeArguments = (): boolean => {
    if (BINOPS.has(arg(pos + 1))) return binaryOperator(false);
    if (arg(pos) === '!') {
      advance(true);
      const v = !twoArguments();
      pos = argc;
      return v;
    }
    if (arg(pos) === '(' && arg(pos + 2) === ')') {
      advance(false);
      const v = oneArgument();
      advance(false);
      return v;
    }
    if (arg(pos + 1) === '-a' || arg(pos + 1) === '-o') return expr();
    throw new SyntaxError2(`${quote(arg(pos + 1))}: binary operator expected`);
  };
  const posixtest = (nargs: number): boolean => {
    switch (nargs) {
      case 1:
        return oneArgument();
      case 2:
        return twoArguments();
      case 3:
        return threeArguments();
      case 4:
        if (arg(pos) === '!') {
          advance(true);
          return !threeArguments();
        }
        if (arg(pos) === '(' && arg(pos + 3) === ')') {
          advance(false);
          const v = twoArguments();
          advance(false);
          return v;
        }
        return expr();
      default:
        return expr();
    }
  };

  if (argc === 0) return false;
  const value = posixtest(argc);
  if (pos !== argc) throw new SyntaxError2(`extra argument ${quote(arg(pos))}`);
  return value;
}

function* main(p: ProcApi): Generator<Syscall, number, unknown> {
  const prog = p.argv[0] ?? p.name;
  let args = p.argv.slice(1);
  if (p.name === '[') {
    // --help and --version only in the [ form, and only as the sole argument.
    if (args.length === 1 && args[0] === '--help') {
      yield* p.write(1, HELP);
      return 0;
    }
    if (args.length === 1 && args[0] === '--version') return yield* p.unsupported({ kind: 'flag', what: 'the flag --version' });
    if (args[args.length - 1] !== ']') {
      yield* p.write(2, `${prog}: missing ${quote(']')}\n`);
      return 2;
    }
    args = args.slice(0, -1);
  }
  try {
    return evaluate(p, args) ? 0 : 1;
  } catch (e) {
    if (e instanceof SyntaxError2) {
      yield* p.write(2, `${prog}: ${e.message}\n`);
      return 2;
    }
    if (e instanceof Unsupported) return yield* p.unsupported({ kind: 'flag', what: e.message });
    throw e;
  }
}

export const testProgram: ProgramSpec = { name: 'test', main };
export const bracketProgram: ProgramSpec = { name: '[', main };

// test and [. docs: bash(1) 5.2 CONDITIONAL EXPRESSIONS and `test` (the POSIX rules by number of
// arguments, then -a and -o with precedence); test(1)
// reference: bash 5.2.21 results and errors, captured 2026-11-16 (packages/host/transcripts/shell/test.t)

import type { Builtin, Shell } from '../shell.ts';
import { getVar } from '../state.ts';
import type { Op } from '../../proc/program.ts';
import type { Stat } from '../../vfs/types.ts';

class TestError extends Error {}

const UNARY = new Set(['-a', '-b', '-c', '-d', '-e', '-f', '-g', '-h', '-k', '-L', '-n', '-N', '-O', '-G', '-p', '-r', '-s', '-S', '-t', '-u', '-v', '-w', '-x', '-z', '-o', '-R']);
const BINARY = new Set(['=', '==', '!=', '<', '>', '-eq', '-ne', '-lt', '-le', '-gt', '-ge', '-nt', '-ot', '-ef']);

function evaluate(sh: Shell, args: string[]): boolean {
  const fs = sh.p.fs();
  const stat = (path: string, follow = true): Stat | undefined => {
    try {
      return follow ? fs.stat(path) : fs.lstat(path);
    } catch {
      return undefined;
    }
  };
  const can = (path: string, mode: number): boolean => {
    try {
      fs.access(path, mode);
      return true;
    } catch {
      return false;
    }
  };
  const int = (s: string): bigint => {
    const t = s.trim();
    if (!/^[+-]?[0-9]+$/.test(t)) throw new TestError(`${s}: integer expression expected`);
    const v = BigInt(t);
    if (v > (1n << 63n) - 1n || v < -(1n << 63n)) throw new TestError(`${s}: integer expression expected`);
    return v;
  };

  const unary = (op: string, a: string): boolean => {
    switch (op) {
      case '-n':
        return a !== '';
      case '-z':
        return a === '';
      case '-e':
      case '-a':
        return stat(a) !== undefined;
      case '-f':
        return stat(a)?.type === 'file';
      case '-d':
        return stat(a)?.type === 'dir';
      case '-h':
      case '-L':
        return stat(a, false)?.type === 'symlink';
      case '-c':
        return stat(a)?.type === 'char';
      case '-b':
      case '-p':
      case '-S':
        return false;
      case '-s':
        return (stat(a)?.size ?? 0) > 0;
      case '-r':
        return stat(a) !== undefined && can(a, 4);
      case '-w':
        return stat(a) !== undefined && can(a, 2);
      case '-x':
        return stat(a) !== undefined && can(a, 1);
      case '-u':
        return ((stat(a)?.mode ?? 0) & 0o4000) !== 0;
      case '-g':
        return ((stat(a)?.mode ?? 0) & 0o2000) !== 0;
      case '-k':
        return ((stat(a)?.mode ?? 0) & 0o1000) !== 0;
      case '-O':
        return stat(a)?.uid === sh.p.cred.uid;
      case '-G':
        return stat(a)?.gid === sh.p.cred.gid;
      case '-t':
        return /^[0-9]+$/.test(a) && sh.p.isatty(Number(a));
      case '-v':
        return getVar(sh.state, a) !== undefined;
      // -N compares the modification time with the access time, which the VFS does not keep.
      case '-N':
      case '-o':
      case '-R':
        throw new UnsupportedTest(`the test operator ${op}`);
    }
    throw new TestError(`${op}: unary operator expected`);
  };

  const binary = (a: string, op: string, b: string): boolean => {
    switch (op) {
      case '=':
      case '==':
        return a === b;
      case '!=':
        return a !== b;
      case '<':
        return a < b;
      case '>':
        return a > b;
      case '-eq':
        return int(a) === int(b);
      case '-ne':
        return int(a) !== int(b);
      case '-lt':
        return int(a) < int(b);
      case '-le':
        return int(a) <= int(b);
      case '-gt':
        return int(a) > int(b);
      case '-ge':
        return int(a) >= int(b);
      case '-nt': {
        const x = stat(a);
        const y = stat(b);
        return x !== undefined && (y === undefined || x.mtime > y.mtime);
      }
      case '-ot': {
        const x = stat(a);
        const y = stat(b);
        return y !== undefined && (x === undefined || x.mtime < y.mtime);
      }
      case '-ef': {
        const x = stat(a);
        const y = stat(b);
        return x !== undefined && y !== undefined && x.ino === y.ino;
      }
    }
    throw new TestError(`${op}: binary operator expected`);
  };

  // The full grammar, for more than four arguments: expr: and (-o and)*; and: not (-a not)*;
  // not: ! not | primary; primary: ( expr ) | unary arg | arg binop arg | arg.
  let i = 0;
  const peek = (): string | undefined => args[i];
  const orExpr = (): boolean => {
    let v = andExpr();
    while (peek() === '-o') {
      i++;
      const r = andExpr();
      v = v || r;
    }
    return v;
  };
  const andExpr = (): boolean => {
    let v = notExpr();
    while (peek() === '-a') {
      i++;
      const r = notExpr();
      v = v && r;
    }
    return v;
  };
  const notExpr = (): boolean => {
    if (peek() === '!') {
      i++;
      return !notExpr();
    }
    return primary();
  };
  const primary = (): boolean => {
    const a = peek();
    if (a === undefined) throw new TestError('argument expected');
    if (a === '(') {
      i++;
      const v = orExpr();
      if (peek() !== ')') throw new TestError("`)' expected");
      i++;
      return v;
    }
    if (args[i + 1] !== undefined && BINARY.has(args[i + 1] as string) && args[i + 2] !== undefined) {
      i += 3;
      return binary(a, args[i - 2] as string, args[i - 1] as string);
    }
    if (UNARY.has(a) && args[i + 1] !== undefined) {
      i += 2;
      return unary(a, args[i - 1] as string);
    }
    i++;
    return a !== '';
  };

  const byCount = (xs: string[]): boolean => {
    switch (xs.length) {
      case 0:
        return false;
      case 1:
        return xs[0] !== '';
      case 2:
        if (xs[0] === '!') return xs[1] === '';
        if (UNARY.has(xs[0] as string)) return unary(xs[0] as string, xs[1] as string);
        throw new TestError(`${xs[0]}: unary operator expected`);
      case 3:
        if (BINARY.has(xs[1] as string)) return binary(xs[0] as string, xs[1] as string, xs[2] as string);
        if (xs[1] === '-a' || xs[1] === '-o') return xs[1] === '-a' ? xs[0] !== '' && xs[2] !== '' : xs[0] !== '' || xs[2] !== '';
        if (xs[0] === '!') return !byCount(xs.slice(1));
        if (xs[0] === '(' && xs[2] === ')') return xs[1] !== '';
        throw new TestError(`${xs[1]}: binary operator expected`);
      case 4:
        if (xs[0] === '!') return !byCount(xs.slice(1));
        if (xs[0] === '(' && xs[3] === ')') return byCount(xs.slice(1, 3));
    }
    const v = orExpr();
    if (i < args.length) throw new TestError(`${args[i]}: binary operator expected`);
    return v;
  };
  return byCount(args);
}

class UnsupportedTest extends Error {}

export const test: Builtin = function* (sh: Shell, argv: string[]): Op<number> {
  const name = argv[0] as string;
  let args = argv.slice(1);
  if (name === '[') {
    if (args[args.length - 1] !== ']') {
      yield* sh.diag("[: missing `]'");
      return 2;
    }
    args = args.slice(0, -1);
  }
  try {
    return evaluate(sh, args) ? 0 : 1;
  } catch (e) {
    if (e instanceof TestError) {
      yield* sh.diag(`${name}: ${e.message}`);
      return 2;
    }
    if (e instanceof UnsupportedTest) return yield* sh.notice(e.message, 'flag', argv.join(' '));
    throw e;
  }
};

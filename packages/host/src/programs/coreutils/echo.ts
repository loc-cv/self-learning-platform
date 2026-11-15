// echo — display a line of text. GNU coreutils 9.4 (not the bash builtin, which runs unless the
// binary is named: `env echo`, `/bin/echo`, `xargs echo`).
//   docs: echo --help and echo(1) of coreutils 9.4
//   upstream: coreutils src/echo.c main
//   reference: coreutils 9.4 echo, captured 2026-11-16 (packages/host/transcripts/coreutils/echo.t)
// Options end at the first argument that is not made of -n, -e and -E only; --help and --version
// count only as the sole argument. With POSIXLY_CORRECT, escapes are always interpreted and only
// a leading -n starts option processing.

import type { ProcApi, ProgramSpec, Syscall } from '../../proc/program.ts';
import { byteChar, decodeBytes } from '../../text/bytes.ts';

/** `echo --help`; NUL stands for argv[0]. reference: coreutils 9.4, captured 2026-11-16 */
const HELP = "Usage: \u0000 [SHORT-OPTION]... [STRING]...\n  or:  \u0000 LONG-OPTION\nEcho the STRING(s) to standard output.\n\n  -n             do not output the trailing newline\n  -e             enable interpretation of backslash escapes\n  -E             disable interpretation of backslash escapes (default)\n      --help        display this help and exit\n      --version     output version information and exit\n\nIf -e is in effect, the following sequences are recognized:\n\n  \\\\      backslash\n  \\a      alert (BEL)\n  \\b      backspace\n  \\c      produce no further output\n  \\e      escape\n  \\f      form feed\n  \\n      new line\n  \\r      carriage return\n  \\t      horizontal tab\n  \\v      vertical tab\n  \\0NNN   byte with octal value NNN (1 to 3 digits)\n  \\xHH    byte with hexadecimal value HH (1 to 2 digits)\n\nNOTE: your shell may have its own version of echo, which usually supersedes\nthe version described here.  Please refer to your shell's documentation\nfor details about the options it supports.\n\nNOTE: printf(1) is a preferred alternative,\nwhich does not have issues outputting option-like strings.\n\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nReport any translation bugs to <https://translationproject.org/team/>\nFull documentation <https://www.gnu.org/software/coreutils/echo>\nor available locally via: info '(coreutils) echo invocation'\n";

const isOct = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '7';
const isHex = (c: string | undefined): boolean => c !== undefined && /^[0-9a-fA-F]$/.test(c);

/**
 * The escapes of `echo -e` as coreutils 9.4 interprets them: \0NNN and \NNN octal (the value
 * wraps to a byte), \xH[H], \c ends all output. Anything else after a backslash is printed as
 * it is. reference: captured 2026-11-16 (`\101`, `\0777`; `\u00e9` and `\U0001F600` print literally).
 */
export function coreutilsEchoEscapes(s: string): { text: string; stop: boolean } {
  const simple: Record<string, string> = { '\\': '\\', a: '\x07', b: '\b', e: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (c !== '\\' || i + 1 >= s.length) {
      out += c;
      continue;
    }
    const e = s[i + 1] as string;
    if (e === 'c') return { text: decodeBytes(out), stop: true };
    if (e in simple) {
      out += simple[e];
      i++;
      continue;
    }
    if (isOct(e)) {
      let j = i + 1;
      let v = 0;
      // \0 takes up to three more digits; \1–\7 are the first of up to three.
      if (e === '0') {
        j++;
        if (isOct(s[j])) v = Number(s[j++]);
      } else v = Number(s[j++]);
      for (let k = 0; k < 2 && isOct(s[j]); k++) v = v * 8 + Number(s[j++]);
      out += byteChar(v & 0xff);
      i = j - 1;
      continue;
    }
    if (e === 'x' && isHex(s[i + 2])) {
      let j = i + 2;
      let v = parseInt(s[j++] as string, 16);
      if (isHex(s[j])) v = v * 16 + parseInt(s[j++] as string, 16);
      out += byteChar(v);
      i = j - 1;
      continue;
    }
    out += c;
  }
  return { text: decodeBytes(out), stop: false };
}

function* main(p: ProcApi): Generator<Syscall, number, unknown> {
  const argv = p.argv;
  const posix = p.env['POSIXLY_CORRECT'] !== undefined;
  if (argv.length === 2 && !posix) {
    if (argv[1] === '--help') {
      yield* p.write(1, HELP.split('\u0000').join(argv[0] ?? p.name));
      return 0;
    }
    if (argv[1] === '--version') return yield* p.unsupported({ kind: 'flag', what: 'the flag --version' });
  }
  let newline = true;
  let escapes = false;
  let i = 1;
  if (!posix || argv[1] === '-n') {
    for (; i < argv.length; i++) {
      const a = argv[i] as string;
      if (!/^-[neE]+$/.test(a)) break;
      for (const ch of a.slice(1)) {
        if (ch === 'n') newline = false;
        else if (ch === 'e') escapes = true;
        else if (ch === 'E') escapes = false;
      }
    }
  }
  let out = argv.slice(i).join(' ');
  // With POSIXLY_CORRECT escapes are interpreted even after -E (captured 2026-11-16).
  if (escapes || posix) {
    const r = coreutilsEchoEscapes(out);
    out = r.text;
    if (r.stop) newline = false;
  }
  yield* p.write(1, newline ? `${out}\n` : out);
  return 0;
}

export const echoProgram: ProgramSpec = { name: 'echo', main };

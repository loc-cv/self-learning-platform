// base64 — encode or decode data in base64. GNU coreutils 9.4.
//   docs: base64 --help and base64(1) of coreutils 9.4
//   upstream: coreutils 9.4 src/basenc.c (main, do_encode, wrap_write, do_decode), gnulib
//             lib/base64.c (base64_decode_ctx, decode_4, get_4)
//   reference: coreutils 9.4 base64, captured 2026-11-16 (packages/host/transcripts/coreutils/base64.t)
// The data are the UTF-8 bytes of the text. Decoded bytes that are not valid UTF-8 become U+FFFD
// (docs/FIDELITY.md DIV-002): `base64 -d` of binary data cannot be reproduced.

import type { ProcApi, ProgramSpec, Syscall } from '../../proc/program.ts';
import { isFsError, strerror } from '../../vfs/errno.ts';
import { utf8Decode, utf8Encode } from '../../text/utf8.ts';
import type { OptionSpec } from '../lib/getopt.ts';
import { openInput, parseArgs, readAll, usageError, warn } from '../lib/io.ts';
import { quote, quotef } from '../lib/quote.ts';

/** `base64 --help`. reference: coreutils 9.4, captured 2026-11-16 */
const HELP = "Usage: base64 [OPTION]... [FILE]\nBase64 encode or decode FILE, or standard input, to standard output.\n\nWith no FILE, or when FILE is -, read standard input.\n\nMandatory arguments to long options are mandatory for short options too.\n  -d, --decode          decode data\n  -i, --ignore-garbage  when decoding, ignore non-alphabet characters\n  -w, --wrap=COLS       wrap encoded lines after COLS character (default 76).\n                          Use 0 to disable line wrapping\n      --help        display this help and exit\n      --version     output version information and exit\n\nThe data are encoded as described for the base64 alphabet in RFC 4648.\nWhen decoding, the input may contain newlines in addition to the bytes of\nthe formal base64 alphabet.  Use --ignore-garbage to attempt to recover\nfrom any other non-alphabet bytes in the encoded stream.\n\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nReport any translation bugs to <https://translationproject.org/team/>\nFull documentation <https://www.gnu.org/software/coreutils/base64>\nor available locally via: info '(coreutils) base64 invocation'\n";

const OPTIONS: OptionSpec[] = [
  { short: 'd', long: 'decode' },
  { short: 'w', long: 'wrap', arg: 'required' },
  { short: 'i', long: 'ignore-garbage' },
  { long: 'help' },
  { long: 'version' },
];

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const VALUE: Record<number, number> = Object.fromEntries([...ALPHABET].map((c, i) => [c.charCodeAt(0), i]));
const EQ = 0x3d;
const NL = 0x0a;
const isBase64 = (c: number | undefined): c is number => c !== undefined && VALUE[c] !== undefined;
const val = (c: number): number => VALUE[c] as number;

/** basenc.c: input is read in blocks of BASE_LENGTH (DEC_BLOCKSIZE) = 4096 bytes when decoding. */
const DEC_BLOCK = 4096;
/** The default wrap column. */
const WRAP = 76;

export function encode(bytes: readonly number[]): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    s += ALPHABET[b0 >> 2];
    s += ALPHABET[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    s += b1 === undefined ? '=' : ALPHABET[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    s += b2 === undefined ? '=' : ALPHABET[b2 & 63];
  }
  return s;
}

/** upstream: basenc.c wrap_write and the final newline of do_encode. */
export function wrap(text: string, column: number): string {
  if (column === 0 || text === '') return text;
  let out = '';
  for (let i = 0; i < text.length; i += column) out += `${text.slice(i, i + column)}\n`;
  return out;
}

/** upstream: gnulib base64.c decode_4 — writes what it could decode even when it fails. */
function decode4(input: readonly number[], at: number, inlen: number, out: number[]): boolean {
  if (inlen < 2) return false;
  const c0 = input[at];
  const c1 = input[at + 1];
  if (!isBase64(c0) || !isBase64(c1)) return false;
  out.push(((val(c0) << 2) | (val(c1) >> 4)) & 0xff);
  if (inlen === 2) return false;
  const c2 = input[at + 2] as number;
  if (c2 === EQ) {
    if (inlen !== 4) return false;
    if (input[at + 3] !== EQ) return false;
  } else {
    if (!isBase64(c2)) return false;
    out.push(((val(c1) << 4) & 0xf0) | (val(c2) >> 2));
    if (inlen === 3) return false;
    const c3 = input[at + 3] as number;
    if (c3 === EQ) {
      if (inlen !== 4) return false;
    } else {
      if (!isBase64(c3)) return false;
      out.push(((val(c2) << 6) & 0xc0) | val(c3));
    }
  }
  return true;
}

interface DecodeCtx {
  i: number;
  buf: number[];
}

/** upstream: gnulib base64.c base64_decode_ctx (with a context: newlines are skipped). */
function decodeCtx(ctx: DecodeCtx, input: readonly number[], out: number[]): boolean {
  let pos = 0;
  let inlen = input.length;
  const flush = inlen === 0;
  const ctxI = ctx.i;
  for (;;) {
    let outSave = out.length;
    if (ctxI === 0 && !flush) {
      for (;;) {
        outSave = out.length;
        if (!decode4(input, pos, inlen, out)) break;
        pos += 4;
        inlen -= 4;
      }
    }
    if (inlen === 0 && !flush) break;
    if (inlen > 0 && input[pos] === NL) {
      pos++;
      inlen--;
      continue;
    }
    out.length = outSave;
    const inEnd = pos + inlen;
    // upstream: base64.c get_4
    let src: readonly number[] = ctx.buf;
    let at = 0;
    if (ctx.i === 4) ctx.i = 0;
    if (ctx.i === 0 && inEnd - pos >= 4 && !input.slice(pos, pos + 4).includes(NL)) {
      src = input;
      at = pos;
      pos += 4;
      inlen = 4;
    } else {
      while (pos < inEnd) {
        const c = input[pos++] as number;
        if (c !== NL) {
          ctx.buf[ctx.i++] = c;
          if (ctx.i === 4) break;
        }
      }
      inlen = ctx.i;
    }
    if (inlen === 0 || (inlen < 4 && !flush)) {
      inlen = 0;
      break;
    }
    if (!decode4(src, at, inlen, out)) break;
    inlen = inEnd - pos;
  }
  return inlen === 0;
}

/** upstream: basenc.c do_decode. Returns the decoded bytes and whether the input was valid. */
export function decode(input: readonly number[], ignoreGarbage: boolean): { bytes: number[]; ok: boolean } {
  const data = ignoreGarbage ? input.filter((c) => isBase64(c) || c === EQ) : input;
  const ctx: DecodeCtx = { i: 0, buf: [] };
  const out: number[] = [];
  let pos = 0;
  for (;;) {
    const block = data.slice(pos, pos + DEC_BLOCK);
    pos += block.length;
    const eof = block.length < DEC_BLOCK;
    for (let k = 0; k < 1 + (eof ? 1 : 0); k++) {
      if (k === 1 && ctx.i === 0) break;
      if (!decodeCtx(ctx, k === 0 ? block : [], out)) return { bytes: out, ok: false };
    }
    if (eof) return { bytes: out, ok: true };
  }
}

function* main(p: ProcApi): Generator<Syscall, number, unknown> {
  const args = yield* parseArgs(p, { options: OPTIONS });
  if (typeof args === 'number') return args;
  if (args.has('help')) {
    yield* p.write(1, HELP);
    return 0;
  }
  if (args.has('version')) return yield* p.unsupported({ kind: 'flag', what: 'the flag --version' });
  let column = WRAP;
  for (const o of args.options) {
    if (o.id !== 'wrap') continue;
    // upstream: basenc.c main, case 'w' — xstrtoimax; an overflowing width means no wrapping.
    const m = /^[ \t\n\v\f\r]*([+-]?)([0-9]+)$/.exec(o.value ?? '');
    if (!m || (m[1] === '-' && /[1-9]/.test(m[2] as string))) {
      yield* warn(p, `invalid wrap size: ${quote(o.value ?? '')}`);
      return 1;
    }
    const n = Number(m[2]);
    column = n > Number.MAX_SAFE_INTEGER ? 0 : n;
  }
  if (args.operands.length > 1) return yield* usageError(p, `extra operand ${quote(args.operands[1] as string)}`);
  const name = args.operands[0] ?? '-';
  const opened = openInput(p, name, 3);
  if (!opened.ok) {
    yield* warn(p, `${quotef(name)}: ${strerror(opened.error.code)}`);
    return 1;
  }
  let text: string;
  try {
    text = yield* readAll(p, opened.fd);
  } catch (e) {
    if (!isFsError(e)) throw e;
    yield* warn(p, `read error: ${strerror(e.code)}`);
    return 1;
  } finally {
    if (opened.fd !== 0) p.close(opened.fd);
  }
  if (!args.has('decode')) {
    yield* p.write(1, wrap(encode(utf8Encode(text)), column));
    return 0;
  }
  const r = decode(utf8Encode(text), args.has('ignore-garbage'));
  if (r.bytes.length > 0) yield* p.write(1, utf8Decode(r.bytes));
  if (!r.ok) {
    yield* warn(p, 'invalid input');
    return 1;
  }
  return 0;
}

export const base64Program: ProgramSpec = { name: 'base64', main };

// Small utilities containers run, as pure functions shared by the shell model (which runs them as
// children or builtins) and the standalone program models (`command: ["sleep", "3600"]`).
// Variants: `gnu` (coreutils in Debian-based images), `busybox` (busybox and Alpine images).
//
// reference: GNU coreutils 9.4, BusyBox v1.36.1 on the workstation with LC_ALL=C TZ=UTC, captured
// 2026-11-16 (fixtures/reference/container-shell/). Containers have no LANG, so GNU quotes with
// ASCII apostrophes.

import { parseInterval } from '../programs/coreutils/sleep.ts';
import { FormatUnsupported, strftime } from '../programs/coreutils/date-format.ts';
import type { ModelGap, Output, ProcessInput } from './types.ts';

export interface UtilityResult {
  output: Output[];
  status: number;
  /** The utility blocks this long first (sleep); Infinity for ever. */
  sleep?: number;
  gaps?: ModelGap[];
}

const out = (text: string): Output => ({ stream: 'stdout', text });
const err = (text: string): Output => ({ stream: 'stderr', text });

/** The utilities modeled here, by program name. */
export const UTILITIES = ['sleep', 'date', 'hostname', 'env', 'printenv', 'cat', 'true', 'false', 'echo', 'printf'] as const;

/** BusyBox `sleep` usage, printed for no operands. reference: busybox sleep, captured 2026-11-16 */
const BUSYBOX_SLEEP_USAGE =
  'BusyBox v1.36.1 (Ubuntu 1:1.36.1-6ubuntu3.1) multi-call binary.\n\nUsage: sleep [N]...\n\nPause for a time equal to the total of the args given, where each arg can\nhave an optional suffix of (s)econds, (m)inutes, (h)ours, or (d)ays\n';

/** BusyBox sleep: strtod plus an optional s/m/h/d suffix (coreutils/sleep.c with FLOAT_DURATION). */
function busyboxInterval(arg: string): number | undefined {
  const m = /^([0-9]+\.?[0-9]*|\.[0-9]+|inf(?:inity)?)([smhd]?)$/i.exec(arg);
  if (!m) return undefined;
  const v = /^inf/i.test(m[1] as string) ? Infinity : Number(m[1]);
  const mult = { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[(m[2] ?? '') as '' | 's' | 'm' | 'h' | 'd'];
  return v * mult;
}

/**
 * `prog` is the name errors start with: the applet name, or the shell's for BusyBox's NOFORK
 * applets run inside ash (`sh: invalid number 'x'`).
 */
export function sleepUtility(variant: string, args: string[], prog = 'sleep'): UtilityResult {
  if (variant === 'busybox') {
    if (args.length === 0) return { output: [err(BUSYBOX_SLEEP_USAGE)], status: 1 };
    let total = 0;
    for (const a of args) {
      const s = busyboxInterval(a);
      if (s === undefined) return { output: [err(`${prog}: invalid number '${a}'\n`)], status: 1 };
      total += s;
    }
    return { output: [], status: 0, sleep: total * 1000 };
  }
  if (args.length === 0) return { output: [err("sleep: missing operand\nTry 'sleep --help' for more information.\n")], status: 1 };
  let total = 0;
  let bad = false;
  const output: Output[] = [];
  for (const a of args) {
    const s = parseInterval(a);
    if (s === undefined) {
      output.push(err(`sleep: invalid time interval '${a}'\n`));
      bad = true;
    } else total += s;
  }
  if (bad) return { output: [...output, err("Try 'sleep --help' for more information.\n")], status: 1 };
  return { output: [], status: 0, sleep: total * 1000 };
}

const UTC_NAMES = new Set(['UTC', 'UTC0', 'Etc/UTC', ':UTC', ':Etc/UTC', 'Universal', 'Zulu', 'UCT']);

export function dateUtility(args: string[], env: [string, string][], now: number): UtilityResult {
  let format = '%a %b %e %H:%M:%S %Z %Y';
  for (const a of args) {
    if (a === '-u' || a === '--utc') continue;
    if (a.startsWith('+')) format = a.slice(1);
    else return { output: [], status: 0, gaps: [{ what: `date ${a}`, detail: 'only +FORMAT and -u are modeled in containers' }] };
  }
  const tz = env.find(([k]) => k === 'TZ')?.[1];
  if (tz !== undefined && tz !== '' && !UTC_NAMES.has(tz)) return { output: [], status: 0, gaps: [{ what: `date with TZ=${tz}`, detail: 'containers run in UTC' }] };
  try {
    return { output: [out(`${strftime(format, now, { abbrev: 'UTC', offset: 0 })}\n`)], status: 0 };
  } catch (e) {
    if (e instanceof FormatUnsupported) return { output: [], status: 0, gaps: [{ what: `date +${format}` }] };
    throw e;
  }
}

/** echo. `escapes`: dash interprets backslash escapes always; bash and BusyBox only with -e. */
export function echoUtility(args: string[], variant: string): UtilityResult {
  let newline = true;
  let escapes = variant === 'dash';
  let i = 0;
  if (variant === 'dash') {
    if (args[0] === '-n') {
      newline = false;
      i = 1;
    }
  } else {
    for (; i < args.length; i++) {
      const a = args[i] as string;
      if (!/^-[neE]+$/.test(a)) break;
      for (const c of a.slice(1)) {
        if (c === 'n') newline = false;
        else if (c === 'e') escapes = true;
        else escapes = false;
      }
    }
  }
  let text = args.slice(i).join(' ');
  if (escapes) {
    const r = unescape(text, variant === 'dash');
    text = r.text;
    if (r.stop) return { output: text ? [out(text)] : [], status: 0 };
  }
  if (newline) text += '\n';
  return { output: text ? [out(text)] : [], status: 0 };
}

/** Backslash escapes of echo -e and printf's %b. dash: `\0nnn` octal only after a zero. */
function unescape(s: string, dashOctal: boolean): { text: string; stop: boolean } {
  let text = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (c !== '\\' || i + 1 >= s.length) {
      text += c;
      continue;
    }
    const n = s[++i] as string;
    const simple: Record<string, string> = { a: '\x07', b: '\b', e: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\' };
    if (n === 'c') return { text, stop: true };
    if (simple[n] !== undefined) text += simple[n];
    else if (n === '0' || (!dashOctal && /[1-7]/.test(n))) {
      let digits = n === '0' ? '' : n;
      while (digits.length < 3 && /[0-7]/.test(s[i + 1] ?? '')) digits += s[++i];
      text += String.fromCharCode(parseInt(digits || '0', 8) & 0xff);
    } else text += `\\${n}`;
  }
  return { text, stop: false };
}

/** printf with the conversions scripts use (%s %d %i %u %x %X %o %c %b %%, flags, width, precision). */
export function printfUtility(args: string[], prog: string): UtilityResult {
  if (args.length === 0) return { output: [err(`${prog}: usage: printf format [arguments]\n`)], status: 2 };
  const format = args[0] as string;
  const rest = args.slice(1);
  let text = '';
  let k = 0;
  const gaps: ModelGap[] = [];
  do {
    let consumed = false;
    for (let i = 0; i < format.length; i++) {
      const c = format[i] as string;
      if (c === '\\') {
        // printf's format escapes: \NNN octal (one to three digits), or one character.
        const one = /^\\([0-7]{1,3})/.exec(format.slice(i));
        if (one) {
          text += String.fromCharCode(parseInt(one[1] as string, 8) & 0xff);
          i += one[0].length - 1;
        } else {
          text += unescape(format.slice(i, i + 2), false).text;
          i += 1;
        }
        continue;
      }
      if (c !== '%') {
        text += c;
        continue;
      }
      const m = /^%([-+ 0#]*)([0-9]*)(?:\.([0-9]*))?([sdiuxXocb%])/.exec(format.slice(i));
      if (!m) {
        gaps.push({ what: `printf format ${format.slice(i, i + 3)}` });
        continue;
      }
      i += m[0].length - 1;
      const conv = m[4] as string;
      if (conv === '%') {
        text += '%';
        continue;
      }
      const arg = rest[k++] ?? '';
      if (k <= rest.length) consumed = true;
      const flags = m[1] ?? '';
      const width = Number(m[2] || 0);
      let s: string;
      if (conv === 's') s = m[3] !== undefined ? arg.slice(0, Number(m[3] || 0)) : arg;
      else if (conv === 'b') s = unescape(arg, false).text;
      else if (conv === 'c') s = arg.slice(0, 1);
      else {
        const n = /^[+-]?[0-9]+$/.test(arg.trim()) ? BigInt(arg.trim()) : arg === '' ? 0n : undefined;
        if (n === undefined) {
          text += '0';
          gaps.push({ what: `printf: non-numeric argument ${arg}` });
          continue;
        }
        const neg = n < 0n;
        const abs = neg ? -n : n;
        let digits = conv === 'x' ? abs.toString(16) : conv === 'X' ? abs.toString(16).toUpperCase() : conv === 'o' ? abs.toString(8) : abs.toString();
        if (m[3] !== undefined) digits = digits.padStart(Number(m[3] || 0), '0');
        const sign = neg ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '';
        if (flags.includes('0') && !flags.includes('-') && m[3] === undefined) digits = digits.padStart(width - sign.length, '0');
        s = sign + digits;
      }
      text += flags.includes('-') ? s.padEnd(width) : s.padStart(width);
    }
    if (!consumed) break;
  } while (k < rest.length);
  return { output: text ? [out(text)] : [], status: 0, ...(gaps.length ? { gaps } : {}) };
}

export function envUtility(args: string[], env: [string, string][], prog: string): UtilityResult {
  if (prog === 'printenv') {
    if (args.length === 0) return { output: env.length ? [out(env.map(([k, v]) => `${k}=${v}\n`).join(''))] : [], status: 0 };
    const vals = args.map((a) => env.find(([k]) => k === a)?.[1]);
    const text = vals.filter((v) => v !== undefined).map((v) => `${v}\n`).join('');
    return { output: text ? [out(text)] : [], status: vals.every((v) => v !== undefined) ? 0 : 1 };
  }
  if (args.length > 0) return { output: [], status: 0, gaps: [{ what: `env ${args.join(' ')}`, detail: 'env with arguments is not modeled in containers' }] };
  return { output: env.length ? [out(env.map(([k, v]) => `${k}=${v}\n`).join(''))] : [], status: 0 };
}

/** Runs utility `name`. Returns undefined when it is not modeled here. */
export function runUtility(name: string, variant: string, args: string[], env: [string, string][], p: ProcessInput, prog = name): UtilityResult | undefined {
  switch (name) {
    case 'sleep':
      return sleepUtility(variant, args, prog);
    case 'date':
      return dateUtility(args, env, p.now);
    case 'hostname':
      if (args.length > 0) return { output: [], status: 0, gaps: [{ what: `hostname ${args.join(' ')}` }] };
      return { output: [out(`${p.hostname}\n`)], status: 0 };
    case 'env':
    case 'printenv':
      return envUtility(args, env, name);
    case 'true':
      return { output: [], status: 0 };
    case 'false':
      return { output: [], status: 1 };
    case 'echo':
      return echoUtility(args, variant === 'busybox' ? 'busybox' : 'gnu');
    case 'printf':
      return printfUtility(args, prog);
    case 'cat': {
      // stdin of a container is /dev/null unless `stdin: true`.
      if (args.length === 0) return { output: [], status: 0 };
      let text = '';
      for (const a of args) {
        const f = p.file(a);
        if (f === undefined) return { output: [], status: 0, gaps: [{ what: `cat ${a}`, detail: 'the file is not part of the modeled image' }] };
        text += f;
      }
      return { output: text ? [out(text)] : [], status: 0 };
    }
    default:
      return undefined;
  }
}

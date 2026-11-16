// The writer every describer prints through: kubectl's PrefixWriter (two spaces per level, terminal
// escapes made visible) over Go's text/tabwriter as tabbedString sets it up, and the value
// formatting the describers share.
//   upstream: staging/src/k8s.io/kubectl/pkg/describe/describe.go prefixWriter.Write, WriteLine,
//             Flush; nestedPrefixWriter; tabbedString (tabwriter.Writer.Init(buf, 0, 8, 2, ' ', 0));
//             LEVEL_0…LEVEL_4
//   upstream: staging/src/k8s.io/cli-runtime/pkg/printers/terminal.go WriteEscaped (ESC as ^[,
//             CR as \r)
//   upstream: Go src/time/format.go RFC1123Z ("Mon, 02 Jan 2006 15:04:05 -0700"); kubectl prints
//             the local time of the machine it runs on, and the simulated machines run in UTC

import { civilFromDays } from '@simlab/kernel';
import type { Json } from '../../apimachinery/json.ts';
import { timestampMicros } from '../../printers/duration.ts';
import { DESCRIBE_TABWRITER, newTabWriter, tabFlush, tabWrite, type TabWriterState } from '../printers/tabwriter.ts';

export const LEVEL_0 = 0;
export const LEVEL_1 = 1;
export const LEVEL_2 = 2;
export const LEVEL_3 = 3;

export interface PrefixWriter {
  /** Write(level, format, a...): the text is already formatted; the level's prefix goes first. */
  write(level: number, text: string): void;
  /** WriteLine(a...): fmt.Sprintln of one value. */
  writeLine(text: string): void;
  /** Flush: the tab writer formats what it holds; later lines start new column blocks. */
  flush(): void;
}

const escape = (s: string): string => (s.includes('\x1b') || s.includes('\r') ? s.split('\x1b').join('^[').split('\r').join('\\r') : s);

/** tabbedString: runs `f` against a fresh writer and returns what the tab writer printed. */
export function tabbedString(f: (w: PrefixWriter) => void): string {
  const tw: TabWriterState = newTabWriter(DESCRIBE_TABWRITER);
  let out = '';
  const w: PrefixWriter = {
    write(level, text) {
      out += tabWrite(tw, escape('  '.repeat(level) + text));
    },
    writeLine(text) {
      out += tabWrite(tw, escape(`${text}\n`));
    },
    flush() {
      out += tabFlush(tw);
    },
  };
  f(w);
  return out + tabFlush(tw);
}

/**
 * NewPrefixWriter over a plain buffer, without a tab writer: tabs stay as they are written (what
 * `rollout history --revision` prints through polymorphichelpers/history.go printTemplate).
 */
export function prefixString(f: (w: PrefixWriter) => void): string {
  let out = '';
  f({
    write: (level, text) => (out += escape('  '.repeat(level) + text)),
    writeLine: (text) => (out += escape(`${text}\n`)),
    flush: () => undefined,
  });
  return out;
}

/** NewNestedPrefixWriter: every level shifted by `indent`. */
export function nested(w: PrefixWriter, indent: number): PrefixWriter {
  return {
    write: (level, text) => w.write(level + indent, text),
    writeLine: (text) => w.write(indent, `${text}\n`),
    flush: () => w.flush(),
  };
}

// ---- values as fmt prints them ----

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n: number): string => String(n).padStart(2, '0');

// time.Time{}: 0001-01-01T00:00:00Z.
const ZERO_TIME_SECONDS = -62135596800;

/** t.Format(time.RFC1123Z) in UTC; an absent time is Go's zero time. */
export function rfc1123z(v: Json | undefined): string {
  const us = timestampMicros(v);
  const seconds = us === undefined ? ZERO_TIME_SECONDS : Math.floor(us / 1_000_000);
  const days = Math.floor(seconds / 86400);
  let rest = seconds - days * 86400;
  const c = civilFromDays(days);
  const h = Math.floor(rest / 3600);
  rest -= h * 3600;
  const m = Math.floor(rest / 60);
  const weekday = DAYS[(((days + 4) % 7) + 7) % 7] as string; // 1970-01-01 was a Thursday
  const year = c.year < 0 ? `-${String(-c.year).padStart(4, '0')}` : String(c.year).padStart(4, '0');
  return `${weekday}, ${two(c.day)} ${MONTHS[c.month - 1] as string} ${year} ${two(h)}:${two(m)}:${two(rest - m * 60)} +0000`;
}

/** %v of a string-valued field (absent is the empty string). */
export const s = (v: Json | undefined): string => (typeof v === 'string' ? v : '');
/** %d of an integer field (absent is 0). */
export const d = (v: Json | undefined): string => (typeof v === 'number' ? String(v) : '0');
/** %v of a bool field (absent is false). */
export const b = (v: Json | undefined): string => (v === true ? 'true' : 'false');

/** printBool */
export const printBool = (v: Json | undefined): string => (v === true ? 'True' : 'False');

/** stringOrNone */
export const stringOrNone = (v: string): string => (v === '' ? '<none>' : v);

const utf8Len = (c: number): number => (c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4);

/** len(s): Go strings are bytes. */
export function byteLength(str: string): number {
  let n = 0;
  for (const ch of str) n += utf8Len(ch.codePointAt(0) as number);
  return n;
}

/**
 * s[:n] of a Go string: the first n bytes. A character the cut splits leaves bytes that are not
 * UTF-8, which the simulator's text shows as U+FFFD (docs/FIDELITY.md DIV-002).
 */
export function byteSlice(str: string, n: number): string {
  let out = '';
  let used = 0;
  for (const ch of str) {
    const l = utf8Len(ch.codePointAt(0) as number);
    if (used + l > n) return used < n ? `${out}\ufffd` : out;
    out += ch;
    used += l;
  }
  return out;
}

/** UTF-8 bytes of a string. */
export function utf8Encode(str: string): number[] {
  const out: number[] = [];
  for (const ch of str) {
    const c = ch.codePointAt(0) as number;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

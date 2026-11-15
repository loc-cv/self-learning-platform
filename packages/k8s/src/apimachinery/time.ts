// metav1.Time and metav1.MicroTime on the wire.
// upstream: staging/src/k8s.io/apimachinery/pkg/apis/meta/v1/time.go (UnmarshalJSON: time.Parse
// with RFC3339; MarshalJSON: t.UTC().Format(time.RFC3339)), micro_time.go (RFC3339Micro,
// "2006-01-02T15:04:05.000000Z07:00"). Error texts: Go src/time/format.go (ParseError.Error:
// `parsing time <q value> as <q layout>: cannot parse <q rest> as <q elem>`, and
// `parsing time <q value>: <message>` for range errors and extra text).

import { daysFromCivil, civilFromDays, type Millis } from '@simlab/kernel';

const RFC3339 = '2006-01-02T15:04:05Z07:00';
const RFC3339_MICRO = '2006-01-02T15:04:05.000000Z07:00';

const quote = (s: string): string => JSON.stringify(s);

/** Microseconds since the Unix epoch, or Go's parse error text. */
export function parseTime(value: string, micro: boolean): { micros: number } | { error: string } {
  const layout = micro ? RFC3339_MICRO : RFC3339;
  const fail = (rest: string, elem: string) => ({ error: `parsing time ${quote(value)} as ${quote(layout)}: cannot parse ${quote(rest)} as ${quote(elem)}` });
  const range = (what: string) => ({ error: `parsing time ${quote(value)}: ${what} out of range` });
  let rest = value;
  const num = (n: number): number | undefined => {
    const m = new RegExp(`^[0-9]{${n}}`).exec(rest);
    if (!m) return undefined;
    rest = rest.slice(n);
    return Number(m[0]);
  };
  const lit = (l: string): boolean => {
    if (!rest.startsWith(l)) return false;
    rest = rest.slice(l.length);
    return true;
  };
  const year = num(4);
  if (year === undefined) return fail(rest, '2006');
  if (!lit('-')) return fail(rest, '-');
  const month = num(2);
  if (month === undefined) return fail(rest, '01');
  if (month < 1 || month > 12) return range('month');
  if (!lit('-')) return fail(rest, '-');
  const day = num(2);
  if (day === undefined) return fail(rest, '02');
  if (!lit('T')) return fail(rest, 'T');
  const hour = num(2);
  if (hour === undefined) return fail(rest, '15');
  if (hour > 23) return range('hour');
  if (!lit(':')) return fail(rest, ':');
  const minute = num(2);
  if (minute === undefined) return fail(rest, '04');
  if (minute > 59) return range('minute');
  if (!lit(':')) return fail(rest, ':');
  const second = num(2);
  if (second === undefined) return fail(rest, '05');
  if (second > 59) return range('second');
  // Go accepts a fractional second after "05" even when the layout has none.
  let micros = 0;
  const frac = /^[.,]([0-9]+)/.exec(rest);
  if (micro && !frac) return fail(rest, '.000000');
  if (frac) {
    if (micro && (frac[1] as string).length !== 6) return fail(rest, '.000000');
    micros = Math.floor(Number(((frac[1] as string) + '000000').slice(0, 6)));
    rest = rest.slice(frac[0].length);
  }
  let offset = 0;
  if (!lit('Z')) {
    const z = /^([+-])([0-9]{2}):([0-9]{2})/.exec(rest);
    if (!z) return fail(rest, 'Z07:00');
    const h = Number(z[2]);
    const mi = Number(z[3]);
    if (h > 24 || mi > 60) return { error: `parsing time ${quote(value)}: time zone offset out of range` };
    offset = (z[1] === '-' ? -1 : 1) * (h * 3600 + mi * 60);
    rest = rest.slice(z[0].length);
  }
  if (rest !== '') return { error: `parsing time ${quote(value)}: extra text: ${quote(rest)}` };
  const dim = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] as number;
  if (day < 1 || day > dim) return range('day');
  const seconds = daysFromCivil(year, month, day) * 86400 + hour * 3600 + minute * 60 + second - offset;
  return { micros: seconds * 1_000_000 + micros };
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

function civil(micros: number): string {
  const secs = Math.floor(micros / 1_000_000);
  const days = Math.floor(secs / 86400);
  let rest = secs - days * 86400;
  const h = Math.floor(rest / 3600);
  rest -= h * 3600;
  const mi = Math.floor(rest / 60);
  const c = civilFromDays(days);
  return `${pad(c.year, 4)}-${pad(c.month)}-${pad(c.day)}T${pad(h)}:${pad(mi)}:${pad(rest - mi * 60)}`;
}

/** metav1.Time's JSON: UTC, second precision. */
export function formatTime(micros: number): string {
  return `${civil(micros)}Z`;
}

/** metav1.MicroTime's JSON: UTC, six fractional digits. */
export function formatMicroTime(micros: number): string {
  const frac = ((micros % 1_000_000) + 1_000_000) % 1_000_000;
  return `${civil(micros)}.${String(frac).padStart(6, '0')}Z`;
}

/** A kernel clock reading as metav1.Time. */
export function timeOf(ms: Millis): string {
  return formatTime(ms * 1000);
}

/** A kernel clock reading as metav1.MicroTime. */
export function microTimeOf(ms: Millis): string {
  return formatMicroTime(ms * 1000);
}

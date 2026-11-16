// Go's time.ParseDuration, for duration flags (`--timeout=30s`, `--request-timeout`).
//   upstream: .upstream/go/src/time/format.go ParseDuration, leadingInt, leadingFraction, quote
// Returns nanoseconds as a bigint, or the error text Go would return.

const UNITS: Record<string, bigint> = {
  ns: 1n,
  us: 1000n,
  'µs': 1000n, // U+00B5
  'μs': 1000n, // U+03BC
  ms: 1_000_000n,
  s: 1_000_000_000n,
  m: 60_000_000_000n,
  h: 3_600_000_000_000n,
};

const MAX = 1n << 63n;

function utf8Bytes(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

/** time's quote: a double-quoted string with non-ASCII and control bytes escaped as \x. */
function quote(s: string): string {
  let out = '"';
  for (const b of utf8Bytes(s)) {
    const c = String.fromCharCode(b);
    if (b >= 0x80 || b < 0x20) out += '\\x' + b.toString(16).padStart(2, '0');
    else if (c === '"' || c === '\\') out += '\\' + c;
    else out += c;
  }
  return out + '"';
}

export function parseGoDuration(orig: string): { ns: bigint } | { error: string } {
  const invalid = { error: 'time: invalid duration ' + quote(orig) };
  let s = orig;
  let neg = false;
  if (s !== '' && (s[0] === '-' || s[0] === '+')) {
    neg = s[0] === '-';
    s = s.slice(1);
  }
  if (s === '0') return { ns: 0n };
  if (s === '') return invalid;
  let d = 0n;
  while (s !== '') {
    if (!(s[0] === '.' || (s[0] as string) >= '0' && (s[0] as string) <= '9')) return invalid;
    const intM = /^[0-9]*/.exec(s)?.[0] ?? '';
    const pre = intM.length > 0;
    let v = intM === '' ? 0n : BigInt(intM);
    if (v >= MAX) return invalid; // leadingInt overflow
    s = s.slice(intM.length);
    let f = 0n;
    let scale = 1;
    let post = false;
    if (s !== '' && s[0] === '.') {
      s = s.slice(1);
      const fracM = /^[0-9]*/.exec(s)?.[0] ?? '';
      post = fracM.length > 0;
      // leadingFraction stops accumulating once it would overflow.
      let overflow = false;
      for (const c of fracM) {
        if (overflow) continue;
        if (f > (MAX - 1n) / 10n) {
          overflow = true;
          continue;
        }
        const y = f * 10n + BigInt(c);
        if (y >= MAX) {
          overflow = true;
          continue;
        }
        f = y;
        scale *= 10;
      }
      s = s.slice(fracM.length);
    }
    if (!pre && !post) return invalid;
    const um = /^[^0-9.]*/.exec(s)?.[0] ?? '';
    if (um === '') return { error: 'time: missing unit in duration ' + quote(orig) };
    s = s.slice(um.length);
    const unit = UNITS[um];
    if (unit === undefined) return { error: 'time: unknown unit ' + quote(um) + ' in duration ' + quote(orig) };
    if (v > MAX / unit) return invalid;
    v *= unit;
    if (f > 0n) {
      v += BigInt(Math.trunc(Number(f) * (Number(unit) / scale)));
      if (v > MAX) return invalid;
    }
    d += v;
    if (d > MAX) return invalid;
  }
  if (neg) return { ns: -d };
  if (d > MAX - 1n) return invalid;
  return { ns: d };
}

// printf(3)-style formatting of one conversion, shared by bash's printf builtin and the coreutils
// that format numbers (printf, seq). docs: printf(3) "Flag characters", "Field width",
// "Precision", "Conversion specifiers" (man-pages 6.7 on the workstation)

export interface ConvSpec {
  /** Any of `-+ #0'`. */
  flags: string;
  width?: number;
  precision?: number;
  /** The conversion character: d i o u x X e E f F g G a A c s. */
  conv: string;
}

function pad(body: string, spec: ConvSpec, signAndPrefix: string, numeric: boolean): string {
  const total = signAndPrefix.length + body.length;
  const width = spec.width ?? 0;
  if (total >= width) return signAndPrefix + body;
  if (spec.flags.includes('-')) return (signAndPrefix + body).padEnd(width);
  if (numeric && spec.flags.includes('0')) return signAndPrefix + '0'.repeat(width - total) + body;
  return (signAndPrefix + body).padStart(width);
}

export function formatInteger(n: bigint, spec: ConvSpec): string {
  const conv = spec.conv;
  const unsigned = conv === 'u' || conv === 'o' || conv === 'x' || conv === 'X';
  let v = n;
  // Unsigned conversions show a negative value as its 64-bit two's complement.
  if (unsigned && v < 0n) v = (1n << 64n) + v;
  const neg = v < 0n;
  const abs = neg ? -v : v;
  let digits = conv === 'o' ? abs.toString(8) : conv === 'x' ? abs.toString(16) : conv === 'X' ? abs.toString(16).toUpperCase() : abs.toString(10);
  if (spec.precision !== undefined) {
    digits = spec.precision === 0 && abs === 0n ? '' : digits.padStart(spec.precision, '0');
  }
  let prefix = neg ? '-' : !unsigned && spec.flags.includes('+') ? '+' : !unsigned && spec.flags.includes(' ') ? ' ' : '';
  if (spec.flags.includes('#')) {
    if (conv === 'o' && !digits.startsWith('0')) digits = `0${digits}`;
    if ((conv === 'x' || conv === 'X') && abs !== 0n) prefix += conv === 'x' ? '0x' : '0X';
  }
  // The 0 flag is ignored when a precision is given for an integer conversion.
  const zeroOk = spec.precision === undefined;
  return pad(digits, zeroOk ? spec : { ...spec, flags: spec.flags.replace('0', '') }, prefix, true);
}

function trimZeros(s: string): string {
  if (!s.includes('.')) return s;
  return s.replace(/\.?0+$/, '');
}

/** `1.5e+3` from JavaScript becomes `1.500000e+03` in C. */
function cExponential(x: number, precision: number, upper: boolean): string {
  const s = x.toExponential(precision);
  const m = /^(-?[\d.]+)e([+-])(\d+)$/.exec(s) as RegExpExecArray;
  const out = `${m[1]}e${m[2]}${(m[3] as string).padStart(2, '0')}`;
  return upper ? out.toUpperCase() : out;
}

function cFixed(x: number, precision: number): string {
  if (Math.abs(x) < 1e21) return x.toFixed(precision);
  // toFixed switches to exponential notation from 1e21; print the integer digits instead.
  const int = BigInt(Math.trunc(x)).toString();
  return precision > 0 ? `${int}.${'0'.repeat(precision)}` : int;
}

export function formatFloat(x: number, spec: ConvSpec): string {
  const conv = spec.conv;
  const upper = conv === conv.toUpperCase();
  const neg = x < 0 || Object.is(x, -0);
  const abs = Math.abs(x);
  const sign = neg ? '-' : spec.flags.includes('+') ? '+' : spec.flags.includes(' ') ? ' ' : '';
  if (!Number.isFinite(abs)) {
    const body = Number.isNaN(abs) ? 'nan' : 'inf';
    return pad(upper ? body.toUpperCase() : body, { ...spec, flags: spec.flags.replace('0', '') }, sign, false);
  }
  const prec = spec.precision ?? 6;
  let body: string;
  switch (conv.toLowerCase()) {
    case 'f':
      body = cFixed(abs, prec);
      if (spec.flags.includes('#') && prec === 0) body += '.';
      break;
    case 'e':
      body = cExponential(abs, prec, upper);
      break;
    case 'g': {
      const p = prec === 0 ? 1 : prec;
      const exp = abs === 0 ? 0 : Number(/e([+-]\d+)$/.exec(abs.toExponential(p - 1))?.[1]);
      if (exp < p && exp >= -4) {
        body = cFixed(abs, p - 1 - exp);
        if (!spec.flags.includes('#')) body = trimZeros(body);
      } else {
        body = cExponential(abs, p - 1, upper);
        if (!spec.flags.includes('#')) body = body.replace(/\.?0+(e)/i, '$1');
      }
      break;
    }
    default:
      body = cFixed(abs, prec);
  }
  return pad(body, spec, sign, true);
}

export function formatString(s: string, spec: ConvSpec): string {
  const body = spec.precision !== undefined ? [...s].slice(0, spec.precision).join('') : s;
  return pad(body, { ...spec, flags: spec.flags.replace('0', '') }, '', false);
}

/**
 * strtoimax(3) with base 0 as printf(1) and bash's printf use it: optional blanks and sign, then
 * `0x` hex, a leading `0` octal or decimal; a leading quote gives the next character's code.
 * `ok` is false when characters are left over or nothing was parsed; `value` is what was parsed.
 */
export function parseCInteger(s: string): { value: bigint; ok: boolean; range: boolean } {
  if (s.startsWith("'") || s.startsWith('"')) {
    const ch = s.slice(1);
    return { value: ch === '' ? 0n : BigInt(ch.codePointAt(0) as number), ok: true, range: true };
  }
  const m = /^[ \t\n]*([+-]?)(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)/.exec(s);
  if (!m) return { value: 0n, ok: false, range: true };
  const digits = m[2] as string;
  let v = digits.startsWith('0x') || digits.startsWith('0X') ? BigInt(digits) : digits.startsWith('0') && digits.length > 1 ? BigInt(`0o${digits.slice(1)}`) : BigInt(digits);
  if (m[1] === '-') v = -v;
  const max = (1n << 63n) - 1n;
  const range = v <= max && v >= -max - 1n;
  if (!range) v = v > 0n ? max : -max - 1n;
  return { value: v, ok: m[0].length === s.length, range };
}

/** strtod(3)-style parse of a printf float argument. */
export function parseCFloat(s: string): { value: number; ok: boolean } {
  if (s.startsWith("'") || s.startsWith('"')) return { value: s.length > 1 ? (s.codePointAt(1) as number) : 0, ok: true };
  const m = /^[ \t\n]*[+-]?(?:inf(?:inity)?|nan|0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/i.exec(s);
  if (!m) return { value: 0, ok: false };
  const t = m[0].trim().toLowerCase();
  let value: number;
  if (t.replace(/^[+-]/, '').startsWith('inf')) value = t.startsWith('-') ? -Infinity : Infinity;
  else if (t.replace(/^[+-]/, '') === 'nan') value = Number.NaN;
  else if (/0x/.test(t)) value = Number.parseInt(t, 16);
  else value = Number(t);
  return { value, ok: m[0].length === s.length };
}

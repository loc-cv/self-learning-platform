// How yaml.v2 decides what a scalar is: YAML 1.1 implicit resolution (`yes` and `on` are
// booleans, `0x1F` and `012` are integers, `2024-01-01` is a timestamp) and explicit tags.
// The encoder uses the same function to decide which strings need quotes.
//
// upstream: vendor/go.yaml.in/yaml/v2/resolve.go (resolveTable, resolveMap, resolve,
// parseTimestamp, allowedTimestampFormats), encode.go (isBase60Float); Go strconv ParseInt,
// ParseUint (atoi.go: base prefixes, ranges) and readFloat/underscoreOK (atof.go, atoi.go);
// Go time.Parse for the four timestamp layouts (format.go: getnum, skip, stdISO8601ColonTZ,
// range checks).

export const LONG_TAG_PREFIX = 'tag:yaml.org,2002:';
export const NULL_TAG = 'tag:yaml.org,2002:null';
export const BOOL_TAG = 'tag:yaml.org,2002:bool';
export const STR_TAG = 'tag:yaml.org,2002:str';
export const INT_TAG = 'tag:yaml.org,2002:int';
export const FLOAT_TAG = 'tag:yaml.org,2002:float';
export const TIMESTAMP_TAG = 'tag:yaml.org,2002:timestamp';
export const SEQ_TAG = 'tag:yaml.org,2002:seq';
export const MAP_TAG = 'tag:yaml.org,2002:map';
export const BINARY_TAG = 'tag:yaml.org,2002:binary';
export const MERGE_TAG = 'tag:yaml.org,2002:merge';

/** A value as yaml.v2 decodes it into interface{} (Go's dynamic types, as plain data). */
export type GoValue =
  | { k: 'nil' }
  | { k: 'bool'; v: boolean }
  /** Go int (64-bit platform). */
  | { k: 'int'; v: bigint }
  /** uint64: only integers above MaxInt64. */
  | { k: 'uint'; v: bigint }
  | { k: 'float'; v: number }
  | { k: 'string'; v: string }
  | { k: 'seq'; items: GoValue[] }
  /** map[interface{}]interface{}; entries in insertion order, keys unique by Go equality. */
  | { k: 'map'; entries: { key: GoValue; value: GoValue }[] };

export function shortTag(tag: string): string {
  return tag.startsWith(LONG_TAG_PREFIX) ? `!!${tag.slice(LONG_TAG_PREFIX.length)}` : tag;
}

function resolvableTag(tag: string): boolean {
  return ['', STR_TAG, BOOL_TAG, INT_TAG, FLOAT_TAG, NULL_TAG, TIMESTAMP_TAG].includes(tag);
}

const RESOLVE_MAP: Record<string, { tag: string; value: GoValue }> = (() => {
  const m: Record<string, { tag: string; value: GoValue }> = {};
  const add = (value: GoValue, tag: string, l: string[]): void => {
    for (const s of l) m[s] = { tag, value };
  };
  add({ k: 'bool', v: true }, BOOL_TAG, ['y', 'Y', 'yes', 'Yes', 'YES']);
  add({ k: 'bool', v: true }, BOOL_TAG, ['true', 'True', 'TRUE']);
  add({ k: 'bool', v: true }, BOOL_TAG, ['on', 'On', 'ON']);
  add({ k: 'bool', v: false }, BOOL_TAG, ['n', 'N', 'no', 'No', 'NO']);
  add({ k: 'bool', v: false }, BOOL_TAG, ['false', 'False', 'FALSE']);
  add({ k: 'bool', v: false }, BOOL_TAG, ['off', 'Off', 'OFF']);
  add({ k: 'nil' }, NULL_TAG, ['', '~', 'null', 'Null', 'NULL']);
  add({ k: 'float', v: NaN }, FLOAT_TAG, ['.nan', '.NaN', '.NAN']);
  add({ k: 'float', v: Infinity }, FLOAT_TAG, ['.inf', '.Inf', '.INF']);
  add({ k: 'float', v: Infinity }, FLOAT_TAG, ['+.inf', '+.Inf', '+.INF']);
  add({ k: 'float', v: -Infinity }, FLOAT_TAG, ['-.inf', '-.Inf', '-.INF']);
  add({ k: 'string', v: '<<' }, MERGE_TAG, ['<<']);
  return m;
})();

/** resolveTable: the hint for a first byte. */
function hint(c: string): string {
  if (c === '+' || c === '-') return 'S';
  if (c >= '0' && c <= '9') return 'D';
  if ('yYnNtTfFoO~'.includes(c)) return 'M';
  if (c === '.') return '.';
  return '';
}

const MAX_INT64 = (1n << 63n) - 1n;
const MAX_UINT64 = (1n << 64n) - 1n;

/** strconv.ParseUint(s, 0, 64) without underscores (resolve removes them first). */
function parseUint(s: string): { v: bigint; range?: boolean } | undefined {
  if (s === '') return undefined;
  let base = 10n;
  let digits = s;
  if (s[0] === '0') {
    const l = (s[1] ?? '').toLowerCase();
    if (s.length >= 3 && l === 'b') [base, digits] = [2n, s.slice(2)];
    else if (s.length >= 3 && l === 'o') [base, digits] = [8n, s.slice(2)];
    else if (s.length >= 3 && l === 'x') [base, digits] = [16n, s.slice(2)];
    else [base, digits] = [8n, s.slice(1)];
  }
  let n = 0n;
  let range = false;
  for (const c of digits) {
    // Go's lower(c) works on bytes: only ASCII letters are digits.
    const code = c.charCodeAt(0) | 0x20;
    let d: number;
    if (c >= '0' && c <= '9') d = c.charCodeAt(0) - 48;
    else if (c.length === 1 && c.charCodeAt(0) < 0x80 && code >= 0x61 && code <= 0x7a) d = code - 87;
    else return undefined;
    if (BigInt(d) >= base) return undefined;
    if (!range) {
      n = n * base + BigInt(d);
      if (n > MAX_UINT64) range = true;
    }
  }
  return range ? { v: MAX_UINT64, range: true } : { v: n };
}

/** strconv.ParseInt(s, 0, 64). */
function parseInt64(s: string): bigint | undefined {
  if (s === '') return undefined;
  let neg = false;
  let rest = s;
  if (s[0] === '+') rest = s.slice(1);
  else if (s[0] === '-') [rest, neg] = [s.slice(1), true];
  const u = parseUint(rest);
  if (!u || u.range) return undefined;
  if (!neg && u.v > MAX_INT64) return undefined;
  if (neg && u.v > MAX_INT64 + 1n) return undefined;
  return neg ? -u.v : u.v;
}

/** strconv.ParseUint(s, 2, 64) / ParseInt(s, 2, 64): base 2 without a prefix (and no sign for uint). */
function parseBinary(s: string, signed: boolean): bigint | undefined {
  let neg = false;
  let rest = s;
  if (signed && (s[0] === '+' || s[0] === '-')) [rest, neg] = [s.slice(1), s[0] === '-'];
  if (rest === '' || !/^[01]+$/.test(rest)) return undefined;
  const v = BigInt(`0b${rest}`);
  if (v > MAX_UINT64) return undefined;
  if (signed && ((!neg && v > MAX_INT64) || (neg && v > MAX_INT64 + 1n))) return undefined;
  return neg ? -v : v;
}

/** underscoreOK (atoi.go): underscores only between digits (or after a base prefix). */
function underscoreOK(s0: string): boolean {
  let s = s0;
  let saw = '^';
  let i = 0;
  if (s.length >= 1 && (s[0] === '-' || s[0] === '+')) s = s.slice(1);
  let hex = false;
  if (s.length >= 2 && s[0] === '0' && 'box'.includes((s[1] as string).toLowerCase())) {
    i = 2;
    saw = '0';
    hex = (s[1] as string).toLowerCase() === 'x';
  }
  for (; i < s.length; i++) {
    const c = s[i] as string;
    if ((c >= '0' && c <= '9') || (hex && c.toLowerCase() >= 'a' && c.toLowerCase() <= 'f')) {
      saw = '0';
      continue;
    }
    if (c === '_') {
      if (saw !== '0') return false;
      saw = '_';
      continue;
    }
    if (saw === '_') return false;
    saw = '!';
  }
  return saw !== '_';
}

/**
 * strconv.ParseFloat(s, 64) for decimal text (no hex floats, no inf/nan words: resolve only calls
 * it on text starting with `.` or matching yamlStyleFloat). Undefined on a syntax error or
 * overflow (ErrRange), as resolve treats both.
 */
function parseFloatDecimal(s: string): number | undefined {
  if (!/^[+-]?[0-9_]*(\.[0-9_]*)?([eE][+-]?[0-9][0-9_]*)?$/.test(s)) return undefined;
  const mant = s.replace(/^[+-]/, '').replace(/[eE].*$/, '');
  if (!/[0-9]/.test(mant)) return undefined;
  if (s.includes('_') && !underscoreOK(s)) return undefined;
  const v = Number(s.replace(/_/g, ''));
  if (!Number.isFinite(v)) return undefined;
  return v;
}

const YAML_STYLE_FLOAT = /^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/;

function intValue(v: bigint): GoValue {
  return { k: 'int', v };
}

export class ResolveError extends Error {}

/**
 * resolve(tag, in): the resolved tag and value. Throws ResolveError with yaml.v2's message
 * (without the `yaml: ` prefix) when an explicit tag does not fit the text.
 */
export function resolve(tag: string, input: string): { tag: string; value: GoValue } {
  if (!resolvableTag(tag)) return { tag, value: { k: 'string', v: input } };
  const r = resolveUnchecked(tag, input);
  // The deferred check of resolve: an explicit tag must match what the text resolves to.
  if (tag === '' || tag === r.tag || tag === STR_TAG || tag === BINARY_TAG) return r;
  if (tag === FLOAT_TAG && r.tag === INT_TAG && r.value.k === 'int') return { tag: FLOAT_TAG, value: { k: 'float', v: Number(r.value.v) } };
  throw new ResolveError(`cannot decode ${shortTag(r.tag)} \`${input}\` as a ${shortTag(tag)}`);
}

function resolveUnchecked(tag: string, input: string): { tag: string; value: GoValue } {
  const h = input === '' ? 'N' : hint(input[0] as string);
  if (h !== '' && tag !== STR_TAG && tag !== BINARY_TAG) {
    const item = RESOLVE_MAP[input];
    if (item) return item;
    switch (h) {
      case '.': {
        const f = parseFloatDecimal(input);
        if (f !== undefined) return { tag: FLOAT_TAG, value: { k: 'float', v: f } };
        break;
      }
      case 'D':
      case 'S': {
        if (tag === '' || tag === TIMESTAMP_TAG) {
          if (isTimestamp(input)) return { tag: TIMESTAMP_TAG, value: { k: 'string', v: input } };
        }
        const plain = input.replace(/_/g, '');
        const i = parseInt64(plain);
        if (i !== undefined) return { tag: INT_TAG, value: intValue(i) };
        const u = parseUint(plain);
        if (u && !u.range) return { tag: INT_TAG, value: { k: 'uint', v: u.v } };
        if (YAML_STYLE_FLOAT.test(plain)) {
          const f = parseFloatDecimal(plain);
          if (f !== undefined) return { tag: FLOAT_TAG, value: { k: 'float', v: f } };
        }
        if (plain.startsWith('0b')) {
          const bi = parseBinary(plain.slice(2), true);
          if (bi !== undefined) return { tag: INT_TAG, value: intValue(bi) };
          const bu = parseBinary(plain.slice(2), false);
          if (bu !== undefined) return { tag: INT_TAG, value: bu > MAX_INT64 ? { k: 'uint', v: bu } : intValue(bu) };
        } else if (plain.startsWith('-0b')) {
          const bi = parseBinary(`-${plain.slice(3)}`, true);
          if (bi !== undefined) return { tag: INT_TAG, value: intValue(bi) };
        }
        break;
      }
      default:
        break;
    }
  }
  return { tag: STR_TAG, value: { k: 'string', v: input } };
}

/** The resolved tag alone, as the encoder asks it (`resolve("", s)`). */
export function resolvedTag(s: string): string {
  return resolveUnchecked('', s).tag;
}

// upstream: encode.go base60float
const BASE60_FLOAT = /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+(?:\.[0-9_]*)?$/;

export function isBase60Float(s: string): boolean {
  if (s === '') return false;
  const c = s[0] as string;
  if (!(c === '+' || c === '-' || (c >= '0' && c <= '9')) || !s.includes(':')) return false;
  return BASE60_FLOAT.test(s);
}

// ---- parseTimestamp: Go time.Parse with the four layouts of allowedTimestampFormats ----

type Cursor = { s: string; ok: boolean };

/** getnum(s, fixed=false): one or two digits. */
function getnum(c: Cursor): number {
  const s = c.s;
  if (!(s[0] !== undefined && s[0] >= '0' && s[0] <= '9')) {
    c.ok = false;
    return 0;
  }
  if (!(s[1] !== undefined && s[1] >= '0' && s[1] <= '9')) {
    c.s = s.slice(1);
    return s.charCodeAt(0) - 48;
  }
  c.s = s.slice(2);
  return (s.charCodeAt(0) - 48) * 10 + (s.charCodeAt(1) - 48);
}

function lit(c: Cursor, prefix: string): void {
  if (!c.ok) return;
  if (prefix === ' ') {
    // skip(): a space in the layout matches one or more spaces (or the end of the value).
    if (c.s.length > 0 && c.s[0] !== ' ') {
      c.ok = false;
      return;
    }
    c.s = c.s.replace(/^ +/, '');
    return;
  }
  if (!c.s.startsWith(prefix)) c.ok = false;
  else c.s = c.s.slice(prefix.length);
}

function daysIn(month: number, year: number): number {
  if (month === 2) return (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28;
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] as number;
}

/** One layout: date, then optionally the time part after `sep`, then optionally `Z07:00`. */
function parseLayout(s: string, sep: string | undefined, zone: boolean): boolean {
  const c: Cursor = { s, ok: true };
  // "2006": four digits.
  if (!/^[0-9]{4}/.test(c.s)) return false;
  const year = Number(c.s.slice(0, 4));
  c.s = c.s.slice(4);
  lit(c, '-');
  if (!c.ok) return false;
  const month = getnum(c);
  if (!c.ok || month <= 0 || month > 12) return false;
  lit(c, '-');
  if (!c.ok) return false;
  const day = getnum(c);
  if (!c.ok) return false;
  if (sep !== undefined) {
    lit(c, sep);
    if (!c.ok) return false;
    const hour = getnum(c);
    if (!c.ok || hour >= 24) return false;
    lit(c, ':');
    if (!c.ok) return false;
    const min = getnum(c);
    if (!c.ok || min >= 60) return false;
    lit(c, ':');
    if (!c.ok) return false;
    const sec = getnum(c);
    if (!c.ok || sec >= 60) return false;
    // ".999999999": optional fraction, `.` or `,` and any number of digits (stdFracSecond9).
    if (c.s.length >= 2 && (c.s[0] === '.' || c.s[0] === ',') && /[0-9]/.test(c.s[1] as string)) {
      c.s = c.s.replace(/^[.,][0-9]+/, '');
    }
    if (zone) {
      if (c.s[0] === 'Z') c.s = c.s.slice(1);
      else {
        if (c.s.length < 6 || c.s[3] !== ':') return false;
        const [sign, hh, mm] = [c.s[0], c.s.slice(1, 3), c.s.slice(4, 6)];
        if (!/^[0-9]{2}$/.test(hh) || !/^[0-9]{2}$/.test(mm)) return false;
        if (Number(hh) > 24 || Number(mm) > 60) return false;
        if (sign !== '+' && sign !== '-') return false;
        c.s = c.s.slice(6);
      }
    }
  }
  if (c.s.length > 0) return false;
  return day >= 1 && day <= daysIn(month, year);
}

/** parseTimestamp: whether yaml.v2 takes the text for a !!timestamp. */
export function isTimestamp(s: string): boolean {
  if (!/^[0-9]{4}-/.test(s)) return false;
  return parseLayout(s, 'T', true) || parseLayout(s, 't', true) || parseLayout(s, ' ', false) || parseLayout(s, undefined, false);
}

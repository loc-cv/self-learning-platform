// Command-line flags as kubectl parses them: spf13/pflag's FlagSet, ported.
//   upstream: vendor/github.com/spf13/pflag/flag.go parseArgs, parseLongArg, parseSingleShortArg,
//             parseShortArg, Set; errors.go (the error texts); bool.go, int.go, int64.go,
//             string_slice.go (readAsCSV), string_array.go, duration.go
//   upstream: staging/src/k8s.io/component-base/cli/flag WordSepNormalizeFunc (kubectl's
//             normalization: `_` in a flag name reads as `-`)
// Values are kept as typed JavaScript values; a flag's `changed` order is the order it was first set.

import { parseGoDuration } from './goduration.ts';

export type FlagKind = 'bool' | 'string' | 'int' | 'int64' | 'int32' | 'stringSlice' | 'stringArray' | 'duration' | 'other';

export type FlagValue = boolean | string | number | string[];

export interface FlagDef {
  name: string;
  shorthand?: string;
  kind: FlagKind;
  /** The default value. For 'other' (a type not simulated), the raw default text. */
  default: FlagValue;
  /** pflag's NoOptDefVal: the value of `--flag` with no `=`; "true" for every bool. */
  noOptDefVal?: string;
}

export interface ParsedFlags {
  /** Value of every defined flag, by name: the default unless set. */
  values: Record<string, FlagValue>;
  /** Names of the flags set on the command line, in the order first set. */
  changed: string[];
  /** Positional arguments. */
  args: string[];
  /** Number of positional arguments before `--`, or -1 when there was none. */
  argsLenAtDash: number;
}

export interface FlagSet {
  defs: FlagDef[];
  byName: Map<string, FlagDef>;
  byShort: Map<string, FlagDef>;
}

/** upstream: component-base/cli/flag/sectioned.go WordSepNormalizeFunc */
export function normalizeFlagName(name: string): string {
  return name.includes('_') ? name.split('_').join('-') : name;
}

export function flagSet(defs: readonly FlagDef[]): FlagSet {
  const byName = new Map<string, FlagDef>();
  const byShort = new Map<string, FlagDef>();
  for (const d of defs) {
    byName.set(normalizeFlagName(d.name), d);
    if (d.shorthand) byShort.set(d.shorthand, d);
  }
  return { defs: [...defs], byName, byShort };
}

export function lookup(fs: FlagSet, name: string): FlagDef | undefined {
  return fs.byName.get(normalizeFlagName(name));
}

function noOpt(d: FlagDef): string {
  return d.noOptDefVal ?? (d.kind === 'bool' ? 'true' : '');
}

/** Go's %q of a string (strconv.Quote) for the ASCII range flag errors meet. */
export function goQuote(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    if (ch === '"' || ch === '\\') out += '\\' + ch;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\r') out += '\\r';
    else if (c < 0x20 || c === 0x7f) out += '\\x' + c.toString(16).padStart(2, '0');
    else out += ch;
  }
  return out + '"';
}

/** Go's %q of a byte (a rune literal): 'n'. */
function goQuoteRune(c: string): string {
  if (c === "'" || c === '\\') return `'\\${c}'`;
  return `'${c}'`;
}

/** strconv.ParseBool */
export function parseGoBool(s: string): boolean | undefined {
  if (['1', 't', 'T', 'TRUE', 'true', 'True'].includes(s)) return true;
  if (['0', 'f', 'F', 'FALSE', 'false', 'False'].includes(s)) return false;
  return undefined;
}

/**
 * strconv.ParseInt(s, 0, bits): base prefixes 0x, 0o, 0b and a leading 0 for octal, underscores
 * between digits only with a prefix-determined base. Returns the error text on failure.
 */
export function parseGoInt(s: string, bits: 32 | 64): { value: number } | { error: string } {
  const fn = 'strconv.ParseInt';
  const syntax = { error: `${fn}: parsing ${goQuote(s)}: invalid syntax` };
  let t = s;
  let neg = false;
  if (t.startsWith('+') || t.startsWith('-')) {
    neg = t.startsWith('-');
    t = t.slice(1);
  }
  if (t === '') return syntax;
  let base = 10;
  let digits = t;
  if (t.length > 1 && t[0] === '0') {
    const p = (t[1] as string).toLowerCase();
    if (p === 'x') [base, digits] = [16, t.slice(2)];
    else if (p === 'o') [base, digits] = [8, t.slice(2)];
    else if (p === 'b') [base, digits] = [2, t.slice(2)];
    else [base, digits] = [8, t.slice(1)];
  }
  // With base 0 underscores may separate digits (strconv underscoreOK).
  if (digits.includes('_')) {
    if (!underscoreOK(t)) return syntax;
    digits = digits.split('_').join('');
  }
  if (digits === '') return syntax;
  const valid = base === 16 ? /^[0-9a-fA-F]+$/ : base === 8 ? /^[0-7]+$/ : base === 2 ? /^[01]+$/ : /^[0-9]+$/;
  if (!valid.test(digits)) return syntax;
  const big = BigInt((base === 16 ? '0x' : base === 8 ? '0o' : base === 2 ? '0b' : '') + digits) * (neg ? -1n : 1n);
  const max = bits === 64 ? 9223372036854775807n : 2147483647n;
  const min = -max - 1n;
  if (big > max || big < min) return { error: `${fn}: parsing ${goQuote(s)}: value out of range` };
  return { value: Number(big) };
}

/** upstream: Go src/strconv/atoi.go underscoreOK (the sign is already removed). */
function underscoreOK(s: string): boolean {
  let saw = '^';
  let i = 0;
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

/** encoding/csv Reader.Read of one record, as pflag's readAsCSV calls it. */
export function readAsCSV(val: string): { value: string[] } | { error: string } {
  if (val === '') return { value: [] };
  const out: string[] = [];
  let i = 0;
  const line = val.split('\n')[0] as string;
  let col = 0;
  while (true) {
    if (line[i] === '"') {
      // Quoted field.
      let f = '';
      i++;
      col = i;
      for (;;) {
        if (i >= line.length) return { error: `parse error on line 1, column ${line.length + 1}: extraneous or missing " in quoted-field` };
        const c = line[i] as string;
        if (c === '"') {
          if (line[i + 1] === '"') {
            f += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        f += c;
        i++;
      }
      out.push(f);
      if (i >= line.length) break;
      if (line[i] !== ',') return { error: `parse error on line 1, column ${i + 1}: extraneous or missing " in quoted-field` };
      i++;
      if (i >= line.length) {
        out.push('');
        break;
      }
      continue;
    }
    const end = line.indexOf(',', i);
    const field = end < 0 ? line.slice(i) : line.slice(i, end);
    const q = field.indexOf('"');
    if (q >= 0) return { error: `parse error on line 1, column ${i + q + 1}: bare " in non-quoted-field` };
    out.push(field);
    if (end < 0) break;
    i = end + 1;
    col = i;
  }
  void col;
  return { value: out };
}

function flagNameForError(d: FlagDef): string {
  return d.shorthand ? `-${d.shorthand}, --${d.name}` : `--${d.name}`;
}

/** Flag.Value.Set: the new value, or the cause of an InvalidValueError. */
function setValue(d: FlagDef, raw: string, current: FlagValue, changed: boolean): { value: FlagValue } | { cause: string } {
  switch (d.kind) {
    case 'bool': {
      const b = parseGoBool(raw);
      return b === undefined ? { cause: `strconv.ParseBool: parsing ${goQuote(raw)}: invalid syntax` } : { value: b };
    }
    case 'int':
    case 'int64': {
      const r = parseGoInt(raw, 64);
      return 'error' in r ? { cause: r.error } : { value: r.value };
    }
    case 'int32': {
      const r = parseGoInt(raw, 32);
      return 'error' in r ? { cause: r.error } : { value: r.value };
    }
    case 'duration': {
      const r = parseGoDuration(raw);
      return 'error' in r ? { cause: r.error } : { value: raw };
    }
    case 'stringSlice': {
      const r = readAsCSV(raw);
      if ('error' in r) return { cause: r.error };
      return { value: changed ? [...(current as string[]), ...r.value] : r.value };
    }
    case 'stringArray':
      return { value: changed ? [...(current as string[]), raw] : [raw] };
    case 'string':
    case 'other':
      return { value: raw };
  }
}

/** pflag's parse with interspersed flags. Returns the parsed flags or the error text. */
export function parseFlags(fs: FlagSet, args: readonly string[]): ParsedFlags | { error: string; help?: boolean } {
  const values: Record<string, FlagValue> = {};
  for (const d of fs.defs) values[d.name] = Array.isArray(d.default) ? [...d.default] : d.default;
  const changed: string[] = [];
  const out: string[] = [];
  let argsLenAtDash = -1;

  const set = (d: FlagDef, raw: string): string | undefined => {
    const wasChanged = changed.includes(d.name);
    const r = setValue(d, raw, values[d.name] as FlagValue, wasChanged);
    if ('cause' in r) return `invalid argument ${goQuote(raw)} for ${goQuote(flagNameForError(d))} flag: ${r.cause}`;
    values[d.name] = r.value;
    if (!wasChanged) changed.push(d.name);
    return undefined;
  };

  let rest = [...args];
  while (rest.length > 0) {
    const s = rest.shift() as string;
    if (s.length === 0 || s[0] !== '-' || s.length === 1) {
      out.push(s);
      continue;
    }
    if (s[1] === '-') {
      if (s.length === 2) {
        argsLenAtDash = out.length;
        out.push(...rest);
        break;
      }
      // parseLongArg
      let name = s.slice(2);
      if (name.length === 0 || name[0] === '-' || name[0] === '=') return { error: `bad flag syntax: ${s}` };
      const eq = name.indexOf('=');
      const hasValue = eq >= 0;
      const value = hasValue ? name.slice(eq + 1) : '';
      name = hasValue ? name.slice(0, eq) : name;
      const d = lookup(fs, name);
      if (!d) {
        if (name === 'help') return { error: 'help', help: true };
        return { error: `unknown flag: --${name}` };
      }
      let v: string;
      if (hasValue) v = value;
      else if (noOpt(d) !== '') v = noOpt(d);
      else if (rest.length > 0) v = rest.shift() as string;
      else return { error: `flag needs an argument: --${name}` };
      const err = set(d, v);
      if (err) return { error: err };
      continue;
    }
    // parseShortArg. pflag passes the original remaining args to each shorthand of the group,
    // so in `-ab x` only the last shorthand that takes a value consumes x.
    let shorthands = s.slice(1);
    const original = rest;
    let a = rest;
    while (shorthands.length > 0) {
      const c = shorthands[0] as string;
      const d = fs.byShort.get(c);
      let outShorts = shorthands.slice(1);
      let outArgs = original;
      if (!d) {
        if (c === 'h') return { error: 'help', help: true };
        return { error: `unknown shorthand flag: ${goQuoteRune(c)} in -${shorthands}` };
      }
      let v: string;
      if (shorthands.length > 2 && shorthands[1] === '=') {
        v = shorthands.slice(2);
        outShorts = '';
      } else if (noOpt(d) !== '') v = noOpt(d);
      else if (shorthands.length > 1) {
        v = shorthands.slice(1);
        outShorts = '';
      } else if (original.length > 0) {
        v = original[0] as string;
        outArgs = original.slice(1);
      } else return { error: `flag needs an argument: ${goQuoteRune(c)} in -${shorthands}` };
      const err = set(d, v);
      if (err) return { error: err };
      shorthands = outShorts;
      a = outArgs;
    }
    rest = a;
  }
  return { values, changed, args: out, argsLenAtDash };
}

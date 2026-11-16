// Word expansion in bash's order (bash(1) 5.2 EXPANSION): brace expansion; then tilde, parameter
// and command substitution, left to right; then word splitting; then pathname expansion; then
// quote removal. Arithmetic expansion and process substitution are rejected by the parser.

import type { List, ParamOp, Word, WordPart } from './ast.ts';
import type { Op } from '../proc/program.ts';
import { expandPathname, hasGlobChars, type GlobFs, type PatChar } from './glob.ts';

export interface ExpandEnv {
  /** A variable or special parameter (`?`, `$`, `#`, `0`, `1`…); undefined when unset. */
  get(name: string): string | undefined;
  set(name: string, value: string): void;
  positional(): readonly string[];
  /** Home directory of `user`, or of the current user (`$HOME`) for ''. */
  home(user: string): string | undefined;
  commandSubstitution(body: List, src: string): Op<string>;
  glob: GlobFs;
}

/**
 * An expansion error: `${x:?}` and bad assignments. Message without the shell prefix. bash 5.2.21
 * abandons the rest of the command line in an interactive shell (status 1) and exits a
 * non-interactive one with status 127 (captured 2026-11-16).
 */
export class ExpansionError extends Error {}

type Seg = { text: string; quoted: boolean; split: boolean } | { brk: true };

const DEFAULT_IFS = ' \t\n';

// ---- brace expansion ---------------------------------------------------------------------------

type BraceTok = { ch: string } | { part: WordPart };

function toBraceToks(parts: readonly WordPart[]): BraceTok[] {
  const out: BraceTok[] = [];
  for (const p of parts) {
    if (p.t === 'lit') for (const ch of p.v) out.push({ ch });
    else out.push({ part: p });
  }
  return out;
}

function fromBraceToks(toks: readonly BraceTok[]): WordPart[] {
  const out: WordPart[] = [];
  for (const t of toks) {
    if ('ch' in t) {
      const last = out[out.length - 1];
      if (last?.t === 'lit') out[out.length - 1] = { t: 'lit', v: last.v + t.ch };
      else out.push({ t: 'lit', v: t.ch });
    } else out.push(t.part);
  }
  return out;
}

const isCh = (t: BraceTok | undefined, ch: string): boolean => t !== undefined && 'ch' in t && t.ch === ch;

/** {x..y[..incr]} with integers or single letters. docs: bash(1) Brace Expansion */
function sequence(body: string): string[] | undefined {
  const m = /^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(?:\.\.(-?\d+))?$/.exec(body);
  if (!m) return undefined;
  const [, a, b, inc] = m as unknown as [string, string, string, string | undefined];
  const numeric = /^-?\d+$/.test(a);
  if (numeric !== /^-?\d+$/.test(b)) return undefined;
  let step = Math.abs(inc === undefined ? 1 : Number(inc)) || 1;
  const out: string[] = [];
  if (numeric) {
    const x = Number(a);
    const y = Number(b);
    const pad = /^-?0\d/.test(a) || /^-?0\d/.test(b) ? Math.max(a.replace('-', '').length, b.replace('-', '').length) : 0;
    if (x > y) step = -step;
    for (let v = x; step > 0 ? v <= y : v >= y; v += step) {
      const s = String(Math.abs(v)).padStart(pad, '0');
      out.push(v < 0 ? `-${s}` : s);
    }
  } else {
    const x = a.charCodeAt(0);
    const y = b.charCodeAt(0);
    if (x > y) step = -step;
    for (let v = x; step > 0 ? v <= y : v >= y; v += step) out.push(String.fromCharCode(v));
  }
  return out;
}

function braceExpand(toks: BraceTok[]): BraceTok[][] {
  for (let i = 0; i < toks.length; i++) {
    if (!isCh(toks[i], '{')) continue;
    // `${` is a parameter expansion, never a brace.
    if (i > 0 && isCh(toks[i - 1], '$')) continue;
    let depth = 0;
    const commas: number[] = [];
    let close = -1;
    for (let j = i + 1; j < toks.length; j++) {
      if (isCh(toks[j], '{')) depth++;
      else if (isCh(toks[j], '}')) {
        if (depth === 0) {
          close = j;
          break;
        }
        depth--;
      } else if (isCh(toks[j], ',') && depth === 0) commas.push(j);
    }
    if (close < 0) continue;
    const prefix = toks.slice(0, i);
    const suffix = toks.slice(close + 1);
    let alts: BraceTok[][];
    if (commas.length > 0) {
      alts = [];
      let from = i + 1;
      for (const c of [...commas, close]) {
        alts.push(toks.slice(from, c));
        from = c + 1;
      }
    } else {
      const inner = toks.slice(i + 1, close);
      if (!inner.every((t) => 'ch' in t)) continue;
      const seq = sequence(inner.map((t) => (t as { ch: string }).ch).join(''));
      if (!seq) continue;
      alts = seq.map((s) => [...s].map((ch) => ({ ch })));
    }
    return alts.flatMap((alt) => braceExpand([...prefix, ...alt, ...suffix]));
  }
  return [toks];
}

// ---- parameter and command expansion -------------------------------------------------------------

/**
 * Tilde expansion inside an assignment-like word (`name=~/a:~/b`): after the `=` and after each
 * `:` of unquoted literal text. Bash does this for every simple command's arguments outside posix
 * mode, so `echo X=~` and `export X=~` both expand (bash(1) Tilde Expansion; checked on bash 5.2.21).
 */
function assignTildes(v: string, from: number, last: boolean, env: ExpandEnv): Seg[] {
  const out: Seg[] = [];
  let lit = v.slice(0, from);
  let i = from;
  while (i <= v.length) {
    if (v[i] === '~') {
      let end = i + 1;
      while (end < v.length && v[end] !== '/' && v[end] !== ':') end++;
      // The prefix must end at a slash, a colon, or the end of the word.
      if (end < v.length || last) {
        const home = env.home(v.slice(i + 1, end));
        if (home !== undefined) {
          if (lit !== '') out.push({ text: lit, quoted: false, split: false });
          out.push({ text: home, quoted: true, split: false });
          lit = '';
          i = end;
        }
      }
    }
    const colon = v.indexOf(':', i);
    const stop = colon < 0 ? v.length : colon + 1;
    lit += v.slice(i, stop);
    i = stop;
    if (colon < 0) break;
  }
  if (lit !== '') out.push({ text: lit, quoted: false, split: false });
  return out;
}

function* expandParts(parts: readonly WordPart[], env: ExpandEnv, inDq: boolean, tildeOk: boolean, assignWord = false): Op<Seg[]> {
  const out: Seg[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] as WordPart;
    switch (p.t) {
      case 'lit': {
        let v = p.v;
        if (assignWord && !inDq) {
          const eq = i === 0 ? v.indexOf('=') + 1 : 0;
          out.push(...assignTildes(v, eq, i === parts.length - 1, env));
          break;
        }
        if (i === 0 && tildeOk && v.startsWith('~')) {
          const slash = v.indexOf('/');
          const prefixEnd = slash < 0 ? v.length : slash;
          // The tilde-prefix must end at a slash or at the end of the word (not inside quotes).
          if (slash >= 0 || parts.length === 1) {
            const home = env.home(v.slice(1, prefixEnd));
            if (home !== undefined) {
              out.push({ text: home, quoted: true, split: false });
              v = v.slice(prefixEnd);
            }
          }
        }
        if (v !== '') out.push({ text: v, quoted: inDq, split: false });
        break;
      }
      case 'q':
        out.push({ text: p.v, quoted: true, split: false });
        break;
      case 'dq': {
        if (p.parts.length === 1 && p.parts[0]?.t === 'param' && p.parts[0].name === '@' && !p.parts[0].op && !p.parts[0].length) {
          // "$@": one field per positional parameter, none when there are none.
          const ps = env.positional();
          ps.forEach((v, k) => {
            if (k > 0) out.push({ brk: true });
            out.push({ text: v, quoted: true, split: false });
          });
          break;
        }
        const inner = yield* expandParts(p.parts, env, true, false);
        out.push({ text: '', quoted: true, split: false }, ...inner);
        break;
      }
      case 'param':
        out.push(...(yield* expandParam(p, env, inDq)));
        break;
      case 'cmd': {
        const text = (yield* env.commandSubstitution(p.body, p.src)).replace(/\n+$/, '');
        out.push({ text, quoted: inDq, split: !inDq });
        break;
      }
    }
  }
  return out;
}

function paramValue(name: string, env: ExpandEnv): string | undefined {
  if (name === '@' || name === '*') {
    const ps = env.positional();
    if (name === '*') {
      const ifs = env.get('IFS');
      return ps.join(ifs === undefined ? ' ' : ifs.slice(0, 1));
    }
    return ps.join(' ');
  }
  return env.get(name);
}

function* expandParam(p: Extract<WordPart, { t: 'param' }>, env: ExpandEnv, inDq: boolean): Op<Seg[]> {
  if (p.bad !== undefined) throw new ExpansionError(`${p.bad}: bad substitution`);
  const value = paramValue(p.name, env);
  if (p.length) {
    const n = p.name === '@' || p.name === '*' ? env.positional().length : [...(value ?? '')].length;
    return [{ text: String(n), quoted: inDq, split: !inDq }];
  }
  const plain = (v: string): Seg[] => [{ text: v, quoted: inDq, split: !inDq }];
  if (!p.op) return plain(value ?? '');
  const op: ParamOp = p.op;
  const colon = op.startsWith(':');
  const missing = value === undefined || (colon && value === '');
  const arg = function* (): Op<Seg[]> {
    return yield* expandParts(p.arg ?? [], env, inDq, true);
  };
  switch (op) {
    case ':-':
    case '-':
      return missing ? yield* arg() : plain(value as string);
    case ':+':
    case '+':
      return missing ? [] : yield* arg();
    case ':=':
    case '=': {
      if (!missing) return plain(value as string);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.name)) throw new ExpansionError(`$${p.name}: cannot assign in this way`);
      const v = segsToString(yield* arg());
      env.set(p.name, v);
      return plain(v);
    }
    case ':?':
    case '?': {
      if (!missing) return plain(value as string);
      const msg = segsToString(yield* arg());
      throw new ExpansionError(`${p.name}: ${msg !== '' ? msg : colon ? 'parameter null or not set' : 'parameter not set'}`);
    }
  }
}

function segsToString(segs: readonly Seg[]): string {
  return segs.map((s) => ('brk' in s ? ' ' : s.text)).join('');
}

// ---- splitting and globbing ----------------------------------------------------------------------

/** Field splitting (bash(1) Word Splitting) of expansion results; literal text is never split. */
function split(segs: readonly Seg[], ifs: string | undefined): PatChar[][] {
  const sep = ifs ?? DEFAULT_IFS;
  const ws: string[] = [...sep].filter((c) => c === ' ' || c === '\t' || c === '\n');
  const fields: PatChar[][] = [];
  let cur: PatChar[] = [];
  let started = false;
  const end = () => {
    if (started) fields.push(cur);
    cur = [];
    started = false;
  };
  for (const s of segs) {
    if ('brk' in s) {
      fields.push(cur);
      cur = [];
      started = false;
      continue;
    }
    if (!s.split || sep === '') {
      for (const c of s.text) cur.push({ c, quoted: s.quoted });
      if (s.quoted || s.text !== '') started = true;
      continue;
    }
    let pendingNonWs = false;
    for (const c of s.text) {
      if (ws.includes(c)) {
        end();
        continue;
      }
      if (sep.includes(c)) {
        // A non-whitespace separator delimits a field even when it is empty.
        if (!started && !pendingNonWs && fields.length === 0) fields.push([]);
        else if (started) end();
        else if (pendingNonWs) fields.push([]);
        pendingNonWs = true;
        continue;
      }
      pendingNonWs = false;
      cur.push({ c, quoted: false });
      started = true;
    }
  }
  end();
  return fields;
}

const text = (f: readonly PatChar[]): string => f.map((c) => c.c).join('');

/** Expands command words or arguments: all expansions, splitting and globbing. */
export function* expandWords(words: readonly Word[], env: ExpandEnv): Op<string[]> {
  const out: string[] = [];
  for (const w of words) {
    for (const toks of braceExpand(toBraceToks(w.parts))) {
      const wparts = fromBraceToks(toks);
      const first = wparts[0];
      const isAssign = first?.t === 'lit' && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(first.v);
      const segs = yield* expandParts(wparts, env, false, true, isAssign);
      for (const field of split(segs, env.get('IFS'))) {
        if (hasGlobChars(field)) {
          const matches = expandPathname(field, env.glob);
          if (matches.length > 0) {
            out.push(...matches);
            continue;
          }
        }
        out.push(text(field));
      }
    }
  }
  return out;
}

/**
 * The value of an assignment: no splitting and no globbing; a tilde is expanded at the start and
 * after each `:` (bash(1) Tilde Expansion).
 */
export function* expandAssignment(w: Word, env: ExpandEnv): Op<string> {
  const parts: WordPart[] = [];
  // Split leading literal text at colons so each piece may start with a tilde.
  const segs: Seg[] = [];
  const first = w.parts[0];
  if (first?.t === 'lit' && first.v.includes(':')) {
    const pieces = first.v.split(':');
    for (let i = 0; i < pieces.length; i++) {
      if (i > 0) segs.push({ text: ':', quoted: true, split: false });
      const rest: WordPart[] = i === pieces.length - 1 ? w.parts.slice(1) : [];
      const piece = pieces[i] as string;
      segs.push(...(yield* expandParts(piece === '' ? rest : [{ t: 'lit', v: piece }, ...rest], env, false, true)));
    }
  } else {
    parts.push(...w.parts);
    segs.push(...(yield* expandParts(parts, env, false, true)));
  }
  return segsToString(segs);
}

/** A redirection target: expanded and globbed; anything but exactly one word is ambiguous. */
export function* expandRedirTarget(w: Word, env: ExpandEnv): Op<string | undefined> {
  const words = yield* expandWords([w], env);
  return words.length === 1 ? words[0] : undefined;
}

/** An unquoted here-document body: parameter and command expansion only. */
export function* expandHeredoc(parts: readonly WordPart[], env: ExpandEnv): Op<string> {
  return segsToString(yield* expandParts(parts, env, true, false));
}

/** A word expanded to one string without splitting or globbing (`case` words, `[[`: later phases). */
export function* expandToString(w: Word, env: ExpandEnv): Op<string> {
  return segsToString(yield* expandParts(w.parts, env, true, true));
}

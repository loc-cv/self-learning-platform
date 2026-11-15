// POSIX basic and extended regular expressions, as GNU grep 3.11 reads them, translated to
// JavaScript regular expressions (used with the `u` flag).
//
// GNU grep checks every pattern with glibc's regcomp first (its errors, capitalized, win), then
// parses all patterns with gnulib's dfa, which prints the "at start of expression" warnings and a
// few errors of its own, and does most of the matching. This parser follows glibc's recursive
// descent (so the same input fails with the same message) and emits the dfa's meaning where the
// two differ (a repetition operator after an anchor or at the start of an extended expression).
// Patterns with back-references or word anchors are matched by glibc in a UTF-8 locale; for them
// glibc's meaning is emitted.
//   upstream: glibc 2.39 posix/regcomp.c (peek_token, parse_reg_exp, parse_branch,
//             parse_expression, parse_sub_exp, parse_dup_op, fetch_number, parse_bracket_exp,
//             parse_bracket_element, parse_bracket_symbol, build_range_exp), posix/regex.h
//             (RE_SYNTAX_GREP, RE_SYNTAX_EGREP), gnulib lib/dfa.c (lex, parse_bracket_exp)
//   reference: grep 3.11 error messages and warnings, captured 2026-11-16
//              (packages/host/transcripts/grep/regex.t, regex-errors.t)

import { utf8Length } from '../../text/utf8.ts';
import { CLASSES, NOT_SPACE_CLASS, NOT_WORD, SPACE_CLASS, WORD } from './classes.ts';

export type Syntax = 'basic' | 'extended';

/** A diagnostic of the dfa parse, printed after every pattern passed glibc's check. */
export interface DfaEvent {
  kind: 'warning' | 'error';
  message: string;
}

export interface Translation {
  /** JavaScript source for the `u` flag; capture groups are numbered from `groupOffset + 1`. */
  source: string;
  groups: number;
  events: DfaEvent[];
  /** Whether a leftmost-first match can be shorter than POSIX's leftmost-longest one. */
  ambiguous: boolean;
}

export type TranslateResult = { ok: true; value: Translation } | { ok: false; error: string };

/** glibc's regerror texts. upstream: glibc posix/regcomp.c __re_error_msgid */
const ERR = {
  BADPAT: 'Invalid regular expression',
  ECOLLATE: 'Invalid collation character',
  ECTYPE: 'Invalid character class name',
  EESCAPE: 'Trailing backslash',
  ESUBREG: 'Invalid back reference',
  EBRACK: 'Unmatched [, [^, [:, [., or [=',
  EPAREN: 'Unmatched ( or \\(',
  EBRACE: 'Unmatched \\{',
  BADBR: 'Invalid content of \\{\\}',
  ERANGE: 'Invalid range end',
  ESIZE: 'Regular expression too big',
  ERPAREN: 'Unmatched ) or \\)',
} as const;

/** upstream: glibc posix/regex.h RE_DUP_MAX (0x7fff) */
const RE_DUP_MAX = 0x7fff;
/** upstream: glibc posix/regcomp.c BRACKET_NAME_BUF_SIZE */
const BRACKET_NAME_BUF_SIZE = 32;

type Tok =
  | { t: 'char'; c: string; len: number }
  | { t: 'period' | 'bracket' | 'open' | 'close' | 'alt' | 'star' | 'plus' | 'question' | 'dupOpen' | 'dupClose' | 'backslash' | 'end'; len: number }
  | { t: 'anchor'; a: string; len: number }
  | { t: 'class'; k: string; len: number }
  | { t: 'backref'; n: number; len: number };

interface Quant {
  min: number;
  /** -1: unbounded. */
  max: number;
}

interface Atom {
  src: string;
  /** A single-character JavaScript atom that takes a quantifier as it is. */
  simple: boolean;
  group: boolean;
  /** An anchor (zero width). */
  anchor: boolean;
  /** When `src` is `base` with a quantifier. */
  quant?: { q: Quant; base: Atom };
}

class RegexError {
  readonly message: string;
  constructor(message: string) {
    this.message = message;
  }
}

const JS_SYNTAX = new Set([...'^$\\.*+?()[]{}|/']);

function literal(c: string): Atom {
  return { src: JS_SYNTAX.has(c) ? `\\${c}` : c, simple: true, group: false, anchor: false };
}

/** A character inside a JavaScript class. */
function classChar(c: string): string {
  return /^[0-9A-Za-z]$/.test(c) ? c : `\\u{${(c.codePointAt(0) as number).toString(16)}}`;
}


function quantSuffix(q: Quant): string {
  if (q.min === 0 && q.max === -1) return '*';
  if (q.min === 1 && q.max === -1) return '+';
  if (q.min === 0 && q.max === 1) return '?';
  if (q.max === q.min) return `{${q.min}}`;
  return q.max === -1 ? `{${q.min},}` : `{${q.min},${q.max}}`;
}

/** (X{a,b}){c,d} as one quantifier on X, when that is exactly the same language. */
function combine(inner: Quant, outer: Quant): Quant | undefined {
  if (outer.max === 0) return { min: 0, max: 0 };
  if (inner.max === -1 && (outer.min >= 1 || inner.min <= 1)) return { min: inner.min * outer.min, max: -1 };
  if (inner.min === 0 && inner.max === 1) return { min: 0, max: outer.max };
  if (outer.min <= 1 && outer.max === -1 && inner.min <= 1) return { min: inner.min * outer.min, max: -1 };
  return undefined;
}

const WORD_SET = WORD.slice(1, -1);
const ANCHORS: Record<string, string> = {
  '^': '^',
  $: '$',
  '`': '^',
  "'": '$',
  '<': `(?<![${WORD_SET}])(?=[${WORD_SET}])`,
  '>': `(?<=[${WORD_SET}])(?![${WORD_SET}])`,
  b: `(?:(?<![${WORD_SET}])(?=[${WORD_SET}])|(?<=[${WORD_SET}])(?![${WORD_SET}]))`,
  B: `(?:(?<=[${WORD_SET}])(?=[${WORD_SET}])|(?<![${WORD_SET}])(?![${WORD_SET}]))`,
};
const CLASS_ESCAPES: Record<string, string> = { w: WORD, W: NOT_WORD, s: SPACE_CLASS, S: NOT_SPACE_CLASS };

export function translate(pattern: string, syntax: Syntax, groupOffset = 0): TranslateResult {
  try {
    return { ok: true, value: new Parser(pattern, syntax, groupOffset).run() };
  } catch (e) {
    if (e instanceof RegexError) return { ok: false, error: e.message };
    throw e;
  }
}

/** Escapes a fixed string (-F). */
export function fixedSource(pattern: string): string {
  return [...pattern].map((c) => literal(c).src).join('');
}

class Parser {
  private readonly cps: string[];
  private readonly ere: boolean;
  /** glibc does the matching (back-references, word anchors): emit its meaning. */
  private readonly glibc: boolean;
  private cur: Tok = { t: 'end', len: 0 };
  private curPos = 0;
  private nsub = 0;
  private completed: boolean[] = [];
  /** dfa's `laststart`: only zero-width tokens since the start, `(` or `|`. */
  private laststart = true;
  private readonly events: DfaEvent[] = [];
  private dfaFailed = false;
  private ambiguous = false;

  private readonly offset: number;

  constructor(pattern: string, syntax: Syntax, offset: number) {
    this.offset = offset;
    this.cps = [...pattern];
    this.ere = syntax === 'extended';
    this.glibc = /\\[1-9<>bB]/.test(pattern);
  }

  run(): Translation {
    this.cur = this.peek(0, false);
    this.curPos = 0;
    const source = this.parseRegExp(0);
    return { source, groups: this.nsub, events: this.events, ambiguous: this.ambiguous };
  }

  private dfaWarn(message: string): void {
    if (!this.dfaFailed) this.events.push({ kind: 'warning', message });
  }

  private dfaError(message: string): void {
    if (!this.dfaFailed) this.events.push({ kind: 'error', message });
    this.dfaFailed = true;
  }

  /** upstream: regcomp.c peek_token, with RE_SYNTAX_GREP or RE_SYNTAX_EGREP. */
  private peek(i: number, caretHere: boolean): Tok {
    const cps = this.cps;
    const ere = this.ere;
    if (i >= cps.length) return { t: 'end', len: 0 };
    const c = cps[i] as string;
    if (c === '\\') {
      if (i + 1 >= cps.length) return { t: 'backslash', len: 1 };
      const c2 = cps[i + 1] as string;
      const ch: Tok = { t: 'char', c: c2, len: 2 };
      switch (c2) {
        case '|':
          return ere ? ch : { t: 'alt', len: 2 };
        case '<':
        case '>':
        case 'b':
        case 'B':
        case '`':
        case "'":
          return { t: 'anchor', a: c2, len: 2 };
        case 'w':
        case 'W':
        case 's':
        case 'S':
          return { t: 'class', k: c2, len: 2 };
        case '(':
          return ere ? ch : { t: 'open', len: 2 };
        case ')':
          return ere ? ch : { t: 'close', len: 2 };
        case '+':
          return ere ? ch : { t: 'plus', len: 2 };
        case '?':
          return ere ? ch : { t: 'question', len: 2 };
        case '{':
          return ere ? ch : { t: 'dupOpen', len: 2 };
        case '}':
          return ere ? ch : { t: 'dupClose', len: 2 };
        default:
          if (c2 >= '1' && c2 <= '9') return { t: 'backref', n: Number(c2) - 1, len: 2 };
          return ch;
      }
    }
    switch (c) {
      case '|':
        return ere ? { t: 'alt', len: 1 } : { t: 'char', c, len: 1 };
      case '*':
        return { t: 'star', len: 1 };
      case '+':
        return ere ? { t: 'plus', len: 1 } : { t: 'char', c, len: 1 };
      case '?':
        return ere ? { t: 'question', len: 1 } : { t: 'char', c, len: 1 };
      case '{':
        return ere ? { t: 'dupOpen', len: 1 } : { t: 'char', c, len: 1 };
      case '}':
        return ere ? { t: 'dupClose', len: 1 } : { t: 'char', c, len: 1 };
      case '(':
        return ere ? { t: 'open', len: 1 } : { t: 'char', c, len: 1 };
      case ')':
        return ere ? { t: 'close', len: 1 } : { t: 'char', c, len: 1 };
      case '[':
        return { t: 'bracket', len: 1 };
      case '.':
        return { t: 'period', len: 1 };
      case '^':
        // Basic: an anchor at the start, after \( and after \| (RE_CARET_ANCHORS_HERE).
        return ere || i === 0 || caretHere ? { t: 'anchor', a: '^', len: 1 } : { t: 'char', c, len: 1 };
      case '$': {
        // Basic: an anchor at the end and before \) or \|.
        if (ere || i + 1 === cps.length) return { t: 'anchor', a: '$', len: 1 };
        const next = this.peek(i + 1, false);
        return next.t === 'alt' || next.t === 'close' ? { t: 'anchor', a: '$', len: 1 } : { t: 'char', c, len: 1 };
      }
      default:
        return { t: 'char', c, len: 1 };
    }
  }

  /** The current token's type, read anew after calls that advance (no stale narrowing). */
  private tokType(): Tok['t'] {
    return this.cur.t;
  }

  private fetch(caretHere = false): void {
    this.curPos += this.cur.len;
    this.cur = this.peek(this.curPos, caretHere);
  }

  private parseRegExp(nest: number): string {
    const initial = [...this.completed];
    const branches = [this.parseBranch(nest)];
    while (this.cur.t === 'alt') {
      this.ambiguous = true;
      this.fetch(true);
      this.laststart = true;
      if (this.cur.t !== 'alt' && this.cur.t !== 'end' && (nest === 0 || this.cur.t !== 'close')) {
        // Each alternative sees only the groups completed before the alternation.
        const accumulated = [...this.completed];
        this.completed = [...initial];
        branches.push(this.parseBranch(nest));
        accumulated.forEach((v, k) => {
          if (v) this.completed[k] = true;
        });
      } else branches.push('');
    }
    return branches.join('|');
  }

  private parseBranch(nest: number): string {
    const branch: Atom[] = [];
    this.parseExpression(branch, nest);
    while (this.cur.t !== 'alt' && this.cur.t !== 'end' && (nest === 0 || this.cur.t !== 'close')) this.parseExpression(branch, nest);
    return branch.map((a) => a.src).join('');
  }

  private parseExpression(branch: Atom[], nest: number): void {
    const tok = this.cur;
    let atom: Atom;
    switch (tok.t) {
      case 'char':
        atom = literal(tok.c);
        this.laststart = false;
        break;
      case 'period':
        atom = { src: '[^]', simple: true, group: false, anchor: false };
        this.laststart = false;
        break;
      case 'class':
        atom = { src: CLASS_ESCAPES[tok.k] as string, simple: true, group: false, anchor: false };
        this.laststart = false;
        break;
      case 'bracket':
        atom = this.parseBracket();
        this.laststart = false;
        break;
      case 'backref':
        if (this.completed[tok.n] !== true) throw new RegexError(ERR.ESUBREG);
        // Grouped so that a following digit is not read as part of the number.
        atom = { src: `(?:\\${tok.n + 1 + this.offset})`, simple: true, group: false, anchor: false };
        this.ambiguous = true;
        this.laststart = false;
        break;
      case 'open':
        atom = this.parseSubExp(nest + 1);
        this.laststart = false;
        break;
      case 'star':
      case 'plus':
      case 'question':
      case 'dupOpen':
        if (this.ere) {
          // RE_CONTEXT_INDEP_OPS: glibc skips the operator and parses what follows.
          this.leadingOperator(branch);
          this.parseExpression(branch, nest);
          return;
        }
        // Basic: an operator at the start of an expression is an ordinary character.
        if (!this.laststart && !this.glibc && branch.length > 0 && (branch[branch.length - 1] as Atom).anchor) {
          // dfa reads it as a repetition of the preceding anchor.
          this.leadingOperator(branch);
          return;
        }
        atom = literal(tok.t === 'star' ? '*' : tok.t === 'plus' ? '+' : tok.t === 'question' ? '?' : '{');
        this.laststart = false;
        break;
      case 'close':
        if (!this.ere) throw new RegexError(ERR.ERPAREN);
        atom = literal(')');
        this.laststart = false;
        break;
      case 'dupClose':
        atom = literal('}');
        this.laststart = false;
        break;
      case 'anchor':
        // Anchors take no repetition operator in glibc: what follows starts a new expression.
        branch.push({ src: ANCHORS[tok.a] as string, simple: false, group: false, anchor: true });
        this.fetch();
        return;
      case 'alt':
      case 'end':
        return;
      case 'backslash':
        throw new RegexError(ERR.EESCAPE);
    }
    this.fetch();
    for (;;) {
      const t = this.cur.t;
      if (t !== 'star' && t !== 'plus' && t !== 'question' && t !== 'dupOpen') break;
      const q = this.parseDupOp();
      if (q === undefined) break;
      atom = this.quantify(atom, q);
    }
    branch.push(atom);
  }

  /**
   * A repetition operator where glibc starts a new expression: at the start of an extended
   * expression (skipped), or after an anchor. dfa applies it to the preceding anchor, if any.
   */
  private leadingOperator(branch: Atom[]): void {
    const tok = this.cur;
    const last = branch[branch.length - 1];
    const target = !this.glibc && last !== undefined && last.anchor ? branch.length - 1 : -1;
    let q: Quant;
    if (tok.t === 'dupOpen') {
      const iv = this.dfaInterval(this.curPos + tok.len, tok.len === 2);
      if (iv === undefined) {
        // dfa: an invalid interval is an ordinary `{` (RE_INVALID_INTERVAL_ORD).
        // Basic syntax has no such fallback (only reached when dfa reads `\{` after an anchor).
        if (!this.ere) this.dfaError('invalid content of \\{\\}');
        if (!this.glibc) branch.push(literal('{'));
        this.laststart = false;
        this.fetch();
        return;
      }
      if (this.laststart && this.ere) this.dfaWarn('{...} at start of expression');
      if (iv.q.max > RE_DUP_MAX) this.dfaError('regular expression too big');
      this.laststart = false;
      q = iv.q;
      if (this.glibc) this.fetch();
      else {
        this.curPos = iv.end;
        this.cur = this.peek(iv.end, false);
      }
    } else {
      if (this.laststart && this.ere) this.dfaWarn(`${tok.t === 'star' ? '*' : tok.t === 'plus' ? '+' : '?'} at start of expression`);
      q = tok.t === 'star' ? { min: 0, max: -1 } : tok.t === 'plus' ? { min: 1, max: -1 } : { min: 0, max: 1 };
      this.fetch();
    }
    // A repeated anchor: zero repetitions allowed means it may as well be absent.
    if (target >= 0 && q.min === 0) branch.splice(target, 1);
  }

  /** dfa's reading of `{m,n}` (after the brace). upstream: gnulib dfa.c lex, case '{' */
  private dfaInterval(i: number, backslash: boolean): { q: Quant; end: number } | undefined {
    const cps = this.cps;
    let p = i;
    let min = -1;
    let max = -1;
    const digit = (k: number): boolean => k < cps.length && /^[0-9]$/.test(cps[k] as string);
    for (; digit(p); p++) min = min < 0 ? Number(cps[p]) : Math.min(RE_DUP_MAX + 1, min * 10 + Number(cps[p]));
    if (p < cps.length) {
      if (cps[p] !== ',') max = min;
      else {
        if (min < 0) min = 0;
        while (digit(++p)) max = max < 0 ? Number(cps[p]) : Math.min(RE_DUP_MAX + 1, max * 10 + Number(cps[p]));
      }
    }
    if (backslash) {
      if (cps[p] !== '\\') return undefined;
      p++;
    }
    if (cps[p] !== '}' || min < 0 || (max >= 0 && min > max)) return undefined;
    return { q: { min, max }, end: p + 1 };
  }

  /** upstream: regcomp.c fetch_number. -1: no digits, -2: not a number. */
  private fetchNumber(): number {
    let num = -1;
    for (;;) {
      this.fetch();
      const tok = this.cur;
      if (tok.t === 'end') return -2;
      if (tok.t === 'dupClose' || (tok.t === 'char' && tok.c === ',')) break;
      num = tok.t !== 'char' || !/^[0-9]$/.test(tok.c) || num === -2 ? -2 : num === -1 ? Number(tok.c) : Math.min(RE_DUP_MAX + 1, num * 10 + Number(tok.c));
    }
    return num;
  }

  /** upstream: regcomp.c parse_dup_op. Undefined when an extended `{` turned out to be literal. */
  private parseDupOp(): Quant | undefined {
    const tok = this.cur;
    if (tok.t !== 'dupOpen') {
      this.fetch();
      return tok.t === 'star' ? { min: 0, max: -1 } : tok.t === 'plus' ? { min: 1, max: -1 } : { min: 0, max: 1 };
    }
    const startPos = this.curPos;
    let start = this.fetchNumber();
    let end = 0;
    const isComma = (): boolean => this.cur.t === 'char' && (this.cur as { c: string }).c === ',';
    if (start === -1) {
      if (isComma()) start = 0;
      else throw new RegexError(ERR.BADBR);
    }
    if (start !== -2) end = this.cur.t === 'dupClose' ? start : isComma() ? this.fetchNumber() : -2;
    if (start === -2 || end === -2) {
      if (!this.ere) throw new RegexError(this.cur.t === 'end' ? ERR.EBRACE : ERR.BADBR);
      // RE_INVALID_INTERVAL_ORD: the brace is an ordinary character.
      this.curPos = startPos;
      this.cur = { t: 'char', c: '{', len: 1 };
      return undefined;
    }
    if ((end !== -1 && start > end) || this.cur.t !== 'dupClose') throw new RegexError(ERR.BADBR);
    if ((end === -1 ? start : end) > RE_DUP_MAX) throw new RegexError(ERR.ESIZE);
    this.fetch();
    this.laststart = false;
    return { min: start, max: end };
  }

  private quantify(atom: Atom, q: Quant): Atom {
    if (atom.group || !atom.simple) this.ambiguous = true;
    if (atom.quant) {
      const c = combine(atom.quant.q, q);
      if (c) return this.quantify(atom.quant.base, c);
    }
    if (q.max === 0) return { src: '(?:)', simple: false, group: false, anchor: false };
    const base = atom.simple || atom.group ? atom.src : `(?:${atom.src})`;
    return { src: base + quantSuffix(q), simple: false, group: false, anchor: false, quant: { q, base: atom } };
  }

  /** upstream: regcomp.c parse_sub_exp */
  private parseSubExp(nest: number): Atom {
    const idx = this.nsub++;
    this.laststart = true;
    this.fetch(true);
    let inner = '';
    if (this.cur.t !== 'close') {
      inner = this.parseRegExp(nest);
      if (this.tokType() !== 'close') throw new RegexError(ERR.EPAREN);
    }
    if (idx < 9) this.completed[idx] = true;
    return { src: `(${inner})`, simple: false, group: true, anchor: false };
  }

  // --- Bracket expressions ---------------------------------------------------------------

  private peekBracket(i: number): BTok {
    const cps = this.cps;
    if (i >= cps.length) return { t: 'end', len: 0 };
    const c = cps[i] as string;
    if (c === '[') {
      const c2 = i + 1 < cps.length ? cps[i + 1] : '';
      if (c2 === '.' || c2 === '=' || c2 === ':') return { t: 'open', delim: c2, len: 2 };
      return { t: 'char', c, len: 1 };
    }
    if (c === '-') return { t: 'range', c, len: 1 };
    if (c === ']') return { t: 'close', c, len: 1 };
    if (c === '^') return { t: 'nonmatch', c, len: 1 };
    return { t: 'char', c, len: 1 };
  }

  /** upstream: regcomp.c parse_bracket_element. Returns the element and the index after it. */
  private bracketElement(i: number, tok: BTok, acceptHyphen: boolean): [Elem, number] {
    i += tok.len;
    if (tok.t === 'open') return this.bracketSymbol(i, tok.delim);
    if (tok.t === 'range' && !acceptHyphen) {
      // A '-' that does not start a range must be last.
      if (this.peekBracket(i).t !== 'close') throw new RegexError(ERR.ERANGE);
    }
    return [{ type: 'char', c: (tok as { c: string }).c }, i];
  }

  /** upstream: regcomp.c parse_bracket_symbol */
  private bracketSymbol(i: number, delim: string): [Elem, number] {
    const cps = this.cps;
    if (i >= cps.length) throw new RegexError(ERR.EBRACK);
    let name = '';
    for (;;) {
      if (utf8Length(name) >= BRACKET_NAME_BUF_SIZE) throw new RegexError(ERR.EBRACK);
      const ch = cps[i++] as string;
      if (i >= cps.length) throw new RegexError(ERR.EBRACK);
      if (ch === delim && cps[i] === ']') break;
      name += ch;
    }
    i++;
    const type = delim === '.' ? 'coll' : delim === '=' ? 'equiv' : 'class';
    return [{ type, c: name }, i];
  }

  /** upstream: regcomp.c parse_bracket_exp; the dfa's [:space:] check follows. */
  private parseBracket(): Atom {
    const start = this.curPos + 1;
    let i = start;
    let tok = this.peekBracket(i);
    if (tok.t === 'end') throw new RegexError(ERR.BADPAT);
    let negate = false;
    if (tok.t === 'nonmatch') {
      negate = true;
      i += tok.len;
      tok = this.peekBracket(i);
      if (tok.t === 'end') throw new RegexError(ERR.BADPAT);
    }
    const body = i;
    if (tok.t === 'close') tok = { t: 'char', c: ']', len: 1 };
    let set = '';
    const exprs: string[] = [];
    let first = true;
    // C.UTF-8 has no collating elements or equivalence classes beyond single bytes.
    const single = (e: Elem): string => {
      if (e.type !== 'char' && utf8Length(e.c) !== 1) throw new RegexError(ERR.ECOLLATE);
      return e.c;
    };
    for (;;) {
      const [startEl, i2] = this.bracketElement(i, tok, first);
      i = i2;
      first = false;
      tok = this.peekBracket(i);
      let range: BTok | undefined;
      if (startEl.type !== 'class' && startEl.type !== 'equiv') {
        if (tok.t === 'end') throw new RegexError(ERR.EBRACK);
        if (tok.t === 'range') {
          const t2 = this.peekBracket(i + 1);
          if (t2.t === 'end') throw new RegexError(ERR.EBRACK);
          if (t2.t === 'close') tok = { t: 'char', c: '-', len: 1 };
          else {
            i += 1;
            range = t2;
          }
        }
      }
      if (range) {
        const [endEl, i3] = this.bracketElement(i, range, true);
        i = i3;
        tok = this.peekBracket(i);
        if (endEl.type === 'class' || endEl.type === 'equiv') throw new RegexError(ERR.ERANGE);
        const lo = single(startEl);
        const hi = single(endEl);
        // RE_NO_EMPTY_RANGES; C.UTF-8 collates in code point order.
        if ((lo.codePointAt(0) as number) > (hi.codePointAt(0) as number)) throw new RegexError(ERR.ERANGE);
        set += `${classChar(lo)}-${classChar(hi)}`;
      } else if (startEl.type === 'class') {
        const frag = CLASSES[startEl.c];
        if (!frag) throw new RegexError(ERR.ECTYPE);
        if ('set' in frag) set += frag.set;
        else exprs.push(frag.expr);
      } else set += classChar(single(startEl));
      if (tok.t === 'end') throw new RegexError(ERR.EBRACK);
      if (tok.t === 'close') break;
    }
    const end = i + 1;
    this.colonCheck(body);
    this.cur = { t: 'bracket', len: end - this.curPos };
    const parts = [...(set !== '' ? [`[${set}]`] : []), ...exprs];
    if (!negate) {
      if (exprs.length === 0) return { src: `[${set}]`, simple: true, group: false, anchor: false };
      return { src: `(?:${parts.join('|')})`, simple: false, group: true, anchor: false };
    }
    if (exprs.length === 0) return { src: `[^${set}]`, simple: true, group: false, anchor: false };
    return { src: `(?!${parts.join('|')})[^]`, simple: false, group: false, anchor: false };
  }

  /**
   * dfa: `[:alpha:]` written without the outer brackets is an error in grep.
   * upstream: gnulib dfa.c parse_bracket_exp (colon_warning_state, DFA_CONFUSING_BRACKETS_ERROR)
   */
  private colonCheck(from: number): void {
    const cps = this.cps;
    let i = from;
    const fetch = (): string => cps[i++] ?? ']';
    let c = fetch();
    let state = c === ':' ? 1 : 0;
    do {
      let c1: string | undefined;
      state &= ~2;
      if (c === '[') {
        c1 = fetch();
        if (c1 === ':' || c1 === '.' || c1 === '=') {
          const delim = c1;
          while (i < cps.length && !(cps[i] === delim && cps[i + 1] === ']')) i++;
          i += 2;
          state |= 8;
          c = fetch();
          continue;
        }
      }
      if (c1 === undefined) c1 = fetch();
      if (c1 === '-') {
        let c2 = fetch();
        if (c2 === '[' && cps[i] === '.') c2 = ']';
        if (c2 === ']') i--;
        else {
          state |= 8;
          c = fetch();
          continue;
        }
      }
      state |= c === ':' ? 2 : 4;
      c = c1;
    } while (c !== ']');
    if (state === 7) this.dfaError('character class syntax is [[:space:]], not [:space:]');
  }
}

type BTok =
  | { t: 'end'; len: number }
  | { t: 'open'; delim: string; len: number }
  | { t: 'char' | 'range' | 'close' | 'nonmatch'; c: string; len: number };

interface Elem {
  type: 'char' | 'coll' | 'equiv' | 'class';
  c: string;
}

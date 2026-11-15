// Lexer and parser for the supported bash subset (docs/COVERAGE.md lists it). A recursive-descent
// parser over the source text, because bash's grammar is context-sensitive: reserved words count
// only in command position, aliases are substituted into the input as it is read, and
// here-document bodies start after the next newline.
//   docs: bash(1) 5.2 SHELL GRAMMAR, QUOTING, ALIASES, REDIRECTION, Here Documents, EXPANSION
//   reference: bash 5.2.21 syntax error messages, captured 2026-11-16 (transcripts in
//              packages/host/transcripts/shell/syntax.t)
//
// The parser reads one command line at a time, as bash does: an alias defined on a line takes
// effect from the next line, and a syntax error on a later line does not stop earlier ones.
// Constructs outside the subset are reported as `unsupported` before anything runs.

import { byteChar, decodeBytes } from '../text/bytes.ts';
import type { AndOr, Assign, Command, List, ParamOp, Pipeline, Redir, RedirOp, SimpleCommand, Word, WordPart } from './ast.ts';

export type ParseResult =
  /** `list` is null for a line with nothing to run. `end` is where the next command line starts. */
  | { kind: 'ok'; list: List | null; end: number; src: string; warnings: string[] }
  /** More input is needed (an open quote, a `|` at the end, an unterminated here-document). */
  | { kind: 'incomplete'; need: Incomplete }
  /** A syntax error, with bash's message (without the `-bash: ` prefix). */
  | { kind: 'error'; message: string; line: number; lineText: string; end: number }
  /** A construct the simulator does not support: `what` names it for the notice. */
  | { kind: 'unsupported'; what: string; end: number; src: string };

export type Incomplete = { kind: 'quote'; ch: string } | { kind: 'heredoc'; delim: string; line: number } | { kind: 'eof' };

export interface ParseOptions {
  aliases: Readonly<Record<string, string>>;
  expandAliases: boolean;
  /** Interactive shells perform history expansion on `!`, which is not supported. */
  history: boolean;
  /** Line number of `src[0]`. */
  line: number;
  /**
   * No more input will come: an unterminated here-document ends at end of file with a warning,
   * and an open construct is a syntax error instead of `incomplete`.
   */
  final: boolean;
}

class IncompleteInput extends Error {
  readonly need: Incomplete;
  constructor(need: Incomplete) {
    super('incomplete');
    this.need = need;
  }
}
class SyntaxError_ extends Error {
  readonly at: number;
  constructor(message: string, at: number) {
    super(message);
    this.at = at;
  }
}
class Unsupported extends Error {
  readonly what: string;
  constructor(what: string) {
    super(what);
    this.what = what;
  }
}

type Token =
  | { t: 'word'; word: Word; start: number; end: number; plain: string | undefined }
  | { t: 'op'; v: string; start: number; end: number }
  | { t: 'redir'; op: RedirOp; fd?: number; start: number; end: number }
  | { t: 'nl'; start: number; end: number }
  | { t: 'eof'; start: number; end: number };

const META = new Set([' ', '\t', '\n', ';', '&', '|', '<', '>', '(', ')']);
const RESERVED_UNSUPPORTED: Record<string, string> = {
  if: 'the "if" statement',
  case: 'the "case" statement',
  for: 'the "for" loop',
  while: 'the "while" loop',
  until: 'the "until" loop',
  select: 'the "select" statement',
  function: 'defining a function',
  time: 'the "time" keyword',
  coproc: 'the "coproc" keyword',
  '[[': 'the "[[" conditional command',
};
/** Reserved words that cannot start a command: bash reports them as unexpected tokens. */
const RESERVED_CLOSERS = new Set(['then', 'elif', 'else', 'fi', 'do', 'done', 'esac', '}']);

const isName = (s: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);

/** Parses one command line of `src` starting at `pos`. */
export function parseCommandLine(src0: string, pos0: number, opts: ParseOptions): ParseResult {
  let src = src0;
  let pos = pos0;
  let peeked: Token | undefined;
  const pendingHeredocs: { redir: Redir; delim: string; strip: boolean; quoted: boolean; line: number }[] = [];
  const guards: { name: string; end: number }[] = [];
  const warnings: string[] = [];
  /** `&` is unsupported, but the rest of the line is parsed first so a syntax error wins, as in bash. */
  let background = false;

  const lineAt = (at: number): number => {
    let n = opts.line;
    for (let i = 0; i < at && i < src.length; i++) if (src[i] === '\n') n++;
    return n;
  };
  const incomplete = (need: Incomplete): never => {
    throw new IncompleteInput(need);
  };

  // ---- characters ------------------------------------------------------------------------------

  const skipBlanks = (): void => {
    for (;;) {
      const c = src[pos];
      if (c === ' ' || c === '\t') pos++;
      else if (c === '\\' && src[pos + 1] === '\n') pos += 2;
      else if (c === '\\' && pos + 1 === src.length && !opts.final) incomplete({ kind: 'eof' });
      else break;
    }
  };

  // ---- words -----------------------------------------------------------------------------------

  /** History expansion: `!` followed by something other than a blank, `=`, `(` or the end (bash(1) HISTORY EXPANSION). */
  const checkBang = (at: number): void => {
    if (!opts.history) return;
    const n = src[at + 1];
    if (n === undefined || n === ' ' || n === '\t' || n === '\n' || n === '=' || n === '(' || n === '"') return;
    throw new Unsupported('history expansion with "!"');
  };

  const pushLit = (parts: WordPart[], t: 'lit' | 'q', v: string): void => {
    const last = parts[parts.length - 1];
    if (last && last.t === t) parts[parts.length - 1] = { t, v: last.v + v };
    else parts.push({ t, v });
  };

  /** ANSI-C quoting $'…'. docs: bash(1) QUOTING */
  const readAnsiC = (): string => {
    let out = '';
    for (;;) {
      const c = src[pos];
      if (c === undefined) return incomplete({ kind: 'quote', ch: "'" });
      pos++;
      if (c === "'") return decodeBytes(out);
      if (c !== '\\') {
        out += c;
        continue;
      }
      const e = src[pos++];
      const simple: Record<string, string> = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
      if (e === undefined) return incomplete({ kind: 'quote', ch: "'" });
      if (e in simple) out += simple[e];
      else if (/[0-7]/.test(e)) {
        let digits = e;
        while (digits.length < 3 && /[0-7]/.test(src[pos] ?? '')) digits += src[pos++];
        out += byteChar(parseInt(digits, 8) & 0xff);
      } else if (e === 'x' && /[0-9a-fA-F]/.test(src[pos] ?? '')) {
        let digits = '';
        while (digits.length < 2 && /[0-9a-fA-F]/.test(src[pos] ?? '')) digits += src[pos++];
        out += byteChar(parseInt(digits, 16));
      } else if (e === 'c' && src[pos] !== undefined) {
        out += String.fromCharCode((src[pos++] as string).toUpperCase().charCodeAt(0) ^ 0x40);
      } else out += `\\${e}`;
    }
  };

  /** `$…` at `pos` (pointing at the `$`). Returns the part, or undefined for a literal `$`. */
  const readDollar = (inDq: boolean): WordPart | undefined => {
    const n = src[pos + 1];
    if (n === '(') {
      if (src[pos + 2] === '(') throw new Unsupported('arithmetic expansion "$(( ))"');
      const start = pos;
      pos += 2;
      const body = parseInner(')');
      return { t: 'cmd', body, src: src.slice(start, pos) };
    }
    if (n === '{') return readBrace();
    if (n !== undefined && /[A-Za-z_]/.test(n)) {
      let end = pos + 1;
      while (end < src.length && /[A-Za-z0-9_]/.test(src[end] as string)) end++;
      const name = src.slice(pos + 1, end);
      pos = end;
      return { t: 'param', name };
    }
    if (n !== undefined && /[0-9?$#@*!-]/.test(n)) {
      pos += 2;
      return { t: 'param', name: n };
    }
    if (n === "'" && !inDq) {
      pos += 2;
      return { t: 'q', v: readAnsiC() };
    }
    if (n === '"' && !inDq) {
      // $"…" is locale translation; with no message catalog it is "…".
      pos += 1;
      return undefined;
    }
    pos++;
    return { t: inDq ? 'q' : 'lit', v: '$' };
  };

  /** ${…}. docs: bash(1) Parameter Expansion */
  const readBrace = (): WordPart => {
    const start = pos;
    pos += 2;
    let length = false;
    if (src[pos] === '#' && src[pos + 1] !== '}' && src[pos + 1] !== undefined) {
      length = true;
      pos++;
    }
    let name = '';
    if (/[A-Za-z_]/.test(src[pos] ?? '')) {
      while (/[A-Za-z0-9_]/.test(src[pos] ?? '')) name += src[pos++];
    } else if (/[0-9]/.test(src[pos] ?? '')) {
      while (/[0-9]/.test(src[pos] ?? '')) name += src[pos++];
    } else if (/[?$#@*!-]/.test(src[pos] ?? '')) {
      name = src[pos++] as string;
    }
    const unsupported = (): never => {
      // Find the closing brace to name the construct as written.
      let depth = 0;
      let i = start + 2;
      for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
          if (depth === 0) break;
          depth--;
        }
      }
      if (i >= src.length && !opts.final) return incomplete({ kind: 'eof' });
      throw new Unsupported(`the parameter expansion "${src.slice(start, i + 1)}"`);
    };
    if (src[pos] === undefined) return incomplete({ kind: 'eof' });
    if (src[pos] === '}') {
      pos++;
      // bash accepts `${}` when parsing and fails when expanding it.
      if (name === '') return { t: 'param', name: '', bad: src.slice(start, pos) };
      return length ? { t: 'param', name, length: true } : { t: 'param', name };
    }
    if (name === '' || length) return unsupported();
    const ops: ParamOp[] = [':-', ':=', ':+', ':?', '-', '=', '+', '?'];
    const op = ops.find((o) => src.startsWith(o, pos));
    if (!op) return unsupported();
    pos += op.length;
    const arg = readWordParts('brace');
    if (src[pos] !== '}') return incomplete({ kind: 'eof' });
    pos++;
    return { t: 'param', name, op, arg };
  };

  /** `…` command substitution: the body has \$, \` and \\ unescaped, then is parsed on its own. */
  const readBacktick = (): WordPart => {
    const start = pos;
    pos++;
    let body = '';
    for (;;) {
      const c = src[pos];
      if (c === undefined) return incomplete({ kind: 'quote', ch: '`' });
      pos++;
      if (c === '`') break;
      if (c === '\\' && (src[pos] === '$' || src[pos] === '`' || src[pos] === '\\')) {
        body += src[pos++];
        continue;
      }
      body += c;
    }
    const inner = parseCommandLineList(body, opts);
    return { t: 'cmd', body: inner, src: src.slice(start, pos) };
  };

  /** "…" contents; `pos` is after the opening quote. */
  const readDq = (): WordPart => {
    const parts: WordPart[] = [];
    for (;;) {
      const c = src[pos];
      if (c === undefined) return incomplete({ kind: 'quote', ch: '"' });
      if (c === '"') {
        pos++;
        return { t: 'dq', parts };
      }
      if (c === '\\') {
        const n = src[pos + 1];
        if (n === undefined) return incomplete({ kind: 'quote', ch: '"' });
        if (n === '\n') pos += 2;
        else if (n === '$' || n === '`' || n === '"' || n === '\\') {
          pushLit(parts, 'q', n);
          pos += 2;
        } else {
          pushLit(parts, 'q', '\\');
          pos++;
        }
        continue;
      }
      if (c === '$') {
        const part = readDollar(true);
        if (part) {
          if (part.t === 'q') pushLit(parts, 'q', part.v);
          else parts.push(part);
        }
        continue;
      }
      if (c === '`') {
        parts.push(readBacktick());
        continue;
      }
      if (c === '!') checkBang(pos);
      pushLit(parts, 'q', c);
      pos++;
    }
  };

  /**
   * Word parts up to an unquoted metacharacter (`word`), the closing brace of ${…} (`brace`), or
   * the end of a here-document body (`heredoc`, where only \$ \` \\ and \newline are escapes).
   */
  function readWordParts(mode: 'word' | 'brace'): WordPart[] {
    const parts: WordPart[] = [];
    let depth = 0;
    for (;;) {
      const c = src[pos];
      if (c === undefined) {
        if (mode === 'brace') return incomplete({ kind: 'eof' });
        return parts;
      }
      if (mode === 'word' && META.has(c)) return parts;
      if (mode === 'brace') {
        if (c === '}' && depth === 0) return parts;
        if (c === '{') depth++;
        if (c === '}') depth--;
      }
      if (c === '\\') {
        const n = src[pos + 1];
        if (n === undefined) {
          if (!opts.final) incomplete({ kind: 'eof' });
          pos++;
          continue;
        }
        pos += 2;
        if (n !== '\n') pushLit(parts, 'q', n);
        continue;
      }
      if (c === "'") {
        pos++;
        const end = src.indexOf("'", pos);
        if (end < 0) return incomplete({ kind: 'quote', ch: "'" });
        // An empty '' still makes the word exist: it leaves a quoted part.
        pushLit(parts, 'q', src.slice(pos, end));
        pos = end + 1;
        continue;
      }
      if (c === '"') {
        pos++;
        parts.push(readDq());
        continue;
      }
      if (c === '$') {
        if (src[pos + 1] === '"') {
          pos += 2;
          parts.push(readDq());
          continue;
        }
        const part = readDollar(false);
        if (part) {
          if (part.t === 'lit' || part.t === 'q') pushLit(parts, part.t, part.v);
          else parts.push(part);
        }
        continue;
      }
      if (c === '`') {
        parts.push(readBacktick());
        continue;
      }
      if (c === '!' && mode === 'word') checkBang(pos);
      pushLit(parts, 'lit', c);
      pos++;
    }
  }

  // ---- tokens ----------------------------------------------------------------------------------

  const lex = (): Token => {
    skipBlanks();
    const start = pos;
    const c = src[pos];
    if (c === undefined) return { t: 'eof', start, end: pos };
    if (c === '#') {
      while (pos < src.length && src[pos] !== '\n') pos++;
      return lex();
    }
    if (c === '\n') {
      pos++;
      return { t: 'nl', start, end: pos };
    }
    // An io number: digits immediately followed by < or >.
    const io = /^[0-9]+(?=[<>])/.exec(src.slice(pos, pos + 12));
    if (io) {
      pos += io[0].length;
      const r = lexRedir(start);
      if (r.t === 'redir') return { ...r, fd: Number(io[0]) };
      return r;
    }
    if (c === '<' || c === '>' || (c === '&' && src[pos + 1] === '>')) return lexRedir(start);
    for (const op of ['&&', '||', ';;', '|&', ';', '&', '|', '(', ')']) {
      if (src.startsWith(op, pos)) {
        pos += op.length;
        return { t: 'op', v: op, start, end: pos };
      }
    }
    const parts = readWordParts('word');
    const text = src.slice(start, pos);
    const plain = parts.length === 1 && parts[0]?.t === 'lit' ? parts[0].v : parts.length === 0 ? '' : undefined;
    return { t: 'word', word: { parts, text }, start, end: pos, plain };
  };

  const lexRedir = (start: number): Token => {
    const ops: RedirOp[] = ['<<<', '<<-', '<<', '<>', '<&', '&>>', '&>', '>>', '>&', '>|', '<', '>'];
    if (src.startsWith('<(', pos) || src.startsWith('>(', pos)) throw new Unsupported('process substitution');
    const op = ops.find((o) => src.startsWith(o, pos)) as RedirOp;
    pos += op.length;
    return { t: 'redir', op, start, end: pos };
  };

  const peek = (): Token => (peeked ??= lex());
  const take = (): Token => {
    const t = peek();
    peeked = undefined;
    if (t.t === 'nl' || t.t === 'eof') readHeredocs();
    return t;
  };
  const tokenText = (t: Token): string => {
    switch (t.t) {
      case 'nl':
        return 'newline';
      case 'eof':
        return 'end of file';
      case 'word':
        return t.word.text;
      case 'op':
        return t.v;
      case 'redir':
        return t.op;
    }
  };
  const unexpected = (t: Token): never => {
    if (t.t === 'eof') {
      if (!opts.final) incomplete({ kind: 'eof' });
      throw new SyntaxError_('syntax error: unexpected end of file', t.start);
    }
    throw new SyntaxError_(`syntax error near unexpected token \`${tokenText(t)}'`, t.start);
  };

  /**
   * Substitutes aliases for the word token in command position, repeatedly, since the value's first
   * word is checked again; the guards stop an alias from expanding inside its own value. Returns
   * true when the last value applied ends in a blank, which makes the next word subject to alias
   * expansion too (bash(1) ALIASES).
   */
  const expandAliases = (): boolean => {
    let next = false;
    for (;;) {
      if (!opts.expandAliases) return next;
      const t = peek();
      if (t.t !== 'word' || t.plain === undefined || t.plain === '') return next;
      const name = t.plain;
      const value = opts.aliases[name];
      if (value === undefined) return next;
      if (guards.some((g) => g.name === name && t.start < g.end)) return next;
      const delta = value.length - (t.end - t.start);
      for (const g of guards) if (g.end >= t.end) g.end += delta;
      src = src.slice(0, t.start) + value + src.slice(t.end);
      guards.push({ name, end: t.start + value.length });
      pos = t.start;
      peeked = undefined;
      next = value.endsWith(' ') || value.endsWith('\t');
    }
  };

  // ---- here-documents --------------------------------------------------------------------------

  function readHeredocs(): void {
    while (pendingHeredocs.length > 0) {
      const h = pendingHeredocs.shift() as (typeof pendingHeredocs)[number];
      let body = '';
      for (;;) {
        if (pos >= src.length) {
          if (!opts.final) incomplete({ kind: 'heredoc', delim: h.delim, line: h.line });
          warnings.push(`warning: here-document at line ${h.line} delimited by end-of-file (wanted \`${h.delim}')`);
          break;
        }
        const nl = src.indexOf('\n', pos);
        let line = nl < 0 ? src.slice(pos) : src.slice(pos, nl);
        pos = nl < 0 ? src.length : nl + 1;
        if (h.strip) line = line.replace(/^\t+/, '');
        if (line === h.delim) break;
        body += `${line}\n`;
      }
      h.redir.heredoc = h.quoted ? { parts: [{ t: 'q', v: body }], quoted: true } : { parts: heredocParts(body), quoted: false };
    }
  }

  /** An unquoted here-document body: expansions apply, and \ escapes only $ ` \ and newline. */
  function heredocParts(body: string): WordPart[] {
    const saveSrc = src;
    const savePos = pos;
    src = body;
    pos = 0;
    const parts: WordPart[] = [];
    try {
      while (pos < src.length) {
        const c = src[pos] as string;
        if (c === '\\' && /[$`\\\n]/.test(src[pos + 1] ?? '')) {
          if (src[pos + 1] !== '\n') pushLit(parts, 'q', src[pos + 1] as string);
          pos += 2;
        } else if (c === '$') {
          const part = readDollar(true);
          if (part) {
            if (part.t === 'q') pushLit(parts, 'q', part.v);
            else parts.push(part);
          } else pushLit(parts, 'q', '$');
        } else if (c === '`') {
          parts.push(readBacktick());
        } else {
          pushLit(parts, 'q', c);
          pos++;
        }
      }
    } finally {
      src = saveSrc;
      pos = savePos;
    }
    return parts;
  }

  // ---- grammar ---------------------------------------------------------------------------------

  const skipNewlines = (): void => {
    while (peek().t === 'nl') take();
  };

  const readRedir = (r: Extract<Token, { t: 'redir' }>): Redir => {
    const t = take();
    if (t.t !== 'word') return unexpected(t);
    const redir: Redir = { op: r.op, target: t.word };
    if (r.fd !== undefined) redir.fd = r.fd;
    if (r.op === '<<' || r.op === '<<-') {
      const quoted = t.word.parts.some((p) => p.t !== 'lit');
      const delim = t.word.parts.map((p) => (p.t === 'lit' || p.t === 'q' ? p.v : p.t === 'dq' ? p.parts.map((q) => (q.t === 'q' ? q.v : '')).join('') : '')).join('');
      pendingHeredocs.push({ redir, delim, strip: r.op === '<<-', quoted, line: lineAt(t.start) });
    }
    return redir;
  };

  /** A word token as a reserved word, if it is one in this position. */
  const reserved = (t: Token): string | undefined => (t.t === 'word' && t.plain !== undefined ? t.plain : undefined);

  function parseCommand(): Command {
    const aliasNext = expandAliases();
    const t = peek();
    const line = lineAt(t.start);
    if (t.t === 'op' && t.v === '(') {
      take();
      if (peek().t === 'op' && (peek() as { v: string }).v === '(') throw new Unsupported('arithmetic evaluation "(( ))"');
      const body = parseInner(')', true);
      return { t: 'subshell', body, redirs: parseTrailingRedirs(), line };
    }
    const word = reserved(t);
    if (word === '{') {
      take();
      const body = parseInner('}', true);
      return { t: 'group', body, redirs: parseTrailingRedirs(), line };
    }
    if (word !== undefined && word in RESERVED_UNSUPPORTED) throw new Unsupported(RESERVED_UNSUPPORTED[word] as string);
    if (word !== undefined && RESERVED_CLOSERS.has(word)) unexpected(t);
    if (word === '((') throw new Unsupported('arithmetic evaluation "(( ))"');
    return parseSimple(line, aliasNext);
  }

  function parseTrailingRedirs(): Redir[] {
    const redirs: Redir[] = [];
    for (;;) {
      const t = peek();
      if (t.t === 'redir') {
        take();
        redirs.push(readRedir(t));
      } else if (t.t === 'word') {
        return unexpected(t);
      } else return redirs;
    }
  }

  function parseSimple(line: number, aliasFirstArg: boolean): SimpleCommand {
    const cmd: SimpleCommand = { t: 'simple', assigns: [], words: [], redirs: [], line };
    let aliasNext = aliasFirstArg;
    for (;;) {
      if (aliasNext && cmd.words.length > 0) aliasNext = expandAliases();
      const t = peek();
      if (t.t === 'redir') {
        take();
        cmd.redirs.push(readRedir(t));
        continue;
      }
      if (t.t === 'word') {
        if (cmd.words.length === 0) {
          const assign = asAssignment(t.word);
          if (assign) {
            take();
            const n = peek();
            if (assign.value.parts.length === 0 && n.t === 'op' && n.v === '(' && n.start === t.end) throw new Unsupported('array assignment');
            cmd.assigns.push(assign);
            continue;
          }
        }
        take();
        cmd.words.push(t.word);
        // name() — a function definition.
        if (cmd.words.length === 1 && cmd.assigns.length === 0) {
          const n = peek();
          if (n.t === 'op' && n.v === '(') throw new Unsupported('defining a function');
        }
        continue;
      }
      if (t.t === 'op' && t.v === '(') {
        if (cmd.words.length === 1 && cmd.assigns.length === 0) throw new Unsupported('defining a function');
        unexpected(t);
      }
      break;
    }
    if (cmd.assigns.length === 0 && cmd.words.length === 0 && cmd.redirs.length === 0) unexpected(peek());
    return cmd;
  }

  /** `name=value` or `name+=value` with an unquoted name (bash(1) PARAMETERS). */
  function asAssignment(w: Word): Assign | undefined {
    const first = w.parts[0];
    if (!first || first.t !== 'lit') return undefined;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=/.exec(first.v);
    if (!m) return undefined;
    const rest = first.v.slice(m[0].length);
    const parts: WordPart[] = rest === '' ? w.parts.slice(1) : [{ t: 'lit', v: rest }, ...w.parts.slice(1)];
    return { name: m[1] as string, value: { parts, text: w.text.slice(m[0].length) }, append: m[2] === '+' };
  }

  function parsePipeline(): Pipeline {
    let bang = false;
    if (reserved(peek()) === '!') {
      take();
      bang = true;
    }
    const cmds: Command[] = [parseCommand()];
    const stderr: boolean[] = [];
    for (;;) {
      const t = peek();
      if (t.t === 'op' && (t.v === '|' || t.v === '|&')) {
        take();
        stderr.push(t.v === '|&');
        skipNewlines();
        cmds.push(parseCommand());
        continue;
      }
      return { t: 'pipeline', bang, cmds, stderr };
    }
  }

  function parseAndOr(): AndOr {
    const node: AndOr = { t: 'andor', first: parsePipeline(), rest: [] };
    for (;;) {
      const t = peek();
      if (t.t === 'op' && (t.v === '&&' || t.v === '||')) {
        take();
        skipNewlines();
        node.rest.push({ op: t.v, pipeline: parsePipeline() });
        continue;
      }
      return node;
    }
  }

  /**
   * A list inside `( )`, `{ }` or `$( )`: newlines separate commands, and the list ends at `close`.
   * `pos` is after the opener. With `nonEmpty`, an empty body is a syntax error, as bash has it.
   */
  function parseInner(close: ')' | '}', nonEmpty = false): List {
    const items: AndOr[] = [];
    const atClose = (t: Token): boolean => (close === ')' ? t.t === 'op' && t.v === ')' : reserved(t) === '}');
    for (;;) {
      skipNewlines();
      const t = peek();
      if (atClose(t)) {
        if (items.length === 0 && nonEmpty) unexpected(t);
        take();
        return { t: 'list', items };
      }
      if (t.t === 'eof') {
        if (!opts.final) incomplete({ kind: 'eof' });
        unexpected(t);
      }
      items.push(parseAndOr());
      const sep = peek();
      if (sep.t === 'op' && sep.v === ';') take();
      else if (sep.t === 'op' && sep.v === '&') {
        take();
        background = true;
      } else if (sep.t === 'nl') take();
      else if (!atClose(sep)) unexpected(sep);
    }
  }

  /** The top-level list of one command line, ending at a newline or the end of input. */
  function parseLine(): List | null {
    const items: AndOr[] = [];
    for (;;) {
      const t = peek();
      if (t.t === 'nl') {
        take();
        break;
      }
      if (t.t === 'eof') {
        take();
        break;
      }
      items.push(parseAndOr());
      const sep = peek();
      if (sep.t === 'op' && (sep.v === ';' || sep.v === '&')) {
        take();
        if (sep.v === '&') background = true;
        continue;
      }
      if (sep.t !== 'nl' && sep.t !== 'eof') unexpected(sep);
    }
    return items.length === 0 ? null : { t: 'list', items };
  }

  try {
    const list = parseLine();
    if (background) throw new Unsupported('the "&" operator (background jobs)');
    return { kind: 'ok', list, end: pos, src, warnings };
  } catch (e) {
    if (e instanceof IncompleteInput) {
      if (opts.final) {
        const message =
          e.need.kind === 'quote' ? `unexpected EOF while looking for matching \`${e.need.ch}'` : 'syntax error: unexpected end of file';
        return { kind: 'error', message, line: lineAt(src.length), lineText: '', end: src.length };
      }
      return { kind: 'incomplete', need: e.need };
    }
    if (e instanceof SyntaxError_) {
      const ls = src.lastIndexOf('\n', e.at - 1) + 1;
      let le = src.indexOf('\n', e.at);
      if (le < 0) le = src.length;
      // Skip to the end of the offending line so the next command line starts after it.
      return { kind: 'error', message: e.message, line: lineAt(e.at), lineText: src.slice(ls, le), end: Math.min(src.length, le + 1) };
    }
    if (e instanceof Unsupported) {
      let le = src.indexOf('\n', pos);
      if (le < 0) le = src.length;
      return { kind: 'unsupported', what: e.what, end: Math.min(src.length, le + 1), src };
    }
    throw e;
  }
}

/** Parses a whole string (a backtick body) as one list; used for nested command substitutions. */
function parseCommandLineList(body: string, opts: ParseOptions): List {
  const items: AndOr[] = [];
  let pos = 0;
  while (pos < body.length) {
    const r = parseCommandLine(body, pos, { ...opts, final: true });
    if (r.kind === 'ok') {
      if (r.list) items.push(...r.list.items);
      if (r.end <= pos) break;
      pos = r.end;
      body = r.src;
    } else if (r.kind === 'unsupported') {
      throw new Unsupported(r.what);
    } else if (r.kind === 'error') {
      throw new SyntaxError_(r.message, 0);
    } else break;
  }
  return { t: 'list', items };
}

export { isName };

// Parser of the container shell's subset: simple commands with assignments and redirections,
// `;`, `&`, newlines, `&&`, `||`, `!`, pipelines (parsed; running one is a gap), `{ }`, `( )`,
// while/until, for, if/elif/else, quoting, parameter expansion, `$(( ))`, `$( )` and backquotes.
// Anything else (case, functions, here-documents) is reported as unsupported so the caller can
// record a gap instead of guessing.
//
// The grammar follows POSIX sh (XCU 2.10); token recognition follows dash's parser.c: reserved
// words only in command position and unquoted, `#` starts a comment at the start of a word.

import type { AndOr, Command, List, Pipeline, Redirect, SimpleCommand, Word, WordPart } from './ast.ts';

export type ParseResult =
  | { ok: List }
  | { syntax: { token: string | undefined; expecting?: string; line: number; text?: string } }
  | { unterminated: { quote: string; line: number } }
  | { unsupported: string };

type Token =
  | { t: 'word'; word: Word; raw: string; line: number }
  | { t: 'op'; op: string; line: number }
  | { t: 'nl'; line: number }
  | { t: 'eof'; line: number };

class Fail {
  readonly result: ParseResult;
  constructor(result: ParseResult) {
    this.result = result;
  }
}

const OPS = ['&&', '||', ';;', '>>', '>&', '<&', '<<', ';', '&', '|', '(', ')', '<', '>'];
const RESERVED = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'for', 'in', 'case', 'esac', '{', '}', '!']);
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function lex(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let line = 1;
  const isBlank = (c: string): boolean => c === ' ' || c === '\t';
  while (i < src.length) {
    const c = src[i] as string;
    if (isBlank(c)) {
      i++;
      continue;
    }
    if (c === '\\' && src[i + 1] === '\n') {
      i += 2;
      line++;
      continue;
    }
    if (c === '\n') {
      out.push({ t: 'nl', line });
      line++;
      i++;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      // An IO number: `2>`, `2>&1` (digits immediately before the operator were lexed as a word).
      out.push({ t: 'op', op, line });
      i += op.length;
      continue;
    }
    const start = i;
    const startLine = line;
    const word: Word = [];
    let lit = '';
    const flush = (q: boolean): void => {
      if (lit !== '') word.push({ t: 'lit', v: lit, q });
      lit = '';
    };
    while (i < src.length) {
      const ch = src[i] as string;
      if (ch === '\\' && src[i + 1] === '\n') {
        i += 2;
        line++;
        continue;
      }
      if (isBlank(ch) || ch === '\n' || OPS.some((o) => src.startsWith(o, i))) break;
      if (ch === "'") {
        flush(false);
        const end = src.indexOf("'", i + 1);
        if (end < 0) throw new Fail({ unterminated: { quote: "'", line: startLine } });
        const v = src.slice(i + 1, end);
        line += v.split('\n').length - 1;
        word.push({ t: 'lit', v, q: true });
        i = end + 1;
        continue;
      }
      if (ch === '"') {
        flush(false);
        i++;
        let closed = false;
        while (i < src.length) {
          const d = src[i] as string;
          if (d === '"') {
            closed = true;
            i++;
            break;
          }
          if (d === '\\' && i + 1 < src.length && '$`"\\\n'.includes(src[i + 1] as string)) {
            if (src[i + 1] !== '\n') lit += src[i + 1];
            else line++;
            i += 2;
            continue;
          }
          if (d === '$' || d === '`') {
            flush(true);
            i = dollar(src, i, word, true);
            continue;
          }
          if (d === '\n') line++;
          lit += d;
          i++;
        }
        if (!closed) throw new Fail({ unterminated: { quote: '"', line: startLine } });
        flush(true);
        // An empty "" still makes a word.
        if (word.length === 0 || word[word.length - 1]?.t !== 'lit') word.push({ t: 'lit', v: '', q: true });
        continue;
      }
      if (ch === '\\') {
        flush(false);
        if (i + 1 < src.length) word.push({ t: 'lit', v: src[i + 1] as string, q: true });
        i += 2;
        continue;
      }
      if (ch === '$' || ch === '`') {
        flush(false);
        i = dollar(src, i, word, false);
        continue;
      }
      lit += ch;
      i++;
    }
    flush(false);
    out.push({ t: 'word', word, raw: src.slice(start, i), line: startLine });
  }
  out.push({ t: 'eof', line });
  return out;
}

/** Index of the `)` closing the `(` at `open`, skipping quotes; -1 if none. */
function matchParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "'") {
      const e = src.indexOf("'", i + 1);
      if (e < 0) return -1;
      i = e;
    } else if (c === '\\') i++;
    else if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Parses a `$…` or backquote expansion at `i`; returns the index after it. */
function dollar(src: string, i: number, word: Word, q: boolean): number {
  if (src[i] === '`') {
    const end = src.indexOf('`', i + 1);
    if (end < 0) throw new Fail({ unterminated: { quote: '`', line: 1 } });
    word.push({ t: 'cmdsub', src: src.slice(i + 1, end), q });
    return end + 1;
  }
  const n = src[i + 1];
  if (n === '(' && src[i + 2] === '(') {
    const end = src.indexOf('))', i + 3);
    if (end < 0) throw new Fail({ syntax: { token: undefined, expecting: '))', line: 1 } });
    word.push({ t: 'arith', expr: src.slice(i + 3, end), q });
    return end + 2;
  }
  if (n === '(') {
    const end = matchParen(src, i + 1);
    if (end < 0) throw new Fail({ syntax: { token: undefined, expecting: ')', line: 1 } });
    word.push({ t: 'cmdsub', src: src.slice(i + 2, end), q });
    return end + 1;
  }
  if (n === '{') {
    const end = src.indexOf('}', i + 2);
    if (end < 0) throw new Fail({ syntax: { token: undefined, expecting: '}', line: 1 } });
    const inner = src.slice(i + 2, end);
    if (!NAME.test(inner) && !/^[0-9]+$/.test(inner) && !/^[?#$@*!-]$/.test(inner)) throw new Fail({ unsupported: `parameter expansion \${${inner}}` });
    word.push({ t: 'param', name: inner, q });
    return end + 1;
  }
  if (n !== undefined && /[?#$@*!0-9-]/.test(n)) {
    word.push({ t: 'param', name: n, q });
    return i + 2;
  }
  const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i + 1));
  if (m) {
    word.push({ t: 'param', name: m[0], q });
    return i + 1 + m[0].length;
  }
  word.push({ t: 'lit', v: '$', q });
  return i + 1;
}

const isLiteral = (w: Word): string | undefined => (w.length === 1 && w[0]?.t === 'lit' && !w[0].q ? w[0].v : undefined);

class Parser {
  private pos = 0;
  private readonly toks: Token[];
  constructor(toks: Token[]) {
    this.toks = toks;
  }

  private peek(): Token {
    return this.toks[this.pos] as Token;
  }

  private next(): Token {
    return this.toks[this.pos++] as Token;
  }

  private reserved(t: Token): string | undefined {
    if (t.t !== 'word') return undefined;
    const v = isLiteral(t.word);
    return v !== undefined && RESERVED.has(v) ? v : undefined;
  }

  private fail(t: Token, expecting?: string): never {
    const token = t.t === 'eof' ? undefined : t.t === 'nl' ? 'newline' : t.t === 'op' ? t.op : (this.reserved(t) ?? 'word');
    throw new Fail({ syntax: { token, ...(expecting ? { expecting } : {}), line: t.line, ...(t.t === 'word' ? { text: t.raw } : {}) } });
  }

  private skipNewlines(): void {
    while (this.peek().t === 'nl') this.pos++;
  }

  private expectWord(w: string): void {
    this.skipNewlines();
    const t = this.peek();
    if (this.reserved(t) !== w) this.fail(t, w);
    this.pos++;
  }

  /** A list up to one of `stops` (reserved words) or the end. */
  list(stops: string[], expecting?: string): List {
    const items: List['items'] = [];
    for (;;) {
      this.skipNewlines();
      const t = this.peek();
      if (t.t === 'eof') {
        if (stops.length > 0) this.fail(t, expecting);
        break;
      }
      const r = this.reserved(t);
      if (r !== undefined && stops.includes(r)) break;
      if (t.t === 'op' && t.op === ')' && stops.includes(')')) break;
      const andOr = this.andOr();
      const sep = this.peek();
      let background = false;
      if (sep.t === 'op' && (sep.op === ';' || sep.op === '&')) {
        background = sep.op === '&';
        this.pos++;
      } else if (sep.t !== 'nl' && sep.t !== 'eof' && !(sep.t === 'op' && sep.op === ')') && this.reserved(sep) === undefined) {
        this.fail(sep);
      }
      items.push({ andOr, background });
    }
    if (items.length === 0 && stops.length > 0) this.fail(this.peek());
    return { items };
  }

  private andOr(): AndOr {
    const first = this.pipeline();
    const rest: AndOr['rest'] = [];
    for (;;) {
      const t = this.peek();
      if (t.t === 'op' && (t.op === '&&' || t.op === '||')) {
        this.pos++;
        this.skipNewlines();
        rest.push({ op: t.op, pipeline: this.pipeline() });
      } else break;
    }
    return { first, rest };
  }

  private pipeline(): Pipeline {
    const line = this.peek().line;
    let negate = false;
    if (this.reserved(this.peek()) === '!') {
      negate = true;
      this.pos++;
    }
    const commands = [this.command()];
    while (this.peek().t === 'op' && (this.peek() as { op: string }).op === '|') {
      this.pos++;
      this.skipNewlines();
      commands.push(this.command());
    }
    return { negate, commands, line };
  }

  private command(): Command {
    const t = this.peek();
    const r = this.reserved(t);
    if (r === 'while' || r === 'until') {
      this.pos++;
      const cond = this.list(['do'], 'do');
      this.expectWord('do');
      const body = this.list(['done'], 'done');
      this.expectWord('done');
      return { kind: 'while', until: r === 'until', cond, body };
    }
    if (r === 'for') {
      this.pos++;
      const n = this.next();
      const name = n.t === 'word' ? isLiteral(n.word) : undefined;
      if (name === undefined || !NAME.test(name)) this.fail(n);
      let words: Word[] | null = null;
      this.skipNewlines();
      if (this.reserved(this.peek()) === 'in') {
        this.pos++;
        words = [];
        while (this.peek().t === 'word') words.push((this.next() as { word: Word }).word);
        const sep = this.peek();
        if (sep.t === 'op' && sep.op === ';') this.pos++;
        else if (sep.t !== 'nl') this.fail(sep, 'do');
      } else if (this.peek().t === 'op' && (this.peek() as { op: string }).op === ';') this.pos++;
      this.expectWord('do');
      const body = this.list(['done'], 'done');
      this.expectWord('done');
      return { kind: 'for', name, words, body };
    }
    if (r === 'if') {
      this.pos++;
      const clauses: { cond: List; body: List }[] = [];
      let otherwise: List | undefined;
      for (;;) {
        const cond = this.list(['then'], 'then');
        this.expectWord('then');
        const body = this.list(['elif', 'else', 'fi'], 'fi');
        clauses.push({ cond, body });
        const w = this.reserved(this.next());
        if (w === 'elif') continue;
        if (w === 'else') {
          otherwise = this.list(['fi'], 'fi');
          this.expectWord('fi');
        }
        break;
      }
      return { kind: 'if', clauses, ...(otherwise ? { otherwise } : {}) };
    }
    if (r === '{') {
      this.pos++;
      const body = this.list(['}'], '}');
      this.expectWord('}');
      return { kind: 'group', subshell: false, body };
    }
    if (t.t === 'op' && t.op === '(') {
      this.pos++;
      const body = this.list([')'], ')');
      const close = this.next();
      if (!(close.t === 'op' && close.op === ')')) this.fail(close, ')');
      return { kind: 'group', subshell: true, body };
    }
    if (r === 'case') throw new Fail({ unsupported: 'case' });
    if (r !== undefined && r !== 'in') this.fail(t);
    return this.simple();
  }

  private simple(): SimpleCommand {
    const line = this.peek().line;
    const cmd: SimpleCommand = { kind: 'simple', assigns: [], words: [], redirects: [], line };
    for (;;) {
      const t = this.peek();
      if (t.t === 'word') {
        // An IO number directly followed by a redirection operator.
        const lit = isLiteral(t.word);
        const after = this.toks[this.pos + 1];
        if (lit !== undefined && /^[0-9]$/.test(lit) && after?.t === 'op' && ['>', '>>', '<', '>&', '<&'].includes(after.op)) {
          this.pos++;
          this.redirect(cmd, Number(lit));
          continue;
        }
        if (cmd.words.length === 0) {
          const first = t.word[0];
          if (first?.t === 'lit' && !first.q) {
            const eq = first.v.indexOf('=');
            if (eq > 0 && NAME.test(first.v.slice(0, eq))) {
              const value: Word = [...(first.v.length > eq + 1 ? [{ t: 'lit', v: first.v.slice(eq + 1), q: false } as WordPart] : []), ...t.word.slice(1)];
              cmd.assigns.push({ name: first.v.slice(0, eq), value });
              this.pos++;
              continue;
            }
          }
        }
        if (cmd.words.length > 0 && t.word.length === 1 && t.word[0]?.t === 'lit' && !t.word[0].q && t.word[0].v === '(') this.fail(t);
        cmd.words.push(t.word);
        this.pos++;
        continue;
      }
      if (t.t === 'op' && ['>', '>>', '<', '>&', '<&'].includes(t.op)) {
        this.redirect(cmd, t.op.startsWith('<') ? 0 : 1);
        continue;
      }
      if (t.t === 'op' && t.op === '<<') throw new Fail({ unsupported: 'here-document' });
      if (t.t === 'op' && t.op === '(') {
        this.pos++;
        const close = this.peek();
        if (cmd.words.length === 1 && cmd.assigns.length === 0 && close.t === 'op' && close.op === ')') throw new Fail({ unsupported: 'function definition' });
        // dash: `echo (a)` → word unexpected (expecting ")")
        this.fail(this.peek(), ')');
      }
      break;
    }
    if (cmd.words.length === 0 && cmd.assigns.length === 0 && cmd.redirects.length === 0) this.fail(this.peek());
    return cmd;
  }

  private redirect(cmd: SimpleCommand, fd: number): void {
    const op = (this.next() as { op: string }).op as Redirect['op'];
    const target = this.next();
    if (target.t !== 'word') this.fail(target);
    cmd.redirects.push({ fd, op, target: target.word });
  }
}

export function parse(src: string): ParseResult {
  try {
    const p = new Parser(lex(src));
    return { ok: p.list([]) };
  } catch (e) {
    if (e instanceof Fail) return e.result;
    throw e;
  }
}

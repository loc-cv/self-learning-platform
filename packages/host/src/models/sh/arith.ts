// `$(( ))`: integer arithmetic as dash and ash evaluate it (XCU 2.6.4): decimal, octal and hex
// constants, variables by name, unary + - ! ~, * / %, + -, << >>, comparisons, == !=, & ^ |,
// && ||, and the conditional operator. Assignment operators are not modeled (an error, so the
// caller records a gap).

export type ArithResult = { value: number } | { error: string };

export function evaluateArith(expr: string, lookup: (name: string) => string | undefined): ArithResult {
  const toks = expr.match(/\s*(0[xX][0-9a-fA-F]+|[0-9]+|[A-Za-z_][A-Za-z0-9_]*|\$[A-Za-z_][A-Za-z0-9_]*|<<|>>|<=|>=|==|!=|&&|\|\||[-+*/%()<>!~&^|?:])/gy);
  const compact = expr.replace(/\s+/g, '');
  if (!toks || toks.join('').replace(/\s+/g, '') !== compact) return { error: expr };
  const list = toks.map((t) => t.trim());
  let pos = 0;
  const peek = (): string | undefined => list[pos];
  const fail = (): never => {
    throw new Error(expr);
  };
  const num = (s: string): number => {
    if (/^0[xX]/.test(s)) return parseInt(s.slice(2), 16);
    if (/^0[0-7]+$/.test(s)) return parseInt(s, 8);
    if (/^[0-9]+$/.test(s)) return parseInt(s, 10);
    return fail();
  };
  const variable = (name: string): number => {
    const v = (lookup(name) ?? '').trim();
    if (v === '') return 0;
    if (/^-?(0[xX][0-9a-fA-F]+|[0-9]+)$/.test(v)) return v.startsWith('-') ? -num(v.slice(1)) : num(v);
    return fail();
  };
  const trunc = (v: number): number => (v < 0 ? Math.ceil(v) : Math.floor(v));
  const primary = (): number => {
    const t = list[pos++];
    if (t === undefined) return fail();
    if (t === '(') {
      const v = ternary();
      if (list[pos++] !== ')') fail();
      return v;
    }
    if (t === '-') return -primary();
    if (t === '+') return primary();
    if (t === '!') return primary() === 0 ? 1 : 0;
    if (t === '~') return ~primary();
    if (/^[0-9]/.test(t)) return num(t);
    if (/^\$?[A-Za-z_]/.test(t)) return variable(t.replace(/^\$/, ''));
    return fail();
  };
  const LEVELS: string[][] = [['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '>', '<=', '>='], ['<<', '>>'], ['+', '-'], ['*', '/', '%']];
  const binary = (level: number): number => {
    if (level >= LEVELS.length) return primary();
    let v = binary(level + 1);
    for (;;) {
      const op = peek();
      if (op === undefined || !(LEVELS[level] as string[]).includes(op)) return v;
      pos++;
      const r = binary(level + 1);
      switch (op) {
        case '||': v = v !== 0 || r !== 0 ? 1 : 0; break;
        case '&&': v = v !== 0 && r !== 0 ? 1 : 0; break;
        case '|': v = v | r; break;
        case '^': v = v ^ r; break;
        case '&': v = v & r; break;
        case '==': v = v === r ? 1 : 0; break;
        case '!=': v = v !== r ? 1 : 0; break;
        case '<': v = v < r ? 1 : 0; break;
        case '>': v = v > r ? 1 : 0; break;
        case '<=': v = v <= r ? 1 : 0; break;
        case '>=': v = v >= r ? 1 : 0; break;
        case '<<': v = v << r; break;
        case '>>': v = v >> r; break;
        case '+': v = v + r; break;
        case '-': v = v - r; break;
        case '*': v = v * r; break;
        case '/': if (r === 0) fail(); v = trunc(v / r); break;
        case '%': if (r === 0) fail(); v = v % r; break;
      }
    }
  };
  const ternary = (): number => {
    const c = binary(0);
    if (peek() !== '?') return c;
    pos++;
    const a = ternary();
    if (list[pos++] !== ':') fail();
    const b = ternary();
    return c !== 0 ? a : b;
  };
  try {
    if (list.length === 0) return { value: 0 };
    const v = ternary();
    if (pos !== list.length) return { error: expr };
    return { value: v };
  } catch {
    return { error: expr };
  }
}

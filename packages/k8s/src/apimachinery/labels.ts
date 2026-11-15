// Label selectors: the string syntax, requirements, matching, and metav1.LabelSelector.
// upstream: staging/src/k8s.io/apimachinery/pkg/labels/selector.go (Lexer, Parser, Parse,
// NewRequirement, Requirement.Matches, Requirement.String, internalSelector, ByKey,
// SelectorFromSet, ValidatedSelectorFromSet, RequiresExactMatch), labels/labels.go (Set.String,
// FormatLabels), selection/operator.go (operator strings), apis/meta/v1/helpers.go
// (LabelSelectorAsSelector, LabelSelectorAsMap, FormatLabelSelector).
//
// A selector is plain data. Requirements are kept sorted by key, as upstream's `sort.Sort(ByKey)`
// leaves them. Go's sort.Sort is an insertion sort up to 12 elements (stable); beyond that it is
// pdqsort and requirements with equal keys may come out in another order than here (we sort
// stably). Only String() of such a selector can differ; matching cannot.

import { aggregate, errorString, goQuote, invalid, NIL_PATH, notSupported, type FieldError, type Path } from './field.ts';
import { goJson, isObject, type Json } from './json.ts';
import { isQualifiedName, isValidLabelValue } from './validation/names.ts';

/** selection.Operator values. */
export type Operator = '!' | '=' | '==' | 'in' | '!=' | 'notin' | 'exists' | 'gt' | 'lt';

export interface Requirement {
  key: string;
  operator: Operator;
  /** As given to NewRequirement; from Parse, the sorted set of values. */
  values: string[];
}

/**
 * A label selector. `nothing` is labels.Nothing(), which matches no labels; otherwise the
 * requirements are ANDed, and none means Everything().
 */
export interface Selector {
  requirements: Requirement[];
  nothing?: true;
}

export type Labels = Readonly<Record<string, string>>;
export type SelectorResult = Selector | { error: string };

/** Go's string order (bytes of UTF-8), which is code point order. */
export function compareGoStrings(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done === true) return y.done === true ? 0 : -1;
    if (y.done === true) return 1;
    const cx = x.value.codePointAt(0) as number;
    const cy = y.value.codePointAt(0) as number;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

const sortedStrings = (xs: readonly string[]): string[] => [...xs].sort(compareGoStrings);
/** sort.Sort(ByKey(...)); see the header about stability. */
const byKey = (rs: readonly Requirement[]): Requirement[] => [...rs].sort((a, b) => compareGoStrings(a.key, b.key));

export function isSelectorError(r: SelectorResult): r is { error: string } {
  return 'error' in r;
}

/** labels.Everything(): an empty selector. */
export function everything(): Selector {
  return { requirements: [] };
}

/** labels.Nothing(). */
export function nothing(): Selector {
  return { requirements: [], nothing: true };
}

/** Selector.Empty(): true for Everything(), false for Nothing(). */
export function selectorEmpty(sel: Selector): boolean {
  return sel.nothing !== true && sel.requirements.length === 0;
}

/** labels.MatchesNothing. */
export function matchesNothing(sel: Selector): boolean {
  return sel.nothing === true;
}

// ---------------------------------------------------------------------------------------------
// Requirements

const BINARY_OPERATORS: readonly Operator[] = ['in', 'notin', '=', '==', '!=', 'gt', 'lt'];
const UNARY_OPERATORS: readonly Operator[] = ['exists', '!'];
const VALID_REQUIREMENT_OPERATORS: readonly string[] = [...BINARY_OPERATORS, ...UNARY_OPERATORS];

/** strconv.ParseInt(s, 10, 64); null on error. */
export function parseInt64(s: string): bigint | null {
  if (!/^[+-]?[0-9]+$/.test(s)) return null;
  const n = BigInt(s);
  return n >= -(2n ** 63n) && n < 2n ** 63n ? n : null;
}

/** validateLabelKey: content.IsLabelKey messages joined with "; ". */
function validateLabelKey(k: string, path: Path): FieldError | null {
  const errs = isQualifiedName(k);
  return errs.length === 0 ? null : invalid(path, k, errs.join('; '));
}

/** validateLabelValue: at `<path>[<key>]`. */
function validateLabelValue(k: string, v: string, path: Path): FieldError | null {
  const errs = isValidLabelValue(v);
  return errs.length === 0 ? null : invalid(path.key(k), v, errs.join('; '));
}

/**
 * NewRequirement. `vals` null is a Go nil slice (rendered `null` in errors), [] an empty one.
 * `path` is the field.WithPath option; without it upstream's path is nil, whose children render
 * without a prefix (`key`, `values[0][k]`).
 */
export function newRequirement(key: string, operator: string, vals: readonly string[] | null, path: Path = NIL_PATH): Requirement | { error: string } {
  const errs: FieldError[] = [];
  const keyErr = validateLabelKey(key, path.child('key'));
  if (keyErr !== null) errs.push(keyErr);
  const values = vals ?? [];
  const valuePath = path.child('values');
  const bad: Json = vals === null ? null : [...vals];
  switch (operator) {
    case 'in':
    case 'notin':
      if (values.length === 0) errs.push(invalid(valuePath, bad, "for 'in', 'notin' operators, values set can't be empty"));
      break;
    case '=':
    case '==':
    case '!=':
      if (values.length !== 1) errs.push(invalid(valuePath, bad, 'exact-match compatibility requires one single value'));
      break;
    case 'exists':
    case '!':
      if (values.length !== 0) errs.push(invalid(valuePath, bad, 'values set must be empty for exists and does not exist'));
      break;
    case 'gt':
    case 'lt':
      if (values.length !== 1) errs.push(invalid(valuePath, bad, "for 'Gt', 'Lt' operators, exactly one value is required"));
      values.forEach((v, i) => {
        if (parseInt64(v) === null) errs.push(invalid(valuePath.index(i), v, "for 'Gt', 'Lt' operators, the value must be an integer"));
      });
      break;
    default:
      // The operator is a named string type, so field.Error renders it with json.Marshal.
      errs.push(notSupported(path.child('operator'), { go: goJson(operator) }, VALID_REQUIREMENT_OPERATORS));
  }
  values.forEach((v, i) => {
    const e = validateLabelValue(key, v, valuePath.index(i));
    if (e !== null) errs.push(e);
  });
  if (errs.length > 0) return { error: aggregate(errs) };
  return { key, operator: operator as Operator, values: [...values] };
}

/** Requirement.Matches. A label that is absent differs from one set to "". */
export function requirementMatches(r: Requirement, labels: Labels): boolean {
  const has = Object.hasOwn(labels, r.key);
  const val = has ? (labels[r.key] as string) : '';
  switch (r.operator) {
    case 'in':
    case '=':
    case '==':
      return has && r.values.includes(val);
    case 'notin':
    case '!=':
      return !has || !r.values.includes(val);
    case 'exists':
      return has;
    case '!':
      return !has;
    case 'gt':
    case 'lt': {
      if (!has) return false;
      const lsValue = parseInt64(val);
      if (lsValue === null || r.values.length !== 1) return false;
      const rValue = parseInt64(r.values[0] as string);
      if (rValue === null) return false;
      return r.operator === 'gt' ? lsValue > rValue : lsValue < rValue;
    }
    default:
      return false;
  }
}

/** Requirement.String(); several values are printed sorted (safeSort), not de-duplicated. */
export function requirementString(r: Requirement): string {
  let s = r.operator === '!' ? `!${r.key}` : r.key;
  switch (r.operator) {
    case '=':
    case '==':
    case '!=':
      s += r.operator;
      break;
    case 'in':
    case 'notin':
      s += ` ${r.operator} `;
      break;
    case 'gt':
      s += '>';
      break;
    case 'lt':
      s += '<';
      break;
    case 'exists':
    case '!':
      return s;
  }
  const vals = r.values.length === 1 ? (r.values[0] as string) : sortedStrings(r.values).join(',');
  return r.operator === 'in' || r.operator === 'notin' ? `${s}(${vals})` : s + vals;
}

// ---------------------------------------------------------------------------------------------
// Selectors

/** Selector.Matches: every requirement matches; Nothing() matches nothing. */
export function selectorMatches(sel: Selector, labels: Labels): boolean {
  if (sel.nothing === true) return false;
  return sel.requirements.every((r) => requirementMatches(r, labels));
}

/** Selector.String(): requirements joined with ","; "" for Everything() and Nothing(). */
export function selectorString(sel: Selector): string {
  return sel.requirements.map(requirementString).join(',');
}

/** Selector.Add: the requirements appended, then sorted by key; Nothing() stays Nothing(). */
export function selectorAdd(sel: Selector, ...reqs: Requirement[]): Selector {
  if (sel.nothing === true) return sel;
  return { requirements: byKey([...sel.requirements, ...reqs]) };
}

/** Selector.RequiresExactMatch: decided by the first requirement on the label. */
export function requiresExactMatch(sel: Selector, label: string): { value: string } | null {
  const r = sel.requirements.find((x) => x.key === label);
  if (r === undefined) return null;
  if ((r.operator === '=' || r.operator === '==' || r.operator === 'in') && r.values.length === 1) return { value: r.values[0] as string };
  return null;
}

/** SelectorFromSet / SelectorFromValidatedSet: one `=` requirement per label, no validation. */
export function selectorFromSet(set: Labels | null | undefined): Selector {
  if (set === null || set === undefined) return everything();
  return { requirements: byKey(Object.keys(set).map((k) => ({ key: k, operator: '=', values: [set[k] as string] }))) };
}

/**
 * ValidatedSelectorFromSet. Upstream returns the error of whichever label Go's map iteration
 * reaches first; we check labels in key order.
 */
export function validatedSelectorFromSet(set: Labels | null | undefined): SelectorResult {
  if (set === null || set === undefined) return everything();
  const reqs: Requirement[] = [];
  for (const k of sortedStrings(Object.keys(set))) {
    const r = newRequirement(k, '=', [set[k] as string]);
    if ('error' in r) return r;
    reqs.push(r);
  }
  return { requirements: reqs };
}

/** labels.Set.String(): `k=v` pairs, sorted as whole strings, joined with ",". */
export function labelsString(set: Labels): string {
  return sortedStrings(Object.keys(set).map((k) => `${k}=${set[k] as string}`)).join(',');
}

/** labels.FormatLabels: Set.String(), or `<none>`. */
export function formatLabels(set: Labels | null | undefined): string {
  const s = labelsString(set ?? {});
  return s === '' ? '<none>' : s;
}

// ---------------------------------------------------------------------------------------------
// Lexer and parser

type Token =
  | 'Error'
  | 'EndOfString'
  | 'ClosedPar'
  | 'Comma'
  | 'DoesNotExist'
  | 'DoubleEquals'
  | 'Equals'
  | 'GreaterThan'
  | 'Identifier'
  | 'In'
  | 'LessThan'
  | 'NotEquals'
  | 'NotIn'
  | 'OpenPar';

const STRING_TO_TOKEN: Readonly<Record<string, Token>> = {
  ')': 'ClosedPar',
  ',': 'Comma',
  '!': 'DoesNotExist',
  '==': 'DoubleEquals',
  '=': 'Equals',
  '>': 'GreaterThan',
  in: 'In',
  '<': 'LessThan',
  '!=': 'NotEquals',
  notin: 'NotIn',
  '(': 'OpenPar',
};

const tokenOf = (s: string): Token | undefined => (Object.hasOwn(STRING_TO_TOKEN, s) ? STRING_TO_TOKEN[s] : undefined);

interface ScannedItem {
  tok: Token;
  literal: string;
}

const isWhitespace = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';
const isSpecialSymbol = (ch: string): boolean => '=!(),><'.includes(ch) && ch.length === 1;

/**
 * Lexer. Go's lexer works on bytes; every byte it treats specially is ASCII, so code units give
 * the same tokens. read() returns 0 at the end, and a NUL in the input reads the same way.
 */
function lex(s: string): ScannedItem[] {
  let pos = 0;
  const END = '\0';
  const read = (): string => {
    if (pos < s.length) return s[pos++] as string;
    return END;
  };
  const unread = (): void => {
    pos--;
  };

  const scanIDOrKeyword = (): ScannedItem => {
    let buffer = '';
    for (;;) {
      const ch = read();
      if (ch === END) break;
      if (isSpecialSymbol(ch) || isWhitespace(ch)) {
        unread();
        break;
      }
      buffer += ch;
    }
    const t = tokenOf(buffer);
    return { tok: t ?? 'Identifier', literal: buffer };
  };

  const scanSpecialSymbol = (): ScannedItem => {
    let last: ScannedItem | null = null;
    let buffer = '';
    for (;;) {
      const ch = read();
      if (ch === END) break;
      if (isSpecialSymbol(ch)) {
        buffer += ch;
        const t = tokenOf(buffer);
        if (t !== undefined) last = { tok: t, literal: buffer };
        else if (last !== null) {
          unread();
          break;
        }
      } else {
        unread();
        break;
      }
    }
    if (last === null) return { tok: 'Error', literal: `error expected: keyword found '${buffer}'` };
    return last;
  };

  const items: ScannedItem[] = [];
  for (;;) {
    let ch = read();
    while (isWhitespace(ch)) ch = read();
    let item: ScannedItem;
    if (ch === END) item = { tok: 'EndOfString', literal: '' };
    else if (isSpecialSymbol(ch)) {
      unread();
      item = scanSpecialSymbol();
    } else {
      unread();
      item = scanIDOrKeyword();
    }
    items.push(item);
    if (item.tok === 'EndOfString') return items;
  }
}

/** A parse error in flight; thrown inside the parser, returned by parseSelector. */
interface ParseError {
  selectorParseError: string;
}
const isParseError = (e: unknown): e is ParseError => typeof e === 'object' && e !== null && 'selectorParseError' in e;

/** ParserContext: in Values, the keywords `in` and `notin` are identifiers. */
type Context = 'KeyAndOperator' | 'Values';

/** Parser.parse and its helpers. */
function parseItems(s: string, path: Path): Requirement[] {
  const items = lex(s);
  let position = 0;
  const at = (i: number): ScannedItem => items[Math.min(i, items.length - 1)] as ScannedItem;
  const inValues = (tok: Token, ctx: Context): Token => (ctx === 'Values' && (tok === 'In' || tok === 'NotIn') ? 'Identifier' : tok);
  const lookahead = (ctx: Context): [Token, string] => {
    const it = at(position);
    return [inValues(it.tok, ctx), it.literal];
  };
  const consume = (ctx: Context): [Token, string] => {
    const it = at(position);
    position++;
    return [inValues(it.tok, ctx), it.literal];
  };
  const fail = (m: string): never => {
    throw { selectorParseError: m } satisfies ParseError;
  };
  const required = (r: Requirement | { error: string }): Requirement => ('error' in r ? fail(r.error) : r);

  const parseKeyAndInferOperator = (): [string, Operator | ''] => {
    let operator: Operator | '' = '';
    let [tok, literal] = consume('Values');
    if (tok === 'DoesNotExist') {
      operator = '!';
      [tok, literal] = consume('Values');
    }
    if (tok !== 'Identifier') fail(`found '${literal}', expected: identifier`);
    const keyErr = validateLabelKey(literal, path);
    if (keyErr !== null) fail(errorString(keyErr));
    const [t] = lookahead('Values');
    if ((t === 'EndOfString' || t === 'Comma') && operator !== '!') operator = 'exists';
    return [literal, operator];
  };

  const parseOperator = (): Operator => {
    const [tok, lit] = consume('KeyAndOperator');
    switch (tok) {
      case 'In':
        return 'in';
      case 'Equals':
        return '=';
      case 'DoubleEquals':
        return '==';
      case 'GreaterThan':
        return 'gt';
      case 'LessThan':
        return 'lt';
      case 'NotIn':
        return 'notin';
      case 'NotEquals':
        return '!=';
      default:
        return fail(`found '${lit}', expected: ${BINARY_OPERATORS.join(', ')}`);
    }
  };

  const parseIdentifiersList = (): Set<string> => {
    const set = new Set<string>();
    for (;;) {
      const [tok, lit] = consume('Values');
      if (tok === 'Identifier') {
        set.add(lit);
        const [tok2, lit2] = lookahead('Values');
        if (tok2 === 'Comma') continue;
        if (tok2 === 'ClosedPar') return set;
        fail(`found '${lit2}', expected: ',' or ')'`);
      } else if (tok === 'Comma') {
        if (set.size === 0) set.add(''); // "(,"
        const [tok2] = lookahead('Values');
        if (tok2 === 'ClosedPar') {
          set.add(''); // ",)"
          return set;
        }
        if (tok2 === 'Comma') set.add(''); // ",,"
      } else {
        fail(`found '${lit}', expected: ',', or identifier`);
      }
    }
  };

  const parseValues = (): Set<string> => {
    const [tok, lit] = consume('Values');
    if (tok !== 'OpenPar') fail(`found '${lit}' expected: '('`);
    const [tok2, lit2] = lookahead('Values');
    switch (tok2) {
      case 'Identifier':
      case 'Comma': {
        const set = parseIdentifiersList();
        const [tok3] = consume('Values');
        if (tok3 !== 'ClosedPar') fail(`found '${lit2}', expected: ')'`);
        return set;
      }
      case 'ClosedPar': // "()"
        consume('Values');
        return new Set(['']);
      default:
        return fail(`found '${lit2}', expected: ',', ')' or identifier`);
    }
  };

  const parseExactValue = (): Set<string> => {
    const [tok] = lookahead('Values');
    if (tok === 'EndOfString' || tok === 'Comma') return new Set(['']);
    const [tok2, lit] = consume('Values');
    if (tok2 === 'Identifier') return new Set([lit]);
    return fail(`found '${lit}', expected: identifier`);
  };

  const parseRequirement = (): Requirement => {
    const [key, inferred] = parseKeyAndInferOperator();
    if (inferred === 'exists' || inferred === '!') return required(newRequirement(key, inferred, [], path));
    const operator = parseOperator();
    const values = operator === 'in' || operator === 'notin' ? parseValues() : parseExactValue();
    // sets.String.List(): sorted.
    return required(newRequirement(key, operator, sortedStrings([...values]), path));
  };

  const reqs: Requirement[] = [];
  for (;;) {
    const [tok, lit] = lookahead('Values');
    if (tok === 'Identifier' || tok === 'DoesNotExist') {
      try {
        reqs.push(parseRequirement());
      } catch (e) {
        if (isParseError(e)) fail(`unable to parse requirement: ${e.selectorParseError}`);
        throw e;
      }
      const [t, l] = consume('Values');
      if (t === 'EndOfString') return reqs;
      if (t === 'Comma') {
        const [t2, l2] = lookahead('Values');
        if (t2 !== 'Identifier' && t2 !== 'DoesNotExist') fail(`found '${l2}', expected: identifier after ','`);
      } else {
        fail(`found '${l}', expected: ',' or 'end of string'`);
      }
    } else if (tok === 'EndOfString') {
      return reqs;
    } else {
      fail(`found '${lit}', expected: !, identifier, or 'end of string'`);
    }
  }
}

/**
 * labels.Parse: the `labelSelector` query parameter. "" is Everything(). Errors are the text the
 * API server returns in its 400 (Convert_string_To_labels_Selector passes err.Error() through).
 */
export function parseSelector(s: string, path: Path = NIL_PATH): SelectorResult {
  try {
    return { requirements: byKey(parseItems(s, path)) };
  } catch (e) {
    if (isParseError(e)) return { error: e.selectorParseError };
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// metav1.LabelSelector

const LABEL_SELECTOR_OPS: Readonly<Record<string, Operator>> = { In: 'in', NotIn: 'notin', Exists: 'exists', DoesNotExist: '!' };

function stringMap(v: Json | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isObject(v)) return out;
  for (const k of Object.keys(v)) {
    const x = v[k];
    if (typeof x === 'string') out[k] = x;
  }
  return out;
}

interface Expression {
  key: string;
  operator: string;
  values: string[];
}

function expressions(v: Json | undefined): Expression[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isObject).map((e) => ({
    key: typeof e['key'] === 'string' ? e['key'] : '',
    operator: typeof e['operator'] === 'string' ? e['operator'] : '',
    values: Array.isArray(e['values']) ? e['values'].filter((x): x is string => typeof x === 'string') : [],
  }));
}

/**
 * metav1.LabelSelectorAsSelector on the JSON of a LabelSelector (already decoded, so typed). A
 * missing (null/undefined) selector selects nothing; one with no matchLabels and no
 * matchExpressions selects everything. matchLabels are checked in key order, where upstream
 * follows Go's random map order (it returns the first error).
 */
export function labelSelectorAsSelector(json: Json | undefined): SelectorResult {
  if (json === null || json === undefined) return nothing();
  const matchLabels = stringMap(isObject(json) ? json['matchLabels'] : undefined);
  const exprs = expressions(isObject(json) ? json['matchExpressions'] : undefined);
  const labelKeys = sortedStrings(Object.keys(matchLabels));
  if (labelKeys.length + exprs.length === 0) return everything();
  const reqs: Requirement[] = [];
  for (const k of labelKeys) {
    const r = newRequirement(k, '=', [matchLabels[k] as string]);
    if ('error' in r) return r;
    reqs.push(r);
  }
  for (const e of exprs) {
    const op = Object.hasOwn(LABEL_SELECTOR_OPS, e.operator) ? LABEL_SELECTOR_OPS[e.operator] : undefined;
    if (op === undefined) return { error: `${goQuote(e.operator)} is not a valid label selector operator` };
    // append([]string(nil), expr.Values...) is nil when there are no values.
    const r = newRequirement(e.key, op, e.values.length === 0 ? null : e.values);
    if ('error' in r) return r;
    reqs.push(r);
  }
  return selectorAdd(everything(), ...reqs);
}

/**
 * metav1.LabelSelectorAsMap: matchLabels plus single-value `In` expressions. A null selector
 * gives null. On error upstream also returns the map built so far; we return the error alone.
 */
export function labelSelectorAsMap(json: Json | undefined): Record<string, string> | null | { error: string } {
  if (json === null || json === undefined) return null;
  const out = stringMap(isObject(json) ? json['matchLabels'] : undefined);
  for (const e of expressions(isObject(json) ? json['matchExpressions'] : undefined)) {
    switch (e.operator) {
      case 'In':
        if (e.values.length !== 1) return { error: `operator ${goQuote(e.operator)} without a single value cannot be converted into the old label selector format` };
        out[e.key] = e.values[0] as string;
        break;
      case 'NotIn':
      case 'Exists':
      case 'DoesNotExist':
        return { error: `operator ${goQuote(e.operator)} cannot be converted into the old label selector format` };
      default:
        return { error: `${goQuote(e.operator)} is not a valid selector operator` };
    }
  }
  return out;
}

/** metav1.FormatLabelSelector: the selector string, `<none>` when empty, `<error>` when invalid. */
export function formatLabelSelector(json: Json | undefined): string {
  const sel = labelSelectorAsSelector(json);
  if ('error' in sel) return '<error>';
  const s = selectorString(sel);
  return s === '' ? '<none>' : s;
}

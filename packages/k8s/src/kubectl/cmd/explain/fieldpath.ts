// How kubectl explain reads its argument: as a JSONPath expression `{.<arg>}` whose nodes are the
// resource and the field names. The part of client-go's JSONPath parser such paths reach is
// ported: fields after `.` (read up to a terminator, `\` escaping the next character), recursive
// descent `..`, the wildcard `*`. Other syntax (`[...]`, filters, quotes, numbers, identifiers,
// spaces) gives null: the caller prints a notice.
//   upstream: staging/src/k8s.io/kubectl/pkg/explain/explain.go jsonPathParse (one trailing `.`
//             trimmed), SplitAndParseResourceRequest, SplitAndParseResourceRequestWithMatchingPrefix
//   upstream: staging/src/k8s.io/client-go/util/jsonpath/parser.go parseInsideAction, parseField,
//             advance, isTerminator, parseRecursive, isAlphaNumeric

export type PathNode = { type: 'field'; value: string } | { type: 'recursive' } | { type: 'wildcard' };

export type Parsed = { nodes: PathNode[] } | { error: string } | null;

const TERMINATORS = new Set([' ', '\t', '\r', '\n', '.', ',', '[', ']', '$', '@', '{', '}']);

/** unicode.IsLetter, unicode.IsDigit or `_` */
function isAlphaNumeric(ch: string | undefined): boolean {
  return ch !== undefined && /^[\p{L}\p{Nd}_]$/u.test(ch);
}

/** jsonPathParse: the nodes of `{.<in>}` with one trailing `.` trimmed. */
export function jsonPathParse(input: string): Parsed {
  // A trailing backslash escapes the closing `}`: an unclosed action.
  if (input.endsWith('\\')) return null;
  const s = '.' + (input.endsWith('.') ? input.slice(0, -1) : input);
  const chars = [...s];
  const nodes: PathNode[] = [];
  let pos = 0;
  const field = (): void => {
    let raw = '';
    while (pos < chars.length) {
      const ch = chars[pos] as string;
      if (ch === '\\') {
        // advance: a backslash takes the next character into the field, terminator or not
        raw += ch + (chars[pos + 1] ?? '');
        pos += 2;
        continue;
      }
      if (TERMINATORS.has(ch)) break;
      raw += ch;
      pos++;
    }
    nodes.push(raw === '*' ? { type: 'wildcard' } : { type: 'field', value: raw.replaceAll('\\', '') });
  };
  while (pos < chars.length) {
    if (chars[pos] === '.' && chars[pos + 1] === '.') {
      if (nodes.at(-1)?.type === 'recursive') return { error: 'invalid multiple recursive descent' };
      pos += 2;
      nodes.push({ type: 'recursive' });
      if (isAlphaNumeric(chars[pos])) field();
      continue;
    }
    if (chars[pos] === '.') {
      pos++;
      field();
      continue;
    }
    return null;
  }
  return { nodes };
}

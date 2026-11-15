// Normalization tokens: placeholders for values that differ between two runs of the same commands
// (identifiers, times, allocated addresses). Golden fixtures (tools/src/golden, phase 04) replace
// volatile values with them; transcripts may contain them in expected output, where a token
// matches any value of its kind. One vocabulary for both (docs/FIDELITY.md §3.1).
//
// A token is written `<<kind>>`, or `<<kind:N>>` for an indexed kind: within one file, the same
// N stands for the same value and different Ns for different values. Real tools never print
// `<<`, unlike `<none>` and `<invalid>`, which kubectl does print and which are not tokens.

export interface TokenKind {
  /** What the token stands for. */
  meaning: string;
  /** A regular expression source matching any value of the kind (no anchors, no groups). */
  pattern: string;
  /** Whether the normalizer numbers distinct values (`<<uid:1>>`, `<<uid:2>>`). */
  indexed: boolean;
}

/** The generated-name alphabet. upstream: staging/src/k8s.io/apimachinery/pkg/util/rand/rand.go alphanums */
const ALPHANUMS = 'bcdfghjklmnpqrstvwxz2456789';

export const TOKENS = {
  uid: {
    meaning: 'an object UID (RFC 4122 UUID)',
    pattern: '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
    indexed: true,
  },
  rv: { meaning: 'a resourceVersion', pattern: '[0-9]+', indexed: false },
  time: {
    meaning:
      'a timestamp: RFC 3339 (2026-11-16T10:00:00Z, with optional fraction), RFC 1123 with numeric zone (Mon, 16 Nov 2026 10:00:00 +0000) or a klog header\'s (1116 10:00:00.123456)',
    pattern:
      '(?:[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})|[A-Z][a-z]{2}, [0-9]{2} [A-Z][a-z]{2} [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} [+-][0-9]{4}|[0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{6})',
    indexed: false,
  },
  age: {
    meaning: 'a human-readable duration as kubectl prints ages (5s, 2m3s, 4d)',
    pattern: '(?:[0-9]+[smhdy])+',
    indexed: false,
  },
  ip: { meaning: 'an address allocated at run time (ClusterIP, Pod IP), or the address of a <<node>>', pattern: '[0-9]{1,3}(?:\\.[0-9]{1,3}){3}', indexed: false },
  hash: {
    meaning: 'a pod-template-hash or controller-revision-hash (SafeEncodeString of a 32-bit hash)',
    // fmt.Sprint(uint32) encoded byte by byte: the digits 0-9 map to these ten characters.
    pattern: '[456789bcdf]{1,10}',
    indexed: true,
  },
  suffix: { meaning: 'the five random characters generateName appends', pattern: `[${ALPHANUMS}]{5}`, indexed: false },
  hex: { meaning: 'a run of hexadecimal digits (an event name suffix, a container ID)', pattern: '[0-9a-f]+', indexed: false },
  port: { meaning: 'a port allocated at run time (NodePort)', pattern: '[0-9]{1,5}', indexed: false },
  pid: { meaning: 'a process ID (the thread field of a klog header)', pattern: '[0-9]+', indexed: false },
  cert: {
    meaning: 'the base64 body of a PEM block generated at run time (the cluster CA in kube-root-ca.crt)',
    pattern: '[A-Za-z0-9+/=\\n]+',
    indexed: false,
  },
  node: {
    meaning: 'a worker node the scheduler chose among equally good ones (a random tie-break), node01 or node02',
    pattern: 'node0[12]',
    indexed: false,
  },
} as const satisfies Record<string, TokenKind>;

export type TokenName = keyof typeof TOKENS;

export function token(kind: TokenName, index?: number): string {
  return index === undefined ? `<<${kind}>>` : `<<${kind}:${index}>>`;
}

const TOKEN_SRC = '<<([a-z]+)(?::([0-9]+))?>>';

export function hasTokens(text: string): boolean {
  return new RegExp(TOKEN_SRC).test(text);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether `actual` matches `expected`, where tokens in `expected` match any value of their kind.
 * An indexed token binds to the value it first matched; a later token with the same kind and
 * index must match the same value, and two indices of a kind never bind the same value.
 */
export function matchTokens(expected: string, actual: string): boolean {
  const groups: { kind: TokenName; index?: string }[] = [];
  let src = '';
  let last = 0;
  for (const m of expected.matchAll(new RegExp(TOKEN_SRC, 'g'))) {
    const kind = m[1] as string;
    if (!(kind in TOKENS)) continue;
    src += escapeRe(expected.slice(last, m.index));
    src += `(${TOKENS[kind as TokenName].pattern})`;
    groups.push({ kind: kind as TokenName, ...(m[2] !== undefined ? { index: m[2] } : {}) });
    last = m.index + m[0].length;
  }
  src += escapeRe(expected.slice(last));
  const m = new RegExp(`^${src}$`, 'u').exec(actual);
  if (!m) return false;
  const bound: Record<string, string> = {};
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i] as { kind: TokenName; index?: string };
    if (g.index === undefined) continue;
    const key = `${g.kind}:${g.index}`;
    const v = m[i + 1] as string;
    const prev = bound[key];
    if (prev !== undefined && prev !== v) return false;
    if (prev === undefined) {
      for (const [k, other] of Object.entries(bound)) if (k.startsWith(`${g.kind}:`) && other === v) return false;
      bound[key] = v;
    }
  }
  return true;
}

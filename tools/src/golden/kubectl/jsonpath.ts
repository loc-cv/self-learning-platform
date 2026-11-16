// A small subset of kubectl's JSONPath templates, enough for the `until` steps of the golden cases
// (polling, never compared): fields, `[n]`, `[*]`, `[?(@.a=="b")]`, `{range …}{end}` and quoted
// literals. The simulated kubectl's own JSONPath arrives in phase 15.
//   upstream: staging/src/k8s.io/client-go/util/jsonpath/jsonpath.go (evalToText: strings as they
//             are, other values as JSON; results of one expression joined by a space)
//   kubectl get -o jsonpath sets AllowMissingKeys(true): a missing field prints nothing
//   (staging/src/k8s.io/cli-runtime/pkg/printers/jsonpath.go JSONPathPrinter).

type Node = { text: string } | { path: string } | { range: string; body: Node[] };

function parse(template: string): Node[] {
  const out: Node[] = [];
  const stack: { range: string; body: Node[] }[] = [];
  const add = (n: Node) => (stack.length > 0 ? (stack[stack.length - 1] as { body: Node[] }).body : out).push(n);
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf('{', i);
    if (open < 0) {
      add({ text: template.slice(i) });
      break;
    }
    if (open > i) add({ text: template.slice(i, open) });
    let depth = 0;
    let j = open;
    let q = false;
    for (; j < template.length; j++) {
      const c = template[j];
      if (c === '"') q = !q;
      if (q) continue;
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) break;
    }
    if (j >= template.length) throw new Error(`unclosed action in ${template}`);
    const inner = template.slice(open + 1, j).trim();
    if (inner.startsWith('range ')) {
      const r = { range: inner.slice(6).trim(), body: [] as Node[] };
      add(r);
      stack.push(r);
    } else if (inner === 'end') {
      if (!stack.pop()) throw new Error('not in range');
    } else if (inner.startsWith('"')) {
      add({ text: JSON.parse(inner) as string });
    } else add({ path: inner });
    i = j + 1;
  }
  return out;
}

/** Path segments: `.name`, `[n]`, `[*]`, `[?(@.a.b=="v")]`. */
function segments(path: string): string[] {
  const out: string[] = [];
  let i = path.startsWith('.') ? 0 : -1;
  if (i < 0) path = '.' + path;
  i = 0;
  while (i < path.length) {
    if (path[i] === '.') {
      let j = i + 1;
      while (j < path.length && path[j] !== '.' && path[j] !== '[') j++;
      const name = path.slice(i + 1, j);
      if (name !== '') out.push(name);
      i = j;
    } else if (path[i] === '[') {
      let depth = 0;
      let j = i;
      for (; j < path.length; j++) {
        if (path[j] === '[') depth++;
        else if (path[j] === ']' && --depth === 0) break;
      }
      out.push(path.slice(i, j + 1));
      i = j + 1;
    } else throw new Error(`bad path ${path}`);
  }
  return out;
}

function evalPath(roots: unknown[], path: string): unknown[] {
  let cur = roots;
  for (const seg of segments(path)) {
    const next: unknown[] = [];
    for (const v of cur) {
      if (seg.startsWith('[?(')) {
        const m = /^\[\?\(@\.([\w.]+)\s*==\s*"([^"]*)"\)\]$/.exec(seg);
        if (!m) throw new Error(`unsupported filter ${seg}`);
        if (!Array.isArray(v)) continue;
        for (const x of v) if (evalPath([x], `.${m[1] as string}`)[0] === m[2]) next.push(x);
      } else if (seg === '[*]') {
        if (Array.isArray(v)) next.push(...v);
        else if (v !== null && typeof v === 'object') next.push(...Object.values(v));
      } else if (/^\[\d+\]$/.test(seg)) {
        if (!Array.isArray(v)) continue;
        const n = Number(seg.slice(1, -1));
        if (n >= v.length) throw new Error(`array index out of bounds: index ${n}, length ${v.length}`);
        next.push(v[n]);
      } else if (v !== null && typeof v === 'object' && !Array.isArray(v) && seg in v) {
        next.push((v as Record<string, unknown>)[seg]);
      }
    }
    cur = next;
  }
  return cur;
}

/** Go's json.Marshal of a decoded value: compact, map keys sorted. */
function goJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(goJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${goJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

const text = (v: unknown): string => (typeof v === 'string' ? v : goJson(v));

function run(nodes: Node[], data: unknown): string {
  let out = '';
  for (const n of nodes) {
    if ('text' in n) out += n.text;
    else if ('path' in n) out += evalPath([data], n.path).map(text).join(' ');
    else for (const item of evalPath([data], n.range)) out += run(n.body, item);
  }
  return out;
}

/** Executes `template` on `data`; throws on what kubectl reports as an error. */
export function jsonpath(template: string, data: unknown): string {
  return run(parse(template), data);
}

// go-spew's `%#v` formatter with the configuration Kubernetes hashes objects with.
// upstream: vendor/k8s.io/utils/dump/dump.go ForHash = prettyPrintConfigForHash.Sprintf("%#v", a)
// with {Indent: " ", SortKeys, DisableMethods, SpewKeys, DisablePointerAddresses,
// DisableCapacities}; vendor/github.com/davecgh/go-spew/spew/format.go formatState.format and
// formatPtr; common.go (the byte constants, printInt/printUint/printBool, sortValues).
//
// What that configuration prints (the `#` flag shows types, `+` is absent, MaxDepth is 0, Indent
// only matters to Dump, never to Sprintf):
//   - a value's type in parentheses, `(v1.PodSpec)`, unless the enclosing value suppressed it:
//     slice and map elements and keys, and a pointer's target, print without one;
//   - struct `{Name:value Name:value}` with every field, exported or not, in declaration order;
//   - strings raw, unquoted; integers in decimal; booleans `true`/`false`;
//   - nil pointers, slices and maps `<nil>`; a pointer `(*T)` then its target;
//   - slices `[a b]`, maps `map[k:v k:v]` with keys sorted (strings byte-wise, numbers by value).
// `ignoreNextType` is formatter state, not a parameter: upstream leaves it set after a nil pointer
// printed without its type, and the next struct field then omits its type too. Ported as is.

/** A Go value as reflect sees it. `t` is reflect's Type.String(): `v1.Container`, `*int64`, `[]string`. */
export type GoValue =
  | { readonly k: 'bool'; readonly t: string; readonly v: boolean }
  | { readonly k: 'int' | 'uint'; readonly t: string; readonly v: bigint }
  | { readonly k: 'string'; readonly t: string; readonly v: string }
  | { readonly k: 'struct'; readonly t: string; readonly fields: readonly (readonly [string, GoValue])[] }
  /** `elem` null: a nil pointer. */
  | { readonly k: 'ptr'; readonly t: string; readonly elem: GoValue | null }
  /** `elems` null: a nil slice. */
  | { readonly k: 'slice'; readonly t: string; readonly elems: readonly GoValue[] | null }
  /** `entries` null: a nil map. Entry order does not matter; the formatter sorts the keys. */
  | { readonly k: 'map'; readonly t: string; readonly entries: readonly (readonly [GoValue, GoValue])[] | null };

interface State {
  out: string[];
  ignoreNextType: boolean;
}

/** dump.ForHash(v): what DeepHashObject writes into the hasher. */
export function forHash(v: GoValue): string {
  const st: State = { out: [], ignoreNextType: false };
  format(st, v);
  return st.out.join('');
}

// upstream: format.go formatPtr. Showing types is always on here (`#`); addresses never print
// (no `+` flag); a tree has no cycles, so the circular-reference branch cannot occur.
function formatPtr(st: State, v: GoValue & { k: 'ptr' }): void {
  if (v.elem === null && st.ignoreNextType) {
    st.out.push('<nil>');
    return;
  }
  let indirects = 0;
  let ve: GoValue = v;
  let nilFound = false;
  while (ve.k === 'ptr') {
    if (ve.elem === null) {
      nilFound = true;
      break;
    }
    indirects++;
    ve = ve.elem;
  }
  if (!st.ignoreNextType) {
    st.out.push('(' + '*'.repeat(indirects) + ve.t + ')');
  } else {
    if (nilFound) indirects += ve.t.split('*').length - 1;
    st.out.push('<' + '*'.repeat(indirects) + '>');
  }
  if (nilFound) {
    st.out.push('<nil>');
  } else {
    st.ignoreNextType = true;
    format(st, ve);
  }
}

// upstream: format.go formatState.format
function format(st: State, v: GoValue): void {
  if (v.k === 'ptr') {
    formatPtr(st, v);
    return;
  }
  if (!st.ignoreNextType) st.out.push('(' + v.t + ')');
  st.ignoreNextType = false;
  switch (v.k) {
    case 'bool':
      st.out.push(v.v ? 'true' : 'false');
      return;
    case 'int':
    case 'uint':
      st.out.push(v.v.toString());
      return;
    case 'string':
      st.out.push(v.v);
      return;
    case 'slice':
      if (v.elems === null) {
        st.out.push('<nil>');
        return;
      }
      st.out.push('[');
      v.elems.forEach((e, i) => {
        if (i > 0) st.out.push(' ');
        st.ignoreNextType = true;
        format(st, e);
      });
      st.out.push(']');
      return;
    case 'map': {
      if (v.entries === null) {
        st.out.push('<nil>');
        return;
      }
      st.out.push('map[');
      sortEntries(v.entries).forEach(([key, value], i) => {
        if (i > 0) st.out.push(' ');
        st.ignoreNextType = true;
        format(st, key);
        st.out.push(':');
        st.ignoreNextType = true;
        format(st, value);
      });
      st.out.push(']');
      return;
    }
    case 'struct':
      st.out.push('{');
      v.fields.forEach(([name, value], i) => {
        if (i > 0) st.out.push(' ');
        st.out.push(name + ':');
        format(st, value);
      });
      st.out.push('}');
      return;
  }
}

// upstream: common.go sortValues/valueSortLess: keys of a primitive kind compare directly (a Go
// string comparison is byte-wise over UTF-8, which is code point order); other key kinds would
// sort by their own spew output (SpewKeys), and no hashed type has such keys.
function sortEntries(entries: readonly (readonly [GoValue, GoValue])[]): (readonly [GoValue, GoValue])[] {
  return [...entries].sort(([a], [b]) => {
    if (a.k === 'string' && b.k === 'string') return compareCodePoints(a.v, b.v);
    if ((a.k === 'int' || a.k === 'uint') && (b.k === 'int' || b.k === 'uint')) return a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
    if (a.k === 'bool' && b.k === 'bool') return Number(a.v) - Number(b.v);
    throw new Error(`spew: map keys of kind ${a.k} are not supported`);
  });
}

function compareCodePoints(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i] as string).codePointAt(0)! - (y[i] as string).codePointAt(0)!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

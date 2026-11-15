// Pattern matching for pathname expansion (and later `case` and `[[ == ]]`).
//   docs: bash(1) 5.2 Pattern Matching and Pathname Expansion; glob(7)
// The locale is C.UTF-8 (docs/decisions.md D-022), so ranges and sorting use code points and the
// character classes are the C locale's.

/** One character of a pattern: `quoted` characters match only themselves. */
export interface PatChar {
  c: string;
  quoted: boolean;
}

export function hasGlobChars(p: readonly PatChar[]): boolean {
  return p.some((x) => !x.quoted && (x.c === '*' || x.c === '?' || x.c === '['));
}

const CLASSES: Record<string, (c: string) => boolean> = {
  alpha: (c) => /[A-Za-z]/.test(c),
  digit: (c) => /[0-9]/.test(c),
  alnum: (c) => /[A-Za-z0-9]/.test(c),
  upper: (c) => /[A-Z]/.test(c),
  lower: (c) => /[a-z]/.test(c),
  space: (c) => /[ \t\n\r\f\v]/.test(c),
  blank: (c) => c === ' ' || c === '\t',
  punct: (c) => /[!-/:-@[-`{-~]/.test(c),
  print: (c) => c >= ' ' && c <= '~',
  graph: (c) => c > ' ' && c <= '~',
  cntrl: (c) => c < ' ' || c === '\x7f',
  xdigit: (c) => /[0-9A-Fa-f]/.test(c),
};

/**
 * Parses a bracket expression starting at `p[i]` (the `[`). Returns the matcher and the index after
 * the closing `]`, or undefined when there is no closing bracket (then `[` is literal).
 */
function bracket(p: readonly PatChar[], i: number): { test: (c: string) => boolean; next: number } | undefined {
  let j = i + 1;
  let negate = false;
  if (j < p.length && !p[j]?.quoted && (p[j]?.c === '!' || p[j]?.c === '^')) {
    negate = true;
    j++;
  }
  const tests: ((c: string) => boolean)[] = [];
  let first = true;
  for (; j < p.length; j++) {
    const ch = p[j] as PatChar;
    if (ch.c === ']' && !ch.quoted && !first) {
      return { test: (c) => tests.some((t) => t(c)) !== negate, next: j + 1 };
    }
    first = false;
    if (ch.c === '[' && !ch.quoted && p[j + 1]?.c === ':') {
      let k = j + 2;
      let name = '';
      while (k < p.length && p[k]?.c !== ':') name += p[k++]?.c;
      if (p[k]?.c === ':' && p[k + 1]?.c === ']' && CLASSES[name]) {
        tests.push(CLASSES[name] as (c: string) => boolean);
        j = k + 1;
        continue;
      }
    }
    const lo = ch.c;
    if (p[j + 1]?.c === '-' && !p[j + 1]?.quoted && p[j + 2] && !(p[j + 2]?.c === ']' && !p[j + 2]?.quoted)) {
      const hi = (p[j + 2] as PatChar).c;
      tests.push((c) => c >= lo && c <= hi);
      j += 2;
      continue;
    }
    tests.push((c) => c === lo);
  }
  return undefined;
}

/** Whether `name` matches the whole pattern. */
export function globMatch(p: readonly PatChar[], name: string): boolean {
  const chars = [...name];
  const memo = new Map<string, boolean>();
  const go = (pi: number, ni: number): boolean => {
    const k = `${pi},${ni}`;
    const hit = memo.get(k);
    if (hit !== undefined) return hit;
    let r: boolean;
    if (pi === p.length) r = ni === chars.length;
    else {
      const pc = p[pi] as PatChar;
      if (!pc.quoted && pc.c === '*') r = go(pi + 1, ni) || (ni < chars.length && go(pi, ni + 1));
      else if (ni === chars.length) r = false;
      else if (!pc.quoted && pc.c === '?') r = go(pi + 1, ni + 1);
      else if (!pc.quoted && pc.c === '[') {
        const b = bracket(p, pi);
        if (b) r = b.test(chars[ni] as string) && go(b.next, ni + 1);
        else r = chars[ni] === '[' && go(pi + 1, ni + 1);
      } else r = chars[ni] === pc.c && go(pi + 1, ni + 1);
    }
    memo.set(k, r);
    return r;
  };
  return go(0, 0);
}

/** Code-point order, which is strcoll(3) in the C.UTF-8 locale. */
export function compareC(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i] as string).codePointAt(0)! - (y[i] as string).codePointAt(0)!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

export interface GlobFs {
  /** Names in a directory, or undefined when it cannot be read. */
  readdir(path: string): string[] | undefined;
  /** Whether the path exists (lstat succeeds). */
  exists(path: string): boolean;
  isDir(path: string): boolean;
}

/**
 * Pathname expansion of one field. Returns the sorted matches, or [] when nothing matches (the
 * caller keeps the word, as bash does without `nullglob`). A name starting with `.` matches only
 * a pattern component that starts with a literal `.`; `.` and `..` never match (`globskipdots`,
 * on by default in bash 5.2).
 */
export function expandPathname(pattern: readonly PatChar[], fs: GlobFs): string[] {
  const comps: PatChar[][] = [[]];
  for (const ch of pattern) {
    if (ch.c === '/') comps.push([]);
    else (comps[comps.length - 1] as PatChar[]).push(ch);
  }
  const absolute = pattern[0]?.c === '/';
  if (absolute) comps.shift();
  let paths: string[] = [absolute ? '/' : ''];
  for (let ci = 0; ci < comps.length; ci++) {
    const comp = comps[ci] as PatChar[];
    const last = ci === comps.length - 1;
    const next: string[] = [];
    const join = (base: string, name: string) => (base === '' ? name : base.endsWith('/') ? base + name : `${base}/${name}`);
    if (comp.length === 0) {
      // A trailing slash: keep only directories.
      for (const base of paths) if (fs.isDir(base === '' ? '.' : base)) next.push(`${base}/`.replace(/\/\/$/, '/'));
      paths = next;
      continue;
    }
    if (!hasGlobChars(comp)) {
      const name = comp.map((c) => c.c).join('');
      for (const base of paths) {
        const p = join(base, name);
        if (last ? fs.exists(p) : fs.isDir(p)) next.push(p);
      }
    } else {
      const dotOk = comp[0]?.c === '.';
      for (const base of paths) {
        const names = fs.readdir(base === '' ? '.' : base);
        if (!names) continue;
        for (const name of names.slice().sort(compareC)) {
          if (name === '.' || name === '..') continue;
          if (name.startsWith('.') && !dotOk) continue;
          if (!globMatch(comp, name)) continue;
          const p = join(base, name);
          if (last || fs.isDir(p)) next.push(p);
        }
      }
    }
    paths = next;
    if (paths.length === 0) return [];
  }
  return paths.sort(compareC);
}

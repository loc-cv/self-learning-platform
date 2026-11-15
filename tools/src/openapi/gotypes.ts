// A reader for the Go type declarations of Kubernetes API packages (staging/src/k8s.io/api/…,
// apimachinery's meta/v1, …): enough of Go's syntax to recover, per struct, each field's JSON
// name, its `omitempty`/`omitzero`/`inline` options and its Go type. encoding/json's behavior
// follows from exactly these, and the OpenAPI documents do not carry them (a non-pointer
// metav1.Time marshals as null, a nil slice without omitempty as null).
//
// Not a Go parser: API type files are gofmt'ed, one field per line, which this relies on.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** A Go type expression with package-qualified names resolved to `<import path>.<Name>`. */
export type GoExpr =
  | { k: 'basic'; name: string }
  | { k: 'named'; id: string }
  | { k: 'ptr'; elem: GoExpr }
  | { k: 'slice'; elem: GoExpr }
  | { k: 'map'; key: GoExpr; elem: GoExpr }
  | { k: 'any' };

export interface GoField {
  /** Go field name; for an embedded field, the type's name. */
  name: string;
  type: GoExpr;
  embedded: boolean;
  /** From the `json` tag: name ('' when the tag gives none), options. Absent tag: undefined. */
  json?: { name: string; omitempty: boolean; omitzero: boolean; inline: boolean; skip: boolean };
}

export type GoDecl = { kind: 'struct'; fields: GoField[] } | { kind: 'alias' | 'defined'; type: GoExpr };

export interface GoPackage {
  path: string;
  /** The package clause's name: what reflect's Type.String() prints (`v1.PodSpec`). */
  name: string;
  types: Map<string, GoDecl>;
}

const BASIC = new Set([
  'string', 'bool', 'byte', 'rune', 'int', 'int8', 'int16', 'int32', 'int64',
  'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr', 'float32', 'float64',
]);

/** Removes comments, keeping string and raw-string literals (struct tags) intact. */
function stripComments(src: string): string {
  let out = '';
  for (let i = 0; i < src.length; ) {
    const c = src[i] as string;
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const body = src.slice(i, end + 2);
      out += body.replace(/[^\n]/g, ' ');
      i = end + 2;
    } else if (c === '`') {
      const end = src.indexOf('`', i + 1);
      out += src.slice(i, end + 1);
      i = end + 1;
    } else if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function parseImports(src: string, resolve: (p: string) => string): Map<string, string> {
  const m = new Map<string, string>();
  const add = (alias: string | undefined, p: string) => {
    m.set(alias ?? resolve(p), p);
  };
  for (const block of src.matchAll(/^import\s*\(([\s\S]*?)^\)/gm)) {
    for (const line of (block[1] as string).split('\n')) {
      const mm = /^\s*(?:([A-Za-z_][\w]*|\.|_)\s+)?"([^"]+)"/.exec(line);
      if (mm) add(mm[1], mm[2] as string);
    }
  }
  for (const mm of src.matchAll(/^import\s+(?:([A-Za-z_]\w*)\s+)?"([^"]+)"/gm)) add(mm[1], mm[2] as string);
  return m;
}

/** Parses a type expression at the start of `s`; returns it and the rest. */
function parseExpr(s: string, pkg: string, imports: Map<string, string>): [GoExpr, string] {
  s = s.trimStart();
  if (s.startsWith('*')) {
    const [e, rest] = parseExpr(s.slice(1), pkg, imports);
    return [{ k: 'ptr', elem: e }, rest];
  }
  if (s.startsWith('[]')) {
    const [e, rest] = parseExpr(s.slice(2), pkg, imports);
    return [{ k: 'slice', elem: e }, rest];
  }
  if (s.startsWith('map[')) {
    const [key, r1] = parseExpr(s.slice(4), pkg, imports);
    const r2 = r1.trimStart();
    if (!r2.startsWith(']')) throw new Error(`bad map type near ${s.slice(0, 40)}`);
    const [elem, rest] = parseExpr(r2.slice(1), pkg, imports);
    return [{ k: 'map', key, elem }, rest];
  }
  if (s.startsWith('interface{}')) return [{ k: 'any' }, s.slice('interface{}'.length)];
  const m = /^([A-Za-z_]\w*)(?:\.([A-Za-z_]\w*))?/.exec(s);
  if (!m) throw new Error(`cannot parse a type at "${s.slice(0, 40)}"`);
  const rest = s.slice(m[0].length);
  if (m[2] !== undefined) {
    const p = imports.get(m[1] as string);
    if (!p) throw new Error(`unknown package qualifier ${m[1]} in ${pkg}`);
    return [{ k: 'named', id: `${p}.${m[2]}` }, rest];
  }
  const name = m[1] as string;
  if (name === 'any') return [{ k: 'any' }, rest];
  if (BASIC.has(name)) return [{ k: 'basic', name: name === 'byte' ? 'uint8' : name }, rest];
  return [{ k: 'named', id: `${pkg}.${name}` }, rest];
}

function parseTag(tag: string | undefined): GoField['json'] {
  if (!tag) return undefined;
  const m = /(?:^|\s)json:"([^"]*)"/.exec(tag);
  if (!m) return undefined;
  const [name = '', ...opts] = (m[1] as string).split(',');
  return {
    name: name === '-' && opts.length === 0 ? '' : name,
    omitempty: opts.includes('omitempty'),
    omitzero: opts.includes('omitzero'),
    inline: opts.includes('inline'),
    skip: name === '-' && opts.length === 0,
  };
}

function parseStructBody(body: string, pkg: string, imports: Map<string, string>): GoField[] {
  const fields: GoField[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const tagMatch = /`([^`]*)`\s*$/.exec(line);
    const tag = tagMatch?.[1];
    const decl = (tagMatch ? line.slice(0, tagMatch.index) : line).trim();
    const first = /^([A-Za-z_]\w*)(\s*,\s*[A-Za-z_]\w*)*\s+(?=\S)/.exec(decl);
    // An embedded field is a type alone: `metav1.TypeMeta`, `*Foo`, `Foo`.
    const isEmbedded = !first || /^[A-Za-z_]\w*\.[A-Za-z_]/.test(decl);
    if (isEmbedded) {
      const [type] = parseExpr(decl, pkg, imports);
      const base = type.k === 'ptr' ? type.elem : type;
      const name = base.k === 'named' ? (base.id.split('.').pop() as string) : decl;
      const json = parseTag(tag);
      fields.push({ name, type, embedded: true, ...(json ? { json } : {}) });
      continue;
    }
    const names = decl.slice(0, first[0].length).split(',').map((n) => n.trim());
    const [type] = parseExpr(decl.slice(first[0].length), pkg, imports);
    const json = parseTag(tag);
    for (const n of names) fields.push({ name: n, type, embedded: false, ...(json ? { json } : {}) });
  }
  return fields;
}

/** Finds the matching closing brace of the `{` at `open`. */
function matchBrace(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '`') i = src.indexOf('`', i + 1);
    else if (c === '"') {
      i++;
      while (src[i] !== '"') i += src[i] === '\\' ? 2 : 1;
    } else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  throw new Error('unbalanced braces');
}

/** Reads every non-test, non-generated .go file of a package directory. */
export function readGoPackage(dir: string, importPath: string): GoPackage {
  const types = new Map<string, GoDecl>();
  let name = '';
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.go') && !f.endsWith('_test.go') && !f.startsWith('zz_generated') && !f.startsWith('generated.'))
    .sort();
  for (const f of files) {
    const src = stripComments(readFileSync(path.join(dir, f), 'utf8'));
    const pkgName = /^package\s+(\w+)/m.exec(src)?.[1];
    if (!pkgName) continue;
    name = pkgName;
    const imports = parseImports(src, (p) => p.split('/').pop() as string);
    const re = /^type\s+([A-Z]\w*)\s+(=\s*)?(struct\s*\{|[^\n]+)/gm;
    for (const m of src.matchAll(re)) {
      const typeName = m[1] as string;
      const rhs = m[3] as string;
      if (rhs.startsWith('struct')) {
        const open = (m.index ?? 0) + m[0].length - 1;
        const close = matchBrace(src, open);
        types.set(typeName, { kind: 'struct', fields: parseStructBody(src.slice(open + 1, close), importPath, imports) });
      } else {
        if (/^interface\b|^func\b/.test(rhs.trim())) continue;
        try {
          const [type] = parseExpr(rhs, importPath, imports);
          types.set(typeName, { kind: m[2] ? 'alias' : 'defined', type });
        } catch {
          // Generic or exotic declarations (none in API types) are not needed.
        }
      }
    }
  }
  return { path: importPath, name, types };
}

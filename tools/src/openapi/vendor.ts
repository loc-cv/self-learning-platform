// npm run api:vendor -- [--check]
//
// Turns upstream API definitions into the compact data packages/k8s vendors per Kubernetes
// version (docs/ARCHITECTURE.md §4.6):
//   - the schema: every type reachable from a served kind, with each field's JSON name, Go type
//     and encoding/json options (from the Go sources, gotypes.ts) and the OpenAPI v3 annotations
//     (required, list type and keys, patch strategy) — packages/k8s/src/openapi/data/<tag>.ts;
//   - the resource registry from the API server's discovery documents as captured by the oracle
//     (fixtures/golden/<tag>/api/discovery.yaml) — packages/k8s/src/discovery/data/<tag>.ts.
// The OpenAPI v3 documents `kubectl explain` reads, descriptions included, come from the real API
// server instead (npm run openapi:capture, tools/src/openapi/capture.ts): the checked-in documents
// read here lack part of what the server serves, such as enums.
// Inputs: .upstream/kubernetes (npm run upstream:fetch) and the committed discovery fixture.
// With --check, nothing is written and a difference from the vendored files fails.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { KUBERNETES_TAG } from '@simlab/k8s';
import { fixturesDir, repoRoot } from '../oracle/paths.ts';
import { readGoPackage, type GoDecl, type GoExpr, type GoPackage } from './gotypes.ts';

const upstream = path.join(repoRoot, '.upstream', 'kubernetes');
const specDir = path.join(upstream, 'api', 'openapi-spec', 'v3');

/** Types whose MarshalJSON/UnmarshalJSON replace the struct encoding (grep in the sources above). */
const CUSTOM: Record<string, string> = {
  'k8s.io/apimachinery/pkg/apis/meta/v1.Time': 'time',
  'k8s.io/apimachinery/pkg/apis/meta/v1.MicroTime': 'microtime',
  'k8s.io/apimachinery/pkg/apis/meta/v1.Duration': 'duration',
  'k8s.io/apimachinery/pkg/apis/meta/v1.FieldsV1': 'json',
  'k8s.io/apimachinery/pkg/apis/meta/v1.GroupVersion': 'string',
  'k8s.io/apimachinery/pkg/api/resource.Quantity': 'quantity',
  'k8s.io/apimachinery/pkg/util/intstr.IntOrString': 'intstr',
  'k8s.io/apimachinery/pkg/runtime.RawExtension': 'json',
  'k8s.io/apimachinery/pkg/runtime.Unknown': 'json',
  'k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1.JSON': 'json',
  'k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1.JSONSchemaPropsOrArray': 'json',
  'k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1.JSONSchemaPropsOrBool': 'json',
  'k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1.JSONSchemaPropsOrStringArray': 'json',
};

/** `k8s.io/api/core/v1.Pod` → `core/v1.Pod`; meta/v1 likewise; other repos keep their path. */
export function shortId(id: string): string {
  return id
    .replace(/^k8s\.io\/api\//, '')
    .replace(/^k8s\.io\/apimachinery\/pkg\/apis\//, '')
    .replace(/^k8s\.io\//, '');
}

/** OpenAPI definition name → Go type id: `io.k8s.api.core.v1.Pod` → `k8s.io/api/core/v1.Pod`. */
function goIdOfDefinition(def: string): string {
  const parts = def.replace(/^io\.k8s\./, '').split('.');
  const name = parts.pop() as string;
  return `k8s.io/${parts.join('/')}.${name}`;
}

const packages = new Map<string, GoPackage>();
function goPackage(importPath: string): GoPackage {
  let p = packages.get(importPath);
  if (!p) {
    const dir = path.join(upstream, 'staging', 'src', importPath);
    if (!existsSync(dir)) throw new Error(`Go package ${importPath} is not in the upstream checkout (${dir}); add it to tools/src/upstream/paths.ts`);
    p = readGoPackage(dir, importPath);
    packages.set(importPath, p);
  }
  return p;
}

function splitId(id: string): [string, string] {
  const i = id.lastIndexOf('.');
  return [id.slice(0, i), id.slice(i + 1)];
}

function declOf(id: string): { pkg: GoPackage; decl: GoDecl } {
  const [pkgPath, name] = splitId(id);
  const pkg = goPackage(pkgPath);
  const decl = pkg.types.get(name);
  if (!decl) throw new Error(`no Go declaration of ${id}`);
  return { pkg, decl };
}

// ---- OpenAPI ----

interface OpenApiSchema {
  description?: string;
  properties?: Record<string, OpenApiSchema & Record<string, unknown>>;
  required?: string[];
  'x-kubernetes-group-version-kind'?: { group: string; version: string; kind: string }[];
}

function loadDefinitions(groupVersions: string[]): Map<string, OpenApiSchema> {
  const defs = new Map<string, OpenApiSchema>();
  for (const gv of groupVersions) {
    const file = gv === 'v1' ? 'api__v1_openapi.json' : `apis__${gv.replace('/', '__')}_openapi.json`;
    const doc = JSON.parse(readFileSync(path.join(specDir, file), 'utf8')) as { components: { schemas: Record<string, OpenApiSchema> } };
    for (const [name, s] of Object.entries(doc.components.schemas)) if (!defs.has(name)) defs.set(name, s);
  }
  return defs;
}

// ---- Discovery ----

interface ApiResource {
  name: string;
  singularName: string;
  namespaced: boolean;
  kind: string;
  verbs: string[];
  shortNames?: string[];
  categories?: string[];
  group?: string;
  version?: string;
  storageVersionHash?: string;
}

interface Discovery {
  /** Group versions in the order of /api then /apis (the order of `kubectl api-resources`' groups). */
  groups: { name: string; versions: string[]; preferred: string }[];
  lists: Record<string, ApiResource[]>;
}

function loadDiscovery(): Discovery {
  const fixture = parseYaml(readFileSync(path.join(fixturesDir, 'api', 'discovery.yaml'), 'utf8')) as {
    steps: { request?: string; response?: Record<string, unknown> }[];
  };
  const byPath = new Map<string, Record<string, unknown>>();
  for (const s of fixture.steps) if (s.request && s.response) byPath.set(s.request.replace(/^GET /, ''), s.response);
  const apis = byPath.get('/apis') as { groups: { name: string; versions: { groupVersion: string; version: string }[]; preferredVersion: { version: string } }[] };
  const groups = [
    { name: '', versions: ['v1'], preferred: 'v1' },
    ...apis.groups.map((g) => ({ name: g.name, versions: g.versions.map((v) => v.version), preferred: g.preferredVersion.version })),
  ];
  const lists: Record<string, ApiResource[]> = {};
  for (const g of groups) {
    for (const v of g.versions) {
      const gv = g.name === '' ? v : `${g.name}/${v}`;
      const doc = byPath.get(g.name === '' ? '/api/v1' : `/apis/${gv}`) as { resources: ApiResource[] } | undefined;
      if (!doc) throw new Error(`the discovery fixture has no resource list for ${gv}`);
      lists[gv] = doc.resources;
    }
  }
  return { groups, lists };
}

// ---- Type graph ----

interface FieldOut {
  json: string;
  type: string;
  flags: string;
  extra?: Record<string, unknown>;
}

const types: Record<string, unknown[] | Record<string, unknown>> = {};
const visiting = new Set<string>();

function exprString(e: GoExpr): string {
  switch (e.k) {
    case 'basic':
      return e.name;
    case 'any':
      return 'any';
    case 'ptr':
      return '*' + exprString(e.elem);
    case 'slice':
      return e.elem.k === 'basic' && e.elem.name === 'uint8' ? 'bytes' : '[]' + exprString(e.elem);
    case 'map':
      return `map[${exprString(e.key)}]${exprString(e.elem)}`;
    case 'named':
      visitNamed(e.id);
      return '@' + shortId(e.id);
  }
}

/** Fields of a struct after Go's embedding rules: inline and untagged embedded structs splice in. */
function structFields(id: string): { field: FieldOut; goName: string }[] {
  const { decl } = declOf(id);
  if (decl.kind !== 'struct') throw new Error(`${id} is not a struct`);
  const out: { field: FieldOut; goName: string }[] = [];
  for (const f of decl.fields) {
    if (!/^[A-Z]/.test(f.name)) continue;
    if (f.json?.skip) continue;
    if (f.embedded && (f.json === undefined || f.json.inline || f.json.name === '')) {
      const base = f.type.k === 'ptr' ? f.type.elem : f.type;
      if (base.k !== 'named') throw new Error(`${id}: embedded ${f.name} is not a named type`);
      const resolved = resolveAlias(base.id);
      if (CUSTOM[resolved]) throw new Error(`${id}: inline custom type ${resolved}`);
      out.push(...structFields(resolved));
      continue;
    }
    const json = f.json?.name || f.name;
    const flags = (f.json?.omitempty ? 'o' : '') + (f.json?.omitzero ? 'z' : '');
    out.push({ field: { json, type: exprString(f.type), flags }, goName: f.name });
  }
  return out;
}

function resolveAlias(id: string): string {
  for (let i = 0; i < 10; i++) {
    if (CUSTOM[id]) return id;
    const { decl } = declOf(id);
    if (decl.kind !== 'alias') return id;
    if (decl.type.k !== 'named') throw new Error(`alias ${id} to a non-named type`);
    id = decl.type.id;
  }
  throw new Error(`alias loop at ${id}`);
}

/** The OpenAPI definitions, by Go type id, for annotations and descriptions. */
let definitionsByGoId = new Map<string, OpenApiSchema>();

function visitNamed(rawId: string): void {
  const id = resolveAlias(rawId);
  const key = shortId(rawId);
  if (types[key] || visiting.has(key)) return;
  visiting.add(key);
  const [pkgPath, name] = splitId(id);
  const custom = CUSTOM[id];
  if (custom) {
    const pkg = goPackage(pkgPath);
    types[key] = { n: `${pkg.name}.${name}`, c: custom };
    return;
  }
  const { pkg, decl } = declOf(id);
  const display = `${pkg.name}.${name}`;
  if (decl.kind !== 'struct') {
    types[key] = { n: display, u: exprString(decl.type) };
    return;
  }
  const def = definitionsByGoId.get(id);
  const required = new Set(def?.required ?? []);
  const fields = structFields(id);
  const props = def?.properties ?? {};
  if (def) {
    const goNames = new Set(fields.map((f) => f.field.json));
    const missing = Object.keys(props).filter((p) => !goNames.has(p));
    if (missing.length > 0) throw new Error(`${id}: OpenAPI properties without a Go field: ${missing.join(', ')}`);
  }
  const rows = fields.map(({ field }) => {
    const p = props[field.json];
    const extra: Record<string, unknown> = {};
    if (p) {
      for (const [k, short] of [
        ['x-kubernetes-list-type', 'lt'],
        ['x-kubernetes-list-map-keys', 'lk'],
        ['x-kubernetes-map-type', 'mt'],
        ['x-kubernetes-patch-strategy', 'ps'],
        ['x-kubernetes-patch-merge-key', 'pk'],
        ['enum', 'en'],
      ] as const) {
        if (p[k] !== undefined) extra[short] = p[k];
      }
    }
    const flags = field.flags + (required.has(field.json) ? 'r' : '');
    const row: unknown[] = [field.json, field.type];
    if (flags || Object.keys(extra).length > 0) row.push(flags);
    if (Object.keys(extra).length > 0) row.push(extra);
    return row;
  });
  const defName = def ? defNameOf.get(id) : undefined;
  types[key] = { n: display, ...(defName ? { d: defName } : {}), f: rows };
}

const defNameOf = new Map<string, string>();

// ---- Go struct layouts (DeepHashObject) ----
//
// pkg/util/hash DeepHashObject prints a Go value with go-spew, which shows every field of every
// struct in declaration order under its Go name, embedded structs as a field named after their
// type, unexported fields and fields encoding/json skips included. The schema above keeps none of
// that, so the types reachable from LAYOUT_ROOTS get their layouts here
// (packages/k8s/src/openapi/data/<tag>.golayout.ts, read by packages/k8s/src/controllers/hash):
//   { version, types: { <short id>: T } }, where T is
//   { n: '<reflect display name>', f: [[goName, json, type], …] }   a struct, fields in order;
//       json is the JSON key the field decodes from, '' for an embedded struct that reads the
//       enclosing object (inline or untagged), '-' for a field JSON never sets (unexported, json:"-");
//   { n, u: type }    a defined non-struct type (`type Protocol string`);
//   { n, c: kind }    a type with its own JSON methods (CUSTOM); its layout is hand-written next
//       to the code that prints it (time.Time, resource.Quantity, intstr.IntOrString, FieldsV1).
// Types are written as in the schema: `string`, `*int64`, `[]@core/v1.Container`, `bytes`,
// `map[string]string`, `@resource.Quantity`.

const LAYOUT_ROOTS = ['k8s.io/api/core/v1.PodTemplateSpec'];
const layouts: Record<string, Record<string, unknown>> = {};

function layoutExpr(e: GoExpr): string {
  switch (e.k) {
    case 'basic':
      return e.name;
    case 'any':
      throw new Error('an interface{} field in a hashed type: its dynamic type is not in the declaration');
    case 'ptr':
      return '*' + layoutExpr(e.elem);
    case 'slice':
      return e.elem.k === 'basic' && e.elem.name === 'uint8' ? 'bytes' : '[]' + layoutExpr(e.elem);
    case 'map':
      return `map[${layoutExpr(e.key)}]${layoutExpr(e.elem)}`;
    case 'named':
      return '@' + visitLayout(e.id);
  }
}

/** Records the layout of a named type; returns its key. Aliases resolve to their target. */
function visitLayout(rawId: string): string {
  const id = resolveAlias(rawId);
  const key = shortId(id);
  if (layouts[key]) return key;
  const [pkgPath, name] = splitId(id);
  const pkg = goPackage(pkgPath);
  const n = `${pkg.name}.${name}`;
  const custom = CUSTOM[id];
  if (custom) {
    layouts[key] = { n, c: custom };
    return key;
  }
  const { decl } = declOf(id);
  if (decl.kind !== 'struct') {
    layouts[key] = { n, u: layoutExpr(decl.type) };
    return key;
  }
  const row: Record<string, unknown> = { n, f: [] };
  layouts[key] = row;
  row.f = decl.fields.map((f) => {
    let json: string;
    if (!/^[A-Z]/.test(f.name) || f.json?.skip) json = '-';
    else if (f.embedded && (f.json === undefined || f.json.inline || f.json.name === '')) json = '';
    else json = f.json?.name || f.name;
    return [f.name, json, layoutExpr(f.type)];
  });
  return key;
}

// ---- Main ----

function generated(what: string, data: unknown): string {
  // A string literal parsed once at load: much faster to load than an object literal of this size.
  return (
    `// Generated by npm run api:vendor from ${what}. Do not edit.\n` +
    `// Format: docs/ARCHITECTURE.md §4.6.\n\n` +
    `export const DATA = ${JSON.stringify(JSON.stringify(data))};\n`
  );
}

const check = process.argv.includes('--check');
const discovery = loadDiscovery();
const groupVersions = Object.keys(discovery.lists);
const defs = loadDefinitions(groupVersions);
definitionsByGoId = new Map([...defs].map(([n, s]) => [goIdOfDefinition(n), s]));
for (const n of defs.keys()) defNameOf.set(goIdOfDefinition(n), n);

// Roots: every kind a served resource or subresource has, by its definition's GVK.
const kinds: Record<string, string> = {};
const gvkIndex = new Map<string, string>();
for (const [name, s] of defs) {
  for (const g of s['x-kubernetes-group-version-kind'] ?? []) {
    const apiVersion = g.group === '' ? g.version : `${g.group}/${g.version}`;
    if (!gvkIndex.has(`${apiVersion}/${g.kind}`)) gvkIndex.set(`${apiVersion}/${g.kind}`, name);
  }
}
for (const [gv, resources] of Object.entries(discovery.lists)) {
  for (const r of resources) {
    const apiVersion = r.group !== undefined && r.version ? (r.group === '' ? r.version : `${r.group}/${r.version}`) : gv;
    for (const kind of [r.kind, `${r.kind}List`]) {
      const def = gvkIndex.get(`${apiVersion}/${kind}`);
      if (!def) {
        if (kind.endsWith('List') || r.name.includes('/')) continue;
        throw new Error(`no OpenAPI definition for ${apiVersion} ${kind} (resource ${r.name})`);
      }
      kinds[`${apiVersion}/${kind}`] = shortId(goIdOfDefinition(def));
      visitNamed(goIdOfDefinition(def));
    }
  }
}
// Bodies the API server decodes that are not resources: options and Status.
for (const extra of ['io.k8s.apimachinery.pkg.apis.meta.v1.DeleteOptions', 'io.k8s.apimachinery.pkg.apis.meta.v1.Status']) {
  kinds[`v1/${extra.split('.').pop() as string}`] = shortId(goIdOfDefinition(extra));
  visitNamed(goIdOfDefinition(extra));
}

const sortedTypes = Object.fromEntries(Object.keys(types).sort().map((k) => [k, types[k]]));
const sortedKinds = Object.fromEntries(Object.keys(kinds).sort().map((k) => [k, kinds[k]]));
const schema = { version: KUBERNETES_TAG, kinds: sortedKinds, types: sortedTypes };

// The registry: discovery's resource lists, in discovery order, without volatile fields.
const registry = {
  version: KUBERNETES_TAG,
  groups: discovery.groups,
  resources: Object.fromEntries(
    Object.entries(discovery.lists).map(([gv, rs]) => [
      gv,
      rs.map((r) => ({
        name: r.name,
        singularName: r.singularName,
        namespaced: r.namespaced,
        kind: r.kind,
        verbs: r.verbs,
        ...(r.shortNames ? { shortNames: r.shortNames } : {}),
        ...(r.categories ? { categories: r.categories } : {}),
        ...(r.group !== undefined ? { group: r.group } : {}),
        ...(r.version !== undefined ? { version: r.version } : {}),
        ...(r.storageVersionHash ? { storageVersionHash: r.storageVersionHash } : {}),
      })),
    ]),
  ),
};

for (const root of LAYOUT_ROOTS) visitLayout(root);
const golayout = { version: KUBERNETES_TAG, types: Object.fromEntries(Object.keys(layouts).sort().map((k) => [k, layouts[k]])) };

const outputs: [string, string][] = [
  [path.join(repoRoot, 'packages', 'k8s', 'src', 'openapi', 'data', `${KUBERNETES_TAG}.ts`), generated(`the OpenAPI v3 documents and Go types of ${KUBERNETES_TAG}`, schema)],
  [path.join(repoRoot, 'packages', 'k8s', 'src', 'discovery', 'data', `${KUBERNETES_TAG}.ts`), generated(`fixtures/golden/${KUBERNETES_TAG}/api/discovery.yaml`, registry)],
  [path.join(repoRoot, 'packages', 'k8s', 'src', 'openapi', 'data', `${KUBERNETES_TAG}.golayout.ts`), generated(`the Go types of ${KUBERNETES_TAG} (Go struct layouts)`, golayout)],
];
let failed = false;
for (const [file, text] of outputs) {
  const old = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  const rel = path.relative(repoRoot, file);
  if (check) {
    if (old !== text) {
      console.error(`${rel} is not what api:vendor generates`);
      failed = true;
    }
  } else if (old !== text) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
    console.log(`wrote ${rel} (${(Buffer.byteLength(text) / 1024).toFixed(0)} KiB)`);
  } else console.log(`${rel} unchanged`);
}
console.log(`${Object.keys(sortedKinds).length} kinds, ${Object.keys(sortedTypes).length} types`);
process.exit(failed ? 1 : 0);

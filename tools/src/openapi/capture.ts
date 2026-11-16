// npm run openapi:capture [-- --check]
//
// The OpenAPI v3 documents the real API server serves, one per group version, as `kubectl
// explain` reads them: started from a fresh oracle (no KWOK), read with `kubectl get --raw` of
// /openapi/v3 and of each group version's serverRelativeURL, reduced, and written as
// packages/k8s/src/openapi/data/<tag>.openapiv3.ts (read by packages/k8s/src/openapi/v3.ts,
// served by packages/k8s/src/apiserver/openapi.ts). The checked-in documents of the upstream
// checkout (api/openapi-spec/v3) are not the source: at v1.37.2 they lack what the server serves,
// such as the enums and the "Possible enum values" part of descriptions.
//
// The documents are about 12 MiB, mostly parameters and responses explain never reads, so they
// are reduced. Format:
//   { version,
//     defs: { <definition name>: S },        each component schema once, as the first document
//                                           that has it shows it
//     gvs: { <path, "api/v1" | "apis/<g>/<v>">: {
//       s: [i, …],                           indexes into the sorted definition names: the
//                                           document's components.schemas
//       p: { <path>: { <method>: "<group>/<version>/<Kind>" } },
//                                           each operation's x-kubernetes-group-version-kind
//                                           (the group version's own discovery path, which has
//                                           none, is left out)
//       o: { <definition name>: { <key>: v } } } } }
//                                           top-level keys where this document's schema differs
//                                           from defs: the GVK lists of DeleteOptions and
//                                           WatchEvent name the document's own group
// where S keeps only the schema keys the template reads (EXPLAIN_KEYS), recursively through
// properties, items, additionalProperties and allOf.
// With --check, nothing is written and a difference from the committed module fails.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { KUBERNETES_TAG } from '@simlab/k8s';
import { binaryPath } from '../oracle/binaries.ts';
import { down, up, type OracleState } from '../oracle/controlplane.ts';
import { repoRoot } from '../oracle/paths.ts';

const moduleFile = path.join(repoRoot, 'packages', 'k8s', 'src', 'openapi', 'data', `${KUBERNETES_TAG}.openapiv3.ts`);

/** What plaintext.tmpl reads of a schema (staging/src/k8s.io/kubectl/pkg/explain/v2/templates). */
const EXPLAIN_KEYS = ['description', 'type', 'items', 'additionalProperties', 'allOf', '$ref', 'properties', 'required', 'enum', 'externalDocs', 'x-kubernetes-group-version-kind'];
const METHODS = ['get', 'put', 'post', 'delete', 'patch'];

type Schema = Record<string, unknown>;
interface Document {
  paths: Record<string, Record<string, { 'x-kubernetes-group-version-kind'?: { group: string; version: string; kind: string } }>>;
  components: { schemas: Record<string, Schema> };
}

function reduceSchema(s: Schema): Schema {
  const out: Schema = {};
  for (const k of EXPLAIN_KEYS) {
    const v = s[k];
    if (v === undefined) continue;
    if (k === 'properties') {
      const props = v as Record<string, Schema>;
      out[k] = Object.fromEntries(Object.keys(props).sort().map((n) => [n, reduceSchema(props[n] as Schema)]));
    } else if (k === 'items' || (k === 'additionalProperties' && typeof v === 'object' && v !== null)) {
      out[k] = reduceSchema(v as Schema);
    } else if (k === 'allOf') {
      out[k] = (v as Schema[]).map(reduceSchema);
    } else out[k] = v;
  }
  // The template tests schemas for emptiness (`with`, `or`), so a schema must not become empty.
  if (Object.keys(out).length === 0 && Object.keys(s).length > 0) throw new Error(`a schema has only keys explain does not read: ${JSON.stringify(s)}`);
  return out;
}

function getRaw(state: OracleState, url: string): string {
  const r = spawnSync(binaryPath('kubectl'), ['--kubeconfig', state.kubeconfig, 'get', '--raw', url], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`kubectl get --raw ${url}: ${r.stderr}`);
  return r.stdout;
}

function reduce(documents: [string, Document][]): unknown {
  const defs = new Map<string, string>();
  const perGv: { key: string; names: string[]; paths: Record<string, Record<string, string>>; own: Record<string, unknown> }[] = [];
  for (const [key, doc] of documents) {
    const names = Object.keys(doc.components.schemas).sort();
    const own: Record<string, unknown> = {};
    for (const n of names) {
      const reduced = reduceSchema(doc.components.schemas[n] as Schema);
      const text = JSON.stringify(reduced);
      const old = defs.get(n);
      if (old === undefined) defs.set(n, text);
      else if (old !== text) {
        const base = JSON.parse(old) as Schema;
        const keys = [...new Set([...Object.keys(base), ...Object.keys(reduced)])];
        if (keys.some((k) => !(k in reduced))) throw new Error(`${n} lacks keys in the document of ${key}`);
        own[n] = Object.fromEntries(keys.filter((k) => JSON.stringify(base[k]) !== JSON.stringify(reduced[k])).map((k) => [k, reduced[k]]));
      }
    }
    const paths: Record<string, Record<string, string>> = {};
    for (const p of Object.keys(doc.paths).sort()) {
      const ops: Record<string, string> = {};
      for (const m of METHODS) {
        const op = doc.paths[p]?.[m];
        if (!op) continue;
        const g = op['x-kubernetes-group-version-kind'];
        if (g) ops[m] = `${g.group}/${g.version}/${g.kind}`;
        // Only the group version's discovery document (`/apis/apps/v1/`) has no GVK; the template
        // looks up resource paths only.
        else if (p !== `/${key}/`) throw new Error(`${m} ${p} has no x-kubernetes-group-version-kind`);
      }
      if (Object.keys(ops).length > 0) paths[p] = ops;
    }
    perGv.push({ key, names, paths, own });
  }
  const sorted = [...defs.keys()].sort();
  const index = new Map(sorted.map((n, i) => [n, i]));
  return {
    version: KUBERNETES_TAG,
    defs: Object.fromEntries(sorted.map((n) => [n, JSON.parse(defs.get(n) as string) as unknown])),
    gvs: Object.fromEntries(perGv.map((g) => [g.key, { s: g.names.map((n) => index.get(n)), p: g.paths, ...(Object.keys(g.own).length > 0 ? { o: g.own } : {}) }])),
  };
}

function generated(data: unknown): string {
  // A string literal parsed once at load: much faster to load than an object literal of this size.
  return (
    `// Generated by npm run openapi:capture from the OpenAPI v3 documents the API server of ${KUBERNETES_TAG} serves. Do not edit.\n` +
    `// Format: tools/src/openapi/capture.ts.\n\n` +
    `export const DATA = ${JSON.stringify(JSON.stringify(data))};\n`
  );
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const state = await up({ kwok: false, owner: 'openapi:capture', log: (s) => console.log(s) });
  let text: string;
  try {
    const index = JSON.parse(getRaw(state, '/openapi/v3')) as { paths: Record<string, { serverRelativeURL: string }> };
    // Group versions only: `api/v1`, `apis/<group>/<version>`.
    const keys = Object.keys(index.paths)
      .filter((k) => /^api\/[^/]+$|^apis\/[^/]+\/[^/]+$/.test(k))
      .sort();
    const documents: [string, Document][] = keys.map((k) => [k, JSON.parse(getRaw(state, (index.paths[k] as { serverRelativeURL: string }).serverRelativeURL)) as Document]);
    text = generated(reduce(documents));
    console.log(`${keys.length} group versions`);
  } finally {
    const problems = await down(state);
    for (const p of problems) console.error(p);
  }
  const rel = path.relative(repoRoot, moduleFile);
  const old = existsSync(moduleFile) ? readFileSync(moduleFile, 'utf8') : undefined;
  if (check) {
    if (old !== text) {
      console.error(`${rel} differs from a fresh capture; run npm run openapi:capture`);
      process.exit(1);
    }
    console.log(`${rel} matches a fresh capture`);
    return;
  }
  if (old === text) console.log(`${rel} unchanged`);
  else {
    writeFileSync(moduleFile, text);
    console.log(`wrote ${rel} (${(Buffer.byteLength(text) / 1024).toFixed(0)} KiB)`);
  }
}

await main();

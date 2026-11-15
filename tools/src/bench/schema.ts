// Measures the vendored API schema and resource registry: size on disk (raw and gzip, what a
// browser downloads with compression) and the time to load them (module import, parse, and
// building every type). Results are recorded in docs/ARCHITECTURE.md §4.6.
// Run: npm run bench:schema

import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

// Not from ../oracle/paths.ts: that imports @simlab/k8s, which would load the data before timing.
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

const files = ['packages/k8s/src/openapi/data/v1.37.2.ts', 'packages/k8s/src/discovery/data/v1.37.2.ts'];
for (const f of files) {
  const buf = readFileSync(path.join(repoRoot, f));
  console.log(`${f}: ${(buf.length / 1024).toFixed(0)} KiB, gzip ${(gzipSync(buf).length / 1024).toFixed(0)} KiB`);
}

let t = performance.now();
const schemaModule = await import('@simlab/k8s');
console.log(`import @simlab/k8s (includes both data modules): ${(performance.now() - t).toFixed(1)} ms`);

t = performance.now();
const s = schemaModule.schema();
const kinds = s.kinds();
console.log(`schema(): parse ${(performance.now() - t).toFixed(1)} ms (${kinds.length} kinds)`);

t = performance.now();
let n = 0;
const seen = new Set<string>();
const walk = (id: string): void => {
  if (seen.has(id)) return;
  seen.add(id);
  n++;
  const ty = s.type(id);
  const visit = (e: { k: string; id?: string; elem?: unknown; key?: unknown }): void => {
    if (e.k === 'named' && e.id) walk(e.id);
    if (e.elem) visit(e.elem as typeof e);
  };
  for (const f of ty.struct?.fields ?? []) visit(f.type as Parameters<typeof visit>[0]);
};
for (const k of kinds) {
  const [kind] = k.split('/').slice(-1);
  const apiVersion = k.slice(0, k.length - (kind as string).length - 1);
  const ty = s.kind(apiVersion, kind as string);
  if (ty) walk(ty.id);
}
console.log(`building every type reachable from a kind: ${(performance.now() - t).toFixed(1)} ms (${n} types)`);

t = performance.now();
const r = schemaModule.registry();
console.log(`registry(): ${(performance.now() - t).toFixed(1)} ms (${r.all.length} resources and subresources)`);

// npm run golden:capture -- [--check] [--jobs N] [case file or directory ...]
//
// Runs golden cases (fixtures/golden/cases/, format in case.ts) against the real binaries and
// writes normalized fixtures to fixtures/golden/<version>/ under the same relative path. Every
// server case gets a fresh throwaway control plane (tools/src/oracle), torn down afterwards.
// With --check, nothing is written and any difference from the committed fixture fails.
//
// A development tool (docs/FIDELITY.md §6). Needs the network once, to fetch the binaries.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse as parseYaml, stringify } from 'yaml';
import { KUBERNETES_TAG } from '@simlab/k8s';
import { etcdVersion, fetchBinaries, KWOK_VERSION, versionBinDir } from '../oracle/binaries.ts';
import { down, up, type OracleState } from '../oracle/controlplane.ts';
import { casesDir, fixturesDir, repoRoot } from '../oracle/paths.ts';
import { defaultTable, parseCase, type RequestStep, type RunStep, type Step } from './case.ts';
import { mapOracle, newContext, normalizeJson, normalizeText, normalizeValue, type NormalizeContext } from './normalize.ts';

/** Fields KWOK writes in place of a kubelet. Never assert them as real kubelet output. */
export const KWOK_AUTHORED = [
  'Node .status.conditions (types, reasons, messages, times)',
  'Lease kube-node-lease/<node> .spec (holderIdentity is KWOK\'s, a real kubelet writes the node name)',
  'Pod .status, except .status.qosClass (API server) and the PodScheduled condition (scheduler)',
];
const KWOK_KINDS = /^(pods?|po|nodes?|no|leases?)(\/|$|\.)/;

function caseFiles(p: string): string[] {
  if (!statSync(p).isDirectory()) return [p];
  return readdirSync(p)
    .sort()
    .flatMap((n) => {
      const q = path.join(p, n);
      return statSync(q).isDirectory() ? caseFiles(q) : n.endsWith('.yaml') && !n.endsWith('.vi.yaml') ? [q] : [];
    });
}

interface Shell {
  dir: string;
  env: Record<string, string>;
}

function sh(s: Shell, command: string, stdin?: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', command], { cwd: s.dir, env: s.env, input: stdin ?? '', encoding: 'utf8', timeout: 120_000 });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

function shTty(s: Shell, command: string, cols: number): { status: number; output: string } {
  const req = { argv: ['/bin/bash', '--noprofile', '--norc', '-c', command], cwd: s.dir, env: { ...s.env, TERM: 'xterm-256color' }, cols, rows: 24 };
  const r = spawnSync('python3', ['-I', path.join(import.meta.dirname, 'pty_run.py')], { input: JSON.stringify(req), encoding: 'utf8', timeout: 120_000 });
  if (r.status !== 0) throw new Error(`pty_run.py failed: ${r.stderr}`);
  return JSON.parse(r.stdout) as { status: number; output: string };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function prepare(s: Shell, step: Step, where: string): Promise<boolean> {
  if ('do' in step) {
    const r = sh(s, step.do, step.stdin);
    if (r.status !== 0) throw new Error(`${where}: "${step.do}" failed (${r.status}):\n${r.stdout}${r.stderr}`);
    return true;
  }
  if ('until' in step) {
    const end = Date.now() + (step.timeout ?? 60) * 1000;
    const re = new RegExp(step.match, 'm');
    let last = '';
    while (Date.now() < end) {
      const r = sh(s, step.until);
      last = r.stdout + r.stderr;
      if (re.test(r.stdout)) return true;
      await sleep(500);
    }
    throw new Error(`${where}: "${step.until}" did not match /${step.match}/ in time; last output:\n${last}`);
  }
  if ('sleep' in step) {
    await sleep(step.sleep * 1000);
    return true;
  }
  return false;
}

/**
 * Sends one request to the oracle's API server with the admin client certificate (admin.crt, as
 * in admin.conf). Resolves with the status code, the Warning headers' texts and the body.
 */
function apiRequest(oracle: OracleState, step: RequestStep): Promise<{ code: number; warnings: string[]; body: string }> {
  const [method, target] = step.request.split(' ') as [string, string];
  let payload: string | undefined;
  if (step.body !== undefined) payload = step.raw ? step.body : JSON.stringify(parseYaml(step.body));
  const url = new URL(target, oracle.server);
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method,
        ca: readFileSync(path.join(oracle.dir, 'ca.crt')),
        cert: readFileSync(path.join(oracle.dir, 'admin.crt')),
        key: readFileSync(path.join(oracle.dir, 'admin.key')),
        headers: {
          Accept: 'application/json',
          ...(payload !== undefined ? { 'Content-Type': step.contentType ?? 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = res.headers.warning;
          const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
          // RFC 7234 warning: `299 - "text"`, several joined by ", " in one header value.
          const warnings = list.flatMap((h) => [...h.matchAll(/\d{3} \S+ "((?:[^"\\]|\\.)*)"/g)].map((m) => (m[1] as string).replace(/\\(.)/g, '$1')));
          resolve({ code: res.statusCode ?? 0, warnings, body: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/**
 * The endpoints of an EndpointSlice in address order, before normalization numbers their UIDs. The
 * controller writes them in the order of its Pod cache, which varies from run to run (upstream:
 * staging/src/k8s.io/endpointslice/reconciler.go sorts slices, never the endpoints in one).
 */
function sortSliceEndpoints(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  if (Array.isArray(o.items)) return { ...o, items: o.items.map(sortSliceEndpoints) };
  if (o.kind !== 'EndpointSlice' || !Array.isArray(o.endpoints)) return v;
  const key = (e: unknown) => {
    const a = ((e as { addresses?: string[] }).addresses ?? [])[0] ?? '';
    return a.split('.').map((x) => x.padStart(3, '0')).join('.');
  };
  return { ...o, endpoints: [...o.endpoints].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)) };
}

/** One captured step as written in the fixture. */
type Record_ = Record<string, unknown>;

async function runCase(file: string, log: (s: string) => void, slot: number): Promise<string> {
  const rel = path.relative(casesDir, file);
  const name = rel.replace(/\.yaml$/, '');
  const caseText = readFileSync(file, 'utf8');
  const c = parseCase(caseText, rel);
  const dir = mkdtempSync(path.join(tmpdir(), 'simlab-golden-'));
  const stateFile = path.join(repoRoot, '.upstream', 'oracle', `capture-${slot}.json`);
  let oracle: OracleState | undefined;
  try {
    for (const [f, content] of Object.entries(c.files)) {
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      writeFileSync(path.join(dir, f), content);
    }
    if (c.server) {
      oracle = await up({ kwok: c.kwok, stateFile });
      mkdirSync(path.join(dir, '.kube'), { recursive: true });
      copyFileSync(oracle.kubeconfig, path.join(dir, '.kube', 'config'));
    }
    const shell: Shell = {
      dir,
      env: { PATH: `${versionBinDir}:/usr/bin:/bin`, HOME: dir, LANG: 'C.UTF-8', TZ: 'UTC', USER: 'student', LOGNAME: 'student' },
    };
    const ctx: NormalizeContext = newContext({
      workdir: dir,
      literals: new Set(caseText.match(/(?<![0-9])3[0-2][0-9]{3}(?![0-9])/g) ?? []),
      ...(oracle ? { apiserverPort: oracle.ports.apiserver as number, hostname: oracle.hostname } : {}),
    });
    for (const [i, s] of c.setup.entries()) await prepare(shell, s, `${rel}: setup[${i}]`);
    const out: Record_[] = [];
    for (const [i, step] of c.steps.entries()) {
      const where = `${rel}: steps[${i}]`;
      if (await prepare(shell, step, where)) continue;
      ctx.anyWorker = 'anyWorker' in step && step.anyWorker === true;
      if ('objects' in step) {
        const objects: Record_[] = [];
        for (const ref of step.objects) {
          const r = sh(shell, `kubectl get ${ref} -o json`);
          if (r.status !== 0) throw new Error(`${where}: kubectl get ${ref}: ${r.stderr}`);
          let obj = sortSliceEndpoints(JSON.parse(r.stdout)) as Record<string, unknown>;
          if (Array.isArray(obj.items)) {
            // A list: item order follows names, which normalization may hide; sort normalized items.
            const items = (obj.items as unknown[]).map((x) => normalizeJson(x, ctx));
            items.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
            obj = { ...(normalizeJson({ ...obj, items: [] }, ctx) as Record<string, unknown>), items };
          } else obj = normalizeJson(obj, ctx) as Record<string, unknown>;
          objects.push({ ref, ...(c.kwok && KWOK_KINDS.test(ref.replace(/^(-\S+\s+\S+\s+)*/, '')) ? { kwok: true } : {}), object: obj });
        }
        out.push({ objects, ...(ctx.anyWorker ? { anyWorker: true } : {}) });
        continue;
      }
      if ('request' in step) {
        if (!oracle) throw new Error(`${where}: a request step needs a server`);
        const r = await apiRequest(oracle, step);
        let body: unknown = r.body;
        try {
          body = JSON.parse(r.body) as unknown;
        } catch {
          // Not JSON (a plain-text error): kept as text.
        }
        if (step.keep && body !== null && typeof body === 'object') {
          body = Object.fromEntries(Object.entries(body).filter(([k]) => (step.keep as string[]).includes(k)));
        }
        const rec: Record_ = { request: step.request };
        if (step.contentType) rec.contentType = step.contentType;
        if (step.body !== undefined) rec.body = step.body;
        Object.assign(rec, { code: r.code });
        if (r.warnings.length > 0) rec.warnings = r.warnings.map((w) => normalizeValue(mapOracle(w, ctx), ctx));
        rec.response = typeof body === 'string' ? normalizeValue(mapOracle(body, ctx), ctx) : normalizeJson(body, ctx);
        out.push(rec);
        continue;
      }
      const st = step as RunStep;
      ctx.ageColumns = st.ageColumns;
      const table = st.table === 'none' ? undefined : (st.table ?? defaultTable(st.run));
      const sortLines = (t: string) => {
        if (!st.unorderedLines || t === '') return t;
        const ls = t.replace(/\n$/, '').split('\n');
        return [ls[0], ...ls.slice(1).sort()].join('\n') + (t.endsWith('\n') ? '\n' : '');
      };
      const norm = (t: string, tab?: typeof table) => sortLines(st.normalize === false ? mapOracle(t, ctx) : normalizeText(t, ctx, tab));
      const rec: Record_ = { run: st.run };
      if (st.stdin !== undefined) rec.stdin = st.stdin;
      if (st.tty) {
        const cols = st.cols ?? 80;
        const r = shTty(shell, st.run, cols);
        Object.assign(rec, { tty: true, cols, exit: r.status, output: norm(r.output) });
      } else {
        const r = sh(shell, st.run, st.stdin);
        Object.assign(rec, { exit: r.status, stdout: norm(r.stdout, r.status === 0 ? table : undefined), stderr: norm(r.stderr) });
      }
      if (st.kwok) rec.kwok = true;
      if (st.anyWorker) rec.anyWorker = true;
      if (st.unorderedLines) rec.unorderedLines = true;
      out.push(rec);
    }
    const fixture: Record_ = {
      case: name,
      description: c.description,
      kubernetes: KUBERNETES_TAG,
      oracle: c.server ? { mode: 'server', etcd: etcdVersion(), ...(c.kwok ? { kwok: KWOK_VERSION } : {}) } : { mode: 'client' },
      ...(c.kwok ? { kwokAuthored: KWOK_AUTHORED } : {}),
      steps: out,
    };
    const text =
      `# Captured from fixtures/golden/cases/${rel} by npm run golden:capture. Do not edit.\n` +
      `# Format and normalization tokens: docs/FIDELITY.md §6.\n` +
      stringify(fixture, { lineWidth: 0, blockQuote: 'literal', aliasDuplicateObjects: false });
    // The file must read back as exactly what was captured.
    if (JSON.stringify(parseYaml(text)) !== JSON.stringify(fixture)) throw new Error(`${rel}: the fixture does not read back identically`);
    log(`captured ${rel}`);
    return text;
  } finally {
    // A control plane left running is reported by the caller (leftovers), never hidden.
    if (oracle) leftovers.push(...(await down({ stateFile })).map((p) => `${rel}: ${p}`));
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Processes or ports a teardown could not clear. */
const leftovers: string[] = [];

const args = process.argv.slice(2);
const check = args.includes('--check');
const jobsAt = args.indexOf('--jobs');
const jobs = jobsAt >= 0 ? Number(args[jobsAt + 1]) : 3;
const targets = args.filter((a, i) => a !== '--check' && a !== '--jobs' && args[i - 1] !== '--jobs');
const files = (targets.length > 0 ? targets : [casesDir]).flatMap((t) => caseFiles(path.resolve(t)));
for (const f of files) if (!f.startsWith(casesDir + path.sep)) throw new Error(`${f} is not under ${path.relative(repoRoot, casesDir)}`);

await fetchBinaries((s) => console.log(s));
let failed = false;
const queue = [...files];
await Promise.all(
  Array.from({ length: Math.max(1, jobs) }, async (_, slot) => {
    for (let f = queue.shift(); f !== undefined; f = queue.shift()) {
      const rel = path.relative(casesDir, f);
      const target = path.join(fixturesDir, rel);
      try {
        const text = await runCase(f, (s) => console.log(s), slot);
        const old = existsSync(target) ? readFileSync(target, 'utf8') : undefined;
        if (check) {
          if (old !== text) {
            failed = true;
            const diffDir = mkdtempSync(path.join(tmpdir(), 'simlab-golden-diff-'));
            writeFileSync(path.join(diffDir, 'new.yaml'), text);
            console.error(`${rel}: differs from the committed fixture (new capture in ${diffDir}/new.yaml)`);
          }
        } else if (old !== text) {
          mkdirSync(path.dirname(target), { recursive: true });
          writeFileSync(target, text);
          console.log(`wrote ${path.relative(repoRoot, target)}`);
        }
      } catch (e) {
        failed = true;
        console.error(e instanceof Error ? e.message : String(e));
      }
    }
  }),
);
if (leftovers.length > 0) {
  console.error(`the oracle left something behind:\n${leftovers.join('\n')}`);
  failed = true;
}
process.exit(failed ? 1 : 0);

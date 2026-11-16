// The differential runner (phase 07a): replays a golden case (fixtures/golden/cases/) in the
// simulator and compares each recorded step the simulated kubectl can execute with the fixture
// captured from the real binaries, normalized with the same rules (docs/FIDELITY.md §6.4).
//
// A step is run in a real simulated shell, as root on the control plane in /root (the oracle ran
// in the case's directory as $HOME, which normalization maps to /home/student; /root maps the same
// way). Its stdout and stderr go to files, read back from the machine's file system.
//
// Steps whose kubectl verb is not simulated yet print the simulator's `[sim]` notice: a command
// that changes state is then replayed through the shim (shim.ts) so the rest of the case can run,
// and reported as shimmed; one that only reads is reported as not simulated; one neither can run
// blocks the rest of the case. Setup, `do` and `until` steps are not compared.
//
// Token numbering: `<<uid:N>>` and `<<hash:N>>` are numbered by first appearance within each step
// on both sides before comparing, so that a step the simulator skips (which numbered tokens in the
// fixture) does not shift the numbers of the steps after it.

import { parse as parseYaml } from 'yaml';
import { SIM_STATUS } from '@simlab/host';
import { createClient, DEFAULT_APISERVER, handle } from '@simlab/k8s';
import { toApiRequest, type RequestRecord } from '../api.differential.ts';
import { GET_TABLE, parse as parseTable, render as renderTable, type Cells } from '../tabwriter.ts';
import { defaultTable, parseCase, type DoStep, type GoldenCase, type RunStep, type SleepStep, type UntilStep } from '../case.ts';
import { mapOracle, newContext, normalizeJson, normalizeText, type NormalizeContext } from '../normalize.ts';
import { caseWorld, HOME, type CaseWorld } from './world.ts';
import { dropItems, KWOK, kubeletEvent, maskDescribe, maskText, maskTouches, maskValue, POD_ADMISSION, type Mask } from './mask.ts';
import { oracleDeviceIn, phaseOf, readOnly, shim, type ShimEnv, type ShimResult, type Unsupported } from './shim.ts';

type Obj = Record<string, unknown>;

/** What the oracle's kubectl takes per invocation, order of magnitude: controllers get this much virtual time after each command. */
const KUBECTL_LATENCY = 100;
/** `until` polls every half second, as golden capture does (capture.ts prepare). */
const UNTIL_POLL = 500;

export type Outcome =
  /** Compared and equal. */
  | 'pass'
  /** Compared and different. */
  | 'fail'
  /** Not simulated yet, only reads: skipped. */
  | 'notice'
  /** Not simulated yet, changes state: replayed through the shim, not compared. */
  | 'shimmed'
  /** After a command neither the simulator nor the shim can run. */
  | 'blocked'
  /** A request step: compared by api.test.ts against the API server, not here. */
  | 'skipped';

export interface StepResult {
  /** Index in the case's `steps`. */
  index: number;
  /** The command, or `objects: …`. */
  label: string;
  outcome: Outcome;
  /** Why it was not compared, or the difference. */
  detail?: string;
  /** Masks (mask.ts) that removed fields from this step's comparison, by reason. */
  masked?: string[];
  /** For compared steps: the normalized expected and actual records. */
  expected?: Obj;
  actual?: Obj;
}

export interface CaseResult {
  name: string;
  server: boolean;
  steps: StepResult[];
  /** The command that blocked the rest of the case. */
  blockedBy?: string;
  /** Notes about the replay: shim fallbacks, shimmed exit codes that differ from the oracle's. */
  notes: string[];
}

interface Exec {
  status: number;
  stdout: string;
  stderr: string;
}

const NOTICE = /^\[sim\] /m;
const isNotice = (r: { status: number; stderr?: string; output?: string }): boolean => r.status === SIM_STATUS && NOTICE.test(r.stderr ?? r.output ?? '');

const OUT = '/tmp/.golden-stdout';
const ERR = '/tmp/.golden-stderr';
const IN = '/tmp/.golden-stdin';

/** Runs a command line in the case's shell; stdout and stderr separately, from files. */
function exec(w: CaseWorld, command: string, stdin = ''): Exec {
  w.write(IN, stdin);
  const r = w.session.run(`{ ${command}\n} >${OUT} 2>${ERR} <${IN}`);
  if (!r.finished) throw new Error(`"${command}" did not finish`);
  const leftover = w.session.take();
  if (r.output !== '' || leftover !== '') throw new Error(`"${command}" wrote to the terminal: ${r.output}${leftover}`);
  return { status: r.status, stdout: w.read(OUT), stderr: w.read(ERR) };
}

function shimEnv(w: CaseWorld, notes: string[]): ShimEnv {
  const env: ShimEnv = {
    kernel: w.kernel,
    readFile: (p) => {
      try {
        return w.read(p.startsWith('/') ? p : `${HOME}/${p}`);
      } catch {
        return undefined;
      }
    },
    listDir: (p) => w.list(p.startsWith('/') ? p : `${HOME}/${p}`),
    substitute: (cmd) => {
      // `$(kubectl get … -o name)`: the simulated kubectl when it can, else the shim's get.
      const r = exec(w, cmd);
      if (r.status === 0) return r.stdout;
      const s = shim(env, cmd);
      if ('unsupported' in s || s.status !== 0) return undefined;
      notes.push(`$(${cmd}) answered by the shim: the simulator exited ${r.status}: ${firstLine(r.stderr)}`);
      return s.stdout;
    },
  };
  return env;
}

const firstLine = (s: string): string => s.split('\n')[0] ?? '';

/** The command runs in the simulator, or through the shim when the simulator prints a notice. */
type Ran = { via: 'sim'; r: Exec } | { via: 'shim'; r: ShimResult; notice: string } | { via: 'none'; why: string; notice: string };

function runEither(w: CaseWorld, env: ShimEnv, command: string, stdin?: string): Ran {
  const device = oracleDeviceIn(env, command, stdin);
  if (device) return { via: 'none', why: device, notice: '' };
  const r = exec(w, command, stdin);
  if (!isNotice(r)) return { via: 'sim', r };
  const notice = firstLine(r.stderr.slice(r.stderr.search(NOTICE)));
  const s: ShimResult | Unsupported = shim(env, command, stdin);
  if ('unsupported' in s) return { via: 'none', why: s.unsupported, notice };
  return { via: 'shim', r: s, notice };
}

class Blocked extends Error {}

/** A setup, `do`, `until` or `sleep` step. Throws Blocked when it cannot be replayed. */
function prepare(w: CaseWorld, env: ShimEnv, step: DoStep | UntilStep | SleepStep, notes: string[]): void {
  if ('sleep' in step) {
    w.kernel.advance(step.sleep * 1000);
    return;
  }
  if ('do' in step) {
    const ran = runEither(w, env, step.do, step.stdin);
    if (ran.via === 'none') throw new Blocked(`${step.do} (${ran.why})`);
    if (ran.r.status !== 0) throw new Blocked(`${step.do} (exit ${ran.r.status} ${ran.via === 'shim' ? 'in the shim' : 'in the simulator'}: ${firstLine(ran.r.stderr)})`);
    w.kernel.advance(KUBECTL_LATENCY);
    return;
  }
  const re = new RegExp(step.match, 'm');
  const end = w.kernel.now + (step.timeout ?? 60) * 1000;
  let useShim = false;
  let last = '';
  for (;;) {
    let stdout: string | undefined;
    if (!useShim) {
      const r = exec(w, step.until);
      if (isNotice(r)) useShim = true;
      else if (re.test(r.stdout)) return;
      else if (r.status !== 0) {
        // The simulated kubectl failed: poll through the shim instead, and say so.
        const s = shim(env, step.until);
        if (!('unsupported' in s) && s.status === 0) {
          notes.push(`until "${step.until}" polled through the shim: the simulator exited ${r.status}: ${firstLine(r.stderr)}`);
          useShim = true;
          stdout = s.stdout;
        } else last = r.stdout + r.stderr;
      } else last = r.stdout;
    }
    if (useShim) {
      const s = stdout !== undefined ? { status: 0, stdout, stderr: '' } : shim(env, step.until);
      if ('unsupported' in s) throw new Blocked(`${step.until} (${s.unsupported})`);
      if (re.test(s.stdout)) return;
      last = s.stdout + s.stderr;
    }
    if (w.kernel.now >= end) throw new Blocked(`${step.until} (no match for /${step.match}/ in ${step.timeout ?? 60} s; last output: ${JSON.stringify(last.slice(0, 200))})`);
    w.kernel.advance(UNTIL_POLL);
  }
}

// ---- normalization ----

/** Renumbers `<<uid:N>>` and `<<hash:N>>` by first appearance in `text`. */
function renumber(text: string): string {
  const tables: Record<string, Map<string, number>> = { uid: new Map(), hash: new Map() };
  return text.replace(/<<(uid|hash):(\d+)>>/g, (_m, kind: string, n: string) => {
    const t = tables[kind] as Map<string, number>;
    if (!t.has(n)) t.set(n, t.size + 1);
    return `<<${kind}:${t.get(n) as number}>>`;
  });
}

function renumberRecord<T>(v: T): T {
  return JSON.parse(renumber(JSON.stringify(v))) as T;
}

/**
 * The items of each listed object in an order that does not depend on token numbers: capture sorts
 * them by their normalized JSON, numbers included, and those follow the order of first appearance
 * in the whole case, which the simulator's run does not share.
 */
function sortItems(objects: Obj[]): Obj[] {
  const key = (v: unknown) => JSON.stringify(v).replace(/<<(uid|hash):\d+>>/g, '<<$1>>');
  return objects.map((o) => {
    const obj = o.object as Obj | undefined;
    if (!obj || !Array.isArray(obj.items)) return o;
    const items = [...(obj.items as unknown[])].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    return { ...o, object: { ...obj, items } };
  });
}

/** Items of a list sorted by their normalized JSON, as capture.ts does; EndpointSlice endpoints by address first. */
function normalizeObject(raw: unknown, ctx: NormalizeContext): unknown {
  const obj = sortSliceEndpoints(raw) as Obj;
  if (Array.isArray(obj.items)) {
    const items = (obj.items as unknown[]).map((x) => normalizeJson(x, ctx));
    items.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
    return { ...(normalizeJson({ ...obj, items: [] }, ctx) as Obj), items };
  }
  return normalizeJson(obj, ctx);
}

/** capture.ts sortSliceEndpoints. */
function sortSliceEndpoints(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  const o = v as Obj;
  if (Array.isArray(o.items)) return { ...o, items: o.items.map(sortSliceEndpoints) };
  if (o.kind !== 'EndpointSlice' || !Array.isArray(o.endpoints)) return v;
  const key = (e: unknown) => {
    const a = ((e as { addresses?: string[] }).addresses ?? [])[0] ?? '';
    return a.split('.').map((x) => x.padStart(3, '0')).join('.');
  };
  return { ...o, endpoints: [...o.endpoints].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)) };
}

/** Masks of a step: always the admission fields (D-046); KWOK's fields where the step shows them. */
const masksFor = (kwok: boolean): Mask[] => [POD_ADMISSION, ...(kwok ? KWOK : [])];

/** `-o yaml` or `-o json` (kubectl's object printers), whose output can be masked. */
const objectOutput = (command: string): boolean => /(^| )(-o|--output)[ =]?(yaml|json)( |$)/.test(command);

const KWOK_KINDS = /^(pods?|po|nodes?|no|leases?)(\/|$|\.)/;

/** A unified-style line diff (longest common subsequence): at most `max` changed lines, each with one line of context. */
export function lineDiff(expected: string, actual: string, max = 16): string {
  const e = expected.split('\n');
  const a = actual.split('\n');
  if (e.length * a.length > 4_000_000) return `(${e.length} vs ${a.length} lines differ)`;
  // lcs[i][j]: the length of the longest common subsequence of e[i..] and a[j..].
  const lcs: number[][] = Array.from({ length: e.length + 1 }, () => new Array<number>(a.length + 1).fill(0));
  const at = (i: number, j: number): number => (lcs[i] as number[])[j] as number;
  for (let i = e.length - 1; i >= 0; i--) for (let j = a.length - 1; j >= 0; j--) (lcs[i] as number[])[j] = e[i] === a[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  const ops: string[] = [];
  let i = 0;
  let j = 0;
  while (i < e.length || j < a.length) {
    if (i < e.length && j < a.length && e[i] === a[j]) {
      ops.push(`  ${e[i++] as string}`);
      j++;
    } else if (j < a.length && (i >= e.length || at(i, j + 1) >= at(i + 1, j))) ops.push(`+ ${a[j++] as string}`);
    else ops.push(`- ${e[i++] as string}`);
  }
  const same = (k: number): boolean => (ops[k] ?? '  ').startsWith('  ');
  const out: string[] = [];
  let changed = 0;
  for (let k = 0; k < ops.length && changed < max; k++) {
    if (same(k)) {
      if (!same(k - 1) || !same(k + 1)) out.push(ops[k] as string);
      else if (out[out.length - 1] !== '  …') out.push('  …');
      continue;
    }
    out.push(ops[k] as string);
    changed++;
  }
  return out.join('\n');
}

function describeDiff(expected: Obj, actual: Obj): string {
  const parts: string[] = [];
  for (const k of ['exit', 'stdout', 'stderr', 'output']) {
    if (!(k in expected) && !(k in actual)) continue;
    const e = expected[k];
    const a = actual[k];
    if (JSON.stringify(e) === JSON.stringify(a)) continue;
    if (typeof e === 'string' && typeof a === 'string') parts.push(`${k}:\n${lineDiff(e, a)}`);
    else parts.push(`${k}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
  }
  return parts.join('\n');
}

/** The differences of two JSON values as paths, at most `max`. */
export function jsonDiff(e: unknown, a: unknown, path = '', out: string[] = [], max = 12): string[] {
  if (out.length >= max) return out;
  if (JSON.stringify(e) === JSON.stringify(a)) return out;
  if (e !== null && a !== null && typeof e === 'object' && typeof a === 'object' && Array.isArray(e) === Array.isArray(a)) {
    const keys = Array.isArray(e) ? [...Array(Math.max((e as unknown[]).length, (a as unknown[]).length)).keys()].map(String) : [...new Set([...Object.keys(e as Obj), ...Object.keys(a as Obj)])];
    if (!Array.isArray(e)) {
      const ek = Object.keys(e as Obj).join(',');
      const ak = Object.keys(a as Obj).join(',');
      if (ek !== ak && new Set(Object.keys(e as Obj)).size === new Set([...Object.keys(e as Obj), ...Object.keys(a as Obj)]).size && Object.keys(e as Obj).length === Object.keys(a as Obj).length) out.push(`${path || '.'}: key order ${ek} vs ${ak}`);
    }
    for (const k of keys) jsonDiff((e as Obj)[k], (a as Obj)[k], `${path}${Array.isArray(e) ? `[${k}]` : `.${k}`}`, out, max);
    return out;
  }
  out.push(`${path || '.'}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
  return out;
}

// ---- the case ----

/** Runs one case: `name` is its path under the cases directory without `.yaml`. */
export function runCase(name: string, caseText: string, fixtureText: string): CaseResult {
  const c: GoldenCase = parseCase(caseText, name);
  const fixture = parseYaml(fixtureText) as { steps: Obj[] };
  const result: CaseResult = { name, server: c.server, steps: [], notes: [] };
  if (c.steps.every((s) => 'request' in s || 'do' in s || 'until' in s || 'sleep' in s)) {
    // Raw API cases: api.test.ts replays them on a bare API server; there is no kubectl output here.
    for (const [index, s] of c.steps.entries()) if ('request' in s) result.steps.push({ index, label: `request: ${s.request}`, outcome: 'skipped', detail: 'request steps are compared by tools/src/golden/api.test.ts' });
    return result;
  }
  const w = caseWorld(c.files, c.server);
  const env = shimEnv(w, result.notes);
  const literals = new Set(caseText.match(/(?<![0-9])3[0-2][0-9]{3}(?![0-9])/g) ?? []);
  const ctx = newContext({ workdir: HOME, literals });
  let blocked: string | undefined;
  const block = (why: string) => {
    blocked = why;
    result.blockedBy = why;
  };
  try {
    for (const s of c.setup) prepare(w, env, s, result.notes);
  } catch (e) {
    if (!(e instanceof Blocked)) throw e;
    block(`setup: ${e.message}`);
  }
  let recorded = 0;
  for (const [index, step] of c.steps.entries()) {
    if ('do' in step || 'until' in step || 'sleep' in step) {
      if (blocked) continue;
      try {
        prepare(w, env, step, result.notes);
      } catch (e) {
        if (!(e instanceof Blocked)) throw e;
        block(e.message);
      }
      continue;
    }
    const expected = fixture.steps[recorded++] as Obj;
    const label = 'objects' in step ? `objects: ${step.objects.join(', ')}` : 'request' in step ? `request: ${step.request}` : (step as RunStep).run;
    if (blocked) {
      result.steps.push({ index, label, outcome: 'blocked', detail: `blocked by ${blocked}` });
      continue;
    }
    if ('request' in step) {
      // Compared by api.test.ts on a bare API server; sent here too, since later steps see its effect.
      const req = toApiRequest(expected as unknown as RequestRecord);
      if (req) w.kernel.act('golden-diff', (ctx) => handle(ctx, DEFAULT_APISERVER, req));
      result.steps.push({ index, label, outcome: 'skipped', detail: 'request steps are compared by tools/src/golden/api.test.ts' });
      w.kernel.advance(KUBECTL_LATENCY);
      continue;
    }
    ctx.anyWorker = 'anyWorker' in step && step.anyWorker === true;
    if ('objects' in step) {
      result.steps.push(objectsStep(w, c, step.objects, expected, ctx, index, label));
      w.kernel.advance(KUBECTL_LATENCY);
      continue;
    }
    const r = runStep(w, env, step, expected, ctx, index, result.notes, c.server, c.kwok);
    if (r.outcome === 'blocked') {
      block(step.run + (r.detail ? ` (${r.detail})` : ''));
      r.detail = `blocked by ${String(blocked)}`;
    }
    result.steps.push(r);
    w.kernel.advance(KUBECTL_LATENCY);
  }
  return result;
}

function objectsStep(w: CaseWorld, c: GoldenCase, refs: string[], expected: Obj, ctx: NormalizeContext, index: number, label: string): StepResult {
  const objects: Obj[] = [];
  for (const ref of refs) {
    const r = exec(w, `kubectl get ${ref} -o json`);
    if (isNotice(r)) return { index, label, outcome: 'notice', detail: `${firstLine(r.stderr)} (phase ${phaseOf(`kubectl get ${ref}`)})` };
    let object: unknown;
    if (r.status !== 0) object = { error: `exit ${r.status}: ${r.stderr}` };
    else {
      try {
        object = normalizeObject(JSON.parse(r.stdout) as unknown, ctx);
      } catch {
        object = { unparsable: r.stdout };
      }
    }
    const kwok = c.kwok && KWOK_KINDS.test(ref.replace(/^(-\S+\s+\S+\s+)*/, ''));
    objects.push({ ref, ...(kwok ? { kwok: true } : {}), object });
  }
  // KWOK's fields are masked by the objects' kinds, the same on both sides: capture marks `kwok`
  // only on refs like `pod/x` (its KWOK_KINDS does not match `pod -l …`).
  const masks = masksFor(c.kwok);
  const withoutKubeletEvents = (list: Obj[]) => (c.kwok ? list.map((o) => ({ ...o, object: dropItems(o.object, kubeletEvent) })) : list);
  const exp = renumberRecord(sortItems(withoutKubeletEvents((expected.objects ?? []) as Obj[])));
  const act0 = sortItems(objects);
  const act = renumberRecord(withoutKubeletEvents(act0));
  const masked = new Set<string>();
  if (JSON.stringify(withoutKubeletEvents(act0)) !== JSON.stringify(act0)) masked.add('KWOK records no kubelet events (FIDELITY §6.5)');
  const strip = (list: Obj[]) =>
    list.map((o) => {
      for (const m of masks) if (maskTouches(o.object, [m])) masked.add(m.why);
      return { ...o, object: maskValue(o.object, masks) };
    });
  const e = strip(exp);
  const a = strip(act);
  const equal = JSON.stringify(e) === JSON.stringify(a);
  const res: StepResult = { index, label, outcome: equal ? 'pass' : 'fail', expected: { objects: exp }, actual: { objects: act } };
  if (masked.size > 0) res.masked = [...masked];
  if (!equal) res.detail = jsonDiff(e, a).join('\n');
  return res;
}

/**
 * A `kubectl get events` table without the rows of Events a kubelet recorded, re-aligned: the
 * oracle's KWOK nodes record none (FIDELITY §6.5). Rows are recognized by reason, object and
 * message of the kubelet's Events in the store.
 */
function withoutKubeletEventRows(w: CaseWorld, text: string): string {
  const r = w.kernel.act('golden-diff', (ctx) => createClient(ctx, DEFAULT_APISERVER).resource('v1/events').list(undefined));
  if (!r.ok) return text;
  const keys = new Set(
    ((r.object as Obj).items as Obj[]).filter(kubeletEvent).map((e) => {
      const o = e.involvedObject as Obj;
      return `${String(e.reason)}\t${String(o.kind).toLowerCase()}/${String(o.name)}\t${String(e.message)}`;
    }),
  );
  const rows = parseTable(text, GET_TABLE);
  if (!rows || rows.length === 0) return text;
  const header = (rows[0] as Cells).map((c) => c.trim());
  const col = (name: string) => header.indexOf(name);
  const [reason, object, message] = [col('REASON'), col('OBJECT'), col('MESSAGE')];
  if (reason < 0 || object < 0 || message < 0) return text;
  const kept = rows.filter((cells, i) => i === 0 || !keys.has(`${(cells[reason] ?? '').trim()}\t${(cells[object] ?? '').trim()}\t${(cells[message] ?? '').trim()}`));
  return kept.length === rows.length ? text : renderTable(kept, GET_TABLE);
}

function runStep(w: CaseWorld, env: ShimEnv, step: RunStep, expected: Obj, ctx: NormalizeContext, index: number, notes: string[], server: boolean, kwok: boolean): StepResult {
  const label = step.run;
  ctx.ageColumns = step.ageColumns;
  const table = step.table === 'none' ? undefined : (step.table ?? defaultTable(step.run));
  const sortLines = (t: string) => {
    if (!step.unorderedLines || t === '') return t;
    const ls = t.replace(/\n$/, '').split('\n');
    return [ls[0], ...ls.slice(1).sort()].join('\n') + (t.endsWith('\n') ? '\n' : '');
  };
  const norm = (t: string, tab?: typeof table) => {
    if (step.normalize === false) return sortLines(mapOracle(t, ctx));
    try {
      return sortLines(normalizeText(t, ctx, tab));
    } catch {
      // Not tab-writer output (a broken table is itself a difference): plain normalization.
      return sortLines(normalizeText(t, ctx));
    }
  };
  let actual: Obj;
  let maskedRows = false;
  if (step.tty) {
    const cols = step.cols ?? 80;
    const s = w.tty(cols);
    const r = s.run(step.run);
    if (!r.finished) throw new Error(`"${step.run}" did not finish`);
    if (isNotice({ status: r.status, output: r.output })) return notCompared(env, step, expected, index, firstLine(r.output.slice(r.output.search(NOTICE))), notes, server);
    actual = { exit: r.status, output: norm(r.output) };
  } else {
    const device = oracleDeviceIn(env, step.run, step.stdin);
    if (device) return { index, label, outcome: 'blocked', detail: device };
    const r = exec(w, step.run, step.stdin);
    if (isNotice(r)) return notCompared(env, step, expected, index, firstLine(r.stderr.slice(r.stderr.search(NOTICE))), notes, server);
    let stdout = r.stdout;
    if (kwok && r.status === 0 && table === 'get' && /^kubectl get (events?|ev)( |$)/.test(step.run)) {
      const dropped = withoutKubeletEventRows(w, stdout);
      if (dropped !== stdout) maskedRows = true;
      stdout = dropped;
    }
    actual = { exit: r.status, stdout: norm(stdout, r.status === 0 ? table : undefined), stderr: norm(r.stderr) };
  }
  const keys = step.tty ? ['exit', 'output'] : ['exit', 'stdout', 'stderr'];
  const exp = renumberRecord(Object.fromEntries(keys.map((k) => [k, expected[k]])));
  const act = renumberRecord(actual);
  const masked: string[] = maskedRows ? ['KWOK records no kubelet events (FIDELITY §6.5): their rows are left out of the table'] : [];
  if (!step.tty && objectOutput(step.run) && exp.exit === 0) {
    // A mask that matches no kind still drops JSON's line-end commas: the baseline to compare with.
    // Nothing is masked (and commas stay compared) unless a mask removes a field on either side.
    const none: Mask = { kind: '', paths: [], why: '' };
    const masks = masksFor(step.kwok === true);
    const touching = masks.filter((m) => [exp.stdout, act.stdout].some((t) => maskText(String(t), [m]) !== maskText(String(t), [none])));
    if (touching.length > 0) {
      masked.push(...touching.map((m) => m.why));
      exp.stdout = maskText(String(exp.stdout), masks);
      act.stdout = maskText(String(act.stdout), masks);
    }
  }
  if (!step.tty && table === 'describe') {
    // describe's text: the same fields, masked in its cells (mask.ts maskDescribe).
    const e = maskDescribe(String(exp.stdout), step.kwok === true);
    const a = maskDescribe(String(act.stdout), step.kwok === true);
    for (const why of [...e.masked, ...a.masked]) if (!masked.includes(why)) masked.push(why);
    // numbered tokens of masked values (a KWOK lease holder's UUID) no longer count
    exp.stdout = renumber(e.text);
    act.stdout = renumber(a.text);
  }
  const equal = JSON.stringify(exp) === JSON.stringify(act);
  const res: StepResult = { index, label, outcome: equal ? 'pass' : 'fail', expected: exp, actual: act };
  if (masked.length > 0) res.masked = masked;
  if (!equal) res.detail = describeDiff(exp, act);
  return res;
}

/**
 * A step the simulated kubectl printed a notice for: skipped when it only reads, else replayed
 * through the shim, or blocking. The shim's exit status is checked against the oracle's: a
 * difference means the replayed state may differ from the oracle's from here on, and is noted.
 */
function notCompared(env: ShimEnv, step: RunStep, expected: Obj, index: number, notice: string, notes: string[], server: boolean): StepResult {
  const phase = phaseOf(step.run);
  if (readOnly(step.run, server)) return { index, label: step.run, outcome: 'notice', detail: `${notice} (phase ${phase})` };
  const s = shim(env, step.run, step.stdin);
  if ('unsupported' in s) return { index, label: step.run, outcome: 'blocked', detail: s.unsupported };
  if (s.status !== expected.exit) notes.push(`step ${index} "${step.run}": the shim exited ${s.status}, the oracle ${String(expected.exit)}: ${firstLine(s.stderr)}`);
  return { index, label: step.run, outcome: 'shimmed', detail: `shimmed: ${notice.replace(/^\[sim\] /, '')}; arrives in phase ${phase}` };
}

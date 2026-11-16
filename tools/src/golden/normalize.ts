// Normalization of captured output: volatile values become tokens (packages/host/src/transcript/
// tokens.ts), values that belong to the oracle rather than the simulated cluster are mapped to the
// topology's, and tables are re-aligned after replacement (tabwriter.ts). The rules are listed in
// docs/FIDELITY.md §6.3. A simulator run normalized with the same rules is comparable with a
// fixture (phase 07a).

import { token, type TokenName } from '@simlab/host';
import { CLUSTER, NODES } from '../oracle/topology.ts';
import { DESCRIBE, GET_TABLE, parse, render, type Cells, type TabParams } from './tabwriter.ts';

/** Per-fixture state: oracle values to map, and the numbering of indexed tokens. */
export interface NormalizeContext {
  /** The oracle API server's port, which stands for the topology's 6443. */
  apiserverPort?: number;
  /** The workstation's host name, which stands for `controlplane` (leader election identities). */
  hostname?: string;
  /** The case's working directory, which stands for the learner's home directory. */
  workdir?: string;
  /** Values the case itself wrote (a chosen nodePort): deterministic, never tokens. */
  literals?: ReadonlySet<string>;
  /** Age columns of a table without a header row (kubectl get --no-headers). */
  ageColumns?: number[] | undefined;
  /** The step's placement was a scheduling tie between the workers: hide which one won. */
  anyWorker?: boolean;
  indices: Partial<Record<TokenName, Record<string, number>>>;
}

export function newContext(init: Omit<NormalizeContext, 'indices'> = {}): NormalizeContext {
  return { ...init, indices: {} };
}

function indexed(ctx: NormalizeContext, kind: TokenName, value: string): string {
  const table = (ctx.indices[kind] ??= {});
  const n = (table[value] ??= Object.keys(table).length + 1);
  return token(kind, n);
}

// Addresses allocated at run time: the service range minus its first address (the `kubernetes`
// Service, always 10.96.0.1) and the Pod range. Node addresses are the topology's and stay.
function volatileIp(ip: string): boolean {
  const o = ip.split('.').map(Number) as [number, number, number, number];
  if (o.some((x) => x > 255)) return false;
  const svc = o[0] === 10 && o[1] >= 96 && o[1] <= 111;
  const pod = o[0] === 10 && o[1] === 244;
  return (svc && ip !== CLUSTER.kubernetesServiceIP) || pod;
}

const UID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const RFC3339 = /[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})/g;
const RFC1123Z = /[A-Z][a-z]{2}, [0-9]{2} [A-Z][a-z]{2} [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} [+-][0-9]{4}/g;
const IPV4 = /(?<![0-9.])[0-9]{1,3}(?:\.[0-9]{1,3}){3}(?![0-9]|\.[0-9])/g;
// pod-template-hash and controller-revision-hash: in a generated name after "-", or as a label value.
const HASH = /(?<=[a-z0-9]-|hash=|hash: |hash": ")(?=[456789]*[bcdf])[456789bcdf]{6,10}(?![a-z0-9])/g;
// generateName's suffix ends a name: "-x8k2p" followed by nothing name-like.
const SUFFIX = /(?<=[a-z0-9>]-)[bcdfghjklmnpqrstvwxz2456789]{5}(?![a-z0-9-])/g;
// Event names: <object>.<UnixNano in hex>. upstream: staging/src/k8s.io/client-go/tools/record/event.go makeEvent
const EVENT_HEX = /(?<=[a-z0-9>])\.[0-9a-f]{15,17}(?![0-9a-z])/g;
// Also compact JSON in a message (`"resourceVersion":"303"`, a three-way merge conflict).
const RV = /(?<=resourceVersion"?: ?")[0-9]+(?=")/g;
const NODEPORT_TEXT = /(?<=[0-9]:|^)3[0-2][0-9]{3}(?=\/(?:TCP|UDP|SCTP)\b)/g;
const NODEPORT_YAML = /(?<=nodePort"?: )[0-9]+/g;
// klog's header: Lmmdd hh:mm:ss.uuuuuu threadid file:line] (k8s.io/klog/v2 klog.go formatHeader)
const KLOG = /(?<=^[IWEF])[0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6} +[0-9]+(?= [^ ]+:[0-9]+\])/gm;
// The body of a PEM block, in text (YAML block scalar, indented) or in a JSON string.
const PEM = /(-----BEGIN [A-Z ]+-----(?:\n|\\n)[ \t]*)[A-Za-z0-9+/=\s\\n]*?(?=(?:\n|\\n)[ \t]*-----END )/g;

/**
 * Maps what belongs to the oracle rather than the simulated cluster: the working directory is the
 * learner's home, the workstation's host name (leader election identities, an event's
 * reportingInstance) is the control plane's, the API server's port is 6443. Applied even when
 * value normalization is off; no workstation detail may reach a committed fixture.
 */
export function mapOracle(s: string, ctx: NormalizeContext): string {
  if (ctx.workdir) s = s.split(ctx.workdir).join('/home/student');
  if (ctx.hostname) s = s.split(ctx.hostname).join(CLUSTER.controlPlaneName);
  if (ctx.apiserverPort !== undefined) {
    const p = ctx.apiserverPort;
    s = s.replace(new RegExp(`127\\.0\\.0\\.1:${p}\\b`, 'g'), `${CLUSTER.advertiseAddress}:${CLUSTER.apiserverPort}`);
    s = s.replace(new RegExp(`(?<![0-9])${p}(?![0-9])`, 'g'), String(CLUSTER.apiserverPort));
  }
  return s;
}

/** Replaces volatile values in a piece of text (a cell or a whole output). */
export function normalizeValue(s: string, ctx: NormalizeContext): string {
  // Identifiers first: a UID's hex digits or a timestamp could contain the API server's port.
  s = s.replace(KLOG, `${token('time')} ${token('pid')}`);
  s = s.replace(PEM, (_m, begin: string) => begin + token('cert'));
  s = s.replace(UID, (v) => indexed(ctx, 'uid', v));
  s = s.replace(RFC3339, token('time')).replace(RFC1123Z, token('time'));
  s = s.replace(RV, token('rv'));
  s = mapOracle(s, ctx);
  s = s.replace(IPV4, (v) => (volatileIp(v) ? token('ip') : v));
  s = s.replace(HASH, (v) => indexed(ctx, 'hash', v));
  s = s.replace(EVENT_HEX, `.${token('hex')}`);
  s = s.replace(SUFFIX, token('suffix'));
  const port = (v: string) => (ctx.literals?.has(v) ? v : token('port'));
  s = s.replace(NODEPORT_TEXT, port).replace(NODEPORT_YAML, port);
  if (ctx.anyWorker) {
    // The winner shows as a name and as an address (hostIP, Node: node01/172.16.0.11).
    s = s.replace(/(?<![a-z0-9-])node0[12](?![a-z0-9-])/g, token('node'));
    for (const n of NODES) if (!n.controlPlane) s = s.replace(new RegExp(`(?<![0-9.])${n.ip.replace(/\./g, '\\.')}(?![0-9])`, 'g'), token('ip'));
  }
  return s;
}

/** Column headers whose cells are ages (kubectl's HumanDuration). */
const AGE_HEADERS = new Set(['AGE', 'LAST SEEN', 'FIRST SEEN', 'DURATION', 'LAST SCHEDULE', 'Age']);
const DURATION = /(?<![0-9a-z])(?:[0-9]+[smhdy])+(?![0-9a-z])/g;
// "2 (5s ago)" in RESTARTS. upstream: pkg/printers/internalversion/printers.go printPod
const AGO = /(?<=\()(?:[0-9]+[smhdy])+(?= ago\))/g;

export type TableKind = 'get' | 'describe';
const PARAMS: Record<TableKind, TabParams> = { get: GET_TABLE, describe: DESCRIBE };

/**
 * Normalizes tab-writer output cell by cell and re-aligns it. Returns undefined when the text does
 * not parse as tab-writer output (then normalize it as plain text).
 */
function normalizeTable(text: string, kind: TableKind, ctx: NormalizeContext): string | undefined {
  const p = PARAMS[kind];
  const lines = parse(text, p);
  if (!lines) return undefined;
  let ageCols: number[] = ctx.ageColumns ?? [];
  const out: Cells[] = lines.map((cells) => {
    // A header line starts a block whose age columns are known; a line with one cell ends it.
    const trimmed = cells.map((c) => c.trim());
    const header = trimmed.map((c, k) => (AGE_HEADERS.has(c) ? k : -1)).filter((k) => k >= 0);
    if (header.length > 0) {
      ageCols = header;
      return cells.map((c) => normalizeValue(c, ctx));
    }
    if (cells.length === 1) ageCols = [];
    return cells.map((c, k) => {
      let v = normalizeValue(c, ctx);
      if (ageCols.includes(k)) v = v.replace(DURATION, token('age'));
      return v.replace(AGO, token('age'));
    });
  });
  return render(kind === 'get' ? sortTables(out) : sortHiddenOrder(out), p);
}

const hidesOrder = (l: Cells) => l.some((c) => c.includes(token('suffix')) || c.includes(`.${token('hex')}`));
const byText = (a: Cells, b: Cells) => (a.join('\t') < b.join('\t') ? -1 : a.join('\t') > b.join('\t') ? 1 : 0);

/**
 * kubectl get sorts rows by name. Once a generated suffix is a token, the order of `web-<<suffix>>`
 * and `web-np-<<suffix>>` is unknowable, so the rows of a table holding such a token are put in
 * the order of their normalized text. Tables are separated by blank lines; the header stays first.
 */
function sortTables(lines: Cells[]): Cells[] {
  const out: Cells[] = [];
  let i = 0;
  while (i < lines.length) {
    let j = i;
    while (j < lines.length && (lines[j] as Cells).join('').trim() !== '') j++;
    const header = lines.slice(i, Math.min(i + 1, j));
    const body = lines.slice(i + 1, j);
    if (body.some(hidesOrder)) body.sort(byText);
    out.push(...header, ...body);
    if (j < lines.length) out.push(lines[j] as Cells);
    i = j + 1;
  }
  return out;
}

/**
 * In describe output (a node's Non-terminated Pods), rows that differed only in a generated suffix
 * come out in run-dependent order: consecutive rows whose first suffix-bearing cell is equal are
 * put in the order of their normalized text.
 */
function sortHiddenOrder(lines: Cells[]): Cells[] {
  const key = (l: Cells) => l.find((c) => c.includes(token('suffix')) || c.includes(`.${token('hex')}`));
  const out: Cells[] = [];
  let i = 0;
  while (i < lines.length) {
    const k = key(lines[i] as Cells);
    let j = i + 1;
    if (k !== undefined) while (j < lines.length && key(lines[j] as Cells) === k && (lines[j] as Cells).length === (lines[i] as Cells).length) j++;
    const group = lines.slice(i, j);
    if (group.length > 1) group.sort(byText);
    out.push(...group);
    i = j;
  }
  return out;
}

export function normalizeText(text: string, ctx: NormalizeContext, table?: TableKind): string {
  if (table && text.endsWith('\n')) {
    const t = normalizeTable(text, table, ctx);
    if (t !== undefined) return t;
    throw new Error(`output does not parse as ${table} table output; set "table: none" on the step\n${text}`);
  }
  return normalizeValue(text, ctx);
}

/** Normalizes a JSON value from `kubectl get -o json`, keys in the order kubectl wrote them. */
export function normalizeJson(v: unknown, ctx: NormalizeContext, key?: string): unknown {
  if (typeof v === 'string') return key === 'resourceVersion' && v !== '' ? token('rv') : normalizeValue(v, ctx);
  if (typeof v === 'number') {
    if (key === 'nodePort') return ctx.literals?.has(String(v)) ? v : token('port');
    if (ctx.apiserverPort !== undefined && v === ctx.apiserverPort) return CLUSTER.apiserverPort;
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => normalizeJson(x, ctx));
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = normalizeJson(x, ctx, k);
    return out;
  }
  return v;
}

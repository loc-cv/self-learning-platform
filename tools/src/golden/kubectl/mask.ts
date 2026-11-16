// Fields left out of a comparison on both sides, by kind and path: what the oracle cannot show
// (KWOK in place of a kubelet, docs/FIDELITY.md §6.5) or what the simulator does not write yet by a
// recorded decision (the admission plugins of phase 20b, D-046). Everything else of the object,
// and in text output (`-o yaml`, `-o json`) the layout of everything else, is still compared.
//
// Text masking removes the lines of each masked key and its value, located with the `yaml`
// package's source ranges (it parses kubectl's JSON as well); in JSON the commas that end lines are
// then ignored on both sides, since removing a member changes its neighbor's.

import { isMap, isScalar, isSeq, parseAllDocuments, type Node as YamlNode } from 'yaml';
import { DESCRIBE as DESCRIBE_CELLS, parse as parseCells, render as renderCells } from '../tabwriter.ts';

type Obj = Record<string, unknown>;

/** A path of keys; `*` is every item of a list; `!a,b` is every key but those. */
export type Path = string[];

export interface Mask {
  kind: string;
  paths: Path[];
  /** Applies only to objects this holds for. */
  when?: (o: Obj) => boolean;
  why: string;
}

/** D-046: the fields the ServiceAccount, DefaultTolerationSeconds and Priority admission plugins add (phase 20b removes this). */
export const POD_ADMISSION: Mask = {
  kind: 'Pod',
  paths: [['spec', 'volumes'], ['spec', 'containers', '*', 'volumeMounts'], ['spec', 'serviceAccount'], ['spec', 'serviceAccountName'], ['spec', 'tolerations'], ['spec', 'priority'], ['spec', 'preemptionPolicy']],
  why: 'admission plugins of phase 20b (D-046, STATUS "Default admission plugins … are missing")',
};

/**
 * docs/FIDELITY.md §6.5 and capture.ts KWOK_AUTHORED: a bound Pod's status is KWOK's but for
 * qosClass; Node conditions; a node Lease's spec. A KWOK Node also lacks what only a kubelet
 * reports (tools/src/golden/topology.test.ts: declaredFeatures, images, runningInUserNamespace),
 * and KWOK records no kubelet events.
 */
export const KWOK: Mask[] = [
  { kind: 'Pod', paths: [['status', '!qosClass']], when: (o) => typeof (o.spec as Obj | undefined)?.nodeName === 'string', why: 'KWOK writes the Pod status (FIDELITY §6.5)' },
  {
    kind: 'Node',
    paths: [['status', 'conditions'], ['status', 'declaredFeatures'], ['status', 'images'], ['status', 'nodeInfo', 'runningInUserNamespace']],
    why: 'KWOK writes Node conditions; only a kubelet reports declaredFeatures, images, runningInUserNamespace (FIDELITY §6.5)',
  },
  { kind: 'Lease', paths: [['spec']], why: 'KWOK holds the node Leases (FIDELITY §6.5)' },
];

/**
 * An Event a kubelet recorded: the oracle has none (FIDELITY §6.5), so such items are left out of
 * listed Events. Items of a list straight from the API server carry no kind.
 */
export const kubeletEvent = (o: Obj): boolean =>
  (o.kind === undefined || o.kind === 'Event') && ((o.source as Obj | undefined)?.component === 'kubelet' || o.reportingController === 'kubelet' || o.reportingComponent === 'kubelet');

/** A copy of a List without the items `drop` holds for. */
export function dropItems(v: unknown, drop: (o: Obj) => boolean): unknown {
  if (v === null || typeof v !== 'object' || Array.isArray(v) || !Array.isArray((v as Obj).items)) return v;
  return { ...(v as Obj), items: ((v as Obj).items as Obj[]).filter((o) => !drop(o)) };
}

const matches = (seg: string, key: string): boolean => (seg.startsWith('!') ? !seg.slice(1).split(',').includes(key) : seg === key);

/** The objects of a value: itself, or a List's items. */
function objectsOf(v: unknown): Obj[] {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return [];
  const o = v as Obj;
  return Array.isArray(o.items) ? (o.items as Obj[]) : [o];
}

function dropPath(v: unknown, p: Path): void {
  if (v === null || typeof v !== 'object') return;
  const [head, ...rest] = p as [string, ...string[]];
  if (head === '*') {
    if (Array.isArray(v)) for (const x of v) dropPath(x, rest);
    return;
  }
  if (Array.isArray(v)) return;
  const o = v as Obj;
  for (const k of Object.keys(o)) {
    if (!matches(head, k)) continue;
    if (rest.length === 0) delete o[k];
    else dropPath(o[k], rest);
  }
}

function applies(m: Mask, o: Obj): boolean {
  return o.kind === m.kind && (m.when === undefined || m.when(o));
}

/** A copy of a JSON value (an object or a List) with the masked fields removed. */
export function maskValue(v: unknown, masks: Mask[]): unknown {
  if (masks.length === 0) return v;
  const copy = structuredClone(v);
  for (const o of objectsOf(copy)) for (const m of masks) if (applies(m, o)) for (const p of m.paths) dropPath(o, p);
  return copy;
}

/** Whether any mask touches a field present in `v`. */
export function maskTouches(v: unknown, masks: Mask[]): boolean {
  return JSON.stringify(maskValue(v, masks)) !== JSON.stringify(v);
}

/** Line ranges [first, last] (0-based, inclusive) of the masked pairs in a YAML or JSON text. */
function maskedLines(text: string, masks: Mask[]): [number, number][] | undefined {
  const lineOf = (offset: number): number => text.slice(0, offset).split('\n').length - 1;
  const out: [number, number][] = [];
  let docs;
  try {
    docs = parseAllDocuments(text);
  } catch {
    return undefined;
  }
  if (!Array.isArray(docs)) return undefined;
  const walk = (node: YamlNode | null | undefined, p: Path): void => {
    if (!node || p.length === 0) return;
    const [head, ...rest] = p as [string, ...string[]];
    if (head === '*') {
      if (isSeq(node)) for (const it of node.items) walk(it as YamlNode, rest);
      return;
    }
    if (!isMap(node)) return;
    for (const pair of node.items) {
      const key = isScalar(pair.key) ? String(pair.key.value) : undefined;
      if (key === undefined || !matches(head, key)) continue;
      if (rest.length > 0) {
        walk(pair.value as YamlNode, rest);
        continue;
      }
      const k = pair.key as YamlNode;
      const v = (pair.value ?? pair.key) as YamlNode;
      if (!k.range || !v.range) continue;
      out.push([lineOf(k.range[0]), lineOf(Math.max(v.range[0], v.range[1] - 1))]);
    }
  };
  for (const d of docs) {
    if (d.errors.length > 0) return undefined;
    const root = d.contents as YamlNode | null;
    const value = d.toJSON() as unknown;
    const items: { node: YamlNode; obj: Obj }[] = [];
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && Array.isArray((value as Obj).items) && isMap(root)) {
      const itemsNode = root.items.find((p) => isScalar(p.key) && p.key.value === 'items')?.value;
      if (isSeq(itemsNode)) itemsNode.items.forEach((n, i) => items.push({ node: n as YamlNode, obj: ((value as Obj).items as Obj[])[i] as Obj }));
    } else if (root) items.push({ node: root, obj: value as Obj });
    for (const { node, obj } of items) for (const m of masks) if (obj && applies(m, obj)) for (const p of m.paths) walk(node, p);
  }
  return out;
}

/**
 * `text` (kubectl's YAML or JSON of an object or List) without the masked fields' lines; in JSON,
 * the commas that end lines are dropped (on both sides of a comparison, whether or not a field was
 * removed). Returns the text unchanged when it does not parse.
 */
export function maskText(text: string, masks: Mask[]): string {
  if (masks.length === 0 || text === '') return text;
  const ranges = maskedLines(text, masks);
  if (!ranges) return text;
  const lines = text.split('\n');
  const drop = new Set<number>();
  for (const [a, b] of ranges) for (let i = a; i <= b; i++) drop.add(i);
  const kept = lines.filter((_l, i) => !drop.has(i));
  const json = text.trimStart().startsWith('{');
  return (json ? kept.map((l) => l.replace(/,$/, '')) : kept).join('\n');
}

// ---- describe text ----
//
// `kubectl describe` prints those fields as lines of a tab-writer layout, so they are masked in its
// cells: the normalized text is split into cells (tabwriter.ts, describe parameters), lines are
// removed or their values replaced by a token on both sides, and the cells are rendered again as
// describe's tab writer would. Where removing the admission plugins' entries leaves a section empty,
// the line becomes what kubectl prints for an empty section (describeContainerVolumes,
// describeVolumes, printTolerationsMultilineWithIndent: `\t<none>`): what the oracle would have
// printed without those plugins. Everything else, the set of lines and their order included, is
// still compared.

/** The token that replaces a KWOK-authored value in describe output. */
export const KWOK_TOKEN = '<<kwok>>';

export const DESCRIBE_ADMISSION_WHY = `${POD_ADMISSION.why}: the Priority and Service Account lines, the kube-api-access mount and volume, the NoExecute tolerations for 300s`;
export const DESCRIBE_KWOK_POD_WHY = 'KWOK writes the Pod status (FIDELITY §6.5): Status, container IDs, states, Ready, Restart Count, the kubelet\'s conditions';
export const DESCRIBE_KWOK_NODE_WHY = 'KWOK writes Node conditions and holds the node Lease (FIDELITY §6.5)';
export const DESCRIBE_KUBELET_EVENTS_WHY = 'KWOK records no kubelet events (FIDELITY §6.5): their rows are left out of the events table';

type Line = string[];

const indentOf = (l: Line): number => /^ */.exec(l[0] ?? '')?.[0].length ?? 0;
const keyOf = (l: Line): string => (l[0] ?? '').trim();
const blank = (l: Line): boolean => l.length === 1 && (l[0] ?? '').trim() === '';

const SA_MOUNT = /^\/var\/run\/secrets\/kubernetes\.io\/serviceaccount from kube-api-access-\S+ \(ro\)$/;
const SA_VOLUME = /^kube-api-access-\S+:$/;
const DEFAULT_TOLERATIONS = new Set(['node.kubernetes.io/not-ready:NoExecute op=Exists for 300s', 'node.kubernetes.io/unreachable:NoExecute op=Exists for 300s']);

/** describePod's object: it has a `QoS Class:` line. */
const isPod = (lines: Line[]): boolean => lines.some((l) => indentOf(l) === 0 && keyOf(l) === 'QoS Class:');
/** describeNode's object: it has a `Roles:` line. */
const isNode = (lines: Line[]): boolean => lines.some((l) => indentOf(l) === 0 && keyOf(l) === 'Roles:');

/** A multi-line value (`Tolerations:` and its continuation lines) with some values removed. */
function filterMultiline(lines: Line[], at: number, drop: (v: string) => boolean): Line[] {
  const head = lines[at] as Line;
  let end = at + 1;
  while (end < lines.length && (lines[end] as Line).length === 2 && (lines[end] as Line)[0] === '') end++;
  const values = [head[1] ?? '', ...lines.slice(at + 1, end).map((l) => l[1] ?? '')];
  const kept = values.filter((v) => !drop(v));
  const replaced: Line[] = kept.length === 0 ? [[head[0] as string, '<none>']] : kept.map((v, i) => (i === 0 ? [head[0] as string, v] : ['', v]));
  return [...lines.slice(0, at), ...replaced, ...lines.slice(end)];
}

function maskPodAdmission(lines: Line[]): Line[] {
  let out = lines.filter((l) => !(indentOf(l) === 0 && (keyOf(l) === 'Priority:' || keyOf(l) === 'Service Account:')));
  // Mounts: the service account token's mount
  const mounts: Line[] = [];
  for (let i = 0; i < out.length; i++) {
    const l = out[i] as Line;
    mounts.push(l);
    if (!(l.length === 1 && keyOf(l) === 'Mounts:')) continue;
    const ind = indentOf(l);
    let j = i + 1;
    const kept: Line[] = [];
    while (j < out.length && (out[j] as Line).length === 1 && indentOf(out[j] as Line) > ind) {
      if (!SA_MOUNT.test(keyOf(out[j] as Line))) kept.push(out[j] as Line);
      j++;
    }
    if (kept.length === 0) mounts[mounts.length - 1] = [l[0] as string, '<none>'];
    mounts.push(...kept);
    i = j - 1;
  }
  out = mounts;
  // Volumes: the kube-api-access projected volume
  const vi = out.findIndex((l) => l.length === 1 && indentOf(l) === 0 && keyOf(l) === 'Volumes:');
  if (vi >= 0) {
    let j = vi + 1;
    const kept: Line[] = [];
    while (j < out.length && indentOf(out[j] as Line) > 0) {
      const name = out[j] as Line;
      let k = j + 1;
      while (k < out.length && indentOf(out[k] as Line) > indentOf(name)) k++;
      if (!(name.length === 1 && SA_VOLUME.test(keyOf(name)))) kept.push(...out.slice(j, k));
      j = k;
    }
    const head: Line[] = kept.length === 0 ? [['Volumes:', '<none>']] : [out[vi] as Line];
    out = [...out.slice(0, vi), ...head, ...kept, ...out.slice(j)];
  }
  const ti = out.findIndex((l) => indentOf(l) === 0 && keyOf(l) === 'Tolerations:' && l.length === 2);
  if (ti >= 0) out = filterMultiline(out, ti, (v) => DEFAULT_TOLERATIONS.has(v));
  return out;
}

/** The rows of the table that starts at the header `title` (indent 0): [first row, end). */
function tableRows(lines: Line[], title: string): [number, number] | undefined {
  const at = lines.findIndex((l) => l.length === 1 && indentOf(l) === 0 && keyOf(l) === title);
  if (at < 0) return undefined;
  let start = at + 1;
  // the column header, and the dashes under it when there are some
  if (start < lines.length && indentOf(lines[start] as Line) > 0) start++;
  if (start < lines.length && /^-+$/.test(keyOf(lines[start] as Line))) start++;
  let end = start;
  while (end < lines.length && indentOf(lines[end] as Line) > 0) end++;
  return [start, end];
}

function dropKubeletEvents(lines: Line[]): Line[] {
  const rows = tableRows(lines, 'Events:');
  if (!rows) return lines;
  const [start, end] = rows;
  const kept = lines.slice(start, end).filter((l) => (l[3] ?? '').trim() !== 'kubelet');
  if (kept.length === end - start) return lines;
  if (kept.length > 0) return [...lines.slice(0, start), ...kept, ...lines.slice(end)];
  // DescribeEvents with no events
  const title = lines.findIndex((l) => l.length === 1 && indentOf(l) === 0 && keyOf(l) === 'Events:');
  return [...lines.slice(0, title), ['Events:', '<none>'], ...lines.slice(end)];
}

const tokenValue = (l: Line): Line => [l[0] as string, KWOK_TOKEN];

function maskPodKwok(lines: Line[]): Line[] {
  const out: Line[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] as Line;
    const key = keyOf(l);
    const ind = indentOf(l);
    if (ind === 0 && key === 'Status:') {
      out.push(tokenValue(l));
      continue;
    }
    if (ind === 4 && (key === 'Container ID:' || key === 'Image ID:' || key === 'Ready:' || key === 'Restart Count:')) {
      out.push(tokenValue(l));
      continue;
    }
    if (ind === 4 && (key === 'State:' || key === 'Last State:')) {
      // the state's details are the lines indented under it
      let j = i + 1;
      while (j < lines.length && indentOf(lines[j] as Line) > ind) j++;
      if (key === 'State:') out.push(tokenValue(l));
      i = j - 1;
      continue;
    }
    out.push(l);
  }
  const rows = tableRows(out, 'Conditions:');
  if (!rows) return out;
  const [start, end] = rows;
  const conditions = out
    .slice(start, end)
    .filter((l) => keyOf(l) !== 'PodReadyToStartContainers')
    .map((l) => (keyOf(l) === 'PodScheduled' ? l : [l[0] as string, KWOK_TOKEN]));
  return [...out.slice(0, start), ...conditions, ...out.slice(end)];
}

function maskNodeKwok(lines: Line[]): Line[] {
  const leaseAt = lines.findIndex((l) => l.length === 1 && indentOf(l) === 0 && keyOf(l) === 'Lease:');
  let out = lines.map((l, i) => (leaseAt >= 0 && i > leaseAt && i <= leaseAt + 3 && indentOf(l) === 2 ? tokenValue(l) : l));
  const rows = tableRows(out, 'Conditions:');
  if (rows) out = [...out.slice(0, rows[0]), ...out.slice(rows[1])];
  return out;
}

/** The objects of a describe output: runs of lines between blank lines. */
function describedObjects(lines: Line[]): Line[][] {
  const out: Line[][] = [];
  let cur: Line[] = [];
  for (const l of lines) {
    if (blank(l)) {
      if (cur.length > 0) out.push(cur);
      out.push([l]);
      cur = [];
      continue;
    }
    cur.push(l);
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/**
 * Masks normalized `kubectl describe` output: the admission plugins' fields of every Pod (D-046)
 * and, with `kwok`, KWOK's fields of Pods and Nodes and the kubelet's event rows. Returns the text
 * unchanged when it does not parse as describe output, and the reasons of the masks that changed it.
 */
export function maskDescribe(text: string, kwok: boolean): { text: string; masked: string[] } {
  if (text === '' || !text.endsWith('\n')) return { text, masked: [] };
  const lines = parseCells(text, DESCRIBE_CELLS);
  if (!lines) return { text, masked: [] };
  const masked = new Set<string>();
  const step = (why: string, f: (l: Line[]) => Line[], o: Line[]): Line[] => {
    const r = f(o);
    if (JSON.stringify(r) !== JSON.stringify(o)) masked.add(why);
    return r;
  };
  const out = describedObjects(lines).flatMap((o) => {
    if (o.length === 1 && blank(o[0] as Line)) return o;
    let r = o;
    if (isPod(r)) {
      r = step(DESCRIBE_ADMISSION_WHY, maskPodAdmission, r);
      if (kwok && r.some((l) => keyOf(l) === 'Node:' && l[1] !== '<none>')) r = step(DESCRIBE_KWOK_POD_WHY, maskPodKwok, r);
    }
    if (kwok && isNode(r)) r = step(DESCRIBE_KWOK_NODE_WHY, maskNodeKwok, r);
    if (kwok) r = step(DESCRIBE_KUBELET_EVENTS_WHY, dropKubeletEvents, r);
    return r;
  });
  if (masked.size === 0) return { text, masked: [] };
  return { text: renderCells(out, DESCRIBE_CELLS), masked: [...masked] };
}

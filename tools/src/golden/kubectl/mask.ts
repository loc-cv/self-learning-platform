// Fields left out of a comparison on both sides, by kind and path: what the oracle cannot show
// (KWOK in place of a kubelet, docs/FIDELITY.md §6.5) or what the simulator does not write yet by a
// recorded decision (the admission plugins of phase 20b, D-046). Everything else of the object,
// and in text output (`-o yaml`, `-o json`) the layout of everything else, is still compared.
//
// Text masking removes the lines of each masked key and its value, located with the `yaml`
// package's source ranges (it parses kubectl's JSON as well); in JSON the commas that end lines are
// then ignored on both sides, since removing a member changes its neighbor's.

import { isMap, isScalar, isSeq, parseAllDocuments, type Node as YamlNode } from 'yaml';

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

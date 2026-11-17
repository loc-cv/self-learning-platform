// Phase 13 exit criterion: in the scheduling lab, "Why?" on a Pending Pod names the same reasons as
// the Pod's FailedScheduling Event, per node, for every cause the lab draws and several seeds. The
// session world is the lab's own (setup ran in its baseline; the session keeps the baseline's
// trace), and the Event is read from the API as kubectl would read it.

import { describe, expect, test } from 'vitest';
import { findItem } from '@simlab/content';
import { buildEvents, buildWhy, type Kernel } from '@simlab/kernel';
import { createClient, DEFAULT_APISERVER, objectId } from '@simlab/k8s';
import { createLab, resolveParams, type Item } from '@simlab/learn';
import { contentRegistry } from './registry.ts';

const ID = 'k8s.scheduling.pending-pods-01';

const item = (): Item => {
  const f = findItem(ID);
  if (!f) throw new Error(`no item ${ID}`);
  return f.raw as unknown as Item;
};

type Obj = Record<string, unknown>;
const list = (k: Kernel, resource: string, ns: string): Obj[] =>
  k.act('test.read', (ctx) => {
    const r = createClient(ctx, DEFAULT_APISERVER).resource(resource).list(ns);
    if (!r.ok) throw new Error(`list ${resource} failed`);
    return ((r.object as Obj).items ?? []) as Obj[];
  });

/** `0/3 nodes are available: 1 node(s) …, 2 node(s) ….` → { reason: count }. */
function histogram(note: string): Record<string, number> {
  const m = /^0\/\d+ nodes are available: (.*?)\.(?: preemption: .*)?$/.exec(note);
  if (!m) throw new Error(`not a FitError message: ${note}`);
  const out: Record<string, number> = {};
  for (const part of (m[1] as string).split(', ')) {
    const n = /^(\d+) (.*)$/.exec(part);
    if (!n) throw new Error(`not a count and a reason: ${part}`);
    out[n[2] as string] = (out[n[2] as string] ?? 0) + Number(n[1]);
  }
  return out;
}

/** Two seeds per cause the lab draws. */
function seeds(): { seed: number; cause: string }[] {
  const out: { seed: number; cause: string }[] = [];
  for (const cause of ['taint', 'selector', 'memory']) {
    let n = 0;
    for (let s = 1; s < 200 && n < 2; s++) {
      if (resolveParams(item(), s).cause === cause) {
        out.push({ seed: s, cause });
        n++;
      }
    }
  }
  return out;
}

describe(`${ID}: Why? on a Pending Pod`, () => {
  test.each(seeds())('seed $seed ($cause): the per-node reasons are the FailedScheduling Event’s, node by node', ({ seed }) => {
    const lab = createLab(item(), contentRegistry, { seed });
    const k = lab.kernel;
    const ns = String(lab.variant.params.ns);
    const pending = list(k, 'v1/pods', ns).filter((p) => ((p.status as Obj).phase as string) === 'Pending' && !((p.spec as Obj).nodeName as string | undefined));
    expect(pending.length).toBeGreaterThan(0);
    for (const p of pending) {
      const name = String((p.metadata as Obj).name);
      const why = buildWhy(contentRegistry, k.world, buildEvents(contentRegistry, k.traceRecords()), objectId('Pod', ns, name));
      expect(why?.summary).toMatch(/^Pending: kube-scheduler found no node for it/);
      const decision = why?.steps.at(-1);
      const items = decision?.items ?? [];
      // One line per node of the cluster, each naming its node.
      expect(items.map((i) => i.label)).toEqual(['controlplane', 'node01', 'node02']);
      expect(items.every((i) => i.entity === `k8s/Node/${i.label}` && i.tone === 'bad')).toBe(true);
      const fromWhy: Record<string, number> = {};
      for (const i of items) for (const r of i.value.split(', ')) fromWhy[r] = (fromWhy[r] ?? 0) + 1;

      const events = list(k, 'events.k8s.io/v1/events', ns).filter((e) => (e.regarding as Obj).name === name && e.reason === 'FailedScheduling');
      expect(events.length).toBeGreaterThan(0);
      const latest = events.sort((a, b) => String(a.eventTime).localeCompare(String(b.eventTime))).at(-1) as Obj;
      expect(fromWhy).toEqual(histogram(String(latest.note)));
    }
  });
});

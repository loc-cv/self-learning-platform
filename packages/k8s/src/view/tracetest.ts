// Test support for the trace coverage and "Why?" tests: a fork of kubeadm-1cp-2w with a root shell
// on the control plane, virtual time run in small steps while every entity id the view shows is
// collected, and the checks every scenario's trace must pass. Nothing here is user-visible.

import { buildEvents, buildView, validateEvents, type Kernel, type TraceRecord, type ViewEvent } from '@simlab/kernel';
import { captureOutput, openSession, type RunResult, type Session } from '@simlab/host';
import { cluster, registry } from '../checks/testenv.ts';

export { registry };

export interface Scene {
  k: Kernel;
  s: Session;
  /** Every entity id a view of the world showed while the scene ran. */
  seen: Set<string>;
}

const STEP_MS = 200;

function sample(sc: Scene): void {
  for (const e of buildView(registry, sc.k.world).entities) sc.seen.add(e.id);
}

export function scene(): Scene {
  const k = cluster();
  const sc: Scene = { k, s: undefined as unknown as Session, seen: new Set() };
  sample(sc);
  sc.s = openSession(k, captureOutput(), { machine: 'controlplane', user: 'root' });
  sample(sc);
  return sc;
}

/** Types a command line into the root shell; fails the test when it fails. */
export function sh(sc: Scene, line: string, status = 0): RunResult {
  const r = sc.s.run(line);
  sample(sc);
  if (r.status !== status) throw new Error(`${line}: exit ${r.status}, want ${status}\n${r.output.split('\n').slice(0, 10).join('\n')}`);
  return r;
}

/** Runs virtual time in steps of 200 ms, collecting the view's entity ids. */
export function run(sc: Scene, ms: number): void {
  const end = sc.k.now + ms;
  while (sc.k.now < end) {
    sc.k.advance(Math.min(STEP_MS, end - sc.k.now));
    sample(sc);
  }
}

/** Runs time until `until` holds (checked every 200 ms), at most `ms`. */
export function runUntil(sc: Scene, ms: number, until: () => boolean): void {
  const end = sc.k.now + ms;
  while (sc.k.now < end && !until()) {
    sc.k.advance(STEP_MS);
    sample(sc);
  }
  if (!until()) throw new Error(`not reached within ${ms} ms`);
}

export const records = (sc: Scene): TraceRecord[] => sc.k.traceRecords();
export const ofKind = (sc: Scene, kind: string): TraceRecord[] => records(sc).filter((r) => r.kind === kind);
export const events = (sc: Scene): ViewEvent[] => buildEvents(registry, records(sc));
export const dataOf = (r: TraceRecord | undefined): Record<string, unknown> => (r?.data ?? {}) as Record<string, unknown>;

/**
 * Kinds a record may have without causes: a root of the trace (someone typed it, a timer of the
 * component's own fired), or work whose cause is held as words in the world (a work queue's
 * `queued by`), since trace ids never enter world state.
 */
export const ROOTS: Record<string, string> = {
  'shell.command': 'typed by a person or a script',
  'apiserver.write': 'a request of kubectl, a process the shell started; ids do not cross into a process',
  'controller.sync': 'a work-queue item; what queued it is kept as words in the queue (world state)',
  'controller.start': 'a component process starting',
  'controller.stop': 'a component process stopping',
  'kubelet.start': 'the kubelet process starting',
  'kubelet.stop': 'the kubelet process stopping',
  'kubelet.node.ready': 'the kubelet’s periodic node status sync',
  'runtime.container.exited': 'a process ending on its own, or the stop timeout’s SIGKILL',
  'runtime.process.wake': 'a process model’s own timer',
  'runtime.process.exec': 'a process replacing its image on its own',
  'event.series-finish': 'the Events API broadcaster’s periodic tick',
  'event.series-refresh': 'the Events API broadcaster’s periodic tick',
};

/**
 * What every scenario's trace must satisfy: valid events, every event about entities a view
 * showed, every record caused unless it is a root, and every record with structured data.
 */
export function expectCoherent(sc: Scene): ViewEvent[] {
  const recs = records(sc);
  const evs = events(sc);
  const problems = validateEvents(evs);
  for (const e of evs) for (const id of e.about) if (!sc.seen.has(id)) problems.push(`event ${e.id} (${e.text}): ${id} was never in the view`);
  for (const e of evs) if (e.link && (!sc.seen.has(e.link.from) || !sc.seen.has(e.link.to))) problems.push(`event ${e.id}: link ${e.link.from} → ${e.link.to} names an entity never in the view`);
  for (const r of recs) {
    if ((r.causes ?? []).length === 0 && !(r.kind in ROOTS)) problems.push(`record ${r.id} ${r.kind} has no cause`);
    if (r.data === undefined || r.data === null || typeof r.data !== 'object') problems.push(`record ${r.id} ${r.kind} has no structured data`);
  }
  if (problems.length > 0) throw new Error(problems.slice(0, 15).join('\n'));
  return evs;
}

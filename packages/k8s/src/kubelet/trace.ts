// What the kubelet's trace records say about a Pod, as structured data (docs/ARCHITECTURE.md §2.9):
// the Pod's coordinates, and the transitions a status write makes visible (phase, Ready, the Pod
// IP, each container's state). The views read these instead of parsing messages. Trace only: these
// functions read the objects they are given and write nothing.

import { isObject, type Json, type JsonObject } from '../apimachinery/json.ts';
import type { ApiObject } from '../apiserver/store.ts';

const str = (v: Json | undefined): string => (typeof v === 'string' ? v : '');
const obj = (v: Json | undefined): JsonObject => (isObject(v) ? v : {});
const objs = (v: Json | undefined): JsonObject[] => (Array.isArray(v) ? (v.filter(isObject) as JsonObject[]) : []);

/** The Pod a record is about. */
export function podData(pod: ApiObject, node: string): JsonObject {
  const m = obj(pod.metadata as Json);
  return { namespace: str(m.namespace), name: str(m.name), uid: str(m.uid), node };
}

/**
 * A container's state as kubectl's STATUS column tells them apart: waiting with its reason,
 * running, terminated with its exit code and reason. The waiting message (`back-off 20s …`) is
 * left out: it changes without the state changing.
 */
export function containerState(cs: JsonObject | undefined): JsonObject | undefined {
  if (!cs) return undefined;
  const state = obj(cs.state);
  if (isObject(state.running)) return { state: 'running' };
  if (isObject(state.terminated)) {
    const t = state.terminated;
    return { state: 'terminated', exitCode: typeof t.exitCode === 'number' ? t.exitCode : 0, reason: str(t.reason) };
  }
  if (isObject(state.waiting)) return { state: 'waiting', reason: str(state.waiting.reason) };
  return undefined;
}

const conditionStatus = (status: JsonObject, type: string): string => str(objs(status.conditions).find((x) => x.type === type)?.status);

/** The transitions between two statuses of a Pod; undefined when none a person would see. */
export function statusTransitions(old: JsonObject, next: JsonObject): JsonObject | undefined {
  const out: JsonObject = {};
  const pair = (from: string, to: string): JsonObject => ({ from, to });
  if (str(old.phase) !== str(next.phase)) out.phase = pair(str(old.phase), str(next.phase));
  const readyOld = conditionStatus(old, 'Ready');
  const readyNew = conditionStatus(next, 'Ready');
  if (readyOld !== readyNew) {
    const reason = str(objs(next.conditions).find((x) => x.type === 'Ready')?.reason);
    out.ready = { ...pair(readyOld, readyNew), ...(reason !== '' ? { reason } : {}) };
  }
  if (str(old.podIP) !== str(next.podIP)) out.podIP = pair(str(old.podIP), str(next.podIP));
  const containers: JsonObject[] = [];
  const before = new Map(objs(old.containerStatuses).map((cs) => [str(cs.name), cs]));
  for (const cs of objs(next.containerStatuses)) {
    const name = str(cs.name);
    const prev = before.get(name);
    const from = containerState(prev);
    const to = containerState(cs);
    const restarts = typeof cs.restartCount === 'number' ? cs.restartCount : 0;
    if (JSON.stringify(from ?? null) === JSON.stringify(to ?? null) && (typeof prev?.restartCount === 'number' ? prev.restartCount : 0) === restarts) continue;
    containers.push({ name, ...(from ? { from } : {}), ...(to ? { to } : {}), restartCount: restarts });
  }
  if (containers.length > 0) out.containers = containers;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** `Running → Failed, Ready True → False, c: running → terminated (1, Error)`: a record's message. */
export function describeTransitions(t: JsonObject): string {
  const parts: string[] = [];
  const p = obj(t.phase);
  if (isObject(t.phase)) parts.push(`phase ${str(p.from) || '(none)'} → ${str(p.to)}`);
  if (isObject(t.ready)) parts.push(`Ready ${str(obj(t.ready).from) || '(none)'} → ${str(obj(t.ready).to)}`);
  if (isObject(t.podIP)) parts.push(`IP ${str(obj(t.podIP).to) || '(none)'}`);
  for (const c of objs(t.containers)) parts.push(`${str(c.name)}: ${stateWords(c.from as JsonObject | undefined)} → ${stateWords(c.to as JsonObject | undefined)}`);
  return parts.join(', ');
}

/** A container state summary in words: `waiting (CrashLoopBackOff)`, `terminated (exit 1, Error)`. */
export function stateWords(s: JsonObject | undefined): string {
  if (!s) return '(none)';
  if (s.state === 'running') return 'running';
  if (s.state === 'terminated') return `terminated (exit ${String(s.exitCode)}${str(s.reason) !== '' ? `, ${str(s.reason)}` : ''})`;
  return str(s.reason) !== '' ? `waiting (${str(s.reason)})` : 'waiting';
}

// What a write sent to an API server was, as structured trace data (docs/ARCHITECTURE.md §2.9).
// The controllers' `controller.write` records and kubectl's `apiserver.write` records share it, so
// the views read both the same way. Trace data only: nothing in the engine reads it back.

import type { JsonObject } from '../apimachinery/json.ts';
import { strategyFor } from '../apiserver/strategies.ts';
import type { ApiRequest, ApiResponse } from '../apiserver/types.ts';

/** The request's coordinates, and the stored object's kind and uid when it succeeded. */
export function writeData(req: ApiRequest, res: ApiResponse, name: string | undefined): JsonObject {
  const out: JsonObject = { verb: req.verb, group: req.group, version: req.version, resource: req.resource };
  if (req.subresource) out.subresource = req.subresource;
  if (req.namespace !== undefined) out.namespace = req.namespace;
  if (name !== undefined) out.name = name;
  out.ok = res.ok;
  out.code = res.code;
  // The resource's kind, as its strategy registers it (a delete answers with a Status).
  const kind = strategyFor(req.group, req.resource)?.kind;
  if (kind !== undefined) out.kind = kind;
  const answer = res.ok ? (res.object as JsonObject | undefined) : undefined;
  if (res.ok) {
    const o = answer;
    const m = o?.kind === 'Status' ? undefined : (o?.metadata as JsonObject | undefined);
    if (typeof m?.uid === 'string') out.uid = m.uid;
    // A delete that only marked the object (grace period, finalizers) left it in place.
    if (req.verb === 'delete' && m?.deletionTimestamp !== undefined && m.deletionTimestamp !== null) out.marked = true;
  } else if ('status' in res) {
    out.message = String(res.status.message ?? '');
    if (typeof res.status.reason === 'string') out.reason = res.status.reason;
  } else if ('notSimulated' in res) out.message = res.notSimulated;
  return out;
}

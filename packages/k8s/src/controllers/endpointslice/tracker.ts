// EndpointSliceTracker: the generation of every EndpointSlice the controller last wrote, per
// Service, so that its own writes coming back through the informer do not queue the Service
// again while someone else's edit or deletion does. upstream:
// staging/src/k8s.io/endpointslice/util/endpointslice_tracker.go. Kept in the controller's data
// under `sliceGenerations` (process memory: a restart forgets it).
//
// StaleSlices is not ported: the controller reads the store itself, so its cache is never behind
// its own writes.

import type { Json } from '../../apimachinery/json.ts';
import type { ApiObject } from '../../apiserver/store.ts';
import type { SyncCtx } from '../types.ts';
import { metaOf, str, strMap } from './util.ts';

const DATA_KEY = 'sliceGenerations';
/** deletionExpected. */
const DELETION_EXPECTED = -1;
export const LABEL_SERVICE_NAME = 'kubernetes.io/service-name';

type Generations = Record<string, Record<string, number>>;

function all(c: SyncCtx): Generations {
  return (c.data()[DATA_KEY] as unknown as Generations | undefined) ?? {};
}

function save(c: SyncCtx, g: Generations): void {
  c.setData(DATA_KEY, g as unknown as Json);
}

/** getServiceNN: the slice's namespace and kubernetes.io/service-name label. */
export function serviceNN(namespace: string, labels: Record<string, string>): string {
  return `${namespace}/${labels[LABEL_SERVICE_NAME] ?? ''}`;
}

const nnOf = (slice: ApiObject): string => serviceNN(str(metaOf(slice).namespace), strMap(metaOf(slice).labels));

/** Has. */
export function trackerHas(c: SyncCtx, nn: string, uid: string): boolean {
  const g = all(c)[nn];
  return g !== undefined && uid in g;
}

/** ShouldSync: untracked, or a generation newer than the one written. */
export function trackerShouldSync(c: SyncCtx, nn: string, uid: string, generation: number): boolean {
  const g = all(c)[nn];
  if (!g) return true;
  const known = g[uid];
  return known === undefined || generation > known;
}

function set(c: SyncCtx, slice: ApiObject, generation: number): void {
  const a = all(c);
  const nn = nnOf(slice);
  save(c, { ...a, [nn]: { ...(a[nn] ?? {}), [str(metaOf(slice).uid)]: generation } });
}

/** Update, with the slice the API server returned. */
export function trackerUpdate(c: SyncCtx, slice: ApiObject): void {
  set(c, slice, typeof metaOf(slice).generation === 'number' ? (metaOf(slice).generation as number) : 0);
}

/** ExpectDeletion. */
export function trackerExpectDeletion(c: SyncCtx, slice: ApiObject): void {
  set(c, slice, DELETION_EXPECTED);
}

/** HandleDeletion: forgets the slice; false when its deletion was not expected. */
export function trackerHandleDeletion(c: SyncCtx, nn: string, uid: string): boolean {
  const a = all(c);
  const g = a[nn];
  if (!g) return true;
  const known = g[uid];
  const rest = { ...g };
  delete rest[uid];
  save(c, { ...a, [nn]: rest });
  return !(known !== undefined && known !== DELETION_EXPECTED);
}

/** DeleteService. */
export function trackerDeleteService(c: SyncCtx, nn: string): void {
  const a = all(c);
  if (!(nn in a)) return;
  const rest = { ...a };
  delete rest[nn];
  save(c, rest);
}

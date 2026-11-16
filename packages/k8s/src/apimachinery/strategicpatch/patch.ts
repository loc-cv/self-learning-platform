// Strategic merge patch: the port of upstream's algorithm, function by function.
// upstream: staging/src/k8s.io/apimachinery/pkg/util/strategicpatch/patch.go (v1.37.2)
//
// Values are decoded JSON as upstream holds them (map[string]interface{}, []interface{}, string,
// int64 for an integer, float64, bool, nil). Like upstream, the merge works in place: it mutates
// the original and the patch, and the result shares parts of both. Callers pass copies. The
// API server shows the mutated patch in some errors (`fmt.Sprintf("%+v", patchMap)`), so the
// mutations are part of the behavior.
//
// Order. Upstream ranges over Go maps, in random order; the patch and the result are marshalled
// with sorted keys. Here maps are walked in insertion order. The outcome differs only where
// upstream's is itself random: which error is reported when a patch has two, and the order in
// which a list and its `$deleteFromPrimitiveList` twin in the same patch apply.

import type { Json, JsonObject } from '../json.ts';
import { compareGoStrings } from '../labels.ts';
import { goSprint, goSprintS } from '../../kubectl/printers/gofmt.ts';
import { marshalYaml } from '../yaml/encode.ts';
import {
  errBadArgType,
  errBadPatchFormatForPrimitiveList,
  errBadPatchFormatForRetainKeys,
  errBadPatchFormatForSetElementOrderList,
  errBadPatchType,
  errConflict,
  errNilDereference,
  errNoListOfLists,
  errNoMergeKey,
  MAP_TYPE,
  PatchError,
  SLICE_TYPE,
} from './errors.ts';
import type { LookupPatchMeta, PatchMeta } from './meta.ts';

export const directiveMarker = '$patch';
export const deleteDirective = 'delete';
export const replaceDirective = 'replace';
export const mergeDirective = 'merge';
export const retainKeysStrategy = 'retainKeys';
export const deleteFromPrimitiveListDirectivePrefix = '$deleteFromPrimitiveList';
export const retainKeysDirective = '$' + retainKeysStrategy;
export const setElementOrderDirectivePrefix = '$setElementOrder';

export interface DiffOptions {
  setElementOrder?: boolean;
  ignoreChangesAndAdditions?: boolean;
  ignoreDeletions?: boolean;
  buildRetainKeysDirective?: boolean;
}

export interface MergeOptions {
  mergeParallelList?: boolean;
  ignoreUnmatchedNulls?: boolean;
  /** Not upstream's: the decoded lists have capacity = length (the API server's; see Go slices below). */
  exactCapacity?: boolean;
}

type JMap = JsonObject;
type Kind = 'map' | 'slice' | 'string' | 'int64' | 'float64' | 'bool';

const hasOwn = (o: JMap, k: string): boolean => Object.hasOwn(o, k);
const isMap = (v: Json | undefined): v is JMap => v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v);

/** reflect.TypeOf of a decoded value; null for nil. */
function goType(v: Json | undefined): Kind | null {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return 'slice';
  switch (typeof v) {
    case 'string':
      return 'string';
    case 'boolean':
      return 'bool';
    case 'number':
      return Number.isInteger(v) ? 'int64' : 'float64';
    default:
      return 'map';
  }
}

/** Go's == on two interface{} values holding decoded scalars (int64 and float64 never equal). */
function goEqual(a: Json | undefined, b: Json | undefined): boolean {
  const ta = goType(a);
  if (ta !== goType(b)) return false;
  if (ta === null) return true;
  // Maps and slices are not comparable in Go (== panics); identity stands in for them.
  return a === b;
}

/** reflect.DeepEqual of decoded values. */
function deepEqual(a: Json | undefined, b: Json | undefined): boolean {
  const ta = goType(a);
  if (ta !== goType(b)) return false;
  if (ta === 'slice') {
    const x = a as Json[];
    const y = b as Json[];
    return x.length === y.length && x.every((v, i) => deepEqual(v, y[i]));
  }
  if (ta === 'map') {
    const x = a as JMap;
    const y = b as JMap;
    const kx = Object.keys(x);
    return kx.length === Object.keys(y).length && kx.every((k) => hasOwn(y, k) && deepEqual(x[k], y[k]));
  }
  return a === b || (a === undefined && b === null) || (a === null && b === undefined);
}

const valueOrNil = (m: JMap, k: string): Json => (hasOwn(m, k) ? (m[k] as Json) : null);

// ---- diff ----

/**
 * diffMaps: a (recursive) strategic merge patch that yields modified when applied to original.
 */
export function diffMaps(original: JMap, modified: JMap, schema: LookupPatchMeta, o: DiffOptions): JMap {
  const patch: JMap = {};
  const retainKeysList: Json[] = [];
  for (const key of Object.keys(modified)) {
    const modifiedValue = modified[key] as Json;
    if (o.buildRetainKeysDirective && modifiedValue !== null) retainKeysList.push(key);
    if (!hasOwn(original, key)) {
      if (!o.ignoreChangesAndAdditions) patch[key] = modifiedValue;
      continue;
    }
    const originalValue = original[key] as Json;
    if (handleDirectiveMarker(key, originalValue, modifiedValue, patch)) continue;
    if (goType(originalValue) !== goType(modifiedValue)) {
      if (!o.ignoreChangesAndAdditions) patch[key] = modifiedValue;
      continue;
    }
    if (isMap(originalValue)) handleMapDiff(key, originalValue, modifiedValue as JMap, patch, schema, o);
    else if (Array.isArray(originalValue)) handleSliceDiff(key, originalValue, modifiedValue as Json[], patch, schema, o);
    else replacePatchFieldIfNotEqual(key, originalValue, modifiedValue, patch, o);
  }
  updatePatchIfMissing(original, modified, patch, o);
  if (retainKeysList.length > 0 && (Object.keys(patch).length > 0 || hasAdditionalNewField(original, modified))) {
    patch[retainKeysDirective] = sortScalars(retainKeysList);
  }
  return patch;
}

function handleDirectiveMarker(key: string, originalValue: Json, modifiedValue: Json, patch: JMap): boolean {
  if (key !== directiveMarker) return false;
  if (typeof originalValue !== 'string' || typeof modifiedValue !== 'string') throw new PatchError(`invalid value for special key: ${directiveMarker}`);
  if (modifiedValue !== originalValue) patch[directiveMarker] = modifiedValue;
  return true;
}

function handleMapDiff(key: string, originalValue: JMap, modifiedValue: JMap, patch: JMap, schema: LookupPatchMeta, o: DiffOptions): void {
  let subschema: LookupPatchMeta;
  let patchMeta: PatchMeta;
  try {
    [subschema, patchMeta] = schema.lookupPatchMetadataForStruct(key);
  } catch (e) {
    // No metadata for the field: identical values need no patch.
    if (deepEqual(originalValue, modifiedValue)) return;
    throw e;
  }
  const [retainKeys, patchStrategy] = extractRetainKeysPatchStrategy(patchMeta.patchStrategies);
  const opts = { ...o, buildRetainKeysDirective: retainKeys };
  if (patchStrategy === replaceDirective) {
    if (!opts.ignoreChangesAndAdditions) patch[key] = modifiedValue;
    return;
  }
  const patchValue = diffMaps(originalValue, modifiedValue, subschema, opts);
  if (Object.keys(patchValue).length > 0) patch[key] = patchValue;
}

function handleSliceDiff(key: string, originalValue: Json[], modifiedValue: Json[], patch: JMap, schema: LookupPatchMeta, o: DiffOptions): void {
  let subschema: LookupPatchMeta;
  let patchMeta: PatchMeta;
  try {
    [subschema, patchMeta] = schema.lookupPatchMetadataForSlice(key);
  } catch (e) {
    if (deepEqual(originalValue, modifiedValue)) return;
    throw e;
  }
  const [retainKeys, patchStrategy] = extractRetainKeysPatchStrategy(patchMeta.patchStrategies);
  if (patchStrategy === mergeDirective) {
    const opts = { ...o, buildRetainKeysDirective: retainKeys };
    const [addList, deletionList, setOrderList] = diffLists(originalValue, modifiedValue, subschema, patchMeta.patchMergeKey, opts);
    if (addList && addList.length > 0) patch[key] = addList;
    if (deletionList && deletionList.length > 0) patch[`${deleteFromPrimitiveListDirectivePrefix}/${key}`] = deletionList;
    if (setOrderList && setOrderList.length > 0) patch[`${setElementOrderDirectivePrefix}/${key}`] = setOrderList;
    return;
  }
  replacePatchFieldIfNotEqual(key, originalValue, modifiedValue, patch, o);
}

function replacePatchFieldIfNotEqual(key: string, original: Json, modified: Json, patch: JMap, o: DiffOptions): void {
  if (o.ignoreChangesAndAdditions) return;
  if (deepEqual(original, modified)) return;
  patch[key] = modified;
}

function updatePatchIfMissing(original: JMap, modified: JMap, patch: JMap, o: DiffOptions): void {
  if (o.ignoreDeletions) return;
  for (const key of Object.keys(original)) if (!hasOwn(modified, key)) patch[key] = null;
}

function validateMergeKeyInLists(mergeKey: string, ...lists: Json[][]): void {
  for (const list of lists) {
    for (const item of list) {
      if (!isMap(item)) throw errBadArgType(MAP_TYPE, item);
      if (!hasOwn(item, mergeKey)) throw errNoMergeKey(item, mergeKey);
    }
  }
}

/** normalizeElementOrder: `patch` sorted by patchOrder, `serverOnly` by serverOrder, then merged. */
function normalizeElementOrder(patch: Json[], serverOnly: Json[], patchOrder: Json[], serverOrder: Json[], mergeKey: string, kind: Kind): Json[] {
  const p = normalizeSliceOrder(patch, patchOrder, mergeKey, kind);
  const s = normalizeSliceOrder(serverOnly, serverOrder, mergeKey, kind);
  return mergeSortedSlice(s, p, serverOrder, mergeKey, kind);
}

/** mergeSortedSlice: inserts the items of `left` into `right`, keeping both relative orders. */
function mergeSortedSlice(left: Json[], right: Json[], serverOrder: Json[], mergeKey: string, kind: Kind): Json[] {
  const less = (l: Json, r: Json): [boolean, boolean] => {
    const li = index(serverOrder, l, mergeKey, kind);
    const ri = index(serverOrder, r, mergeKey, kind);
    return li >= 0 && ri >= 0 ? [li < ri, true] : [false, false];
  };
  const size = left.length + right.length;
  let i = 0;
  let j = 0;
  const s: Json[] = [];
  for (let k = 0; k < size; k++) {
    if (i >= left.length && j < right.length) s.push(right[j++] as Json);
    else if (j >= right.length && i < left.length) s.push(left[i++] as Json);
    else {
      const [lt, foundBoth] = less(left[i] as Json, right[j] as Json);
      if (foundBoth && lt) s.push(left[i++] as Json);
      else s.push(right[j++] as Json);
    }
  }
  return s;
}

/** index: the position of an item (by merge key value for maps), or -1. */
function index(l: Json[], valToLookUp: Json, mergeKey: string, kind: Kind): number {
  const get = kind === 'map' ? (item: Json): Json => (isMap(item) ? valueOrNil(item, mergeKey) : null) : (item: Json): Json => item;
  const want = get(valToLookUp);
  for (let i = 0; i < l.length; i++) if (goEqual(want, get(l[i] as Json))) return i;
  return -1;
}

/** extractToDeleteItems: the items to keep and those with `$patch: delete`. */
function extractToDeleteItems(l: Json[]): [Json[], Json[]] {
  const nonDelete: Json[] = [];
  const toDelete: Json[] = [];
  for (const v of l) {
    if (!isMap(v)) throw errBadArgType(MAP_TYPE, v);
    if (hasOwn(v, directiveMarker) && v[directiveMarker] === deleteDirective) toDelete.push(v);
    else nonDelete.push(v);
  }
  return [nonDelete, toDelete];
}

/** normalizeSliceOrder: `toSort` sorted (sort.SliceStable) by the positions of its items in `order`. */
function normalizeSliceOrder(toSort: Json[], order: Json[], mergeKey: string, kind: Kind): Json[] {
  let list = toSort;
  let toDelete: Json[] = [];
  if (kind === 'map') {
    validateMergeKeyInLists(mergeKey, toSort, order);
    [list, toDelete] = extractToDeleteItems(toSort);
  } else list = toSort.slice();
  // An item missing from `order` is "less" than anything: the result is what Go's algorithm
  // makes of that comparison, so the algorithm is ported rather than replaced by a JS sort.
  sliceStable(list, (i, j) => {
    const ii = index(order, list[i] as Json, mergeKey, kind);
    if (ii >= 0) {
      const ij = index(order, list[j] as Json, mergeKey, kind);
      if (ij >= 0) return ii < ij;
    }
    return true;
  });
  return list.concat(toDelete);
}

/**
 * diffLists: a (recursive) patch list, a parallel deletion list (primitives only) and a
 * `$setElementOrder` list, for a list with the merge strategy.
 */
function diffLists(original: Json[], modified: Json[], schema: LookupPatchMeta, mergeKey: string, o: DiffOptions): [Json[] | null, Json[] | null, Json[] | null] {
  if (original.length === 0) {
    if (modified.length === 0 || o.ignoreChangesAndAdditions) return [null, null, null];
    return [modified, null, null];
  }
  const kind = sliceElementType(original, modified);
  let patchList: Json[];
  let deleteList: Json[] | null;
  let setOrderList: Json[] | null = null;
  if (kind === 'map') {
    [patchList, deleteList] = diffListsOfMaps(original, modified, schema, mergeKey, o);
    patchList = normalizeSliceOrder(patchList, modified, mergeKey, kind);
    const orderSame = isOrderSame(original, modified, mergeKey);
    patchList = patchList.concat(deleteList);
    deleteList = null;
    if (o.setElementOrder && ((!o.ignoreChangesAndAdditions && (patchList.length > 0 || !orderSame)) || (!o.ignoreDeletions && patchList.length > 0))) {
      setOrderList = modified.map((v) => ({ [mergeKey]: valueOrNil(v as JMap, mergeKey) }));
    }
  } else if (kind === 'slice') {
    throw errNoListOfLists();
  } else {
    [patchList, deleteList] = diffListsOfScalars(original, modified, o);
    patchList = normalizeSliceOrder(patchList, modified, mergeKey, kind);
    // diffListsOfScalars sorted `original` in place: upstream compares the sorted list.
    if (o.setElementOrder && ((!o.ignoreDeletions && deleteList.length > 0) || (!o.ignoreChangesAndAdditions && !deepEqual(original, modified)))) {
      setOrderList = modified;
    }
  }
  return [patchList, deleteList, setOrderList];
}

function isOrderSame(original: Json[], modified: Json[], mergeKey: string): boolean {
  if (original.length !== modified.length) return false;
  for (let i = 0; i < modified.length; i++) if (!mergeKeyValueEqual(original[i] as Json, modified[i] as Json, mergeKey)) return false;
  return true;
}

/** diffListsOfScalars: additions and deletions. Sorts `original` in place, as upstream does. */
function diffListsOfScalars(original: Json[], modified: Json[], o: DiffOptions): [Json[], Json[]] {
  const originalScalars = sortScalars(original);
  const modifiedScalars = sortScalars(modified.slice());
  let oi = 0;
  let mi = 0;
  const addList: Json[] = [];
  const deletionList: Json[] = [];
  for (;;) {
    const oIn = oi < originalScalars.length;
    const mIn = mi < modifiedScalars.length;
    if (!oIn && !mIn) break;
    const ov = oIn ? (originalScalars[oi] as Json) : null;
    const mv = mIn ? (modifiedScalars[mi] as Json) : null;
    const os = oIn ? goSprint(ov) : '';
    const ms = mIn ? goSprint(mv) : '';
    const cmp = compareGoStrings(os, ms);
    if (oIn && mIn && cmp === 0) {
      oi++;
      mi++;
    } else if (!oIn || (oIn && mIn && cmp > 0)) {
      if (!o.ignoreChangesAndAdditions) addList.push(mv);
      mi++;
    } else {
      if (!o.ignoreDeletions) deletionList.push(ov);
      oi++;
    }
  }
  return [addList, deduplicateScalars(deletionList)];
}

/** diffListsOfMaps: changes and additions, and `$patch: delete` items for removals. */
function diffListsOfMaps(original: Json[], modified: Json[], schema: LookupPatchMeta, mergeKey: string, o: DiffOptions): [Json[], Json[]] {
  const patch: Json[] = [];
  const deletionList: Json[] = [];
  const originalSorted = sortMergeListsByNameArray(original, schema, mergeKey, false);
  const modifiedSorted = sortMergeListsByNameArray(modified, schema, mergeKey, false);
  let oi = 0;
  let mi = 0;
  for (;;) {
    const oIn = oi < originalSorted.length;
    const mIn = mi < modifiedSorted.length;
    if (!oIn && !mIn) break;
    let oEl: JMap = {};
    let mEl: JMap = {};
    let oKey: Json = null;
    let mKey: Json = null;
    let os = '';
    let ms = '';
    if (oIn) {
      [oEl, oKey] = getMapAndMergeKeyValueByIndex(oi, mergeKey, originalSorted);
      os = goSprint(oKey);
    }
    if (mIn) {
      [mEl, mKey] = getMapAndMergeKeyValueByIndex(mi, mergeKey, modifiedSorted);
      ms = goSprint(mKey);
    }
    const cmp = compareGoStrings(os, ms);
    if (oIn && mIn && cmp === 0) {
      const patchValue = diffMaps(oEl, mEl, schema, o);
      if (Object.keys(patchValue).length > 0) {
        patchValue[mergeKey] = mKey;
        patch.push(patchValue);
      }
      oi++;
      mi++;
    } else if (!oIn || (oIn && mIn && cmp > 0)) {
      if (!o.ignoreChangesAndAdditions) patch.push(mEl);
      mi++;
    } else {
      if (!o.ignoreDeletions) deletionList.push(createDeleteDirective(mergeKey, oKey));
      oi++;
    }
  }
  return [patch, deletionList];
}

function getMapAndMergeKeyValueByIndex(i: number, mergeKey: string, listOfMaps: Json[]): [JMap, Json] {
  const m = listOfMaps[i] as Json;
  if (!isMap(m)) throw errBadArgType(MAP_TYPE, m);
  if (!hasOwn(m, mergeKey)) throw errNoMergeKey(m, mergeKey);
  return [m, m[mergeKey] as Json];
}

// ---- apply ----

/** StrategicMergeMapPatchUsingLookupPatchMeta: what the API server applies. Mutates both. */
export function strategicMergeMapPatch(original: JMap, patch: JMap, schema: LookupPatchMeta, exactCapacity = false): JMap {
  return mergeMap(original, patch, schema, { mergeParallelList: true, ignoreUnmatchedNulls: true, exactCapacity });
}

function handleDirectiveInMergeMap(directive: Json, patch: JMap): JMap {
  if (directive === replaceDirective) {
    delete patch[directiveMarker];
    return patch;
  }
  if (directive === deleteDirective) return {};
  throw errBadPatchType(directive, patch);
}

function containsDirectiveMarker(item: Json): boolean {
  return isMap(item) && hasOwn(item, directiveMarker);
}

function mergeKeyValueEqual(left: Json, right: Json, mergeKey: string): boolean {
  if (mergeKey.length === 0) return goEqual(left, right);
  if (!isMap(left)) throw errBadArgType(MAP_TYPE, left);
  if (!isMap(right)) throw errBadArgType(MAP_TYPE, right);
  if (!hasOwn(left, mergeKey)) throw errNoMergeKey(left, mergeKey);
  if (!hasOwn(right, mergeKey)) throw errNoMergeKey(right, mergeKey);
  return goEqual(left[mergeKey], right[mergeKey]);
}

/** extractKey: the key after `<prefix>/`. */
function extractKey(s: string, prefix: string): string {
  const slash = s.indexOf('/');
  if (slash < 0 || s.slice(0, slash) !== prefix) {
    if (prefix === deleteFromPrimitiveListDirectivePrefix) throw errBadPatchFormatForPrimitiveList();
    if (prefix === setElementOrderDirectivePrefix) throw errBadPatchFormatForSetElementOrderList();
    throw new PatchError(`fail to find unknown prefix ${JSON.stringify(prefix)} in ${s}\n`);
  }
  return s.slice(slash + 1);
}

/**
 * validatePatchWithSetOrderList: the patch list's items appear in the `$setElementOrder` list,
 * in the same relative order (deletions aside).
 */
function validatePatchWithSetOrderList(patchList: Json[], setOrderList: Json[], mergeKey: string): void {
  if (setOrderList.length === 0 || patchList.length === 0) return;
  const nonDeleteList = mergeKey.length > 0 ? extractToDeleteItems(patchList)[0] : patchList;
  let pi = 0;
  let si = 0;
  while (pi < nonDeleteList.length && si < setOrderList.length) {
    if (containsDirectiveMarker(nonDeleteList[pi] as Json)) {
      pi++;
      continue;
    }
    if (mergeKeyValueEqual(nonDeleteList[pi] as Json, setOrderList[si] as Json, mergeKey)) pi++;
    si++;
  }
  if (pi < nonDeleteList.length && si >= setOrderList.length) {
    throw new PatchError(`The order in patch list:\n${goSprint(patchList)}\n doesn't match ${setElementOrderDirectivePrefix} list:\n${goSprint(setOrderList)}\n`);
  }
}

/** preprocessDeletionListForMerging: [skip, isDeleteList, the list's own key]. */
function preprocessDeletionListForMerging(key: string, original: JMap, patchVal: Json, mergeDeletionList: boolean): [boolean, boolean, string] {
  if (key.startsWith(deleteFromPrimitiveListDirectivePrefix)) {
    if (!mergeDeletionList) {
      original[key] = patchVal;
      return [true, false, ''];
    }
    return [false, true, extractKey(key, deleteFromPrimitiveListDirectivePrefix)];
  }
  return [false, false, ''];
}

/** applyRetainKeysDirective: clears the keys of `original` the `$retainKeys` list does not name. */
function applyRetainKeysDirective(original: JMap, patch: JMap, options: MergeOptions): void {
  if (!hasOwn(patch, retainKeysDirective)) return;
  const retainKeysInPatch = patch[retainKeysDirective] as Json;
  delete patch[retainKeysDirective];
  if (!options.mergeParallelList) {
    if (hasOwn(original, retainKeysDirective)) {
      const inOriginal = original[retainKeysDirective] as Json;
      if (!deepEqual(inOriginal, retainKeysInPatch)) {
        throw new PatchError(`${goSprint(inOriginal)} and ${goSprint(retainKeysInPatch)} are not deep equal: this may happen when calculating the 3-way diff patch`);
      }
    } else original[retainKeysDirective] = retainKeysInPatch;
    return;
  }
  if (!Array.isArray(retainKeysInPatch)) throw errBadPatchFormatForRetainKeys();
  const m = new Set<Json>(retainKeysInPatch);
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (v === null || k.startsWith(deleteFromPrimitiveListDirectivePrefix) || k.startsWith(setElementOrderDirectivePrefix)) continue;
    if (!m.has(k)) throw errBadPatchFormatForRetainKeys();
  }
  for (const k of Object.keys(original)) if (!m.has(k)) delete original[k];
}

/**
 * mergePatchIntoOriginal: processes each `$setElementOrder/<list>` with its list: merged, then
 * ordered by `$setElementOrder` > order in the patch list > order in the live list.
 */
function mergePatchIntoOriginal(original: JMap, patch: JMap, schema: LookupPatchMeta, o: MergeOptions): void {
  for (const key of Object.keys(patch)) {
    if (!hasOwn(patch, key) || !key.startsWith(setElementOrderDirectivePrefix)) continue;
    const setElementOrderInPatch = patch[key] as Json;
    if (!o.mergeParallelList) {
      if (hasOwn(original, key)) {
        if (!deepEqual(original[key], setElementOrderInPatch)) throw errBadPatchFormatForSetElementOrderList();
      } else original[key] = setElementOrderInPatch;
    }
    delete patch[key];
    if (!Array.isArray(setElementOrderInPatch)) throw errBadArgType(SLICE_TYPE, setElementOrderInPatch);
    const typedSetElementOrderList = setElementOrderInPatch;
    const originalKey = extractKey(key, setElementOrderDirectivePrefix);
    const foundOriginal = hasOwn(original, originalKey);
    const foundPatch = hasOwn(patch, originalKey);
    let originalFieldValue: Json[] = [];
    let patchFieldValue: Json[] = [];
    if (foundOriginal) {
      const v = original[originalKey] as Json;
      if (!Array.isArray(v)) throw errBadArgType(SLICE_TYPE, v);
      originalFieldValue = v;
    }
    if (foundPatch) {
      const v = patch[originalKey] as Json;
      if (!Array.isArray(v)) throw errBadArgType(SLICE_TYPE, v);
      patchFieldValue = v;
    }
    const [subschema, patchMeta] = schema.lookupPatchMetadataForSlice(originalKey);
    const [, patchStrategy] = extractRetainKeysPatchStrategy(patchMeta.patchStrategies);
    validatePatchWithSetOrderList(patchFieldValue, typedSetElementOrderList, patchMeta.patchMergeKey);
    let merged: Json[];
    if (foundOriginal && !foundPatch) merged = originalFieldValue;
    else if (!foundOriginal && foundPatch) merged = removeDirectives(patchFieldValue)[0] as Json[];
    else if (foundOriginal && foundPatch) merged = mergeSliceHandler(originalFieldValue, patchFieldValue, subschema, patchStrategy, patchMeta.patchMergeKey, false, o);
    else continue;
    let patchItems: Json[];
    let serverOnlyItems: Json[];
    if (patchMeta.patchMergeKey.length === 0) [patchItems, serverOnlyItems] = partitionPrimitivesByPresentInList(merged, typedSetElementOrderList);
    else [patchItems, serverOnlyItems] = partitionMapsByPresentInList(merged, typedSetElementOrderList, patchMeta.patchMergeKey);
    const kind = sliceElementType(originalFieldValue, patchFieldValue);
    original[originalKey] = normalizeElementOrder(patchItems, serverOnlyItems, typedSetElementOrderList, originalFieldValue, patchMeta.patchMergeKey, kind);
    delete patch[originalKey];
  }
}

function partitionPrimitivesByPresentInList(original: Json[], partitionBy: Json[]): [Json[], Json[]] {
  const patch: Json[] = [];
  const serverOnly: Json[] = [];
  for (const v of original) {
    if (partitionBy.some((p) => goEqual(p, v))) patch.push(v);
    else serverOnly.push(v);
  }
  return [patch, serverOnly];
}

function partitionMapsByPresentInList(original: Json[], partitionBy: Json[], mergeKey: string): [Json[], Json[]] {
  const patch: Json[] = [];
  const serverOnly: Json[] = [];
  for (const v of original) {
    if (!isMap(v)) throw errBadArgType(MAP_TYPE, v);
    if (!hasOwn(v, mergeKey)) throw errNoMergeKey(v, mergeKey);
    const [, , found] = findMapInSliceBasedOnKeyValue(partitionBy, mergeKey, v[mergeKey] as Json);
    if (found) patch.push(v);
    else serverOnly.push(v);
  }
  return [patch, serverOnly];
}

/** removeDirectives: the value without maps holding `$patch`; [value, keep]. Mutates maps. */
export function removeDirectives(obj: Json): [Json, boolean] {
  if (obj === null) return [obj, true];
  if (isMap(obj)) {
    if (hasOwn(obj, directiveMarker)) return [null, false];
    for (const k of Object.keys(obj)) {
      const [v, keep] = removeDirectives(obj[k] as Json);
      if (keep) obj[k] = v;
      else delete obj[k];
    }
    return [obj, true];
  }
  if (Array.isArray(obj)) {
    const res: Json[] = [];
    for (const v of obj) {
      const [nv, keep] = removeDirectives(v);
      if (keep) res.push(nv);
    }
    return [res, true];
  }
  return [obj, true];
}

/** mergeMap: the patch merged into the original (both may be modified). */
export function mergeMap(originalIn: JMap | null, patch: JMap, schema: LookupPatchMeta, o: MergeOptions): JMap {
  if (hasOwn(patch, directiveMarker)) return handleDirectiveInMergeMap(patch[directiveMarker] as Json, patch);
  const original = originalIn ?? {};
  applyRetainKeysDirective(original, patch, o);
  mergePatchIntoOriginal(original, patch, schema, o);
  for (const pk of Object.keys(patch)) {
    if (!hasOwn(patch, pk)) continue;
    const patchV = patch[pk] as Json;
    const [skip, isDeleteList, noPrefixKey] = preprocessDeletionListForMerging(pk, original, patchV, o.mergeParallelList ?? false);
    if (skip) continue;
    const k = noPrefixKey.length > 0 ? noPrefixKey : pk;
    // A null deletes the key; it is kept when unmatched nulls are not ignored (client side).
    if (patchV === null) {
      delete original[k];
      if (o.ignoreUnmatchedNulls) continue;
    }
    if (!hasOwn(original, k) || goType(original[k]) !== goType(patchV)) {
      if (!isDeleteList) {
        if (o.ignoreUnmatchedNulls) discardNullValuesFromPatch(patchV);
        const [v, keep] = removeDirectives(patchV);
        if (keep) original[k] = v;
        else delete original[k];
      }
      continue;
    }
    const ov = original[k] as Json;
    if (isMap(ov)) {
      const [subschema, patchMeta] = schema.lookupPatchMetadataForStruct(k);
      const [, patchStrategy] = extractRetainKeysPatchStrategy(patchMeta.patchStrategies);
      original[k] = mergeMapHandler(ov, patchV, subschema, patchStrategy, o);
    } else if (Array.isArray(ov)) {
      const [subschema, patchMeta] = schema.lookupPatchMetadataForSlice(k);
      const [, patchStrategy] = extractRetainKeysPatchStrategy(patchMeta.patchStrategies);
      original[k] = mergeSliceHandler(ov, patchV, subschema, patchStrategy, patchMeta.patchMergeKey, isDeleteList, o);
    } else {
      const [v, keep] = removeDirectives(patchV);
      if (keep) original[k] = v;
      else delete original[k];
    }
  }
  return original;
}

/** discardNullValuesFromPatch: drops null members of every map inside, in place. */
function discardNullValuesFromPatch(v: Json): void {
  if (isMap(v)) {
    for (const k of Object.keys(v)) {
      if (v[k] === null) delete v[k];
      else discardNullValuesFromPatch(v[k] as Json);
    }
  } else if (Array.isArray(v)) {
    for (const x of v) discardNullValuesFromPatch(x);
  }
}

function mergeMapHandler(original: Json, patch: Json, schema: LookupPatchMeta, fieldPatchStrategy: string, o: MergeOptions): JMap {
  if (!isMap(original)) throw errBadArgType(MAP_TYPE, original);
  if (!isMap(patch)) throw errBadArgType(MAP_TYPE, patch);
  if (fieldPatchStrategy !== replaceDirective) return mergeMap(original, patch, schema, o);
  return patch;
}

function mergeSliceHandler(original: Json, patch: Json, schema: LookupPatchMeta, fieldPatchStrategy: string, fieldPatchMergeKey: string, isDeleteList: boolean, o: MergeOptions): Json[] {
  if (!Array.isArray(original)) throw errBadArgType(SLICE_TYPE, original);
  if (!Array.isArray(patch)) throw errBadArgType(SLICE_TYPE, patch);
  // Delete lists are handled the same way whatever the field's strategy.
  if (fieldPatchStrategy === mergeDirective || isDeleteList) return mergeSlice(original, patch, schema, fieldPatchMergeKey, o, isDeleteList);
  return patch;
}

/** mergeSlice: two lists merged (by merge key for maps, as a set for primitives), then ordered. */
function mergeSlice(originalIn: Json[], patchIn: Json[], schema: LookupPatchMeta, mergeKey: string, o: MergeOptions, isDeleteList: boolean): Json[] {
  if (originalIn.length === 0 && patchIn.length === 0) return originalIn;
  const kind = sliceElementType(originalIn, patchIn);
  let original = sliceOf(originalIn, o);
  let patch = patchIn;
  let merged: Json[];
  if (kind !== 'map') {
    if (o.mergeParallelList && isDeleteList) return deleteFromSlice(originalIn, patch);
    // Maybe in the future add a "concat" mode that doesn't deduplicate.
    merged = deduplicateSlice(appendSlice(original, patch));
  } else {
    if (mergeKey === '') throw new PatchError(`cannot merge lists without merge key for ${schema.name()}`);
    [original, patch] = mergeSliceWithSpecialElements(original, patch, mergeKey);
    merged = elements(mergeSliceWithoutSpecialElements(original, patch, mergeKey, schema, o));
  }
  let patchItems: Json[];
  let serverOnlyItems: Json[];
  if (mergeKey.length === 0) [patchItems, serverOnlyItems] = partitionPrimitivesByPresentInList(merged, patch);
  else [patchItems, serverOnlyItems] = partitionMapsByPresentInList(merged, patch, mergeKey);
  // For primitives upstream passes the original slice, which the deduplication may have written.
  return normalizeElementOrder(patchItems, serverOnlyItems, patch, kind === 'map' ? elements(original) : originalIn, mergeKey, kind);
}

/** mergeSliceWithSpecialElements: applies `$patch` items; [original, patch without them]. */
function mergeSliceWithSpecialElements(originalIn: GoSlice, patch: Json[], mergeKey: string): [GoSlice, Json[]] {
  let original = originalIn;
  const patchWithoutSpecialElements: Json[] = [];
  let replace = false;
  for (const v of patch) {
    const typedV = v as JMap;
    if (!hasOwn(typedV, directiveMarker)) {
      patchWithoutSpecialElements.push(v);
      continue;
    }
    const patchType = typedV[directiveMarker] as Json;
    if (patchType === deleteDirective) {
      if (!hasOwn(typedV, mergeKey)) throw errNoMergeKey(typedV, mergeKey);
      original = deleteMatchingEntries(original, mergeKey, typedV[mergeKey] as Json);
    } else if (patchType === replaceDirective) {
      // Go on, to prune the other `$patch` items.
      replace = true;
    } else if (patchType === mergeDirective) {
      throw new PatchError('merging lists cannot yet be specified in the patch');
    } else throw errBadPatchType(patchType, typedV);
  }
  if (replace) return [newSlice(patchWithoutSpecialElements), []];
  return [original, patchWithoutSpecialElements];
}

/** deleteMatchingEntries: `append(original[:i], original[i+1:]...)`, in the same backing array. */
function deleteMatchingEntries(originalIn: GoSlice, mergeKey: string, mergeValue: Json): GoSlice {
  let original = originalIn;
  for (;;) {
    const [, i, found] = findMapInSliceBasedOnKeyValue(elements(original), mergeKey, mergeValue);
    if (!found) return original;
    for (let k = i + 1; k < original.len; k++) setElement(original, k - 1, elementAt(original, k));
    original = { back: original.back, len: original.len - 1 };
  }
}

function mergeSliceWithoutSpecialElements(originalIn: GoSlice, patch: Json[], mergeKey: string, schema: LookupPatchMeta, o: MergeOptions): GoSlice {
  let original = originalIn;
  for (const v of patch) {
    const typedV = v as JMap;
    if (!hasOwn(typedV, mergeKey)) throw errNoMergeKey(typedV, mergeKey);
    const [originalMap, i, found] = findMapInSliceBasedOnKeyValue(elements(original), mergeKey, typedV[mergeKey] as Json);
    if (found) setElement(original, i, mergeMap(originalMap, typedV, schema, o));
    else original = appendSlice(original, [v]);
  }
  return original;
}

// ---- Go slices ----
//
// Where upstream appends to or deletes from a list it decoded, the change happens in the list's
// backing array when its capacity allows, and the decoded list (a slice header of its own length
// over that array) sees the writes below its length. mergePatchIntoOriginal then orders the merged
// list by that decoded list, so the order of server-only items after a `$patch: delete` depends
// on it (patch_test.go "add map and delete map from merging list"). The capacity of a list is
// what produced it: encoding/json's decoder appends one by one from an empty slice (capacity the
// next power of two of the length); the API server's lists come from deep copies of the cached
// object (generated DeepCopyInto: make([]T, len)), so their capacity is their length.

interface GoBacking {
  cells: Json[];
  cap: number;
  /** The decoded list that shares this backing array. */
  doc?: Json[];
}

interface GoSlice {
  back: GoBacking;
  len: number;
}

/** encoding/json's arrayInterface: append from make([]any, 0), so growslice's doubling. */
function decodedCapacity(n: number): number {
  let c = 0;
  while (c < n) c = c === 0 ? 1 : c < 256 ? c * 2 : c + ((c + 3 * 256) >> 2);
  return c;
}

function sliceOf(doc: Json[], o: MergeOptions): GoSlice {
  return { back: { cells: doc.slice(), cap: o.exactCapacity ? doc.length : decodedCapacity(doc.length), doc }, len: doc.length };
}

const newSlice = (items: Json[]): GoSlice => ({ back: { cells: items.slice(), cap: items.length }, len: items.length });
const elements = (s: GoSlice): Json[] => s.back.cells.slice(0, s.len);
const elementAt = (s: GoSlice, i: number): Json => s.back.cells[i] as Json;

function setElement(s: GoSlice, i: number, v: Json): void {
  s.back.cells[i] = v;
  const doc = s.back.doc;
  if (doc && i < doc.length) doc[i] = v;
}

/** append(s, items...): in place when it fits, else a new backing array (growslice). */
function appendSlice(s: GoSlice, items: Json[]): GoSlice {
  const n = s.len + items.length;
  if (n <= s.back.cap) {
    items.forEach((v, k) => setElement(s, s.len + k, v));
    return { back: s.back, len: n };
  }
  // growslice: double while small, then grow by a quarter (plus 192); at least the needed length.
  let cap = s.back.cap;
  const doubled = cap * 2;
  if (n > doubled) cap = n;
  else if (cap < 256) cap = doubled;
  else while (cap < n) cap += (cap + 3 * 256) >> 2;
  return { back: { cells: elements(s).concat(items), cap }, len: n };
}

/** deduplicateScalars on a slice: writes go to its backing array. */
function deduplicateSlice(s: GoSlice): Json[] {
  let length = s.len - 1;
  for (let i = 0; i < length; i++) {
    for (let j = i + 1; j <= length; j++) {
      if (goEqual(elementAt(s, i), elementAt(s, j))) {
        setElement(s, j, elementAt(s, length));
        length--;
        j--;
      }
    }
  }
  return s.back.cells.slice(0, length + 1);
}

function deleteFromSlice(current: Json[], toDelete: Json[]): Json[] {
  return current.filter((v) => !toDelete.some((d) => goEqual(d, v)));
}

function findMapInSliceBasedOnKeyValue(m: Json[], key: string, value: Json): [JMap | null, number, boolean] {
  for (let k = 0; k < m.length; k++) {
    const v = m[k] as Json;
    if (!isMap(v)) throw new PatchError(`value for key ${k} is not a map`);
    if (hasOwn(v, key) && goEqual(v[key], value)) return [v, k, true];
  }
  return [null, 0, false];
}

// ---- sorting (sortMergeListsByName is used by tests and by diffListsOfMaps) ----

/** sortMergeListsByNameMap: merge lists sorted by merge key, recursively. */
export function sortMergeListsByNameMap(s: JMap, schema: LookupPatchMeta): JMap {
  const newS: JMap = {};
  for (const k of Object.keys(s)) {
    let v = s[k] as Json;
    if (k === retainKeysDirective) {
      if (!Array.isArray(v)) throw errBadPatchFormatForRetainKeys();
      v = sortScalars(v);
    } else if (k.startsWith(deleteFromPrimitiveListDirectivePrefix)) {
      if (!Array.isArray(v)) throw errBadPatchFormatForPrimitiveList();
      v = sortScalars(v);
    } else if (k.startsWith(setElementOrderDirectivePrefix)) {
      if (!Array.isArray(v)) throw errBadPatchFormatForSetElementOrderList();
    } else if (k !== directiveMarker) {
      if (isMap(v)) {
        const [subschema] = schema.lookupPatchMetadataForStruct(k);
        v = sortMergeListsByNameMap(v, subschema);
      } else if (Array.isArray(v)) {
        const [subschema, patchMeta] = schema.lookupPatchMetadataForSlice(k);
        const [, patchStrategy] = extractRetainKeysPatchStrategy(patchMeta.patchStrategies);
        if (patchStrategy === mergeDirective) v = sortMergeListsByNameArray(v, subschema, patchMeta.patchMergeKey, true);
      }
    }
    newS[k] = v;
  }
  return newS;
}

function sortMergeListsByNameArray(s: Json[], schema: LookupPatchMeta, mergeKey: string, recurse: boolean): Json[] {
  if (s.length === 0) return s;
  const kind = sliceElementType(s);
  if (kind !== 'map') return deduplicateAndSortScalars(s);
  const newS = s.map((elem) => (recurse ? sortMergeListsByNameMap(elem as JMap, schema) : elem));
  return sortMapsBasedOnField(newS, mergeKey);
}

function sortMapsBasedOnField(m: Json[], fieldName: string): Json[] {
  const out = m.slice();
  goSortByText(out, (v) => goSprint(isMap(v) ? valueOrNil(v, fieldName) : null));
  return out;
}

/** deduplicateAndSortScalars: dedupes and sorts `s` in place; returns the shortened list. */
function deduplicateAndSortScalars(s: Json[]): Json[] {
  const d = deduplicateScalars(s);
  const sorted = sortScalars(d);
  // Go sorted the prefix of the same backing array.
  for (let i = 0; i < sorted.length; i++) s[i] = sorted[i] as Json;
  return sorted;
}

/** sortScalars: sorted in place by %v text. */
function sortScalars(s: Json[]): Json[] {
  goSortByText(s, goSprint);
  return s;
}

/**
 * sort.Sort with upstream's Less, `sort.StringsAreSorted([]string{a, b})` of the %v texts: true
 * for equal texts too. Up to 12 items Go's pdqsort is an insertion sort, which with that Less
 * moves a later item before an equal earlier one; that order is kept (items with equal merge
 * keys, like a container's 53/TCP and 53/UDP ports). Longer lists are sorted stably: their
 * order of equal items can differ from Go's pdqsort, which is not ported.
 * upstream: Go src/sort/zsortinterface.go pdqsort (maxInsertion = 12), insertionSort.
 */
function goSortByText(s: Json[], text: (v: Json) => string): void {
  if (s.length > 12) {
    const keyed = s.map((v) => ({ v, t: text(v) }));
    keyed.sort((a, b) => compareGoStrings(a.t, b.t));
    keyed.forEach((x, i) => (s[i] = x.v));
    return;
  }
  const lessOrEqual = (i: number, j: number): boolean => compareGoStrings(text(s[i] as Json), text(s[j] as Json)) <= 0;
  for (let i = 1; i < s.length; i++) {
    for (let j = i; j > 0 && lessOrEqual(j, j - 1); j--) {
      const t = s[j] as Json;
      s[j] = s[j - 1] as Json;
      s[j - 1] = t;
    }
  }
}

/**
 * deduplicateScalars: upstream's in-place algorithm (a duplicate is overwritten by the last
 * element), which decides the order of what remains. `s` is modified like Go's backing array;
 * the result is the shortened slice.
 */
function deduplicateScalars(s: Json[]): Json[] {
  let length = s.length - 1;
  for (let i = 0; i < length; i++) {
    for (let j = i + 1; j <= length; j++) {
      if (goEqual(s[i], s[j])) {
        s[j] = s[length] as Json;
        length--;
        j--;
      }
    }
  }
  return s.slice(0, length + 1);
}

/** sliceElementType: the kind of the elements of the lists, which must all be the same type. */
function sliceElementType(...slices: Json[][]): Kind {
  let prev: Kind | null | undefined;
  for (const s of slices) {
    for (const v of s) {
      const cur = goType(v);
      if (prev === undefined) {
        // reflect.TypeOf(nil).Kind() dereferences a nil interface.
        if (cur === null) throw errNilDereference();
        prev = cur;
        if (prev === 'slice') throw errNoListOfLists();
      } else if (prev !== cur) {
        throw new PatchError(`list element types are not identical: ${goSprint(slices)}`);
      }
    }
  }
  if (prev === undefined || prev === null) throw new PatchError('no elements in any of the given slices');
  return prev;
}

// ---- conflicts ----

/** MergingMapsHaveConflicts: left and right change a key differently. */
export function mergingMapsHaveConflicts(left: JMap, right: JMap, schema: LookupPatchMeta): boolean {
  return mergingMapFieldsHaveConflicts(left, right, schema, '', '');
}

function mergingMapFieldsHaveConflicts(left: Json, right: Json, schema: LookupPatchMeta | undefined, fieldPatchStrategy: string, fieldPatchMergeKey: string): boolean {
  if (isMap(left)) {
    if (!isMap(right)) return true;
    const okLeft = hasOwn(left, directiveMarker);
    const okRight = hasOwn(right, directiveMarker);
    if (okLeft || okRight) {
      if (okLeft !== okRight) return true;
      if (!goEqual(left[directiveMarker], right[directiveMarker])) return true;
    }
    if (fieldPatchStrategy === replaceDirective) return false;
    return mapsHaveConflicts(left, right, schema as LookupPatchMeta);
  }
  if (Array.isArray(left)) {
    if (!Array.isArray(right)) return true;
    return slicesHaveConflicts(left, right, schema as LookupPatchMeta, fieldPatchStrategy, fieldPatchMergeKey);
  }
  return !deepEqual(left, right);
}

function mapsHaveConflicts(typedLeft: JMap, typedRight: JMap, schema: LookupPatchMeta): boolean {
  for (const key of Object.keys(typedLeft)) {
    if (key === directiveMarker || key === retainKeysDirective || !hasOwn(typedRight, key)) continue;
    const leftValue = typedLeft[key] as Json;
    let subschema: LookupPatchMeta | undefined;
    let patchMeta: PatchMeta = { patchStrategies: [], patchMergeKey: '' };
    let patchStrategy = '';
    if (Array.isArray(leftValue)) {
      [subschema, patchMeta] = schema.lookupPatchMetadataForSlice(key);
      [, patchStrategy] = extractRetainKeysPatchStrategy(patchMeta.patchStrategies);
    } else if (isMap(leftValue)) {
      [subschema, patchMeta] = schema.lookupPatchMetadataForStruct(key);
      [, patchStrategy] = extractRetainKeysPatchStrategy(patchMeta.patchStrategies);
    }
    if (mergingMapFieldsHaveConflicts(leftValue, typedRight[key] as Json, subschema, patchStrategy, patchMeta.patchMergeKey)) return true;
  }
  return false;
}

function slicesHaveConflicts(typedLeftIn: Json[], typedRightIn: Json[], schema: LookupPatchMeta, fieldPatchStrategy: string, fieldPatchMergeKey: string): boolean {
  let typedLeft = typedLeftIn;
  let typedRight = typedRightIn;
  const kind = sliceElementType(typedLeft, typedRight);
  if (fieldPatchStrategy === mergeDirective) {
    // Merging lists of scalars have no conflicts by definition.
    if (kind !== 'map') return false;
    const leftMap = sliceOfMapsToMapOfMaps(typedLeft, fieldPatchMergeKey);
    const rightMap = sliceOfMapsToMapOfMaps(typedRight, fieldPatchMergeKey);
    return mapsOfMapsHaveConflicts(leftMap, rightMap, schema);
  }
  if (typedLeft.length !== typedRight.length) return true;
  if (kind !== 'map') {
    typedLeft = deduplicateAndSortScalars(typedLeft);
    typedRight = deduplicateAndSortScalars(typedRight);
  }
  for (let i = 0; i < typedLeft.length; i++) {
    if (mergingMapFieldsHaveConflicts(typedLeft[i] as Json, typedRight[i] as Json, schema, '', '')) return true;
  }
  return false;
}

function sliceOfMapsToMapOfMaps(slice: Json[], mergeKey: string): JMap {
  const result: JMap = {};
  for (const value of slice) {
    if (!isMap(value)) throw new PatchError(`invalid element type in merging list:${goSprint(slice)}`);
    if (!hasOwn(value, mergeKey)) throw new PatchError(`cannot find merge key \`${mergeKey}\` in merging list element:${goSprint(value)}`);
    result[goSprintS(value[mergeKey] as Json)] = value;
  }
  return result;
}

function mapsOfMapsHaveConflicts(typedLeft: JMap, typedRight: JMap, schema: LookupPatchMeta): boolean {
  for (const key of Object.keys(typedLeft)) {
    if (hasOwn(typedRight, key) && mergingMapFieldsHaveConflicts(typedLeft[key] as Json, typedRight[key] as Json, schema, '', '')) return true;
  }
  return false;
}

// ---- two-way and three-way patches ----

/** CreateTwoWayMergeMapPatchUsingLookupPatchMeta. */
export function createTwoWayMergeMapPatch(original: JMap, modified: JMap, schema: LookupPatchMeta): JMap {
  return diffMaps(original, modified, schema, { setElementOrder: true });
}

/**
 * CreateThreeWayMergePatch on decoded documents: the difference from current to modified without
 * deletions, plus the deletions from original to modified. Mutates its inputs.
 */
export function createThreeWayMergeMapPatch(originalMap: JMap, modifiedMap: JMap, currentMap: JMap, schema: LookupPatchMeta, overwrite: boolean): JMap {
  const deltaMap = diffMaps(currentMap, modifiedMap, schema, { ignoreDeletions: true, setElementOrder: true });
  const deletionsMap = diffMaps(originalMap, modifiedMap, schema, { setElementOrder: true, ignoreChangesAndAdditions: true });
  const patchMap = mergeMap(deletionsMap, deltaMap, schema, {});
  if (!overwrite) {
    const changedMap = diffMaps(originalMap, currentMap, schema, {});
    if (mergingMapsHaveConflicts(patchMap, changedMap, schema)) throw errConflict(toYamlOrError(patchMap), toYamlOrError(changedMap));
  }
  return patchMap;
}

/** mergepatch.ToYAMLOrError (sigs.k8s.io/yaml Marshal). */
function toYamlOrError(v: JMap): string {
  try {
    return marshalYaml(v);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

const createDeleteDirective = (mergeKey: string, mergeKeyValue: Json): JMap => ({ [mergeKey]: mergeKeyValue, [directiveMarker]: deleteDirective });

/** extractRetainKeysPatchStrategy: [has retainKeys, the other strategy]. */
function extractRetainKeysPatchStrategy(strategies: string[]): [boolean, string] {
  switch (strategies.length) {
    case 0:
      return [false, ''];
    case 1:
      return strategies[0] === retainKeysStrategy ? [true, ''] : [false, strategies[0] as string];
    case 2:
      if (strategies[0] === retainKeysStrategy) return [true, strategies[1] as string];
      if (strategies[1] === retainKeysStrategy) return [true, strategies[0] as string];
      throw new PatchError(`unexpected patch strategy: [${strategies.join(' ')}]`);
    default:
      throw new PatchError(`unexpected patch strategy: [${strategies.join(' ')}]`);
  }
}

/** hasAdditionalNewField: original has a non-nil key modified lacks. */
function hasAdditionalNewField(original: JMap, modified: JMap): boolean {
  for (const k of Object.keys(original)) {
    if (original[k] === null) continue;
    if (!hasOwn(modified, k)) return true;
  }
  return false;
}

// ---- Go's sort.SliceStable (upstream: Go src/sort/zsortfunc.go stable_func) ----

function sliceStable(data: Json[], less: (i: number, j: number) => boolean): void {
  const swap = (i: number, j: number): void => {
    const t = data[i] as Json;
    data[i] = data[j] as Json;
    data[j] = t;
  };
  const insertionSort = (a: number, b: number): void => {
    for (let i = a + 1; i < b; i++) for (let j = i; j > a && less(j, j - 1); j--) swap(j, j - 1);
  };
  const swapRange = (a: number, b: number, n: number): void => {
    for (let i = 0; i < n; i++) swap(a + i, b + i);
  };
  const rotate = (a: number, m: number, b: number): void => {
    let i = m - a;
    let j = b - m;
    while (i !== j) {
      if (i > j) {
        swapRange(m - i, m, j);
        i -= j;
      } else {
        swapRange(m - i, m + j - i, i);
        j -= i;
      }
    }
    swapRange(m - i, m, i);
  };
  const symMerge = (a: number, m: number, b: number): void => {
    if (m - a === 1) {
      let i = m;
      let j = b;
      while (i < j) {
        const h = (i + j) >>> 1;
        if (less(h, a)) i = h + 1;
        else j = h;
      }
      for (let k = a; k < i - 1; k++) swap(k, k + 1);
      return;
    }
    if (b - m === 1) {
      let i = a;
      let j = m;
      while (i < j) {
        const h = (i + j) >>> 1;
        if (!less(m, h)) i = h + 1;
        else j = h;
      }
      for (let k = m; k > i; k--) swap(k, k - 1);
      return;
    }
    const mid = (a + b) >>> 1;
    const n = mid + m;
    let start: number;
    let r: number;
    if (m > mid) {
      start = n - b;
      r = mid;
    } else {
      start = a;
      r = m;
    }
    const p = n - 1;
    while (start < r) {
      const c = (start + r) >>> 1;
      if (!less(p - c, c)) start = c + 1;
      else r = c;
    }
    const end = n - start;
    if (start < m && m < end) rotate(start, m, end);
    if (a < start && start < mid) symMerge(a, start, mid);
    if (mid < end && end < b) symMerge(mid, end, b);
  };
  const n = data.length;
  let blockSize = 20;
  let a = 0;
  let b = blockSize;
  while (b <= n) {
    insertionSort(a, b);
    a = b;
    b += blockSize;
  }
  insertionSort(a, n);
  while (blockSize < n) {
    a = 0;
    b = 2 * blockSize;
    while (b <= n) {
      symMerge(a, a + blockSize, b);
      a = b;
      b += 2 * blockSize;
    }
    const m = a + blockSize;
    if (m < n) symMerge(a, m, n);
    blockSize *= 2;
  }
}

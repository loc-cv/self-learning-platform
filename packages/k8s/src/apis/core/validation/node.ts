// Node validation.
// upstream: pkg/apis/core/validation/validation.go ValidateNode, ValidateNodeUpdate,
// ValidateNodeName (NameIsDNSSubdomain), ValidateNodeSpecificAnnotations, validateNodeTaints,
// validateTaintEffect, ValidateNodeResources, ValidateResourceQuantityValue,
// validateNodeSwapStatus, validateNodeDeclaredFeatures, validateNodeConfigSourceSpec. Taint
// errors are reported under `metadata.taints`, as upstream does (ValidateNode passes the
// metadata path): checked against the v1.37.2 oracle, e.g. `metadata.taints[2].effect:
// Unsupported value: "Bad": supported values: "NoSchedule", "PreferNoSchedule", "NoExecute"`.
// Go iterates the capacity and allocatable maps in random order; this port goes in key order
// (D-040).

import { duplicate, forbidden, goQuote, internalError, invalid, newPath, notSupported, required, type FieldError, type Path } from '../../../apimachinery/field.ts';
import { goJson, isObject, jsonEqual, type Json, type JsonObject } from '../../../apimachinery/json.ts';
import { isDualStackCIDRStrings } from '../../../apimachinery/net.ts';
import { milliValue, parseQuantity, sign } from '../../../apimachinery/quantity.ts';
import { isValidCIDRForLegacyField } from '../../../apimachinery/validation/ip.ts';
import { isValidLabelValue, nameIsDNSSubdomain } from '../../../apimachinery/validation/names.ts';
import { validateLabelName } from '../../../apimachinery/validation/objectmeta.ts';
import { validateObjectMeta, validateObjectMetaUpdate } from './objectmeta.ts';
import { isExtendedResourceName } from './resources.ts';

export const TAINTS_ANNOTATION_KEY = 'scheduler.alpha.kubernetes.io/taints';
export const PREFER_AVOID_PODS_ANNOTATION_KEY = 'scheduler.alpha.kubernetes.io/preferAvoidPods';
export const TAINT_EFFECTS = ['NoSchedule', 'PreferNoSchedule', 'NoExecute'] as const;

/** helper.integerResources. */
const INTEGER_RESOURCES = ['pods', 'resourcequotas', 'services', 'replicationcontrollers', 'secrets', 'configmaps', 'persistentvolumeclaims', 'services.nodeports', 'services.loadbalancers'];
const DECLARED_FEATURE = /^[A-Z][a-zA-Z0-9]*(\/[a-zA-Z][a-zA-Z0-9]*)*$/;
const DNS1123_SUBDOMAIN_MAX_LENGTH = 253;

const str = (v: Json | undefined): string => (typeof v === 'string' ? v : '');
const obj = (v: Json | undefined): JsonObject => (isObject(v) ? v : {});
const arr = (v: Json | undefined): Json[] => (Array.isArray(v) ? v : []);
const strs = (v: Json | undefined): string[] => arr(v).map(str);
const sortedKeys = (o: JsonObject): string[] => Object.keys(o).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** Reports a request that uses a part of validation that is not ported. */
export type NotPorted = (what: string) => void;

/** validateTaintEffect. */
export function validateTaintEffect(effect: string, allowEmpty: boolean, path: Path): FieldError[] {
  if (!allowEmpty && effect === '') return [required(path, '')];
  if ((TAINT_EFFECTS as readonly string[]).includes(effect)) return [];
  return [notSupported(path, effect, TAINT_EFFECTS)];
}

/** core.Taint as json.Marshal prints the internal struct (no json tags). */
function goTaint(t: JsonObject): string {
  return goJson({ Key: str(t.key), Value: str(t.value), Effect: str(t.effect), TimeAdded: typeof t.timeAdded === 'string' ? t.timeAdded : null });
}

/** validateNodeTaints. */
function validateNodeTaints(taints: Json[], path: Path): FieldError[] {
  const errs: FieldError[] = [];
  const unique = new Map<string, Set<string>>();
  taints.forEach((t0, i) => {
    const t = obj(t0);
    const idx = path.index(i);
    const key = str(t.key);
    const effect = str(t.effect);
    errs.push(...validateLabelName(key, idx.child('key')));
    const valueErrs = isValidLabelValue(str(t.value));
    if (valueErrs.length > 0) errs.push(invalid(idx.child('value'), str(t.value), valueErrs.join(';')));
    errs.push(...validateTaintEffect(effect, false, idx.child('effect')));
    const seen = unique.get(effect);
    if (seen?.has(key)) {
      errs.push({ ...duplicate(idx, { go: goTaint(t) }), detail: 'taints must be unique by key and effect pair' });
      return;
    }
    if (seen) seen.add(key);
    else unique.set(effect, new Set([key]));
  });
  return errs;
}

/** ValidateNodeSpecificAnnotations: the JSON-encoded taint and avoid-pods annotations. */
function validateNodeSpecificAnnotations(annotations: JsonObject, notPorted: NotPorted): FieldError[] {
  if (str(annotations[TAINTS_ANNOTATION_KEY]) !== '') notPorted(`validation of the ${TAINTS_ANNOTATION_KEY} Node annotation`);
  if (str(annotations[PREFER_AVOID_PODS_ANNOTATION_KEY]) !== '') notPorted(`validation of the ${PREFER_AVOID_PODS_ANNOTATION_KEY} Node annotation`);
  return [];
}

/** ValidateResourceQuantityValue (ValidateNonnegativeQuantity prints value.String()). */
function validateResourceQuantityValue(name: string, value: string, path: Path): FieldError[] {
  const q = parseQuantity(value);
  if ('error' in q) return [];
  const errs: FieldError[] = [];
  if (sign(q) < 0) errs.push(invalid(path, value, 'must be greater than or equal to 0'));
  if ((INTEGER_RESOURCES.includes(name) || isExtendedResourceName(name)) && milliValue(q) % 1000 !== 0) errs.push(invalid(path, value, 'must be an integer'));
  return errs;
}

/** ValidateNodeResources. */
function validateNodeResources(node: JsonObject): FieldError[] {
  const status = obj(node.status);
  const errs: FieldError[] = [];
  for (const list of ['capacity', 'allocatable']) {
    const l = obj(status[list]);
    for (const k of sortedKeys(l)) errs.push(...validateResourceQuantityValue(k, str(l[k]), newPath('status', list, k)));
  }
  return errs;
}

/** validateNodeSwapStatus (reported under metadata.nodeSwapStatus, as upstream does). */
function validateNodeSwapStatus(swap: Json | undefined, path: Path): FieldError[] {
  if (!isObject(swap)) return [];
  const capacity = swap.capacity;
  if (typeof capacity === 'number' && capacity <= 0) return [invalid(path.child('capacity'), capacity, 'must be greater than zero')];
  return [];
}

/** validateNodeDeclaredFeatures (the NodeDeclaredFeatures gate is on in v1.37.2). */
function validateNodeDeclaredFeatures(features: string[], path: Path): FieldError[] {
  const errs: FieldError[] = [];
  features.forEach((f, i) => {
    if (f.length > DNS1123_SUBDOMAIN_MAX_LENGTH) {
      errs.push(invalid(path.index(i), f, `invalid feature name ${goQuote(f)}: must be no more than ${DNS1123_SUBDOMAIN_MAX_LENGTH} characters`));
    } else if (!DECLARED_FEATURE.test(f)) {
      errs.push(
        invalid(
          path.index(i),
          f,
          `invalid feature name ${goQuote(f)}: must start with an UpperCamelCase segment, with subsequent segments separated by '/' (e.g., MyFeature or MyFeature/mySubFeature), and contain only alphanumeric characters and slashes`,
        ),
      );
    }
    const next = features[i + 1];
    if (next !== undefined) {
      if (f === next) errs.push(duplicate(path.index(i + 1), next));
      else if (f > next) errs.push(invalid(path.index(i + 1), next, 'list must be sorted alphabetically'));
    }
  });
  return errs;
}

export function validateNode(node: JsonObject, notPorted: NotPorted): FieldError[] {
  const metaPath = newPath('metadata');
  const meta = obj(node.metadata);
  const spec = obj(node.spec);
  const status = obj(node.status);
  const errs = validateObjectMeta(meta, false, nameIsDNSSubdomain, metaPath);
  errs.push(...validateNodeSpecificAnnotations(obj(meta.annotations), notPorted));
  const taints = arr(spec.taints);
  if (taints.length > 0) errs.push(...validateNodeTaints(taints, metaPath.child('taints')));
  errs.push(...validateNodeResources(node));
  errs.push(...validateNodeSwapStatus(obj(status.nodeInfo).swap, metaPath.child('nodeSwapStatus')));
  errs.push(...validateNodeDeclaredFeatures(strs(status.declaredFeatures), newPath('status', 'declaredFeatures')));
  const podCIDRs = strs(spec.podCIDRs);
  if (podCIDRs.length > 0) {
    const path = newPath('spec', 'podCIDRs');
    podCIDRs.forEach((c, i) => errs.push(...isValidCIDRForLegacyField(path.index(i), c)));
    if (podCIDRs.length > 1) {
      const r = isDualStackCIDRStrings(podCIDRs);
      if ('error' in r) errs.push(internalError(path, `invalid PodCIDRs. failed to check with dual stack with error:${r.error}`));
      const dualStack = 'dualStack' in r && r.dualStack;
      if (!dualStack || podCIDRs.length > 2) errs.push(invalid(path, podCIDRs, 'may specify no more than one CIDR for each IP family'));
    }
  }
  return errs;
}

const PODCIDR_CHANGE = 'node updates may not change podCIDR except from "" to valid';

export function validateNodeUpdate(node: JsonObject, old: JsonObject, notPorted: NotPorted): FieldError[] {
  const metaPath = newPath('metadata');
  const meta = obj(node.metadata);
  const spec = obj(node.spec);
  const oldSpec = obj(old.spec);
  const status = obj(node.status);
  const errs = validateObjectMetaUpdate(meta, obj(old.metadata), metaPath);
  errs.push(...validateNodeSpecificAnnotations(obj(meta.annotations), notPorted));
  errs.push(...validateNodeResources(node));
  errs.push(...validateNodeDeclaredFeatures(strs(status.declaredFeatures), newPath('status', 'declaredFeatures')));
  // No duplicate addresses: a NodeAddress is compared as a whole.
  const seen: Json[] = [];
  arr(status.addresses).forEach((a, i) => {
    if (seen.some((s) => jsonEqual(s, a))) errs.push(duplicate(newPath('status', 'addresses').index(i), { go: goJson({ Type: str(obj(a).type), Address: str(obj(a).address) }) }));
    seen.push(a);
  });
  // The controller manager may assign a CIDR to a node that has none.
  const oldCIDRs = strs(oldSpec.podCIDRs);
  const newCIDRs = strs(spec.podCIDRs);
  if (oldCIDRs.length > 0) {
    if (oldCIDRs.length !== newCIDRs.length) errs.push(forbidden(newPath('spec', 'podCIDRs'), PODCIDR_CHANGE));
    else oldCIDRs.forEach((c, i) => c !== newCIDRs[i] && errs.push(forbidden(newPath('spec', 'podCIDRs'), PODCIDR_CHANGE)));
  }
  // The controller manager may set the provider ID when it is unset.
  const oldProvider = str(oldSpec.providerID);
  const newProvider = str(spec.providerID);
  if (oldProvider !== '' && newProvider !== '' && oldProvider !== newProvider) errs.push(invalid(newPath('spec', 'providerID'), null, 'field cannot be modified once set'));
  if (oldProvider !== '' && newProvider === '') errs.push(invalid(newPath('spec', 'providerID'), null, 'field cannot be cleared once set'));
  // spec.configSource is dropped unless the old Node has one, which no Node created through this API can have.
  if (isObject(spec.configSource)) notPorted('validation of Node spec.configSource');
  if (isObject(status.config)) notPorted('validation of Node status.config');
  const taints = arr(spec.taints);
  if (taints.length > 0) errs.push(...validateNodeTaints(taints, metaPath.child('taints')));
  if (str(spec.externalID) !== str(oldSpec.externalID)) errs.push(forbidden(newPath('spec', 'externalID'), 'may not be updated'));
  return errs;
}

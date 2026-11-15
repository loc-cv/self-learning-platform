// Resource requirements of containers and pods.
// upstream: pkg/apis/core/validation/validation.go validateResourceRequirements,
// ValidateContainerResourceRequirements, validateResourceName, ValidateContainerResourceName,
// ValidateResourceQuantityValue, ValidateNonnegativeQuantity, validateResourceQuantityHugePageValue,
// validateResourceClaimNames; pkg/apis/core/helper/helpers.go IsStandardResourceName,
// IsStandardContainerResourceName, IsNativeResource, IsExtendedResourceName, IsHugePageResourceName,
// IsOvercommitAllowed, IsIntegerResourceName, IsHugePageResourceValueDivisible.
//
// Go iterates the limits and requests maps in random order; this port goes in key order (D-040).

import { duplicate, forbidden, invalid, notFound, required, type FieldError, type Path } from '../../../apimachinery/field.ts';
import type { Json, JsonObject } from '../../../apimachinery/json.ts';
import { compareQuantities, milliValue, parseQuantity, quantityString, scaledValue, sign, type Quantity } from '../../../apimachinery/quantity.ts';
import { isQualifiedName } from '../../../apimachinery/validation/names.ts';
import { objs, sortedKeys, sortStrings, str, strMap, validateDNS1123Label } from './util.ts';

const STANDARD_RESOURCES = [
  'cpu', 'memory', 'ephemeral-storage', 'requests.cpu', 'requests.memory', 'requests.ephemeral-storage', 'limits.cpu', 'limits.memory',
  'limits.ephemeral-storage', 'pods', 'resourcequotas', 'services', 'replicationcontrollers', 'secrets', 'configmaps', 'persistentvolumeclaims',
  'storage', 'requests.storage', 'services.nodeports', 'services.loadbalancers',
];
const INTEGER_RESOURCES = ['pods', 'resourcequotas', 'services', 'replicationcontrollers', 'secrets', 'configmaps', 'persistentvolumeclaims', 'services.nodeports', 'services.loadbalancers'];
const STANDARD_CONTAINER_RESOURCES = ['cpu', 'memory', 'ephemeral-storage'];

export const isHugePageResourceName = (name: string): boolean => name.startsWith('hugepages-');
const isQuotaHugePageResourceName = (name: string): boolean => name.startsWith('hugepages-') || name.startsWith('requests.hugepages-');
const isStandardResourceName = (name: string): boolean => STANDARD_RESOURCES.includes(name) || isQuotaHugePageResourceName(name);
const isStandardContainerResourceName = (name: string): boolean => STANDARD_CONTAINER_RESOURCES.includes(name) || isHugePageResourceName(name);
export const isNativeResource = (name: string): boolean => !name.includes('/') || name.includes('kubernetes.io/');
export function isExtendedResourceName(name: string): boolean {
  if (isNativeResource(name) || name.startsWith('requests.')) return false;
  return isQualifiedName(`requests.${name}`).length === 0;
}
export const isOvercommitAllowed = (name: string): boolean => isNativeResource(name) && !isHugePageResourceName(name);
const isIntegerResourceName = (name: string): boolean => INTEGER_RESOURCES.includes(name) || isExtendedResourceName(name);

/** validateResourceName. */
function validateResourceName(value: string, path: Path): FieldError[] {
  const errs = isQualifiedName(value).map((m) => invalid(path, value, m));
  if (errs.length > 0) return errs;
  if (!value.includes('/') && !isStandardResourceName(value)) return [invalid(path, value, 'must be a standard resource type or fully qualified')];
  return [];
}

/** ValidateContainerResourceName. */
export function validateContainerResourceName(value: string, path: Path): FieldError[] {
  const errs = validateResourceName(value, path);
  if (!value.includes('/')) {
    if (!isStandardContainerResourceName(value)) return [...errs, invalid(path, value, 'must be a standard resource for containers')];
  } else if (!isNativeResource(value)) {
    if (!isExtendedResourceName(value)) return [...errs, invalid(path, value, "doesn't follow extended resource name standard")];
  }
  return errs;
}

function q(v: Json | undefined): Quantity | undefined {
  if (typeof v !== 'string') return undefined;
  const r = parseQuantity(v);
  return 'error' in r ? undefined : r;
}

/** ValidateResourceQuantityValue. The value printed for "must be an integer" is the Quantity (JSON string). */
function validateResourceQuantityValue(name: string, value: string, path: Path): FieldError[] {
  const quantity = q(value);
  if (!quantity) return [];
  const errs: FieldError[] = [];
  if (sign(quantity) < 0) errs.push(invalid(path, value, 'must be greater than or equal to 0'));
  if (isIntegerResourceName(name) && milliValue(quantity) % 1000 !== 0) errs.push(invalid(path, value, 'must be an integer'));
  return errs;
}

/** HugePageSizeFromResourceName and IsHugePageResourceValueDivisible. */
function hugePageValueError(name: string, value: string): string | undefined {
  const quantity = q(value);
  if (!quantity) return undefined;
  const page = q(name.slice('hugepages-'.length));
  let divisible = false;
  if (page && sign(page) > 0 && milliValue(page) % 1000 === 0) {
    const pv = scaledValue(page, 0);
    divisible = pv !== 0n && scaledValue(quantity, 0) % pv === 0n;
  }
  return divisible ? undefined : `${quantityString(quantity)} is not positive integer multiple of ${name}`;
}

type NameFn = (name: string, path: Path) => FieldError[];

/** validateResourceRequirements on a ResourceRequirements JSON object. */
export function validateResourceRequirements(req: JsonObject | undefined, nameFn: NameFn, podClaimNames: ReadonlySet<string>, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  const limPath = path.child('limits');
  const reqPath = path.child('requests');
  const limits = strMap(req?.limits);
  const requests = strMap(req?.requests);
  let limCpuMem = false;
  let reqCpuMem = false;
  let limHuge = false;
  let reqHuge = false;
  for (const name of sortedKeys(limits)) {
    const p = limPath.key(name);
    const value = limits[name] as string;
    errs.push(...nameFn(name, p));
    errs.push(...validateResourceQuantityValue(name, value, p));
    if (isHugePageResourceName(name)) {
      limHuge = true;
      const e = hugePageValueError(name, value);
      if (e) errs.push(invalid(p, value, e));
    }
    if (name === 'cpu' || name === 'memory') limCpuMem = true;
  }
  for (const name of sortedKeys(requests)) {
    const p = reqPath.key(name);
    const value = requests[name] as string;
    errs.push(...nameFn(name, p));
    errs.push(...validateResourceQuantityValue(name, value, p));
    const limit = limits[name];
    if (limit !== undefined) {
      const rq = q(value);
      const lq = q(limit);
      if (rq && lq) {
        const cmp = compareQuantities(rq, lq);
        if (cmp !== 0 && !isOvercommitAllowed(name)) errs.push(invalid(reqPath, value, `must be equal to ${name} limit of ${limit}`));
        else if (cmp > 0) errs.push(invalid(reqPath, value, `must be less than or equal to ${name} limit of ${limit}`));
      }
    } else if (!isOvercommitAllowed(name)) {
      errs.push(required(limPath, 'Limit must be set for non overcommitable resources'));
    }
    if (isHugePageResourceName(name)) {
      reqHuge = true;
      const e = hugePageValueError(name, value);
      if (e) errs.push(invalid(p, value, e));
    }
    if (name === 'cpu' || name === 'memory') reqCpuMem = true;
  }
  if (!limCpuMem && !reqCpuMem && (reqHuge || limHuge)) errs.push(forbidden(path, 'HugePages require cpu or memory'));
  errs.push(...validateResourceClaimNames(req?.claims, podClaimNames, path.child('claims')));
  return errs;
}

/** validateResourceClaimNames. */
function validateResourceClaimNames(claims: Json | undefined, podClaimNames: ReadonlySet<string>, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  const names = new Set<string>();
  objs(claims).forEach((claim, i) => {
    const name = str(claim.name);
    const request = str(claim.request);
    if (name === '') {
      errs.push(required(path.index(i)));
      return;
    }
    if (names.has(name)) errs.push(duplicate(path.index(i), name));
    else {
      let key = name;
      if (request !== '') {
        errs.push(...validateDNS1123Label(request, path.index(i).child('request')));
        key += `/${request}`;
      }
      if (names.has(key)) errs.push(duplicate(path.index(i), key));
      else if (request === '') {
        for (const k of names) {
          const idx = k.indexOf('/');
          if (idx >= 0 && k.slice(0, idx) === name) errs.push(duplicate(path.index(i), name));
        }
      }
      names.add(key);
    }
    if (!podClaimNames.has(name)) {
      const e = notFound(path.index(i), name);
      e.detail = `must be one of the names in pod.spec.resourceClaims${podClaimNames.size === 0 ? ' which is empty' : `: ${sortStrings([...podClaimNames]).join(', ')}`}`;
      errs.push(e);
    }
  });
  return errs;
}

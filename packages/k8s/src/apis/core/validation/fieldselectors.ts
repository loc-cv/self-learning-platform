// Downward API selectors of env vars and volume files.
// upstream: pkg/apis/core/validation/validation.go validateObjectFieldSelector,
// validateContainerResourceFieldSelector, validateContainerResourceDivisor,
// validContainerResourceFieldPathExpressions; pkg/apis/core/pods/helpers.go
// ConvertDownwardAPIFieldLabel; pkg/fieldpath/fieldpath.go SplitMaybeSubscriptedPath.

import { invalid, notSupported, required, type FieldError, type Path } from '../../../apimachinery/field.ts';
import type { JsonObject } from '../../../apimachinery/json.ts';
import { canonicalQuantity, parseQuantity, isZero } from '../../../apimachinery/quantity.ts';
import { sortStrings, str, validateQualifiedName } from './util.ts';

export const VALID_CONTAINER_RESOURCE_FIELD_PATHS = ['limits.cpu', 'limits.memory', 'limits.ephemeral-storage', 'requests.cpu', 'requests.memory', 'requests.ephemeral-storage'];
const HUGEPAGES_REQUESTS_PREFIX = 'requests.hugepages-';
const HUGEPAGES_LIMITS_PREFIX = 'limits.hugepages-';

/** SplitMaybeSubscriptedPath: `metadata.labels['app']` → path and subscript. */
export function splitMaybeSubscriptedPath(fieldPath: string): { path: string; subscript: string } | undefined {
  if (!fieldPath.endsWith("']")) return undefined;
  const s = fieldPath.slice(0, -2);
  const i = s.indexOf("['");
  if (i < 0) return undefined;
  const path = s.slice(0, i);
  if (path === '') return undefined;
  return { path, subscript: s.slice(i + 2) };
}

const DOWNWARD_API_LABELS = [
  'metadata.annotations', 'metadata.labels', 'metadata.name', 'metadata.namespace', 'metadata.uid', 'spec.nodeName', 'spec.restartPolicy',
  'spec.serviceAccountName', 'spec.schedulerName', 'status.phase', 'status.hostIP', 'status.hostIPs', 'status.podIP', 'status.podIPs',
];

/** ConvertDownwardAPIFieldLabel for v1: the internal label, or the error text. */
function convertDownwardAPIFieldLabel(version: string, label: string): { label: string } | { error: string } {
  if (version !== 'v1') return { error: `unsupported pod version: ${version}` };
  const sub = splitMaybeSubscriptedPath(label);
  if (sub) {
    if (sub.path === 'metadata.annotations' || sub.path === 'metadata.labels') return { label };
    return { error: `field label does not support subscript: ${label}` };
  }
  if (DOWNWARD_API_LABELS.includes(label)) return { label };
  if (label === 'spec.host') return { label: 'spec.nodeName' };
  return { error: `field label not supported: ${label}` };
}

/** validateObjectFieldSelector: `expressions` is the allowed set (sorted for the message). */
export function validateObjectFieldSelector(fs: JsonObject, expressions: readonly string[], path: Path): FieldError[] {
  if (str(fs.apiVersion) === '') return [required(path.child('apiVersion'))];
  if (str(fs.fieldPath) === '') return [required(path.child('fieldPath'))];
  const conv = convertDownwardAPIFieldLabel(str(fs.apiVersion), str(fs.fieldPath));
  if ('error' in conv) return [invalid(path.child('fieldPath'), str(fs.fieldPath), `error converting fieldPath: ${conv.error}`)];
  const sub = splitMaybeSubscriptedPath(conv.label);
  if (sub) {
    switch (sub.path) {
      case 'metadata.annotations':
        return validateQualifiedName(sub.subscript.toLowerCase(), path);
      case 'metadata.labels':
        return validateQualifiedName(sub.subscript, path);
      default:
        return [invalid(path, sub.path, 'does not support subscript')];
    }
  }
  if (!expressions.includes(conv.label)) return [notSupported(path.child('fieldPath'), conv.label, sortStrings(expressions))];
  return [];
}

const MEMORY_DIVISORS = ['1', '1k', '1M', '1G', '1T', '1P', '1E', '1Ki', '1Mi', '1Gi', '1Ti', '1Pi', '1Ei'];

/** validateContainerResourceDivisor: the divisor's String() must be one of the listed units. */
function validateContainerResourceDivisor(rName: string, divisor: string | undefined, path: Path): FieldError[] {
  if (divisor === undefined) return [];
  const q = parseQuantity(divisor);
  if ('error' in q || isZero(q)) return [];
  const c = canonicalQuantity(divisor);
  const s = typeof c === 'string' ? c : divisor;
  const errs: FieldError[] = [];
  switch (rName) {
    case 'limits.cpu':
    case 'requests.cpu':
      if (!['1m', '1'].includes(s)) errs.push(invalid(path.child('divisor'), rName, "only divisor's values 1m and 1 are supported with the cpu resource"));
      break;
    case 'limits.memory':
    case 'requests.memory':
      if (!MEMORY_DIVISORS.includes(s)) errs.push(invalid(path.child('divisor'), rName, "only divisor's values 1, 1k, 1M, 1G, 1T, 1P, 1E, 1Ki, 1Mi, 1Gi, 1Ti, 1Pi, 1Ei are supported with the memory resource"));
      break;
    case 'limits.ephemeral-storage':
    case 'requests.ephemeral-storage':
      if (!MEMORY_DIVISORS.includes(s)) errs.push(invalid(path.child('divisor'), rName, "only divisor's values 1, 1k, 1M, 1G, 1T, 1P, 1E, 1Ki, 1Mi, 1Gi, 1Ti, 1Pi, 1Ei are supported with the local ephemeral storage resource"));
      break;
  }
  if ((rName.startsWith(HUGEPAGES_REQUESTS_PREFIX) || rName.startsWith(HUGEPAGES_LIMITS_PREFIX)) && !MEMORY_DIVISORS.includes(s)) {
    errs.push(invalid(path.child('divisor'), rName, "only divisor's values 1, 1k, 1M, 1G, 1T, 1P, 1E, 1Ki, 1Mi, 1Gi, 1Ti, 1Pi, 1Ei are supported with the hugepages resource"));
  }
  return errs;
}

/** validateContainerResourceFieldSelector (prefixes: the hugepages ones, allowed by default). */
export function validateContainerResourceFieldSelector(fs: JsonObject, expressions: readonly string[], path: Path, volume: boolean): FieldError[] {
  const errs: FieldError[] = [];
  const resource = str(fs.resource);
  if (volume && str(fs.containerName) === '') errs.push(required(path.child('containerName')));
  else if (resource === '') errs.push(required(path.child('resource')));
  else if (!expressions.includes(resource)) {
    const prefixed = resource.startsWith(HUGEPAGES_LIMITS_PREFIX) || resource.startsWith(HUGEPAGES_REQUESTS_PREFIX);
    if (!prefixed) errs.push(notSupported(path.child('resource'), resource, sortStrings(expressions)));
  }
  errs.push(...validateContainerResourceDivisor(resource, typeof fs.divisor === 'string' ? fs.divisor : undefined, path));
  return errs;
}

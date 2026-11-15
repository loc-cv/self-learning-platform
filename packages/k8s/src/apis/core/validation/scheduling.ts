// Scheduling-related parts of a PodSpec: affinity, tolerations, topology spread constraints,
// readiness and scheduling gates, DNS config, host aliases. validateImagePullSecrets has
// nothing to check here: the decoder already refuses any field of LocalObjectReference but name.
// upstream: pkg/apis/core/validation/validation.go validateAffinity, validateNodeAffinity,
// ValidateNodeSelector, ValidateNodeSelectorTerm, ValidateNodeSelectorRequirement,
// ValidateNodeFieldSelectorRequirement, ValidatePreferredSchedulingTerms, validatePodAffinity,
// validatePodAntiAffinity, validatePodAffinityTerms, validateWeightedPodAffinityTerms,
// validatePodAffinityTerm, ValidatePodAffinityTermSelector, ValidateTolerations, validateTaintEffect,
// validateTopologySpreadConstraints, validateMinDomains, ValidateTopologyKey, ValidateWhenUnsatisfiable,
// ValidateSpreadConstraintNotRepeat, validateNodeInclusionPolicy, validateReadinessGates,
// validateSchedulingGates, validatePodDNSConfig, ValidateHostAliases.

import { duplicate, forbidden, invalid, notSupported, required, type FieldError, type Path } from '../../../apimachinery/field.ts';
import type { Json, JsonObject } from '../../../apimachinery/json.ts';
import { isValidIPForLegacyField } from '../../../apimachinery/validation/ip.ts';
import { byteLength, isValidLabelValue, nameIsDNSSubdomain } from '../../../apimachinery/validation/names.ts';
import { validateLabelName, validateLabelSelector, validateNamespaceName } from '../../../apimachinery/validation/objectmeta.ts';
import { ALLOW_TAINT_TOLERATION_COMPARISON_OPERATORS, type PodValidationOptions } from './options.ts';
import { arr, isSet, num, obj, objs, str, strs, validateDNS1123Subdomain, validateDNS1123SubdomainWithUnderScore, validateQualifiedName } from './util.ts';

// ---- node affinity ----

function validateNodeSelectorRequirement(rq: JsonObject, allowInvalidLabelValue: boolean, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  const values = strs(rq.values);
  const op = str(rq.operator);
  switch (op) {
    case 'In':
    case 'NotIn':
      if (values.length === 0) errs.push(required(path.child('values'), "must be specified when `operator` is 'In' or 'NotIn'"));
      break;
    case 'Exists':
    case 'DoesNotExist':
      if (values.length > 0) errs.push(forbidden(path.child('values'), "may not be specified when `operator` is 'Exists' or 'DoesNotExist'"));
      break;
    case 'Gt':
    case 'Lt':
      if (values.length !== 1) errs.push(required(path.child('values'), "must be specified single value when `operator` is 'Lt' or 'Gt'"));
      break;
    default:
      errs.push(invalid(path.child('operator'), op, 'not a valid selector operator'));
  }
  errs.push(...validateLabelName(str(rq.key), path.child('key')));
  if (!allowInvalidLabelValue) {
    values.forEach((v, i) => {
      for (const m of isValidLabelValue(v)) errs.push(invalid(path.child('values').index(i), v, m));
    });
  }
  return errs;
}

function validateNodeFieldSelectorRequirement(rq: JsonObject, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  const values = strs(rq.values);
  const op = str(rq.operator);
  if (op === 'In' || op === 'NotIn') {
    if (values.length !== 1) errs.push(required(path.child('values'), "must be only one value when `operator` is 'In' or 'NotIn' for node field selector"));
  } else {
    errs.push(invalid(path.child('operator'), op, 'not a valid selector operator'));
  }
  // nodeFieldSelectorValidators: only metadata.name, checked with ValidateNodeName.
  if (str(rq.key) !== 'metadata.name') errs.push(invalid(path.child('key'), str(rq.key), 'not a valid field selector key'));
  else values.forEach((v, i) => errs.push(...nameIsDNSSubdomain(v, false).map((m) => invalid(path.child('values').index(i), v, m))));
  return errs;
}

function validateNodeSelectorTerm(term: JsonObject, allowInvalidLabelValue: boolean, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  objs(term.matchExpressions).forEach((r, j) => errs.push(...validateNodeSelectorRequirement(r, allowInvalidLabelValue, path.child('matchExpressions').index(j))));
  objs(term.matchFields).forEach((r, j) => errs.push(...validateNodeFieldSelectorRequirement(r, path.child('matchFields').index(j))));
  return errs;
}

function validateNodeAffinity(na: JsonObject, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  const req = obj(na.requiredDuringSchedulingIgnoredDuringExecution);
  if (req) {
    const termsPath = path.child('requiredDuringSchedulingIgnoredDuringExecution').child('nodeSelectorTerms');
    const terms = objs(req.nodeSelectorTerms);
    // AllowInvalidLabelValueInRequiredNodeAffinity only for objects that already had one: off.
    if (terms.length === 0) errs.push(required(termsPath, 'must have at least one node selector term'));
    else terms.forEach((t, i) => errs.push(...validateNodeSelectorTerm(t, false, termsPath.index(i))));
  }
  objs(na.preferredDuringSchedulingIgnoredDuringExecution).forEach((term, i) => {
    const p = path.child('preferredDuringSchedulingIgnoredDuringExecution').index(i);
    const weight = num(term.weight);
    if (weight <= 0 || weight > 100) errs.push(invalid(p.child('weight'), weight, 'must be in the range 1-100'));
    // Invalid label values are always allowed in preferred terms.
    errs.push(...validateNodeSelectorTerm(obj(term.preference) ?? {}, true, p.child('preference')));
  });
  return errs;
}

// ---- pod affinity ----

function validatePodAffinityTerm(term: JsonObject, path: Path, opts: PodValidationOptions): FieldError[] {
  const errs: FieldError[] = [];
  errs.push(...validateLabelSelector(term.labelSelector, {}, path.child('labelSelector')));
  errs.push(...validateLabelSelector(term.namespaceSelector, {}, path.child('namespaceSelector')));
  for (const ns of strs(term.namespaces)) errs.push(...validateNamespaceName(ns, false).map((m) => invalid(path.child('namespace'), ns, m)));
  if (arr(term.matchLabelKeys).length > 0 || arr(term.mismatchLabelKeys).length > 0) opts.notPorted('validation of pod affinity matchLabelKeys and mismatchLabelKeys');
  const topologyKey = str(term.topologyKey);
  if (topologyKey === '') errs.push(required(path.child('topologyKey'), 'can not be empty'));
  errs.push(...validateLabelName(topologyKey, path.child('topologyKey')));
  return errs;
}

function validatePodAffinityKind(pa: JsonObject, path: Path, opts: PodValidationOptions): FieldError[] {
  const errs: FieldError[] = [];
  objs(pa.requiredDuringSchedulingIgnoredDuringExecution).forEach((t, i) => errs.push(...validatePodAffinityTerm(t, path.child('requiredDuringSchedulingIgnoredDuringExecution').index(i), opts)));
  objs(pa.preferredDuringSchedulingIgnoredDuringExecution).forEach((wt, j) => {
    const p = path.child('preferredDuringSchedulingIgnoredDuringExecution').index(j);
    const weight = num(wt.weight);
    if (weight <= 0 || weight > 100) errs.push(invalid(p.child('weight'), weight, 'must be in the range 1-100'));
    errs.push(...validatePodAffinityTerm(obj(wt.podAffinityTerm) ?? {}, p.child('podAffinityTerm'), opts));
  });
  return errs;
}

export function validateAffinity(affinity: JsonObject | undefined, path: Path, opts: PodValidationOptions): FieldError[] {
  if (!affinity) return [];
  const errs: FieldError[] = [];
  const na = obj(affinity.nodeAffinity);
  if (na) errs.push(...validateNodeAffinity(na, path.child('nodeAffinity')));
  const pa = obj(affinity.podAffinity);
  if (pa) errs.push(...validatePodAffinityKind(pa, path.child('podAffinity'), opts));
  const paa = obj(affinity.podAntiAffinity);
  if (paa) errs.push(...validatePodAffinityKind(paa, path.child('podAntiAffinity'), opts));
  return errs;
}

// ---- tolerations ----

function validateTaintEffect(effect: string, allowEmpty: boolean, path: Path): FieldError[] {
  if (!allowEmpty && effect === '') return [required(path)];
  if (effect === 'NoSchedule' || effect === 'PreferNoSchedule' || effect === 'NoExecute') return [];
  return [notSupported(path, effect, ['NoSchedule', 'PreferNoSchedule', 'NoExecute'])];
}

export function validateTolerations(tolerations: Json | undefined, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  objs(tolerations).forEach((t, i) => {
    const p = path.index(i);
    const key = str(t.key);
    const operator = str(t.operator);
    const value = str(t.value);
    const effect = str(t.effect);
    // Covered by a declarative rule that is alpha in v1.37 (not enforced), so this one stands.
    if (key !== '') errs.push(...validateLabelName(key, p.child('key')));
    if (key === '' && operator !== 'Exists') errs.push(invalid(p.child('operator'), operator, 'operator must be Exists when `key` is empty, which means "match all values and all keys"'));
    if (isSet(t.tolerationSeconds) && effect !== 'NoExecute') errs.push(invalid(p.child('effect'), effect, "effect must be 'NoExecute' when `tolerationSeconds` is set"));
    switch (operator) {
      case 'Equal':
      case '': {
        const msgs = isValidLabelValue(value);
        if (msgs.length > 0) errs.push(invalid(p.child('operator'), value, msgs.join(';')));
        break;
      }
      case 'Exists':
        if (value !== '') errs.push(invalid(p.child('operator'), value, "value must be empty when `operator` is 'Exists'"));
        break;
      case 'Lt':
      case 'Gt':
        if (!ALLOW_TAINT_TOLERATION_COMPARISON_OPERATORS) {
          errs.push(notSupported(p.child('operator'), operator, ['Equal', 'Exists', 'Lt', 'Gt']));
          break;
        }
        break;
      default:
        errs.push(notSupported(p.child('operator'), operator, ['Equal', 'Exists']));
    }
    if (effect !== '') errs.push(...validateTaintEffect(effect, true, p.child('effect')));
  });
  return errs;
}

// ---- topology spread ----

export function validateTopologySpreadConstraints(constraints: Json | undefined, path: Path, opts: PodValidationOptions): FieldError[] {
  const errs: FieldError[] = [];
  const list = objs(constraints);
  list.forEach((c, i) => {
    const p = path.index(i);
    const maxSkew = num(c.maxSkew);
    if (maxSkew <= 0) errs.push(invalid(p.child('maxSkew'), maxSkew, 'must be greater than zero'));
    const topologyKey = str(c.topologyKey);
    if (topologyKey === '') errs.push(required(p.child('topologyKey'), 'can not be empty'));
    const when = str(c.whenUnsatisfiable);
    if (when !== 'DoNotSchedule' && when !== 'ScheduleAnyway') errs.push(notSupported(p.child('whenUnsatisfiable'), when, ['DoNotSchedule', 'ScheduleAnyway']));
    const repeat = list.slice(i + 1).find((r) => str(r.topologyKey) === topologyKey && str(r.whenUnsatisfiable) === when);
    if (repeat) errs.push(duplicate(p.child('{topologyKey, whenUnsatisfiable}'), `{${topologyKey}, ${when}}`));
    if (typeof c.minDomains === 'number') {
      if (c.minDomains <= 0) errs.push(invalid(p.child('minDomains'), c.minDomains, 'must be greater than zero'));
      if (when !== 'DoNotSchedule') errs.push(invalid(p.child('minDomains'), c.minDomains, `can only use minDomains if whenUnsatisfiable=DoNotSchedule, not ${when}`));
    }
    for (const f of ['nodeAffinityPolicy', 'nodeTaintsPolicy']) {
      if (isSet(c[f]) && !['Honor', 'Ignore'].includes(str(c[f]))) errs.push(notSupported(p.child(f), str(c[f]), ['Honor', 'Ignore']));
    }
    if (arr(c.matchLabelKeys).length > 0) opts.notPorted('validation of topologySpreadConstraints matchLabelKeys');
    errs.push(...validateLabelSelector(c.labelSelector, {}, p.child('labelSelector')));
  });
  return errs;
}

// ---- gates, DNS, host aliases, pull secrets ----

export function validateReadinessGates(gates: Json | undefined, path: Path): FieldError[] {
  return objs(gates).flatMap((g, i) => validateQualifiedName(str(g.conditionType), path.index(i).child('conditionType')));
}

export function validateSchedulingGates(gates: Json | undefined, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  const seen = new Set<string>();
  objs(gates).forEach((g, i) => {
    const name = str(g.name);
    errs.push(...validateQualifiedName(name, path.index(i)));
    if (seen.has(name)) errs.push(duplicate(path.index(i), name));
    seen.add(name);
  });
  return errs;
}

export function validatePodDNSConfig(dnsConfig: JsonObject | undefined, dnsPolicy: string, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  if (dnsPolicy === 'None') {
    if (!dnsConfig) return [required(path, 'must provide `dnsConfig` when `dnsPolicy` is None')];
    if (arr(dnsConfig.nameservers).length === 0) return [required(path.child('nameservers'), 'must provide at least one DNS nameserver when `dnsPolicy` is None')];
  }
  if (!dnsConfig) return errs;
  const nameservers = strs(dnsConfig.nameservers);
  if (nameservers.length > 3) errs.push(invalid(path.child('nameservers'), nameservers, 'must not have more than 3 nameservers'));
  nameservers.forEach((ns, i) => errs.push(...isValidIPForLegacyField(path.child('nameservers').index(i), ns)));
  const searches = strs(dnsConfig.searches);
  if (searches.length > 32) errs.push(invalid(path.child('searches'), searches, 'must not have more than 32 search paths'));
  if (byteLength(searches.join(' ')) > 2048) errs.push(invalid(path.child('searches'), searches, 'must not have more than 2048 characters (including spaces) in the search list'));
  searches.forEach((s, i) => {
    if (s !== '.') errs.push(...validateDNS1123SubdomainWithUnderScore(s.endsWith('.') ? s.slice(0, -1) : s, path.child('searches').index(i)));
  });
  objs(dnsConfig.options).forEach((o, i) => {
    if (str(o.name) === '') errs.push(required(path.child('options').index(i), 'must not be empty'));
  });
  return errs;
}

export function validateHostAliases(aliases: Json | undefined, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  objs(aliases).forEach((a, i) => {
    errs.push(...isValidIPForLegacyField(path.index(i).child('ip'), str(a.ip)));
    strs(a.hostnames).forEach((h, j) => errs.push(...validateDNS1123Subdomain(h, path.index(i).child('hostnames').index(j))));
  });
  return errs;
}

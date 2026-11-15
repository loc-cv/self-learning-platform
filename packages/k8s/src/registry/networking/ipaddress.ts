// IPAddress: the record the ClusterIP allocator keeps per allocated Service IP.
// upstream: pkg/registry/networking/ipaddress/strategy.go (cluster-scoped, no status; Prepare*
// do nothing; create on update not allowed, unconditional update allowed; no generated names),
// pkg/apis/networking/validation/validation.go ValidateIPAddress, ValidateIPAddressName (IsValidIP:
// the canonical form of an IP), validateIPAddressParentReference, ValidateIPAddressUpdate.
// Left out: the declarative validation of parentRef (its required and immutable rules duplicate
// the handwritten ones; their messages are assumed to agree), the --admission IPAddress
// protection of in-use addresses (a ValidatingAdmissionPolicy installed by kube-apiserver).

import { invalid, newPath, required, type FieldError, type Path } from '../../apimachinery/field.ts';
import { isObject, type Json, type JsonObject } from '../../apimachinery/json.ts';
import { isValidIP } from '../../apimachinery/validation/ip.ts';
import { isDNS1123Subdomain, isValidPathSegmentName, type NameFn } from '../../apimachinery/validation/names.ts';
import { validateImmutableField } from '../../apimachinery/validation/objectmeta.ts';
import type { Strategy } from '../../apiserver/types.ts';
import { validateObjectMeta, validateObjectMetaUpdate } from '../../apis/core/validation/objectmeta.ts';
import { defaultFieldLabel, objectMetaFields } from '../meta.ts';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** ValidateIPAddressName: the details of IsValidIP. */
const validateIPAddressName: NameFn = (name) => isValidIP(newPath(''), name).map((e) => e.detail);

function validateParentRef(ref: Json | undefined, path: Path): FieldError[] {
  if (!isObject(ref)) return [required(path.child('parentRef'))];
  const p = path.child('parentRef');
  const errs: FieldError[] = [];
  const group = str(ref.group);
  if (group !== '') for (const m of isDNS1123Subdomain(group)) errs.push(invalid(p.child('group'), group, m));
  const resource = str(ref.resource);
  if (resource === '') errs.push(required(p.child('resource')));
  else for (const m of isValidPathSegmentName(resource)) errs.push(invalid(p.child('resource'), resource, m));
  const name = str(ref.name);
  if (name === '') errs.push(required(p.child('name')));
  else for (const m of isValidPathSegmentName(name)) errs.push(invalid(p.child('name'), name, m));
  const ns = str(ref.namespace);
  if (ns !== '') for (const m of isValidPathSegmentName(ns)) errs.push(invalid(p.child('namespace'), ns, m));
  return errs;
}

function validateIPAddress(ip: JsonObject): FieldError[] {
  const errs = validateObjectMeta(ip.metadata as JsonObject, false, validateIPAddressName, newPath('metadata'));
  const spec = isObject(ip.spec) ? ip.spec : {};
  return [...errs, ...validateParentRef(spec.parentRef, newPath('spec'))];
}

export const ipAddressStrategy: Strategy = {
  group: 'networking.k8s.io',
  resource: 'ipaddresses',
  kind: 'IPAddress',
  storage: 'ipaddresses.networking.k8s.io',
  storageVersion: 'v1',
  validate: (obj) => validateIPAddress(obj),
  validateUpdate(obj, old) {
    const spec = isObject(obj.spec) ? obj.spec : {};
    const ospec = isObject(old.spec) ? old.spec : {};
    return [
      ...validateIPAddress(obj),
      ...validateObjectMetaUpdate(obj.metadata as JsonObject, old.metadata as JsonObject, newPath('metadata')),
      ...validateImmutableField(spec.parentRef, ospec.parentRef, newPath('spec').child('parentRef')),
    ];
  },
  allowCreateOnUpdate: false,
  allowUnconditionalUpdate: true,
  fields: (o) => objectMetaFields(o, false),
  convertFieldLabel: defaultFieldLabel,
};

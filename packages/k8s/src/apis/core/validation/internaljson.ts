// json.Marshal of internal core types, as validation errors print them. Internal types
// (pkg/apis/core/types.go) have no json tags, so encoding/json writes Go field names in struct
// order, every field (no omitempty), nil pointers and slices as null. A value printed this way is
// handed to field.Invalid as `{ go: text }`.
// upstream: staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go ErrorBody (json.Marshal
// of a non-primitive bad value); layouts from pkg/apis/core/types.go SecurityContext, Capabilities,
// SELinuxOptions, WindowsSecurityContextOptions, SeccompProfile, AppArmorProfile.

import { goJson, isObject, type Json, type JsonObject } from '../../../apimachinery/json.ts';

/** A field type: Go zero value when the versioned JSON lacks it. */
type Kind = 'string' | 'int' | 'bool' | '*string' | '*int' | '*bool' | '[]string' | { ptr: Layout };
/** [Go field name, versioned json name, kind], in the internal struct's order. */
type Layout = readonly (readonly [string, string, Kind])[];

const CAPABILITIES: Layout = [
  ['Add', 'add', '[]string'],
  ['Drop', 'drop', '[]string'],
];
const SELINUX_OPTIONS: Layout = [
  ['User', 'user', 'string'],
  ['Role', 'role', 'string'],
  ['Type', 'type', 'string'],
  ['Level', 'level', 'string'],
];
const WINDOWS_OPTIONS: Layout = [
  ['GMSACredentialSpecName', 'gmsaCredentialSpecName', '*string'],
  ['GMSACredentialSpec', 'gmsaCredentialSpec', '*string'],
  ['RunAsUserName', 'runAsUserName', '*string'],
  ['HostProcess', 'hostProcess', '*bool'],
];
const SECCOMP_PROFILE: Layout = [
  ['Type', 'type', 'string'],
  ['LocalhostProfile', 'localhostProfile', '*string'],
];
const APPARMOR_PROFILE: Layout = [
  ['Type', 'type', 'string'],
  ['LocalhostProfile', 'localhostProfile', '*string'],
];
const SECURITY_CONTEXT: Layout = [
  ['Capabilities', 'capabilities', { ptr: CAPABILITIES }],
  ['Privileged', 'privileged', '*bool'],
  ['SELinuxOptions', 'seLinuxOptions', { ptr: SELINUX_OPTIONS }],
  ['WindowsOptions', 'windowsOptions', { ptr: WINDOWS_OPTIONS }],
  ['RunAsUser', 'runAsUser', '*int'],
  ['RunAsGroup', 'runAsGroup', '*int'],
  ['RunAsNonRoot', 'runAsNonRoot', '*bool'],
  ['ReadOnlyRootFilesystem', 'readOnlyRootFilesystem', '*bool'],
  ['AllowPrivilegeEscalation', 'allowPrivilegeEscalation', '*bool'],
  ['ProcMount', 'procMount', '*string'],
  ['SeccompProfile', 'seccompProfile', { ptr: SECCOMP_PROFILE }],
  ['AppArmorProfile', 'appArmorProfile', { ptr: APPARMOR_PROFILE }],
];

function encodeKind(v: Json | undefined, kind: Kind): Json {
  const absent = v === undefined || v === null;
  switch (kind) {
    case 'string':
      return typeof v === 'string' ? v : '';
    case 'int':
      return typeof v === 'number' ? v : 0;
    case 'bool':
      return v === true;
    case '*string':
    case '*int':
    case '*bool':
      return absent ? null : v;
    case '[]string':
      return Array.isArray(v) ? v : null;
    default:
      return isObject(v) ? encodeStruct(v, kind.ptr) : null;
  }
}

function encodeStruct(v: JsonObject, layout: Layout): JsonObject {
  const out: JsonObject = {};
  for (const [goName, json, kind] of layout) out[goName] = encodeKind(v[json], kind);
  return out;
}

/** json.Marshal(*core.SecurityContext) from the versioned securityContext. */
export function encodeSecurityContext(sc: JsonObject): string {
  return goJson(encodeStruct(sc, SECURITY_CONTEXT));
}

/** json.Marshal(*core.SeccompProfile). */
export function encodeSeccompProfile(sp: JsonObject): string {
  return goJson(encodeStruct(sp, SECCOMP_PROFILE));
}

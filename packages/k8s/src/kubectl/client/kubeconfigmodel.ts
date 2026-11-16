// The kubeconfig as clientcmd holds it: the internal api.Config (maps of clusters, users and
// contexts, each entry remembering the file it came from), decoded from and encoded to the v1
// serialization exactly as client-go's latest.Codec does.
//   upstream: staging/src/k8s.io/client-go/tools/clientcmd/api/types.go (internal types,
//             LocationOfOrigin), api/v1/types.go (JSON names, omitempty/omitzero, field order),
//             api/v1/conversion.go (named lists to maps; maps back to lists sorted by name),
//             api/latest/latest.go (the YAML serializer: YAML to JSON, encoding/json, JSON to
//             YAML with sorted keys; the default group version v1, kind Config)
//   upstream: Go src/encoding/json decode.go (UnmarshalTypeError "json: cannot unmarshal <value>
//             into Go struct field <Struct>.<field path> of type <type>", the first one kept;
//             null leaves a field unchanged; []byte is standard base64), encode.go
//   reference: .upstream/bin/v1.37.2/kubectl config view on files with a type error, a wrong
//              apiVersion and kind, a YAML syntax error (2026-11-16); a file of comments, a
//              scalar, a list, apiVersion and kind that are not strings (2026-11-16)
//   upstream: api/v1/conversion.go Convert_Slice_v1_NamedCluster_To_Map_string_To_Pointer_api_Cluster
//             and its AuthInfo and Context twins (a repeated name is an error that prints Go's %v
//             of the whole v1 list), zz_generated.conversion.go (clusters, users, contexts)
// Not simulated (each prints a notice when a file has it): exec and auth-provider credentials and
// extensions (also when a list holding them repeats a name, since %v would print them).

import type { Json, JsonObject } from '../../apimachinery/json.ts';
import { base64Error } from '../../apimachinery/gojson.ts';
import { decodeBase64, encodeBase64 } from '../../apimachinery/base64.ts';

export interface Cluster {
  server: string;
  tlsServerName: string;
  insecureSkipTLSVerify: boolean;
  certificateAuthority: string;
  /** []byte as a binary string; undefined is nil. */
  certificateAuthorityData?: string;
  proxyURL: string;
  disableCompression: boolean;
}

export interface AuthInfo {
  clientCertificate: string;
  clientCertificateData?: string;
  clientKey: string;
  clientKeyData?: string;
  token: string;
  tokenFile: string;
  impersonate: string;
  impersonateUID: string;
  impersonateGroups?: string[];
  impersonateUserExtra?: Record<string, string[] | null>;
  username: string;
  password: string;
}

export interface Context {
  cluster: string;
  authInfo: string;
  namespace: string;
}

/** A map entry and its LocationOfOrigin (the file it was read from; '' for a new entry). */
export interface Entry<T> {
  value: T;
  origin: string;
}

export interface Config {
  preferences: { colors: boolean };
  clusters: Record<string, Entry<Cluster>>;
  users: Record<string, Entry<AuthInfo>>;
  contexts: Record<string, Entry<Context>>;
  currentContext: string;
}

export function newConfig(): Config {
  return { preferences: { colors: false }, clusters: {}, users: {}, contexts: {}, currentContext: '' };
}

export function newContext(): Context {
  return { cluster: '', authInfo: '', namespace: '' };
}

export function cloneConfig(c: Config): Config {
  return JSON.parse(JSON.stringify(c)) as Config;
}

/** reflect.DeepEqual of two values of the model (plain data built in a fixed key order). */
export function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---- decoding ----

export type DecodeResult = { config: Config } | { error: string } | { notSimulated: string };

const SCHEME = 'k8s.io/client-go/tools/clientcmd/api/latest/latest.go:50';

interface Ctx {
  error?: string;
  notSimulated?: string;
}

function kindOf(v: Json): string {
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'object' && v !== null) return 'object';
  return typeof v;
}

function typeError(c: Ctx, value: Json, struct: string, field: string, type: string): void {
  c.error ??= `json: cannot unmarshal ${kindOf(value)} into Go struct field ${struct}.${field} of type ${type}`;
}

function isObj(v: Json | undefined): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

type FieldKind = 'string' | 'bool' | 'bytes' | 'strings' | 'extra';

/** Decodes one struct's fields into `out` (keyed by property), case-sensitively; unknown fields are dropped. */
function fields(c: Ctx, v: JsonObject, struct: string, path: string, spec: Record<string, [string, FieldKind]>, out: Record<string, unknown>): void {
  for (const json of Object.keys(v).sort()) {
    const raw = v[json] as Json;
    const f = spec[json];
    if (!f || raw === null) continue;
    const [prop, kind] = f;
    const field = path === '' ? json : `${path}.${json}`;
    switch (kind) {
      case 'string':
        if (typeof raw === 'string') out[prop] = raw;
        else typeError(c, raw, struct, field, 'string');
        break;
      case 'bool':
        if (typeof raw === 'boolean') out[prop] = raw;
        else typeError(c, raw, struct, field, 'bool');
        break;
      case 'bytes':
        if (typeof raw !== 'string') typeError(c, raw, struct, field, '[]uint8');
        else {
          const e = base64Error(raw);
          if (e !== undefined) c.error ??= e;
          else out[prop] = decodeBase64(raw) ?? '';
        }
        break;
      case 'strings':
        if (!Array.isArray(raw)) typeError(c, raw, struct, field, '[]string');
        else {
          const list: string[] = [];
          for (const x of raw) {
            if (x === null) list.push('');
            else if (typeof x === 'string') list.push(x);
            else typeError(c, x, struct, field, 'string');
          }
          out[prop] = list;
        }
        break;
      case 'extra':
        if (!isObj(raw)) typeError(c, raw, struct, field, 'map[string][]string');
        else {
          const m: Record<string, string[] | null> = {};
          for (const k of Object.keys(raw).sort()) {
            const x = raw[k] as Json;
            if (x === null) m[k] = null;
            else if (!Array.isArray(x)) typeError(c, x, struct, field, '[]string');
            else m[k] = x.map((y) => (typeof y === 'string' ? y : (y !== null && typeError(c, y, struct, field, 'string'), '')));
          }
          out[prop] = m;
        }
        break;
    }
  }
}

const CLUSTER_FIELDS: Record<string, [string, FieldKind]> = {
  server: ['server', 'string'],
  'tls-server-name': ['tlsServerName', 'string'],
  'insecure-skip-tls-verify': ['insecureSkipTLSVerify', 'bool'],
  'certificate-authority': ['certificateAuthority', 'string'],
  'certificate-authority-data': ['certificateAuthorityData', 'bytes'],
  'proxy-url': ['proxyURL', 'string'],
  'disable-compression': ['disableCompression', 'bool'],
};

const AUTHINFO_FIELDS: Record<string, [string, FieldKind]> = {
  'client-certificate': ['clientCertificate', 'string'],
  'client-certificate-data': ['clientCertificateData', 'bytes'],
  'client-key': ['clientKey', 'string'],
  'client-key-data': ['clientKeyData', 'bytes'],
  token: ['token', 'string'],
  tokenFile: ['tokenFile', 'string'],
  as: ['impersonate', 'string'],
  'as-uid': ['impersonateUID', 'string'],
  'as-groups': ['impersonateGroups', 'strings'],
  'as-user-extra': ['impersonateUserExtra', 'extra'],
  username: ['username', 'string'],
  password: ['password', 'string'],
};

const CONTEXT_FIELDS: Record<string, [string, FieldKind]> = {
  cluster: ['cluster', 'string'],
  user: ['authInfo', 'string'],
  namespace: ['namespace', 'string'],
};

function newCluster(): Cluster {
  return { server: '', tlsServerName: '', insecureSkipTLSVerify: false, certificateAuthority: '', proxyURL: '', disableCompression: false };
}

function newAuthInfo(): AuthInfo {
  return { clientCertificate: '', clientKey: '', token: '', tokenFile: '', impersonate: '', impersonateUID: '', username: '', password: '' };
}

interface NamedSpec<T> {
  list: string;
  named: string;
  inner: string;
  innerStruct: string;
  /** The internal type the list converts to (`api.Cluster`). */
  apiType: string;
  fields: Record<string, [string, FieldKind]>;
  make: () => T;
  /** Go's %v of the v1 struct the entry was decoded into. */
  format: (v: T) => string;
}

/** A named list decoded: its map, and what the conversion needs to report a repeated name. */
interface NamedList<T> {
  entries: Record<string, Entry<T>>;
  /** The first name the list repeats. */
  duplicate?: string;
  /** Go's %v of each element, in list order. */
  items: string[];
  /** An element holds content the model does not keep (exec, auth-provider, extensions). */
  unsupported: boolean;
}

/** A named list (`clusters`) decoded; null and an empty list leave it empty. */
function namedList<T>(c: Ctx, raw: Json | undefined, s: NamedSpec<T>, origin: string): NamedList<T> {
  const out: NamedList<T> = { entries: {}, items: [], unsupported: false };
  if (raw === undefined || raw === null) return out;
  if (!Array.isArray(raw)) {
    typeError(c, raw, 'Config', s.list, `[]v1.${s.named}`);
    return out;
  }
  for (const element of raw) {
    // A null element decodes to the zero struct: an entry named "" (checked on the binary).
    const item: JsonObject = element === null ? {} : (element as JsonObject);
    if (element !== null && !isObj(element)) {
      typeError(c, element, 'Config', s.list, `v1.${s.named}`);
      continue;
    }
    let name = '';
    const decodeName = () => {
      if (item.name === undefined || item.name === null) return;
      if (typeof item.name === 'string') name = item.name;
      else typeError(c, item.name, s.named, `${s.list}.name`, 'string');
    };
    const value = s.make() as unknown as Record<string, unknown>;
    const notSimulated = (what: string) => {
      out.unsupported = true;
      c.notSimulated ??= what;
    };
    const decodeInner = () => {
      const inner = item[s.inner];
      if (inner === undefined || inner === null) return;
      if (!isObj(inner)) typeError(c, inner, s.named, `${s.list}.${s.inner}`, `v1.${s.innerStruct}`);
      else {
        if ('extensions' in inner && inner.extensions !== null) notSimulated(`extensions in a kubeconfig ${s.inner}`);
        if ('exec' in inner && inner.exec !== null) notSimulated('exec credentials in a kubeconfig user');
        if ('auth-provider' in inner && inner['auth-provider'] !== null) notSimulated('auth-provider credentials in a kubeconfig user');
        fields(c, inner, s.innerStruct, `${s.list}.${s.inner}`, s.fields, value);
      }
    };
    // Keys in sorted order: sigs.k8s.io/yaml's JSON has them so, and the first type error wins.
    if (s.inner < 'name') {
      decodeInner();
      decodeName();
    } else {
      decodeName();
      decodeInner();
    }
    out.items.push(`{${name} ${s.format(value as unknown as T)}}`);
    if (name in out.entries) out.duplicate ??= name;
    else out.entries[name] = { value: value as unknown as T, origin };
  }
  return out;
}

// Go's %v of the v1 structs (fmt: a struct is its fields in order, space-separated, in braces; a
// []byte is its bytes in decimal; a map is sorted by key; a nil pointer is <nil>). Fields the
// model does not keep are their zero values: anything else makes the list unsupported.
//   reference: .upstream/bin/v1.37.2/kubectl on files repeating a cluster and a user name (2026-11-16)
function goBytes(b: string | undefined): string {
  return `[${[...(b ?? '')].map((ch) => ch.charCodeAt(0)).join(' ')}]`;
}

function goStrings(a: readonly string[] | null | undefined): string {
  return `[${(a ?? []).join(' ')}]`;
}

function formatCluster(x: Cluster): string {
  return `{${[x.server, x.tlsServerName, String(x.insecureSkipTLSVerify), x.certificateAuthority, goBytes(x.certificateAuthorityData), x.proxyURL, String(x.disableCompression), '[]'].join(' ')}}`;
}

function formatAuthInfo(x: AuthInfo): string {
  const extra = x.impersonateUserExtra ?? {};
  const m = `map[${Object.keys(extra).sort().map((k) => `${k}:${goStrings(extra[k])}`).join(' ')}]`;
  const f = [x.clientCertificate, goBytes(x.clientCertificateData), x.clientKey, goBytes(x.clientKeyData), x.token, x.tokenFile, x.impersonate, x.impersonateUID, goStrings(x.impersonateGroups), m, x.username, x.password];
  // AuthProvider and Exec (nil pointers), Extensions
  return `{${[...f, '<nil>', '<nil>', '[]'].join(' ')}}`;
}

function formatContext(x: Context): string {
  return `{${[x.cluster, x.authInfo, x.namespace, '[]'].join(' ')}}`;
}

/** The conversion's error for a list that repeats a name (Convert_Slice_v1_NamedCluster_To_Map_…). */
function duplicateError<T>(l: NamedList<T>, s: NamedSpec<T>): DecodeResult | undefined {
  if (l.duplicate === undefined) return undefined;
  if (l.unsupported) return { notSimulated: `a kubeconfig whose ${s.list} repeat the name "${l.duplicate}" and hold exec, auth-provider or extensions` };
  return { error: `error converting *[]${s.named} into *map[string]*api.${s.apiType}: duplicate name "${l.duplicate}" in list: [${l.items.join(' ')}]` };
}

const CLUSTERS: NamedSpec<Cluster> = { list: 'clusters', named: 'NamedCluster', inner: 'cluster', innerStruct: 'Cluster', apiType: 'Cluster', fields: CLUSTER_FIELDS, make: newCluster, format: formatCluster };
const CONTEXTS: NamedSpec<Context> = { list: 'contexts', named: 'NamedContext', inner: 'context', innerStruct: 'Context', apiType: 'Context', fields: CONTEXT_FIELDS, make: newContext, format: formatContext };
const USERS: NamedSpec<AuthInfo> = { list: 'users', named: 'NamedAuthInfo', inner: 'user', innerStruct: 'AuthInfo', apiType: 'AuthInfo', fields: AUTHINFO_FIELDS, make: newAuthInfo, format: formatAuthInfo };

/**
 * clientcmd.Load of a file's decoded YAML (`doc` is the JSON sigs.k8s.io/yaml makes of it, or
 * undefined for an empty file), with LocationOfOrigin set to `origin` (LoadFromFile).
 */
export function decodeConfig(doc: Json | undefined, origin: string): DecodeResult {
  const config = newConfig();
  // null (a file of comments) decodes to nothing: an empty config.
  if (doc === undefined || doc === null) return { config };
  // upstream: apimachinery/pkg/runtime/serializer/json/meta.go SimpleMetaFactory.Interpret
  const interpret = (e: string) => ({ error: `couldn't get version/kind; json parse error: json: cannot unmarshal ${e}` });
  if (!isObj(doc)) return interpret(`${kindOf(doc)} into Go value of type struct { APIVersion string "json:\\"apiVersion,omitempty\\""; Kind string "json:\\"kind,omitempty\\"" }`);
  for (const k of ['apiVersion', 'kind'] as const) {
    const v = doc[k];
    if (v !== undefined && v !== null && typeof v !== 'string') return interpret(`${kindOf(v)} into Go struct field .${k} of type string`);
  }
  const apiVersion = typeof doc.apiVersion === 'string' ? doc.apiVersion : '';
  const kind = typeof doc.kind === 'string' ? doc.kind : '';
  if ((apiVersion !== '' && apiVersion !== 'v1') || (kind !== '' && kind !== 'Config')) {
    return { error: `no kind "${kind || 'Config'}" is registered for version "${apiVersion || 'v1'}" in scheme "${SCHEME}"` };
  }
  const c: Ctx = {};
  // In sorted key order (the JSON sigs.k8s.io/yaml makes), so the first type error is Go's.
  const clusters = namedList(c, doc.clusters, CLUSTERS, origin);
  const contexts = namedList(c, doc.contexts, CONTEXTS, origin);
  const cc = doc['current-context'];
  if (cc !== undefined && cc !== null) {
    if (typeof cc === 'string') config.currentContext = cc;
    else typeError(c, cc, 'Config', 'current-context', 'string');
  }
  if (doc.extensions !== undefined && doc.extensions !== null) c.notSimulated ??= 'extensions in a kubeconfig';
  if (doc.preferences !== undefined && doc.preferences !== null) {
    const p = doc.preferences;
    if (!isObj(p)) typeError(c, p, 'Config', 'preferences', 'v1.Preferences');
    else {
      if (p.extensions !== undefined && p.extensions !== null) c.notSimulated ??= 'extensions in kubeconfig preferences';
      fields(c, p, 'Preferences', 'preferences', { colors: ['colors', 'bool'] }, config.preferences);
    }
  }
  const users = namedList(c, doc.users, USERS, origin);
  // Decoding fails first; then the conversion, in Convert_v1_Config_To_api_Config's order.
  if (c.error !== undefined) return { error: c.error };
  const dup = duplicateError(clusters, CLUSTERS) ?? duplicateError(users, USERS) ?? duplicateError(contexts, CONTEXTS);
  if (dup) return dup;
  config.clusters = clusters.entries;
  config.contexts = contexts.entries;
  config.users = users.entries;
  if (c.notSimulated !== undefined) return { notSimulated: c.notSimulated };
  return { config };
}

// ---- encoding ----

function clusterJson(x: Cluster): JsonObject {
  const o: JsonObject = { server: x.server };
  if (x.tlsServerName !== '') o['tls-server-name'] = x.tlsServerName;
  if (x.insecureSkipTLSVerify) o['insecure-skip-tls-verify'] = true;
  if (x.certificateAuthority !== '') o['certificate-authority'] = x.certificateAuthority;
  if (x.certificateAuthorityData) o['certificate-authority-data'] = encodeBase64(x.certificateAuthorityData);
  if (x.proxyURL !== '') o['proxy-url'] = x.proxyURL;
  if (x.disableCompression) o['disable-compression'] = true;
  return o;
}

function authInfoJson(x: AuthInfo): JsonObject {
  const o: JsonObject = {};
  if (x.clientCertificate !== '') o['client-certificate'] = x.clientCertificate;
  if (x.clientCertificateData) o['client-certificate-data'] = encodeBase64(x.clientCertificateData);
  if (x.clientKey !== '') o['client-key'] = x.clientKey;
  if (x.clientKeyData) o['client-key-data'] = encodeBase64(x.clientKeyData);
  if (x.token !== '') o.token = x.token;
  if (x.tokenFile !== '') o.tokenFile = x.tokenFile;
  if (x.impersonate !== '') o.as = x.impersonate;
  if (x.impersonateUID !== '') o['as-uid'] = x.impersonateUID;
  if (x.impersonateGroups && x.impersonateGroups.length > 0) o['as-groups'] = [...x.impersonateGroups];
  if (x.impersonateUserExtra && Object.keys(x.impersonateUserExtra).length > 0) {
    const m: JsonObject = {};
    for (const k of Object.keys(x.impersonateUserExtra).sort()) {
      const v = x.impersonateUserExtra[k];
      m[k] = v ? [...v] : null;
    }
    o['as-user-extra'] = m;
  }
  if (x.username !== '') o.username = x.username;
  if (x.password !== '') o.password = x.password;
  return o;
}

function contextJson(x: Context): JsonObject {
  const o: JsonObject = { cluster: x.cluster, user: x.authInfo };
  if (x.namespace !== '') o.namespace = x.namespace;
  return o;
}

function named<T>(m: Record<string, Entry<T>>, inner: string, enc: (v: T) => JsonObject): Json {
  const keys = Object.keys(m).sort();
  if (keys.length === 0) return null;
  return keys.map((k) => ({ name: k, [inner]: enc((m[k] as Entry<T>).value) }));
}

/** The v1.Config the conversion makes, as encoding/json writes it (struct field order). */
export function toV1(c: Config): JsonObject {
  const o: JsonObject = { kind: 'Config', apiVersion: 'v1' };
  if (c.preferences.colors) o.preferences = { colors: true };
  o.clusters = named(c.clusters, 'cluster', clusterJson);
  o.users = named(c.users, 'user', authInfoJson);
  o.contexts = named(c.contexts, 'context', contextJson);
  o['current-context'] = c.currentContext;
  return o;
}

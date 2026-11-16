// The `kubectl create <kind>` generators: deployment, namespace, serviceaccount, configmap, secret generic and
// service clusterip|nodeport|loadbalancer|externalname. Each builds the typed object its upstream
// command builds, then creates it (or, with --dry-run=client, only prints it).
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/create/create_deployment.go Validate,
//             createDeployment, buildPodSpec, sanitizeAndUniquify ("failed to create deployment: %v")
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/create/create_namespace.go Validate,
//             createNamespace (the API error unwrapped)
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/create/create_serviceaccount.go Validate,
//             createServiceAccount ("failed to create serviceaccount: %v")
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/create/create_configmap.go Validate,
//             createConfigMap ("failed to create configmap: %v")
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/create/create_secret.go Validate, createSecret,
//             newSecretObj ("failed to create secret %v", no colon)
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/create/create_service.go Validate,
//             createService, parsePorts ("failed to create %s service: %v"); Complete never reads
//             --save-config, so create service never writes the annotation
//   upstream: k8s.io/utils/net ParsePort (strconv.ParseUint(s, 10, 16)); Go src/strconv/atoi.go
//   upstream: staging/src/k8s.io/apimachinery/pkg/util/rand/rand.go String (the container name
//             suffix of an image name with `.` or `_`)
//   fixtures/golden/v1.37.2/client/generators.yaml, generate/client.yaml, generate/create.yaml

import type { JsonObject } from '../../../apimachinery/json.ts';
import { NAME_ALPHABET } from '../../../apimachinery/rand.ts';
import { isDNS1123Subdomain, isValidPortName, isValidPortNum } from '../../../apimachinery/validation/names.ts';
import type { Invocation, Verb } from '../../cli/command.ts';
import { messageError, type KubectlError } from '../../cli/errors.ts';
import { goQuote } from '../../cli/flagset.ts';
import { str, strs, type Completed } from './common.ts';
import { generatorVerb } from './generator.ts';
import { addEnvFileSources, addFileSources, addLiteralSources, configMapAdder, configMapHash, secretAdder, secretHash, type ConfigMapData, type SecretData } from './sources.ts';

const nsOf = (c: Completed): string | undefined => (c.config.explicitNamespace ? c.config.namespace : undefined);
const meta = (name: string, c: Completed, extra: JsonObject = {}): JsonObject => {
  const ns = nsOf(c);
  return { name, ...extra, ...(ns !== undefined ? { namespace: ns } : {}) };
};

// ---- deployment ----

/** The arguments after the name (`-- command args…`). */
const commandOf = (inv: Invocation): string[] => inv.args.slice(1);

/** sanitizeAndUniquify: `_` and `.` become `-`, and the name gets a random suffix. */
function containerName(inv: Invocation, image: string): string {
  let name = image.split('/').pop() as string;
  if (name.includes(':')) name = name.split(':')[0] as string;
  if (name.includes('@')) name = name.split('@')[0] as string;
  if (/[_.]/.test(name)) {
    const r = inv.p.random('kubectl.rand');
    let suffix = '';
    for (let i = 0; i < 5; i++) suffix += NAME_ALPHABET[r.int(NAME_ALPHABET.length)];
    name = `${name.replace(/_/g, '-').replace(/\./g, '-')}-${suffix}`;
  }
  return name;
}

export const createDeploymentVerb: Verb = generatorVerb({
  path: 'create deployment',
  flags: [
    { name: 'image', kind: 'stringSlice', default: [] },
    { name: 'port', kind: 'int32', default: -1 },
    { name: 'replicas', shorthand: 'r', kind: 'int32', default: 1 },
  ],
  required: ['image'],
  typeId: 'apps/v1.Deployment',
  saveConfig: true,
  validate(inv) {
    if (strs(inv.flags.values.image).length > 1 && commandOf(inv).length > 0) return messageError('cannot specify multiple --image options and command');
    return undefined;
  },
  build(inv, name, c) {
    const v = inv.flags.values;
    const labels = { app: name };
    const command = commandOf(inv);
    const containers: JsonObject[] = strs(v.image).map((image) => ({ name: containerName(inv, image), image, ...(command.length > 0 ? { command } : {}) }));
    const port = v.port as number;
    if (port >= 0 && containers.length > 0) (containers[0] as JsonObject).ports = [{ containerPort: port }];
    return {
      object: {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: meta(name, c, { labels }),
        spec: { replicas: v.replicas as number, selector: { matchLabels: { ...labels } }, template: { metadata: { labels: { ...labels } }, spec: { containers } } },
      },
    };
  },
  target: (c) => ({ group: 'apps', version: 'v1', resource: 'deployments', namespace: c.config.namespace }),
  errorPrefix: () => 'failed to create deployment: ',
});

// ---- namespace ----

export const createNamespaceVerb: Verb = generatorVerb({
  path: 'create namespace',
  flags: [],
  typeId: 'core/v1.Namespace',
  saveConfig: true,
  validate: (inv) => (inv.args[0] === '' ? messageError('name must be specified') : undefined),
  build: (_inv, name) => ({ object: { apiVersion: 'v1', kind: 'Namespace', metadata: { name } } }),
  target: () => ({ group: '', version: 'v1', resource: 'namespaces', namespace: '' }),
});

// ---- serviceaccount ----

export const createServiceAccountVerb: Verb = generatorVerb({
  path: 'create serviceaccount',
  flags: [],
  typeId: 'core/v1.ServiceAccount',
  saveConfig: true,
  validate: (inv) => (inv.args[0] === '' ? messageError('name must be specified') : undefined),
  build: (_inv, name, c) => ({ object: { apiVersion: 'v1', kind: 'ServiceAccount', metadata: meta(name, c) } }),
  target: (c) => ({ group: '', version: 'v1', resource: 'serviceaccounts', namespace: c.config.namespace }),
  errorPrefix: () => 'failed to create serviceaccount: ',
});

// ---- configmap and secret ----

const SOURCE_FLAGS = [
  { name: 'from-file', kind: 'stringSlice', default: [] },
  { name: 'from-literal', kind: 'stringArray', default: [] },
  { name: 'from-env-file', kind: 'stringSlice', default: [] },
  { name: 'append-hash', kind: 'bool', default: false },
] as const;

function validateSources(inv: Invocation): KubectlError | undefined {
  const v = inv.flags.values;
  if (inv.args[0] === '') return messageError('name must be specified');
  if (strs(v['from-env-file']).length > 0 && (strs(v['from-file']).length > 0 || strs(v['from-literal']).length > 0)) {
    return messageError('from-env-file cannot be combined with from-file or from-literal');
  }
  return undefined;
}

export const createConfigMapVerb: Verb = generatorVerb({
  path: 'create configmap',
  flags: SOURCE_FLAGS.map((f) => ({ ...f, default: f.kind === 'bool' ? false : [] })),
  typeId: 'core/v1.ConfigMap',
  saveConfig: true,
  validate: validateSources,
  build(inv, name, c) {
    const v = inv.flags.values;
    const fs = inv.p.fs();
    const cm: ConfigMapData = { name, data: {} };
    const add = configMapAdder(cm);
    const err =
      (strs(v['from-file']).length > 0 ? addFileSources(fs, strs(v['from-file']), add) : undefined) ??
      addLiteralSources(strs(v['from-literal']), add) ??
      addEnvFileSources(fs, strs(v['from-env-file']), inv.p.env, 'env config file cannot be a directory', add);
    if (err) return { error: messageError(err.error) };
    const finalName = v['append-hash'] === true ? `${name}-${configMapHash(cm)}` : name;
    return { object: { apiVersion: 'v1', kind: 'ConfigMap', metadata: meta(finalName, c), data: cm.data } };
  },
  target: (c) => ({ group: '', version: 'v1', resource: 'configmaps', namespace: c.config.namespace }),
  errorPrefix: () => 'failed to create configmap: ',
});

export const createSecretGenericVerb: Verb = generatorVerb({
  path: 'create secret generic',
  flags: [...SOURCE_FLAGS.map((f) => ({ ...f, default: f.kind === 'bool' ? false : [] })), { name: 'type', kind: 'string', default: '' }],
  typeId: 'core/v1.Secret',
  saveConfig: true,
  validate: validateSources,
  build(inv, name, c) {
    const v = inv.flags.values;
    const fs = inv.p.fs();
    const s: SecretData = { name, type: str(v.type), data: {} };
    const add = secretAdder(s);
    const err =
      addLiteralSources(strs(v['from-literal']), add) ??
      (strs(v['from-file']).length > 0 ? addFileSources(fs, strs(v['from-file']), add) : undefined) ??
      addEnvFileSources(fs, strs(v['from-env-file']), inv.p.env, 'env secret file cannot be a directory', add);
    if (err) return { error: messageError(err.error) };
    const finalName = v['append-hash'] === true ? `${name}-${secretHash(s)}` : name;
    return { object: { apiVersion: 'v1', kind: 'Secret', metadata: meta(finalName, c), ...(s.type !== '' ? { type: s.type } : {}), data: s.data } };
  },
  target: (c) => ({ group: '', version: 'v1', resource: 'secrets', namespace: c.config.namespace }),
  errorPrefix: () => 'failed to create secret ',
});

// ---- service ----

/** ParsePort(s, true): strconv.ParseUint(s, 10, 16). */
function parsePort(s: string): number | KubectlError {
  if (!/^[0-9]+$/.test(s)) return messageError(`strconv.ParseUint: parsing ${goQuote(s)}: invalid syntax`);
  const n = Number(s);
  if (n > 65535) return messageError(`strconv.ParseUint: parsing ${goQuote(s)}: value out of range`);
  return n;
}

/** strconv.Atoi: a decimal int64, with an optional sign. */
function atoi(s: string): number | undefined {
  if (!/^[+-]?[0-9]+$/.test(s)) return undefined;
  const n = BigInt(s);
  if (n > 9223372036854775807n || n < -9223372036854775808n) return undefined;
  return Number(n);
}

/** parsePorts: `<port>[:<targetPort>]`, the target a number or a port name. */
function parsePorts(spec: string): { port: number; targetPort: number | string } | KubectlError {
  const parts = spec.split(':');
  const port = parsePort(parts[0] as string);
  if (typeof port !== 'number') return port;
  if (parts.length === 1) return { port, targetPort: port };
  const target = parts[1] as string;
  const n = atoi(target);
  if (n === undefined) {
    const errs = isValidPortName(target);
    if (errs.length > 0) return messageError(errs.join(','));
    return { port, targetPort: target };
  }
  const errs = isValidPortNum(n);
  if (errs.length > 0) return messageError(errs.join(','));
  return { port, targetPort: n };
}

type ServiceType = 'ClusterIP' | 'NodePort' | 'LoadBalancer' | 'ExternalName';

function serviceVerb(sub: string, type: ServiceType, extra: Verb['flags']): Verb {
  return generatorVerb({
    path: `create service ${sub}`,
    flags: [{ name: 'tcp', kind: 'stringSlice', default: [] }, ...extra],
    ...(type === 'ExternalName' ? { required: ['external-name'] } : {}),
    typeId: 'core/v1.Service',
    saveConfig: false,
    validate(inv) {
      const v = inv.flags.values;
      const clusterIP = str(v.clusterip);
      if (clusterIP === 'None' && type !== 'ClusterIP') return messageError('ClusterIP=None can only be used with ClusterIP service type');
      if (clusterIP !== 'None' && strs(v.tcp).length === 0 && type !== 'ExternalName') return messageError('at least one tcp port specifier must be provided');
      if (type === 'ExternalName' && isDNS1123Subdomain(str(v['external-name'])).length !== 0) return messageError(`invalid service external name ${str(v['external-name'])}`);
      return undefined;
    },
    build(inv, name, c) {
      const v = inv.flags.values;
      const ports: JsonObject[] = [];
      for (const tcp of strs(v.tcp)) {
        const pp = parsePorts(tcp);
        if ('type' in pp) return { error: pp };
        const nodePort = typeof v['node-port'] === 'number' ? v['node-port'] : 0;
        ports.push({ name: tcp.split(':').join('-'), port: pp.port, targetPort: pp.targetPort, protocol: 'TCP', ...(nodePort !== 0 ? { nodePort } : {}) });
      }
      const clusterIP = str(v.clusterip);
      const externalName = str(v['external-name']);
      return {
        object: {
          apiVersion: 'v1',
          kind: 'Service',
          metadata: meta(name, c, { labels: { app: name } }),
          spec: { type, selector: { app: name }, ports, ...(externalName !== '' ? { externalName } : {}), ...(clusterIP !== '' ? { clusterIP } : {}) },
        },
      };
    },
    target: (c) => ({ group: '', version: 'v1', resource: 'services', namespace: c.config.namespace }),
    errorPrefix: () => `failed to create ${type} service: `,
  });
}

export const createServiceVerbs: Verb[] = [
  serviceVerb('clusterip', 'ClusterIP', [{ name: 'clusterip', kind: 'string', default: '' }]),
  serviceVerb('nodeport', 'NodePort', [{ name: 'node-port', kind: 'int', default: 0 }]),
  serviceVerb('loadbalancer', 'LoadBalancer', []),
  serviceVerb('externalname', 'ExternalName', [{ name: 'external-name', kind: 'string', default: '' }]),
];

// kubectl's completion functions and where each command registers them (ValidArgsFunction,
// ValidArgs, RegisterFlagCompletionFunc, the BashCompFilenameExt annotation of -f).
//   upstream: staging/src/k8s.io/kubectl/pkg/util/completion/completion.go (every function below
//             is a port of the one of the same name there)
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/cmd.go NewKubectlCommand (get and debug use
//             ResourceTypeAndNameCompletionFunc), registerCompletionFuncForGlobalFlags (namespace,
//             context, cluster, user)
//   upstream: the ValidArgsFunction of each command: top_pod.go, top_node.go, attach.go,
//             autoscale.go, scale.go, cp.go, create_token.go, drain.go (cordon, uncordon, drain),
//             delete.go, describe.go, label.go, annotate.go, edit.go, patch.go, taint.go, exec.go,
//             logs.go, expose.go, portforward.go, set_image.go, apply_edit_last_applied.go,
//             apply_view_last_applied.go, rollout_{history,pause,restart,resume,status,undo}.go,
//             config/{use_context,rename_context,set_context,delete_context,delete_user,
//             delete_cluster}.go; completion.go (ValidArgs: the shells)
//   upstream: flag functions: get/get_flags.go (output: the allowed formats), util/helpers.go
//             AddSubresourceFlags (status, scale, resize), create_clusterrolebinding.go
//             (clusterrole), config/set_context.go (namespace), exec.go (container)
//   upstream: cli-runtime/pkg/genericclioptions/filename_flags.go and kubectl
//             util/helpers.go AddJsonFilenameFlag: `filename` is annotated with
//             resource.FileExtensions (.json .yaml .yml) without the dot

import type { Json } from '@simlab/kernel';
import { manifestCommand } from '../manifest.ts';
import { DIRECTIVE, type CompletionCall, type CompletionFn, type Completions, type Registrations } from './cobra.ts';
import { namesOf, type Client } from './client.ts';

type MakeClient = (values: Record<string, unknown>) => Client;

const NO_FILE = DIRECTIVE.noFileComp;

const isObject = (v: Json | undefined): v is Record<string, Json> => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: Json | undefined): Json[] => (Array.isArray(v) ? v : []);
const field = (v: Json | undefined, k: string): Json | undefined => (isObject(v) ? v[k] : undefined);

/** cmdutil.Difference: the items of a not in b. */
function difference(a: readonly string[], b: readonly string[]): string[] {
  return a.filter((x) => !b.includes(x));
}

function compGetResource(c: Client, type: string, toComplete: string, namespace?: string): string[] {
  return namesOf(c.get([type], namespace)).filter((n) => n.startsWith(toComplete));
}

function compGetContainers(c: Client, pod: string, toComplete: string): string[] {
  const obj = c.get(['pod', pod])[0];
  const spec = field(obj, 'spec');
  const names = [...arr(field(spec, 'initContainers')), ...arr(field(spec, 'containers'))].map((x) => field(x, 'name')).filter((n): n is string => typeof n === 'string' && n !== '');
  return names.filter((n) => n.startsWith(toComplete));
}

/** The `<exposed>:<port>` pairs of the pod's container ports or the service's ports. */
function compGetPorts(c: Client, kind: 'pod' | 'service', name: string, toComplete: string): string[] {
  const exposed = toComplete === '' ? undefined : (toComplete.split(':')[0] as string);
  const obj = c.get([kind, name])[0];
  const spec = field(obj, 'spec');
  const ports: string[] = [];
  if (kind === 'pod') {
    for (const ctr of arr(field(spec, 'containers'))) for (const p of arr(field(ctr, 'ports'))) ports.push(String(field(p, 'containerPort') ?? '<no value>'));
  } else for (const p of arr(field(spec, 'ports'))) ports.push(String(field(p, 'port') ?? '<no value>'));
  return ports.map((p) => `${exposed ?? p}:${p}`).filter((x) => x.startsWith(toComplete));
}

function compGetResourceList(c: Client, toComplete: string): string[] {
  const i = toComplete.lastIndexOf(',');
  const prefix = i < 0 ? '' : toComplete.slice(0, i + 1);
  const suffix = i < 0 ? toComplete : toComplete.slice(i + 1);
  return c.resourceTypes().filter((r) => r.startsWith(suffix)).map((r) => `${prefix}${r}`);
}

/**
 * convertResourceNameToPodName: a plain name is the pod's. For `<type>/<name>` kubectl asks
 * polymorphichelpers.AttachablePodForObjectFn; only pods are resolved here (see the report).
 */
function podNameOf(arg: string): string {
  if (!arg.includes('/')) return arg;
  const [type, name] = arg.split('/', 2) as [string, string];
  return ['pod', 'pods', 'po'].includes(type) ? name : '';
}

function resourceTypeAndName(make: MakeClient, allowedTypes: readonly string[] | undefined, allowRepeat: boolean): CompletionFn {
  return ({ rootValues: values, args, toComplete }) => {
    const c = make(values);
    let comps: string[] = [];
    let directive: number = NO_FILE;
    if (args.length > 0 && !(args[0] as string).includes('/')) {
      if (allowRepeat || args.length === 1) {
        comps = compGetResource(c, args[0] as string, toComplete);
        if (args.length > 1) comps = difference(comps, args.slice(1));
      }
    } else {
      const slash = toComplete.indexOf('/');
      if (slash < 0) {
        if (args.length === 0) {
          comps = allowedTypes === undefined ? compGetResourceList(c, toComplete) : allowedTypes.filter((t) => t.startsWith(toComplete));
        } else if (allowRepeat) {
          directive |= DIRECTIVE.noSpace;
          const types = allowedTypes === undefined ? compGetResourceList(c, toComplete) : allowedTypes.filter((t) => t.startsWith(toComplete));
          comps = types.map((t) => `${t}/`);
        }
      } else if (allowRepeat || args.length === 0) {
        const type = toComplete.slice(0, slash);
        comps = compGetResource(c, type, toComplete.slice(slash + 1)).map((n) => `${type}/${n}`);
        if (args.length > 0) comps = difference(comps, args);
      }
    }
    return { comps, directive };
  };
}

/** doPodResourceCompletion */
function podResource(c: Client, toComplete: string): Completions {
  let directive: number = NO_FILE;
  const slash = toComplete.indexOf('/');
  if (slash >= 0) {
    const type = toComplete.slice(0, slash);
    return { comps: compGetResource(c, type, toComplete.slice(slash + 1)).map((n) => `${type}/${n}`), directive };
  }
  const comps = compGetResource(c, 'pod', toComplete);
  if (comps.length === 0) directive |= DIRECTIVE.noSpace;
  const withPods = ['daemonsets', 'deployments', 'pods', 'jobs', 'replicasets', 'replicationcontrollers', 'services', 'statefulsets'];
  for (const r of withPods) if (r.startsWith(toComplete)) comps.push(`${r}/`);
  return { comps, directive };
}

const resourceName =
  (make: MakeClient, type: string): CompletionFn =>
  ({ rootValues: values, args, toComplete }) => ({ comps: args.length === 0 ? compGetResource(make(values), type, toComplete) : [], directive: NO_FILE });

const podResourceName =
  (make: MakeClient): CompletionFn =>
  ({ rootValues: values, args, toComplete }) =>
    args.length === 0 ? podResource(make(values), toComplete) : { comps: [], directive: NO_FILE };

const podResourceNameAndContainer =
  (make: MakeClient): CompletionFn =>
  ({ rootValues: values, args, toComplete }) => {
    if (args.length === 0) return podResource(make(values), toComplete);
    if (args.length === 1) return { comps: compGetContainers(make(values), podNameOf(args[0] as string), toComplete), directive: NO_FILE };
    return { comps: [], directive: NO_FILE };
  };

const containerFn =
  (make: MakeClient): CompletionFn =>
  ({ rootValues: values, args, toComplete }) => ({ comps: args.length > 0 ? compGetContainers(make(values), podNameOf(args[0] as string), toComplete) : [], directive: NO_FILE });

const resourceAndPort =
  (make: MakeClient): CompletionFn =>
  ({ rootValues: values, args, toComplete }) => {
    if (args.length === 0) return podResource(make(values), toComplete);
    if (args.length !== 1) return { comps: [], directive: NO_FILE };
    const t = (args[0] as string).split('/');
    const type = t.length === 1 ? 'pod' : (t[0] as string);
    if (type === 'service' || type === 'services' || type === 'svc') return { comps: compGetPorts(make(values), 'service', t[1] as string, toComplete), directive: NO_FILE };
    return { comps: compGetPorts(make(values), 'pod', podNameOf(args[0] as string), toComplete), directive: NO_FILE };
  };

const kubeconfigNames =
  (make: MakeClient, which: 'contexts' | 'clusters' | 'users'): CompletionFn =>
  ({ rootValues: values, args, toComplete }) => ({ comps: args.length === 0 ? make(values)[which]().filter((n) => n.startsWith(toComplete)) : [], directive: NO_FILE });

/** cp.go's ValidArgsFunction: `<namespace>/`, `<pod>:`, then local files. */
const cpFn =
  (make: MakeClient): CompletionFn =>
  ({ rootValues: values, args, toComplete }) => {
    const comps: string[] = [];
    if (args.length === 0) {
      const c = make(values);
      if (/^[/.~]/.test(toComplete)) {
        // looks like a path
      } else if (toComplete.includes(':')) {
        // remote files: not completed by kubectl either
      } else if (toComplete.indexOf('/') > 0) {
        const ns = toComplete.slice(0, toComplete.indexOf('/'));
        // template `{{ range .items }}{{ .metadata.namespace }}/{{ .metadata.name }}: {{ end }}`
        for (const o of c.get(['pod'], ns)) {
          const md = field(o, 'metadata');
          const s = `${String(field(md, 'namespace') ?? '<no value>')}/${String(field(md, 'name') ?? '<no value>')}:`;
          if (s.startsWith(toComplete)) comps.push(s);
        }
      } else {
        for (const ns of compGetResource(c, 'namespace', toComplete)) comps.push(`${ns}/`);
        for (const pod of compGetResource(c, 'pod', toComplete)) comps.push(`${pod}:`);
        if (comps.length > 0 && toComplete.length > 0) {
          for (const f of c.cwdEntries()) if (f.name.startsWith(toComplete)) comps.push(f.dir ? `${f.name}/` : f.name);
        } else if (toComplete.length === 0) comps.push('./', '/');
      }
    }
    return { comps, directive: DIRECTIVE.noSpace };
  };

/** The allowed -o formats of get, as its --output usage lists them (get_flags.go AllowedFormats). */
function getOutputFormats(): string[] {
  const usage = manifestCommand('get')?.flags.find((f) => f.name === 'output')?.usage ?? '';
  const m = /One of: \(([^)]*)\)/.exec(usage);
  return m ? (m[1] as string).split(', ') : [];
}

const EXPOSE = ['pod', 'service', 'replicationcontroller', 'deployment', 'replicaset'];
const SCALE = ['deployment', 'replicaset', 'replicationcontroller', 'statefulset'];
const ROLLOUT = ['deployment', 'daemonset', 'statefulset'];
const SET_IMAGE = ['daemonsets', 'deployments', 'pods', 'cronjobs', 'replicasets', 'replicationcontrollers', 'statefulsets'];

export function kubectlRegistrations(make: MakeClient): Registrations {
  const typeAndName = resourceTypeAndName(make, undefined, true);
  const args: Record<string, CompletionFn> = {
    get: typeAndName,
    debug: typeAndName,
    describe: typeAndName,
    delete: typeAndName,
    label: typeAndName,
    annotate: typeAndName,
    edit: typeAndName,
    patch: typeAndName,
    'apply edit-last-applied': typeAndName,
    'apply view-last-applied': typeAndName,
    'top pod': resourceName(make, 'pod'),
    'top node': resourceName(make, 'node'),
    cordon: resourceName(make, 'node'),
    uncordon: resourceName(make, 'node'),
    drain: resourceName(make, 'node'),
    'create token': resourceName(make, 'serviceaccount'),
    attach: podResourceName(make),
    exec: podResourceName(make),
    logs: podResourceNameAndContainer(make),
    'port-forward': resourceAndPort(make),
    cp: cpFn(make),
    autoscale: resourceTypeAndName(make, SCALE, true),
    scale: resourceTypeAndName(make, SCALE, true),
    taint: resourceTypeAndName(make, ['node'], true),
    expose: resourceTypeAndName(make, EXPOSE, true),
    'set image': resourceTypeAndName(make, SET_IMAGE, false),
    'rollout status': resourceTypeAndName(make, ROLLOUT, false),
    'rollout history': resourceTypeAndName(make, ROLLOUT, true),
    'rollout restart': resourceTypeAndName(make, ROLLOUT, true),
    'rollout undo': resourceTypeAndName(make, ROLLOUT, true),
    'rollout pause': resourceTypeAndName(make, ['deployment'], true),
    'rollout resume': resourceTypeAndName(make, ['deployment'], true),
    'config use-context': kubeconfigNames(make, 'contexts'),
    'config rename-context': kubeconfigNames(make, 'contexts'),
    'config set-context': kubeconfigNames(make, 'contexts'),
    'config delete-context': kubeconfigNames(make, 'contexts'),
    'config delete-user': kubeconfigNames(make, 'users'),
    'config delete-cluster': kubeconfigNames(make, 'clusters'),
  };
  const namespaceFn: CompletionFn = ({ rootValues: values, toComplete }) => ({ comps: compGetResource(make(values), 'namespace', toComplete), directive: NO_FILE });
  const globals: Record<string, CompletionFn> = {
    namespace: namespaceFn,
    context: (call: CompletionCall) => kubeconfigNames(make, 'contexts')({ ...call, args: [] }),
    cluster: (call: CompletionCall) => kubeconfigNames(make, 'clusters')({ ...call, args: [] }),
    user: (call: CompletionCall) => kubeconfigNames(make, 'users')({ ...call, args: [] }),
  };
  const local: Record<string, CompletionFn> = {
    'get --output': ({ toComplete }) => ({ comps: getOutputFormats().filter((f) => f.startsWith(toComplete)), directive: NO_FILE }),
    'create clusterrolebinding --clusterrole': ({ rootValues: values, toComplete }) => ({ comps: compGetResource(make(values), 'clusterrole', toComplete), directive: NO_FILE }),
    'config set-context --namespace': namespaceFn,
    'exec --container': containerFn(make),
    // kustomize's build command (sigs.k8s.io/kustomize/kustomize/v5, not in the fetched tree):
    // reference fixtures/golden/v1.37.2/completion/flags.yaml, both values whatever was typed.
    'kustomize --load-restrictor': () => ({ comps: ['LoadRestrictionsNone', 'LoadRestrictionsRootOnly'], directive: NO_FILE }),
  };
  for (const p of ['get', 'replace', 'edit', 'patch', 'apply']) local[`${p} --subresource`] = () => ({ comps: ['status', 'scale', 'resize'], directive: NO_FILE });
  const isLocal = (path: string, flag: string) => manifestCommand(path)?.flags.some((f) => f.name === flag) ?? false;
  return {
    validArgsFunction: (path) => args[path],
    validArgs: (path) => (path === 'completion' ? ['bash', 'zsh', 'fish', 'powershell'] : undefined),
    flagFunction(path, flag) {
      const own = local[`${path} --${flag}`];
      if (own) return own;
      // A command's own flag of the same name shadows the global one.
      if (isLocal(path, flag)) return undefined;
      return globals[flag];
    },
    filenameExt: (path, flag) => (flag === 'filename' && isLocal(path, flag) ? ['json', 'yaml', 'yml'] : undefined),
  };
}

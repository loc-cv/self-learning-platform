// Resource arguments to what to fetch: kubectl's resource.Builder for arguments (types, names,
// type/name pairs, comma-separated types, categories) and selectors. The plan is resolved before
// any object is fetched, so argument and mapping errors come first, as `r.Err()` returns them.
//   upstream: staging/src/k8s.io/cli-runtime/pkg/resource/builder.go ResourceTypeOrNameArgs,
//             normalizeMultipleResourcesArgs, hasCombinedTypeArgs, splitResourceTypeName,
//             ReplaceAliases, SplitResourceArgument, visitorResult, visitBySelector,
//             visitByResource, visitByName, resourceMappings, resourceTupleMappings
//   (filenames, -k and --raw are not simulated: the commands print a notice before building)

import { messageError, type KubectlError } from '../cli/errors.ts';
import { expandCategory, mappingFor, type Mapping } from '../client/restmapper.ts';

export interface BuilderInput {
  args: readonly string[];
  /** The request namespace (already resolved from the kubeconfig and -n). */
  namespace: string;
  allNamespaces: boolean;
  labelSelector?: string;
  fieldSelector?: string;
  /** SingleResourceType(): watch takes one type only. */
  singleResourceType?: boolean;
}

/** One request of the plan: a list (selector visit) or a get by name. */
export type Visit =
  | {
      kind: 'list';
      mapping: Mapping;
      namespace: string;
      labelSelector: string;
      fieldSelector: string;
      /** Named only through a category (`all`): a type the simulator does not store holds no objects. */
      fromCategory: boolean;
    }
  | { kind: 'get'; mapping: Mapping; namespace: string; name: string };

export interface Plan {
  visits: Visit[];
  /** Exactly one object named: errors are returned as they are and the object printed alone. */
  singleItemImplied: boolean;
}

const MISSING_RESOURCE = `You must provide one or more resources by argument or filename.
Example resource specifications include:
   '-f rsrc.yaml'
   '--filename=rsrc.json'
   '<resource> <name>'
   '<resource>'`;

export function splitResourceArgument(arg: string): string[] {
  const out: string[] = [];
  for (const s of arg.split(',')) if (!out.includes(s)) out.push(s);
  return out;
}

interface Tuple {
  resource: string;
  name: string;
}

function splitResourceTypeName(s: string): Tuple | undefined | KubectlError {
  if (!s.includes('/')) return undefined;
  const seg = s.split('/');
  if (seg.length !== 2) return messageError('arguments in resource/name form may not have more than one slash');
  const [resource, name] = seg as [string, string];
  if (resource === '' || name === '' || splitResourceArgument(resource).length !== 1) {
    return messageError('arguments in resource/name form must have a single resource and name');
  }
  return { resource, name };
}

function isError(v: unknown): v is KubectlError {
  return typeof v === 'object' && v !== null && 'type' in v;
}

/** ReplaceAliases: each category among comma-separated types becomes its members. */
function replaceAliases(input: string, fromCategory: Set<string>): string {
  const explicit = new Set<string>();
  const out = input
    .split(',')
    .map((arg) => {
      const members = expandCategory(arg);
      if (!members) {
        explicit.add(arg);
        return arg;
      }
      for (const m of members) fromCategory.add(m);
      return members.join(',');
    })
    .join(',');
  for (const e of explicit) fromCategory.delete(e);
  return out;
}

/**
 * The argument errors ResourceTypeOrNameArgs records before any request (hasCombinedTypeArgs,
 * splitResourceTypeName): kubectl reports them without contacting the server.
 */
export function argumentError(args: readonly string[]): KubectlError | undefined {
  let a = [...args];
  if (a.length >= 2) {
    const resources = splitResourceArgument(a[0] as string);
    if (resources.length > 1) a = resources.flatMap((r) => a.slice(1).map((n) => `${r}/${n}`));
  }
  const slashes = a.filter((x) => x.includes('/')).length;
  if (slashes === 0) return undefined;
  if (slashes !== a.length) {
    return messageError(
      "there is no need to specify a resource type as a separate argument when passing arguments in resource/name form (e.g. 'kubectl get resource/<resource_name>' instead of 'kubectl get resource resource/<resource_name>'",
    );
  }
  for (const s of a) {
    const t = splitResourceTypeName(s);
    if (isError(t)) return t;
  }
  return undefined;
}

export function buildPlan(input: BuilderInput): Plan | KubectlError {
  let args = [...input.args];
  // normalizeMultipleResourcesArgs: `a,b x y` → a/x a/y b/x b/y
  if (args.length >= 2) {
    const resources = splitResourceArgument(args[0] as string);
    if (resources.length > 1) {
      const names = args.slice(1);
      args = resources.flatMap((r) => names.map((n) => `${r}/${n}`));
    }
  }
  const tuples: Tuple[] = [];
  let resources: string[] = [];
  let names: string[] = [];
  let labelSelector = input.labelSelector;
  const fromCategory = new Set<string>();
  const slashes = args.filter((a) => a.includes('/')).length;
  if (slashes > 0) {
    if (slashes !== args.length) {
      return messageError(
        "there is no need to specify a resource type as a separate argument when passing arguments in resource/name form (e.g. 'kubectl get resource/<resource_name>' instead of 'kubectl get resource resource/<resource_name>'",
      );
    }
    for (const s of args) {
      const t = splitResourceTypeName(s);
      if (isError(t)) return t;
      if (t) tuples.push(t);
    }
  } else if (args.length > 0) {
    args[0] = replaceAliases(args[0] as string, fromCategory);
    resources = splitResourceArgument(args[0] as string);
    names = args.slice(1);
    // ResourceTypeOrNameArgs(allowEmptySelector=true) with only a type selects everything.
    if (args.length === 1 && labelSelector === undefined) labelSelector = '';
  }

  const fieldSelector = input.fieldSelector;
  const nsFor = (m: Mapping) => (m.namespaced ? (input.allNamespaces ? '' : input.namespace) : '');

  // visitorResult
  if (labelSelector !== undefined || fieldSelector !== undefined) {
    if (names.length !== 0) return messageError('name cannot be provided when a selector is specified');
    if (tuples.length !== 0) return messageError('selectors and the all flag cannot be used when passing resource/name arguments');
    if (resources.length === 0) return messageError('at least one resource must be specified to use a selector');
    if (input.singleResourceType && resources.length > 1) return messageError('you may only specify a single resource type');
    const mappings: { m: Mapping; category: boolean }[] = [];
    for (const r of resources) {
      const m = mappingFor(r);
      if (isError(m)) return m;
      const seen = mappings.find((x) => x.m.group === m.group && x.m.version === m.version && x.m.kind === m.kind);
      if (seen) {
        if (!fromCategory.has(r)) seen.category = false;
        continue;
      }
      mappings.push({ m, category: fromCategory.has(r) });
    }
    return {
      singleItemImplied: false,
      visits: mappings.map(({ m, category }) => ({
        kind: 'list',
        mapping: m,
        namespace: nsFor(m),
        labelSelector: labelSelector ?? '',
        fieldSelector: fieldSelector ?? '',
        fromCategory: category,
      })),
    };
  }
  if (tuples.length !== 0) {
    if (resources.length !== 0) return messageError('you may not specify individual resources and bulk resources in the same call');
    const mappings = new Map<string, Mapping>();
    for (const t of tuples) {
      if (mappings.has(t.resource)) continue;
      const m = mappingFor(t.resource);
      if (isError(m)) return m;
      mappings.set(t.resource, m);
    }
    if (input.singleResourceType && new Set([...mappings.values()].map((m) => `${m.group}/${m.version}/${m.resource}`)).size > 1) {
      return messageError('you may only specify a single resource type');
    }
    const visits: Visit[] = [];
    for (const t of tuples) {
      const m = mappings.get(t.resource) as Mapping;
      const ns = nsFor(m);
      if (m.namespaced && ns === '') {
        return messageError(input.allNamespaces ? 'a resource cannot be retrieved by name across all namespaces' : 'namespace may not be empty when retrieving a resource by name');
      }
      visits.push({ kind: 'get', mapping: m, namespace: ns, name: t.name });
    }
    return { singleItemImplied: tuples.length === 1, visits };
  }
  if (names.length !== 0) {
    if (resources.length === 0) return messageError('you must provide a resource and a resource name together');
    if (resources.length > 1) return messageError('you must specify only one resource');
    const m = mappingFor(resources[0] as string);
    if (isError(m)) return m;
    const ns = nsFor(m);
    if (m.namespaced && ns === '') {
      return messageError(input.allNamespaces ? 'a resource cannot be retrieved by name across all namespaces' : 'namespace may not be empty when retrieving a resource by name');
    }
    return { singleItemImplied: names.length === 1, visits: names.map((name) => ({ kind: 'get', mapping: m, namespace: ns, name })) };
  }
  if (resources.length !== 0) {
    for (const r of resources) {
      const m = mappingFor(r);
      if (isError(m)) return m;
    }
    return messageError('resource(s) were provided, but no name was specified');
  }
  return messageError(MISSING_RESOURCE);
}

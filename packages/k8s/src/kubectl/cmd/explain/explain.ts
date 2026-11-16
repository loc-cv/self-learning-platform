// kubectl explain: the documentation of a resource or of a field path in it, rendered from the
// OpenAPI v3 document the API server serves for the resource's group version.
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/explain/explain.go AddFlags, Validate (the
//             argument and --max-depth errors), Run (the mapper first; --api-version replaces the
//             group and version after it; plaintext-openapiv2 renders the OpenAPI v2 document;
//             other formats go to the v3 generator)
//   upstream: staging/src/k8s.io/kubectl/pkg/explain/explain.go SplitAndParseResourceRequest,
//             SplitAndParseResourceRequestWithMatchingPrefix (the first resource whose
//             `resource.group` prefixes the argument, else the first one)
//   upstream: staging/src/k8s.io/kubectl/pkg/explain/v2/explain.go printModelDescriptionWithGenerator
//             (`couldn't find resource for "<gvr>"`), generator.go Render
//   upstream: staging/src/k8s.io/apimachinery/pkg/runtime/schema/group_version.go ParseGroupVersion
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/util/helpers.go checkErr (a NoResourceMatchError
//             is printed without `error: `), printing.go SuggestAPIResources
//   fixtures/golden/v1.37.2/explain/*.yaml (the outputs and errors; with nothing listening,
//             discovery logs its failure twice before the connection error, no-server.yaml)

import type { Op } from '@simlab/host';
import { getOpenApiV3 } from '../../../apiserver/openapi.ts';
import { isObject, type JsonObject } from '../../../apimachinery/json.ts';
import { registry } from '../../../discovery/registry.ts';
import type { Invocation, Verb } from '../../cli/command.ts';
import { messageError } from '../../cli/errors.ts';
import type { FlagDef } from '../../cli/flagset.ts';
import { resourcesFor, type Mapping } from '../../client/restmapper.ts';
import { fail, overridesOf, resolveConfig } from '../../client/session.ts';
import { discoveryError, openServer } from '../../resource/server.ts';
import { parseYaml } from '../printing.ts';
import { jsonPathParse, type PathNode } from './fieldpath.ts';
import { ExplainError, gvrString, renderPlaintext, type Gvr } from './template.ts';

const FLAGS: FlagDef[] = [
  { name: 'recursive', shorthand: 'R', kind: 'bool', default: false },
  { name: 'api-version', kind: 'string', default: '' },
  { name: 'output', shorthand: 'o', kind: 'string', default: 'plaintext' },
  { name: 'max-depth', kind: 'int', default: 0 },
];

const PLAINTEXT = 'plaintext';
const PLAINTEXT_OPENAPIV2 = 'plaintext-openapiv2';

type Request = { gvr: Gvr; fields: string[] } | { error: string } | { noMatch: string } | { unsupported: string };

const gvrOf = (m: Mapping): Gvr => ({ group: m.group, version: m.version, resource: m.resource });

/** The field names of nodes, or the error for the first node that is not a field. */
function fieldsOf(nodes: readonly PathNode[], error: string): string[] | { error: string } {
  const out: string[] = [];
  for (const n of nodes) {
    if (n.type !== 'field') return { error };
    out.push(n.value);
  }
  return out;
}

function parse(arg: string): { nodes: PathNode[]; resource: string } | Exclude<Request, { gvr: Gvr }> {
  const parsed = jsonPathParse(arg);
  if (parsed === null) return { unsupported: `the field path syntax of "${arg}"` };
  if ('error' in parsed) return parsed;
  const first = parsed.nodes[0] as PathNode;
  if (first.type !== 'field') return { error: 'invalid jsonpath syntax, first node must be field node' };
  if (first.value === '') return { unsupported: 'an empty resource name' };
  return { nodes: parsed.nodes, resource: first.value };
}

/** SplitAndParseResourceRequestWithMatchingPrefix */
function withMatchingPrefix(arg: string): Request {
  const p = parse(arg);
  if (!('nodes' in p)) return p;
  const gvrs = resourcesFor(p.resource);
  if (gvrs.length === 0) return { noMatch: p.resource };
  const notField = 'invalid jsonpath syntax, first node must be field node';
  for (const m of gvrs) {
    const groupResource = m.group === '' ? m.resource : `${m.resource}.${m.group}`;
    if (!arg.startsWith(groupResource)) continue;
    const suffix = arg.slice(groupResource.length);
    let fields: string[] = [];
    if (suffix.length > 0) {
      const s = jsonPathParse(suffix);
      if (s === null) return { unsupported: `the field path syntax of "${arg}"` };
      if ('error' in s) return s;
      if (s.nodes.length > 0) {
        const f = fieldsOf(s.nodes.slice(1), notField);
        if (!Array.isArray(f)) return f;
        fields = f;
      }
    }
    return { gvr: gvrOf(m), fields };
  }
  const f = fieldsOf(p.nodes.slice(1), notField);
  if (!Array.isArray(f)) return f;
  return { gvr: gvrOf(gvrs[0] as Mapping), fields: f };
}

/**
 * PriorityRESTMapper.ResourceFor: of the matches, the first by group priority (discovery order),
 * the preferred version before the others.
 *   upstream: staging/src/k8s.io/apimachinery/pkg/api/meta/priority.go ResourceFor
 */
function priorityFirst(ms: Mapping[]): Mapping | undefined {
  const groups = registry().groups;
  const rank = (m: Mapping): number => {
    const gi = groups.findIndex((g) => g.name === m.group);
    const g = groups[gi];
    const vi = g ? (g.preferred === m.version ? -1 : g.versions.indexOf(m.version)) : 0;
    return gi * 1000 + vi;
  };
  return [...ms].sort((a, b) => rank(a) - rank(b))[0];
}

/** SplitAndParseResourceRequest */
function plainRequest(arg: string): Request {
  const p = parse(arg);
  if (!('nodes' in p)) return p;
  const m = priorityFirst(resourcesFor(p.resource));
  if (!m) return { noMatch: p.resource };
  const f = fieldsOf(p.nodes.slice(1), 'invalid jsonpath syntax, all nodes must be field nodes');
  if (!Array.isArray(f)) return f;
  return { gvr: gvrOf(m), fields: f };
}

/** schema.ParseGroupVersion */
function parseGroupVersion(gv: string): { group: string; version: string } | { error: string } {
  if (gv === '' || gv === '/') return { group: '', version: '' };
  const slashes = gv.split('/').length - 1;
  if (slashes === 0) return { group: '', version: gv };
  if (slashes === 1) return { group: gv.slice(0, gv.indexOf('/')), version: gv.slice(gv.indexOf('/') + 1) };
  return { error: `unexpected GroupVersion string: ${gv}` };
}

function* run(inv: Invocation): Op<number> {
  const { p, flags, args } = inv;
  const v = flags.values;
  const config = resolveConfig(p, overridesOf(v), parseYaml);
  if ('type' in config) return yield* fail(p, config);
  const recursive = v.recursive === true;
  const maxDepth = v['max-depth'] as number;
  const apiVersion = v['api-version'] as string;
  const output = v.output as string;
  // Validate
  if (args.length === 0) {
    return yield* fail(p, messageError('You must specify the type of resource to explain. Use "kubectl api-resources" for a complete list of supported resources.\n'));
  }
  if (args.length > 1) return yield* fail(p, messageError('We accept only this format: explain RESOURCE\n'));
  if (maxDepth > 0 && !recursive) return yield* fail(p, messageError('--max-depth requires --recursive'));
  if (maxDepth < 0) return yield* fail(p, messageError('--max-depth must be non-negative'));
  // Run: the mapper (discovery)
  const server = yield* openServer(p, config);
  if (typeof server === 'number') return server;
  const arg = args[0] as string;
  if ('refused' in server) {
    // The argument is parsed before the mapper asks discovery, which fails.
    const pre = parse(arg);
    if ('unsupported' in pre) return yield* p.unsupported({ kind: 'syntax', what: pre.unsupported });
    if ('error' in pre) return yield* fail(p, messageError(pre.error));
    yield* discoveryError(p, server);
    yield* discoveryError(p, server);
    const u = server.refused;
    return yield* fail(p, { type: 'url', op: 'Get', url: `${u.base}/api?timeout=32s`, err: `dial tcp ${u.dialAddress}: connect: connection refused` });
  }
  const req = apiVersion === '' ? withMatchingPrefix(arg) : plainRequest(arg);
  if ('unsupported' in req) return yield* p.unsupported({ kind: 'syntax', what: req.unsupported });
  if ('error' in req) return yield* fail(p, messageError(req.error));
  if ('noMatch' in req) {
    yield* p.write(2, `the server doesn't have a resource type "${req.noMatch}"\n`);
    return 1;
  }
  if (output === PLAINTEXT_OPENAPIV2) return yield* p.unsupported({ kind: 'output-format', what: `the output format "${PLAINTEXT_OPENAPIV2}"` });
  const gvr = { ...req.gvr };
  if (apiVersion !== '') {
    const gv = parseGroupVersion(apiVersion);
    if ('error' in gv) return yield* fail(p, messageError(gv.error));
    gvr.group = gv.group;
    gvr.version = gv.version;
  }
  // PrintModelDescription: Paths, the group version's document, then the template.
  const s = server.session;
  const index = getOpenApiV3(s.server, '/openapi/v3');
  if (!index.ok) throw new Error('explain: the API server serves no OpenAPI v3 index');
  const paths = (index.object as JsonObject).paths as JsonObject;
  const resourcePath = gvr.group === '' ? `api/${gvr.version}` : `apis/${gvr.group}/${gvr.version}`;
  const entry = paths[resourcePath];
  if (!isObject(entry)) return yield* fail(p, messageError(`couldn't find resource for "${gvrString(gvr)}"`));
  const docResponse = getOpenApiV3(s.server, entry.serverRelativeURL as string);
  if (!docResponse.ok) {
    if ('notSimulated' in docResponse) return yield* p.unsupported({ kind: 'behavior', what: docResponse.notSimulated });
    throw new Error(`explain: ${resourcePath}: ${docResponse.code}`);
  }
  if (output !== PLAINTEXT) return yield* fail(p, messageError(`unrecognized format: ${output}`));
  const r = renderPlaintext({ document: docResponse.object as JsonObject, gvr, fieldPath: req.fields, recursive, maxDepth });
  if (r.text !== '') yield* p.write(1, r.text);
  if (!r.error) return 0;
  if (r.error instanceof ExplainError) return yield* fail(p, messageError(r.error.message));
  return yield* p.unsupported({ kind: 'internal', what: `explain's template: ${r.error.message}` });
}

export const explainVerb: Verb = {
  path: 'explain',
  flags: FLAGS,
  partial: { output: `${PLAINTEXT_OPENAPIV2} (the OpenAPI v2 renderer)` },
  outputFormats: { allowed: [PLAINTEXT, PLAINTEXT_OPENAPIV2], simulated: [PLAINTEXT] },
  run,
};

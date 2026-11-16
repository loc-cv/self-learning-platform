// kubectl cluster-info: the control plane's address and the Services labelled
// kubernetes.io/cluster-service=true in kube-system (or the namespace of -n), with their proxy URLs.
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/clusterinfo/clusterinfo.go Complete (the namespace
//             flag, else kube-system; arguments are not checked), Run (the builder's list of
//             services by label, printService, the closing "cluster-info dump" line written
//             before the error is returned)
//   upstream: staging/src/k8s.io/apimachinery/pkg/util/net/port_split.go JoinSchemeNamePort
//   fixtures/golden/v1.37.2/info/cluster-info.yaml, info/no-server.yaml, client/no-server.yaml
// The output has no terminal colors at this pin: printService writes plain text.
// `cluster-info dump` is not simulated (its command prints a notice).

import type { JsonObject } from '../../../apimachinery/json.ts';
import type { Invocation, Op, Verb } from '../../cli/command.ts';
import { fail, klogLine, overridesOf, request, resolveConfig } from '../../client/session.ts';
import { openServer } from '../../resource/server.ts';
import { parseYaml } from '../printing.ts';

const DUMP_HINT = "\nTo further debug and diagnose cluster problems, use 'kubectl cluster-info dump'.\n";

/** utilnet.JoinSchemeNamePort */
function joinSchemeNamePort(scheme: string, name: string, port: string): string {
  if (scheme !== '') return `${scheme}:${name}:${port}`;
  if (port !== '') return `${name}:${port}`;
  return name;
}

function serviceLine(host: string, svc: JsonObject): string {
  const meta = (svc.metadata ?? {}) as JsonObject;
  const spec = (svc.spec ?? {}) as JsonObject;
  const ports = (spec.ports as JsonObject[] | undefined) ?? [];
  const ingress = ((((svc.status ?? {}) as JsonObject).loadBalancer ?? {}) as JsonObject).ingress as JsonObject[] | undefined;
  const svcName = (meta.name as string | undefined) ?? '';
  let link = '';
  if (ingress && ingress.length > 0) {
    const first = ingress[0] as JsonObject;
    const ip = (first.ip as string | undefined) || ((first.hostname as string | undefined) ?? '');
    for (const port of ports) link += `http://${ip}:${String(port.port)} `;
  } else {
    let name = svcName;
    if (ports.length > 0) {
      const port = ports[0] as JsonObject;
      const portName = (port.name as string | undefined) ?? '';
      // "guess if the scheme is https"
      const scheme = portName === 'https' || port.port === 443 ? 'https' : '';
      name = joinSchemeNamePort(scheme, svcName, portName);
    }
    // The REST config's GroupVersion is the core v1 of kubectl's defaults.
    link = `${host}/api/v1/namespaces/${(meta.namespace as string | undefined) ?? ''}/services/${name}/proxy`;
  }
  const labels = (meta.labels ?? {}) as JsonObject;
  const shown = (labels['kubernetes.io/name'] as string | undefined) || svcName;
  return `${shown} is running at ${link}\n`;
}

function* run({ p, flags }: Invocation): Op<number> {
  const v = flags.values;
  const config = resolveConfig(p, overridesOf(v), parseYaml);
  if ('type' in config) return yield* fail(p, config);
  // cmdutil.GetFlagString(cmd, "namespace"): the flag, not the kubeconfig's namespace.
  const namespace = (v.namespace as string) || 'kube-system';
  const state = yield* openServer(p, config);
  if (typeof state === 'number') return state;
  if ('refused' in state) {
    // The builder's REST mapping retries discovery: five failed group list requests are logged.
    const url = `${state.refused.base}/api?timeout=32s`;
    const err = `dial tcp ${state.refused.dialAddress}: connect: connection refused`;
    const line = klogLine(p, 'E', 'memcache.go:381', `"Couldn't get current server API group list" err="Get \\"${url}\\": ${err}"`);
    yield* p.write(2, line.repeat(5));
    yield* p.write(1, DUMP_HINT);
    return yield* fail(p, { type: 'url', op: 'Get', url, err });
  }
  const r = yield* request(state.session, {
    verb: 'list',
    group: '',
    version: 'v1',
    resource: 'services',
    namespace,
    options: { labelSelector: 'kubernetes.io/cluster-service=true' },
  });
  if (!r.ok) {
    if ('notSimulated' in r) return yield* p.unsupported({ kind: 'behavior', what: r.notSimulated });
    yield* p.write(1, DUMP_HINT);
    return yield* fail(p, { type: 'status', status: r.status });
  }
  // rest.Config.Host: the server as the kubeconfig (or --server) names it.
  let out = `Kubernetes control plane is running at ${config.server}\n`;
  for (const svc of ((r.object as JsonObject).items as JsonObject[] | undefined) ?? []) out += serviceLine(config.server, svc);
  yield* p.write(1, out + DUMP_HINT);
  return 0;
}

export const clusterInfoVerb: Verb = {
  path: 'cluster-info',
  flags: [],
  run,
};

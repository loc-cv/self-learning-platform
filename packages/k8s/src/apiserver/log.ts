// GET pods/<name>/log: the API server's LogREST. It validates the PodLogOptions, finds the Pod and
// the container (LogLocation), finds the node's kubelet from the Node object (address and port),
// and streams what the kubelet answers. A Pod with no node gets no content (204); a kubelet it
// cannot reach is the dial error as a Status without a reason; the kubelet's own errors come back
// as BadRequests. Separate from `handle`, as watches are: the answer is a byte stream, not an object.
//   upstream: pkg/registry/core/pod/rest/log.go LogREST.Get (ValidatePodLogOptions → Invalid PodLogOptions)
//   upstream: pkg/apis/core/validation/validation.go ValidatePodLogOptions
//   upstream: pkg/registry/core/pod/strategy.go LogLocation, validateContainer, podHasContainerWithName
//   upstream: pkg/kubelet/client/kubelet_client.go GetConnectionInfo (preferred address, the Node's
//             daemonEndpoints port, https); pkg/util/node/node.go GetPreferredNodeAddress, NoMatchError;
//             kubeadm's --kubelet-preferred-address-types=InternalIP,ExternalIP,Hostname
//             (cmd/kubeadm/app/phases/controlplane/manifests.go)
//   upstream: staging/src/k8s.io/apiserver/pkg/registry/generic/rest/streamer.go InputStream (no
//             location: no stream; a failed client.Do is returned as it is) and response_checker.go
//             (a 400 from the kubelet becomes NewBadRequest(body));
//             endpoints/handlers/responsewriters/status.go ErrorToAPIStatus (a plain error: 500, no reason)
//   The dial error is Go's: net/url Error `Get "<url>": <err>`, net OpError `dial tcp <addr>: connect: connection refused`.

import type { Ctx } from '@simlab/kernel';
import { getMachine, hostSlice } from '@simlab/host';
import { badRequestError, invalidError, unknownStatusError, type Status } from '../apimachinery/errors.ts';
import { forbidden, invalid, newPath, type FieldError } from '../apimachinery/field.ts';
import { isObject, type Json, type JsonObject } from '../apimachinery/json.ts';
import { isKubeletRunning } from '../kubelet/kubelet.ts';
import { openContainerLog, readContainerLog, type LogStream } from '../kubelet/logs.ts';
import { KUBELET_PORT } from '../topology/nodes.ts';
import type { ApiServerConfig } from './config.ts';
import { handle } from './pipeline.ts';

/** core/v1 PodLogOptions as kubectl sends them (absent fields are unset). */
export interface PodLogOptions {
  container?: string;
  follow?: boolean;
  previous?: boolean;
  timestamps?: boolean;
  sinceSeconds?: number;
  /** RFC 3339 in whole seconds (metav1.Time on the query string). */
  sinceTime?: string;
  tailLines?: number;
  limitBytes?: number;
  insecureSkipTLSVerifyBackend?: boolean;
}

export type PodLogOpen =
  | { status: Status }
  /** No location: the Pod has no node yet; the answer has no content. */
  | { empty: true }
  | { stream: LogStream }
  | { notSimulated: string };

const str = (v: Json | undefined): string => (typeof v === 'string' ? v : '');
const obj = (v: Json | undefined): JsonObject => (isObject(v) ? v : {});

/** kube-apiserver --kubelet-preferred-address-types as kubeadm sets it. */
const PREFERRED_ADDRESS_TYPES = ['InternalIP', 'ExternalIP', 'Hostname'];

export function validatePodLogOptions(o: PodLogOptions): FieldError[] {
  const errs: FieldError[] = [];
  if (o.tailLines !== undefined && o.tailLines < 0) errs.push(invalid(newPath('tailLines'), o.tailLines, 'must be greater than or equal to 0'));
  if (o.limitBytes !== undefined && o.limitBytes < 1) errs.push(invalid(newPath('limitBytes'), o.limitBytes, 'must be greater than 0'));
  if (o.sinceSeconds !== undefined && o.sinceTime !== undefined) errs.push(forbidden(newPath(''), 'at most one of `sinceTime` or `sinceSeconds` may be specified'));
  else if (o.sinceSeconds !== undefined && o.sinceSeconds < 1) errs.push(invalid(newPath('sinceSeconds'), o.sinceSeconds, 'must be greater than 0'));
  return errs;
}

/** The names of the Pod's containers in VisitContainers order: init, regular, ephemeral. */
function containerNames(spec: JsonObject): string[] {
  const names = (k: string): string[] => (Array.isArray(spec[k]) ? (spec[k] as Json[]).filter(isObject).map((c) => str(c.name)) : []);
  return [...names('initContainers'), ...names('containers'), ...names('ephemeralContainers')];
}

/** validateContainer: the container the request means, or its BadRequest. */
function validateContainer(pod: JsonObject, container: string): string | Status {
  const name = str(obj(pod.metadata).name);
  const spec = obj(pod.spec);
  const containers = Array.isArray(spec.containers) ? (spec.containers as Json[]).filter(isObject) : [];
  if (container === '') {
    if (containers.length === 1) return str((containers[0] as JsonObject).name);
    if (containers.length === 0) return badRequestError(`a container name must be specified for pod ${name}`);
    // %s of a []string: [a b c]
    return badRequestError(`a container name must be specified for pod ${name}, choose one of: [${containerNames(spec).join(' ')}]`);
  }
  if (!containerNames(spec).includes(container)) return badRequestError(`container ${container} is not valid for pod ${name}`);
  return container;
}

/** url.Values.Encode of LogLocation's parameters: keys sorted, values query-escaped. */
function logQuery(o: PodLogOptions): string {
  const params: [string, string][] = [];
  if (o.follow) params.push(['follow', 'true']);
  if (o.previous) params.push(['previous', 'true']);
  if (o.timestamps) params.push(['timestamps', 'true']);
  if (o.sinceSeconds !== undefined) params.push(['sinceSeconds', String(o.sinceSeconds)]);
  if (o.sinceTime !== undefined) params.push(['sinceTime', o.sinceTime]);
  if (o.tailLines !== undefined) params.push(['tailLines', String(o.tailLines)]);
  if (o.limitBytes !== undefined) params.push(['limitBytes', String(o.limitBytes)]);
  params.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const esc = (s: string) => encodeURIComponent(s).replace(/%20/g, '+');
  return params.map(([k, v]) => `${k}=${esc(v)}`).join('&');
}

/** The machine an address reaches, if the simulator knows it. */
function machineAt(ctx: Ctx, address: string): string | undefined {
  const machines = hostSlice(ctx).machines;
  for (const id of Object.keys(machines).sort()) if (machines[id]?.addresses?.includes(address)) return id;
  return undefined;
}

/** Opens a log request for Pod `name` in `namespace`. */
export function openPodLog(ctx: Ctx, server: ApiServerConfig, namespace: string, name: string, o: PodLogOptions): PodLogOpen {
  const errs = validatePodLogOptions(o);
  if (errs.length > 0) return { status: invalidError({ group: '', kind: 'PodLogOptions' }, name, errs) };
  const got = handle(ctx, server, { verb: 'get', group: '', version: 'v1', resource: 'pods', namespace, name });
  if (!got.ok) return 'notSimulated' in got ? { notSimulated: got.notSimulated } : { status: got.status };
  const pod = got.object as JsonObject;
  const container = validateContainer(pod, o.container ?? '');
  if (typeof container !== 'string') return { status: container };
  const nodeName = str(obj(pod.spec).nodeName);
  if (nodeName === '') return { empty: true };
  // GetConnectionInfo
  const n = handle(ctx, server, { verb: 'get', group: '', version: 'v1', resource: 'nodes', name: nodeName });
  if (!n.ok) return 'notSimulated' in n ? { notSimulated: n.notSimulated } : { status: n.status };
  const nodeStatus = obj((n.object as JsonObject).status);
  const addresses = Array.isArray(nodeStatus.addresses) ? (nodeStatus.addresses as Json[]).filter(isObject) : [];
  let host: string | undefined;
  for (const t of PREFERRED_ADDRESS_TYPES) {
    host = addresses.map((a) => (str(a.type) === t ? str(a.address) : undefined)).find((a) => a !== undefined);
    if (host !== undefined) break;
  }
  if (host === undefined) {
    // NoMatchError's %v of []v1.NodeAddress: [{InternalIP 10.0.0.1} {Hostname cp1}]
    const known = addresses.map((a) => `{${str(a.type)} ${str(a.address)}}`).join(' ');
    return { status: unknownStatusError(`no preferred addresses found; known addresses: [${known}]`) };
  }
  const port0 = Number(obj(obj(nodeStatus.daemonEndpoints).kubeletEndpoint).Port ?? 0);
  const port = port0 > 0 ? port0 : KUBELET_PORT;
  const query = logQuery(o);
  const url = `https://${host}:${port}/containerLogs/${namespace}/${name}/${container}${query ? `?${query}` : ''}`;
  // The dial: the machine behind the address, its kubelet listening on 10250.
  const machine = machineAt(ctx, host);
  if (machine === undefined) return { notSimulated: `connecting to the kubelet at ${host}` };
  if (getMachine(ctx, machine).boot.state !== 'running') return { notSimulated: 'connecting to a machine that is off' };
  if (!isKubeletRunning(ctx, machine) || port !== KUBELET_PORT) {
    return { status: unknownStatusError(`Get "${url}": dial tcp ${host}:${port}: connect: connection refused`) };
  }
  // The kubelet: its pod manager has the Pod bound to its node; the 400s it answers with.
  const r = openContainerLog(ctx, machine, pod, container, {
    follow: o.follow === true,
    previous: o.previous === true,
    timestamps: o.timestamps === true,
    ...(o.sinceSeconds !== undefined ? { sinceSeconds: o.sinceSeconds } : {}),
    ...(o.sinceTime !== undefined ? { sinceTime: o.sinceTime } : {}),
    ...(o.tailLines !== undefined ? { tailLines: o.tailLines } : {}),
    ...(o.limitBytes !== undefined ? { limitBytes: o.limitBytes } : {}),
  });
  if ('error' in r) return { status: badRequestError(r.error) };
  return { stream: r.stream };
}

/**
 * Reads what the stream has now. It is done when the kubelet ended it, or when the kubelet is no
 * longer running: its connections close, and the API server ends the response (StreamObject
 * ignores io.Copy's error), which the client reads as the end of the logs.
 */
export function readPodLog(ctx: Ctx, stream: LogStream): { data: string; stream: LogStream } {
  if (!isKubeletRunning(ctx, stream.node)) return { data: '', stream: { ...stream, done: true } };
  return readContainerLog(ctx, stream);
}

// What a node's runtime holds when the simulation starts on a cluster kubeadm set up a few minutes
// earlier: the images kubeadm and the kubelet pulled, and the running sandboxes and containers of
// the Pods the node already runs (the control plane's static Pods, kube-proxy). The kubelet adopts
// them when it starts and writes their status, as a restarted kubelet does. Only the topology
// builder calls this (STATUS.md, temporary shortcuts: phase 27 starts static Pods from their
// manifests through the kubelet, phase 18a's DaemonSet controller creates kube-proxy's Pods).

import type { Ctx } from '@simlab/kernel';
import { isObject, type Json, type JsonObject } from '../apimachinery/json.ts';
import type { ApiObject } from '../apiserver/store.ts';
import { capturedById, preloaded } from '../runtime/images/catalog.ts';
import { imageView } from '../runtime/images/files.ts';
import { parseImageName, type ImageName } from '../runtime/images/reference.ts';
import { containerLogPath } from '../runtime/logs.ts';
import { addImage, createContainer, findLocalImage, runPodSandbox, startProcess } from '../runtime/runtime.ts';
import { containerProcess } from './env.ts';
import type { KubeletNode } from './kubelet.ts';
import { hashString } from '@simlab/kernel';

const str = (v: Json | undefined): string => (typeof v === 'string' ? v : '');
const obj = (v: Json | undefined): JsonObject => (isObject(v) ? v : {});

/** Puts `repository:tag` into the node's image store as pulled earlier. */
export function preloadImage(ctx: Ctx, node: string, repository: string, tag: string): void {
  addImage(ctx, node, preloaded(repository, tag));
}

/** The runtime state of `pod` running on `node` since now: sandbox, containers, processes. */
export function seedRunningPod(ctx: Ctx, node: KubeletNode, pod: ApiObject, services: ApiObject[]): void {
  const m = obj(pod.metadata as Json);
  const spec = obj(pod.spec as Json);
  const hostNetwork = spec.hostNetwork === true;
  const sb = runPodSandbox(ctx, node.name, {
    podUID: str(m.uid),
    namespace: str(m.namespace),
    name: str(m.name),
    hostNetwork,
    nodeIP: node.ip,
    podCIDR: node.podCIDR,
    hostname: hostNetwork ? node.name : str(m.name),
  });
  for (const c of (Array.isArray(spec.containers) ? spec.containers : []).filter(isObject) as JsonObject[]) {
    const n = parseImageName(str(c.image)) as ImageName;
    const local = findLocalImage(ctx, node.name, n);
    if (!local) throw new Error(`seeding ${str(m.name)}: image ${str(c.image)} is not on ${node.name}`);
    const img = capturedById(local.id);
    if (!img) throw new Error(`seeding ${str(m.name)}: image ${str(c.image)} is not in the catalog`);
    const name = str(c.name);
    const ctr = createContainer(ctx, node.name, {
      sandbox: sb,
      name,
      attempt: 0,
      imageRef: str(c.image),
      image: local,
      imageName: local.repoTags[0] ?? local.id,
      imageDigest: local.repoDigests[0] ?? local.id,
      hash: hashString(JSON.stringify(c)),
      logPath: containerLogPath(str(m.namespace), str(m.name), str(m.uid), name, 0),
    });
    const proc = containerProcess(pod, c, img, services, sb.hostname);
    const v = imageView(local.id);
    const exe = v.which(proc.env, proc.argv[0] ?? '');
    if (!exe) throw new Error(`seeding ${str(m.name)}: ${proc.argv[0] ?? ''} is not in ${str(c.image)}`);
    startProcess(ctx, node.name, ctr.id, exe, { argv: proc.argv, env: proc.env, which: (x) => v.which(proc.env, x), file: v.file });
  }
}

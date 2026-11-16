// The container runtime of each node (containerd 1.7.28 behind the CRI), as world data: the image
// store, pod sandboxes, containers and their processes. It belongs to the node, not to the kubelet:
// containers keep running and writing logs while the kubelet is stopped, and a restarted kubelet
// finds them here. docs/ARCHITECTURE.md §4.8.

import type { Json, Millis } from '@simlab/kernel';
import type { Executable, Listener } from '@simlab/host';

/** An image in the node's store (CRI Image). */
export interface RuntimeImage {
  /** Config digest: the image id (`sha256:…`). */
  id: string;
  /** `docker.io/library/nginx:1.29`, in the order they were added. */
  repoTags: string[];
  /** `docker.io/library/nginx@sha256:…`. */
  repoDigests: string[];
  /** Bytes, as containerd reports it (runtime/images/catalog.ts imageSize). */
  size: number;
}

export interface Sandbox {
  id: string;
  podUID: string;
  namespace: string;
  name: string;
  /** Sandbox attempt (metadata.attempt): 0 for the first sandbox of a Pod. */
  attempt: number;
  state: 'ready' | 'notready';
  createdAt: Millis;
  hostNetwork: boolean;
  /** The Pod IP the CNI assigned; the node's IP for hostNetwork. */
  ip: string;
  hostname: string;
}

export type ContainerState = 'created' | 'running' | 'exited';

export interface ProcessState {
  exe: Executable;
  argv: string[];
  env: [string, string][];
  pid: number;
  /** The model's own state (ProgramModel), null when it has none. */
  state: Json;
  /** A model wake-up is pending at this time; absent while waiting or exited. */
  wakeAt?: Millis;
  /** A pending exit or exec, due at `at`. */
  pendingEnd?: { at: Millis; exit?: number; exec?: { exe: Executable; argv: string[]; env?: [string, string][] } };
  listen: Listener[];
}

export interface RuntimeContainer {
  id: string;
  sandboxId: string;
  podUID: string;
  /** Pod namespace and name, for log paths. */
  namespace: string;
  podName: string;
  name: string;
  /** Restart count, kept as the container's annotation (io.kubernetes.container.restartCount). */
  attempt: number;
  /** The image as the kubelet asked for it after defaulting the tag: `docker.io/library/nginx:latest` resolves from `nginx`. */
  imageRef: string;
  /** Image id (config digest). */
  imageId: string;
  /** What CRI ContainerStatus reports as image (the first repo tag) and imageRef (repo digest). */
  image: string;
  imageDigest: string;
  /** The kubelet's spec hash of the container: a changed spec restarts it. */
  hash: string;
  state: ContainerState;
  createdAt: Millis;
  startedAt?: Millis;
  finishedAt?: Millis;
  exitCode?: number;
  reason?: string;
  message?: string;
  /** The running process; absent once exited. */
  proc?: ProcessState;
  /** Output already produced but due later (a model's `after` offsets). */
  pending: { at: Millis; stream: 'stdout' | 'stderr'; text: string }[];
  /** A partial line per stream, written when its newline arrives. */
  partial: { stdout: string; stderr: string };
  /** The pending runtime event (wake, output or kill), one per container. */
  event?: { id: string; at: Millis };
  /** SIGKILL is due at this time (StopContainer's timeout). */
  killAt?: Millis;
  /** The kubelet stopped this container (StopContainer was called). */
  stopping?: boolean;
  logPath: string;
  /** The last log timestamp written, so stamps within a millisecond keep increasing. */
  logClock?: { at: Millis; sub: number };
}

export interface NodeRuntime {
  node: string;
  images: Record<string, RuntimeImage>;
  sandboxes: Record<string, Sandbox>;
  containers: Record<string, RuntimeContainer>;
  /** host-local IPAM: the last address handed out in the node's Pod CIDR, as an offset. */
  lastIp: number;
  /** Next process id in the node's PID space (the shim gives each container's init a host pid). */
  nextPid: number;
}

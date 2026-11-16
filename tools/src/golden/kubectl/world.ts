// The simulated cluster a golden case is replayed on: the kubeadm-1cp-2w topology made to look like
// the oracle's (docs/FIDELITY.md §6.6: no kube-system workloads), booted once and forked per case.

import { bootKernel, createRegistry, DEFAULT_START_TIME, TOPOLOGY, type GapEvent, type Kernel, type TopologySpec } from '@simlab/kernel';
import { captureOutput, createFs, hostPlugin, openSession, ROOT_CRED, type Fs, type OutputCapture, type Session } from '@simlab/host';
import { createClient, DEFAULT_APISERVER, k8sPlugin } from '@simlab/k8s';

type Obj = Record<string, unknown>;

const registry = createRegistry([hostPlugin, k8sPlugin]);

/** The machine and user the cases run as: the oracle's commands ran on the control plane's admin. */
export const MACHINE = 'controlplane';
export const USER = 'root';
export const HOME = '/root';

let base: Kernel | undefined;

function items(k: Kernel, resource: string, namespace: string): Obj[] {
  const r = k.act('golden-diff', (ctx) => createClient(ctx, DEFAULT_APISERVER).resource(resource).list(namespace));
  if (!r.ok) throw new Error(`list ${resource}: ${JSON.stringify(r)}`);
  return ((r.object as Obj).items ?? []) as Obj[];
}

const nameOf = (o: Obj): string => String((o.metadata as Obj).name);

function del(k: Kernel, resource: string, namespace: string, name: string, gracePeriodSeconds?: number): void {
  const r = k.act('golden-diff', (ctx) =>
    createClient(ctx, DEFAULT_APISERVER)
      .resource(resource)
      .delete(namespace, name, gracePeriodSeconds === undefined ? {} : { gracePeriodSeconds }),
  );
  if (!r.ok && r.code !== 404) throw new Error(`delete ${resource} ${namespace}/${name}: ${JSON.stringify(r)}`);
}

/**
 * Boots kubeadm-1cp-2w and removes what the oracle's cluster does not have: the kube-system
 * workloads (CoreDNS, kube-proxy) and their Pods, the kube-dns Service, and the control plane's
 * mirror Pods (the static Pods' manifests are removed first, so the kubelet does not recreate them).
 */
function bootBase(): Kernel {
  const k = bootKernel(registry, { seed: 1, startTime: DEFAULT_START_TIME });
  const spec = registry.get<TopologySpec>(TOPOLOGY, 'kubeadm-1cp-2w');
  if (!spec) throw new Error('no topology kubeadm-1cp-2w');
  k.act('topology', (ctx) => spec.build(ctx, {}));
  k.advance(5_000);
  for (const d of items(k, 'apps/v1/deployments', 'kube-system')) del(k, 'apps/v1/deployments', 'kube-system', nameOf(d));
  for (const d of items(k, 'apps/v1/daemonsets', 'kube-system')) del(k, 'apps/v1/daemonsets', 'kube-system', nameOf(d));
  del(k, 'v1/services', 'kube-system', 'kube-dns');
  k.advance(2_000);
  for (const p of items(k, 'v1/pods', 'kube-system')) del(k, 'v1/pods', 'kube-system', nameOf(p), 0);
  k.advance(5_000);
  const left = items(k, 'v1/pods', 'kube-system').map(nameOf);
  if (left.length > 0) throw new Error(`kube-system Pods left after the cleanup: ${left.join(', ')}`);
  return k;
}

export interface CaseWorld {
  kernel: Kernel;
  capture: OutputCapture;
  gaps: GapEvent[];
  /** A plain shell session (no line editing, no echo, empty prompts) as root in /root. */
  session: Session;
  /** A session on a terminal of `cols` columns, opened on first use. */
  tty(cols: number): Session;
  /** Reads a file as root. */
  read(path: string): string;
  write(path: string, content: string): void;
  /** The regular files directly in a directory, sorted; undefined when it is not a directory. */
  list(path: string): string[] | undefined;
  remove(path: string): void;
}

/**
 * A fork of the oracle-like world with the case's files in the home directory. A client-only case
 * (`server: false`) runs without root's kubeconfig, as the client-only oracle had none.
 */
export function caseWorld(files: Record<string, string>, server: boolean): CaseWorld {
  base ??= bootBase();
  const capture = captureOutput();
  const gaps: GapEvent[] = [];
  const kernel = base.fork({ ports: { ...capture.ports, gap: (g) => gaps.push(g) } });
  /** Runs `fn` with root's view of the control plane's file system, in the home directory. */
  const withFs = <T>(fn: (f: Fs) => T): T => kernel.act('golden-diff', (ctx) => fn(createFs(ctx, MACHINE, { cred: ROOT_CRED, umask: 0o022, cwd: HOME })));
  const read = (path: string) => withFs((f) => f.readFile(path));
  const write = (path: string, content: string) =>
    withFs((f) => {
      const parts = path.split('/').slice(0, -1);
      for (let i = 2; i <= parts.length; i++) {
        try {
          f.mkdir(parts.slice(0, i).join('/'));
        } catch {
          // Exists already.
        }
      }
      f.writeFile(path, content);
    });
  const list = (path: string) =>
    withFs((f) => {
      try {
        if (f.stat(path).type !== 'dir') return undefined;
        const dir = path.replace(/\/$/, '');
        return f
          .readdir(path)
          .filter((n) => n !== '.' && n !== '..' && f.stat(`${dir}/${n}`).type === 'file')
          .sort();
      } catch {
        return undefined;
      }
    });
  const remove = (path: string) =>
    withFs((f) => {
      try {
        f.unlink(path);
      } catch {
        // Not there.
      }
    });
  if (!server) remove(`${HOME}/.kube/config`);
  for (const [f, content] of Object.entries(files)) write(`${HOME}/${f}`, content);
  const ttys = new Map<number, Session>();
  return {
    kernel,
    capture,
    gaps,
    session: openSession(kernel, capture, { machine: MACHINE, user: USER, cwd: HOME }),
    tty: (cols) => {
      const s = ttys.get(cols) ?? openSession(kernel, capture, { machine: MACHINE, user: USER, cwd: HOME, cols });
      ttys.set(cols, s);
      return s;
    },
    read,
    write,
    list,
    remove,
  };
}

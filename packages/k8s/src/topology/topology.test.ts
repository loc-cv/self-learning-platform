// The cluster topologies: one builder, two data definitions. What a learner finds on the machines
// and in the API right after the build, and that the same ClusterDef machinery gives a different
// cluster when the data differs.

import { describe, expect, test } from 'vitest';
import { bootKernel, createRegistry, DEFAULT_START_TIME, TOPOLOGY, type Kernel, type TopologySpec } from '@simlab/kernel';
import { createFs, hostPlugin, ROOT_CRED } from '@simlab/host';
import type { JsonObject } from '../apimachinery/json.ts';
import { DEFAULT_APISERVER } from '../apiserver/config.ts';
import { createClient } from '../client/client.ts';
import { k8sPlugin } from '../plugin.ts';
import { apiServerConfig } from './build.ts';
import { KUBEADM_1CP_2W, KUBEADM_1N } from './cluster.ts';

const registry = createRegistry([hostPlugin, k8sPlugin]);

function boot(name: string, seed = 1): { k: Kernel; info: { entry: { machine: string; user: string }; machines: string[] } } {
  const k = bootKernel(registry, { seed, startTime: DEFAULT_START_TIME });
  const spec = registry.get<TopologySpec>(TOPOLOGY, name);
  if (!spec) throw new Error(`no topology ${name}`);
  const info = k.act('topology', (ctx) => spec.build(ctx, {}));
  k.advance(5_000);
  return { k, info };
}

const list = (k: Kernel, resource: string, ns?: string): JsonObject[] => {
  const r = k.act('list', (ctx) => createClient(ctx, DEFAULT_APISERVER).resource(resource).list(ns));
  return (r.ok ? ((r.object as JsonObject).items ?? []) : []) as JsonObject[];
};
const name = (o: JsonObject): string => String((o.metadata as JsonObject).name);
const read = (k: Kernel, machine: string, path: string): string => k.act('read', (ctx) => createFs(ctx, machine, { cred: ROOT_CRED, umask: 0o022 }).readFile(path));

describe('kubeadm-1cp-2w', () => {
  test('three machines, the terminal on the control plane as root', () => {
    const { info } = boot('kubeadm-1cp-2w');
    expect(info).toEqual({ entry: { machine: 'controlplane', user: 'root' }, machines: ['controlplane', 'node01', 'node02'] });
  });

  test('Nodes with the control-plane taint, Pod CIDRs and Leases', () => {
    const { k } = boot('kubeadm-1cp-2w');
    const nodes = list(k, 'v1/nodes');
    expect(nodes.map(name)).toEqual(['controlplane', 'node01', 'node02']);
    const cp = nodes[0] as JsonObject;
    expect((cp.spec as JsonObject).taints).toEqual([{ key: 'node-role.kubernetes.io/control-plane', effect: 'NoSchedule' }]);
    expect(nodes.map((n) => (n.spec as JsonObject).podCIDR)).toEqual(['10.244.0.0/24', '10.244.1.0/24', '10.244.2.0/24']);
    expect(list(k, 'coordination.k8s.io/v1/leases', 'kube-node-lease').map(name)).toEqual(['controlplane', 'node01', 'node02']);
  });

  test('kube-system: control plane mirror Pods and kube-proxy running, CoreDNS bound to the workers', () => {
    const { k } = boot('kubeadm-1cp-2w');
    const pods = list(k, 'v1/pods', 'kube-system');
    const phase = (p: JsonObject) => String((p.status as JsonObject).phase);
    const node = (p: JsonObject) => String((p.spec as JsonObject).nodeName ?? '');
    for (const c of ['etcd', 'kube-apiserver', 'kube-controller-manager', 'kube-scheduler']) {
      const p = pods.find((x) => name(x) === `${c}-controlplane`) as JsonObject;
      expect(phase(p), c).toBe('Running');
      expect(((p.metadata as JsonObject).annotations as JsonObject)['kubernetes.io/config.source']).toBe('file');
    }
    const proxies = pods.filter((p) => name(p).startsWith('kube-proxy-'));
    expect(proxies.map(node).sort()).toEqual(['controlplane', 'node01', 'node02']);
    expect(proxies.every((p) => phase(p) === 'Running')).toBe(true);
    const dns = pods.filter((p) => name(p).startsWith('coredns-'));
    expect(dns.length).toBe(2);
    // Bound by the scheduler to the workers, whose kubelets pull the image and start it.
    expect(dns.map(node).sort()).toEqual(['node01', 'node02']);
    expect(dns.map(phase)).toEqual(['Running', 'Running']);
    const svc = list(k, 'v1/services', 'kube-system').find((s) => name(s) === 'kube-dns') as JsonObject;
    expect((svc.spec as JsonObject).clusterIP).toBe('10.96.0.10');
    const ds = list(k, 'apps/v1/daemonsets', 'kube-system')[0] as JsonObject;
    expect((ds.status as JsonObject).numberReady).toBe(3);
    expect(list(k, 'v1/configmaps', 'kube-system').map(name)).toEqual(expect.arrayContaining(['coredns', 'kube-proxy', 'kubeadm-config', 'kubelet-config']));
  });

  test("kubeadm's files: manifests and kubeconfigs on the control plane, the kubelet's on every node", () => {
    const { k } = boot('kubeadm-1cp-2w');
    expect(read(k, 'controlplane', '/etc/kubernetes/manifests/kube-scheduler.yaml')).toContain('- kube-scheduler\n');
    expect(read(k, 'controlplane', '/root/.kube/config')).toContain('server: https://172.16.0.10:6443');
    expect(read(k, 'node01', '/var/lib/kubelet/kubeadm-flags.env')).toBe('KUBELET_KUBEADM_ARGS=""\n');
    expect(read(k, 'node01', '/etc/kubernetes/kubelet.conf')).toContain('current-context: default-context');
    expect(() => read(k, 'node01', '/etc/kubernetes/admin.conf')).toThrow();
  });

  test('the same seed builds the same world', () => {
    expect(boot('kubeadm-1cp-2w', 7).k.hash()).toBe(boot('kubeadm-1cp-2w', 7).k.hash());
  });
});

describe('kubeadm-1n: a different cluster from the same builder', () => {
  test('one untainted node that runs everything, CoreDNS included', () => {
    const { k, info } = boot('kubeadm-1n');
    expect(info.machines).toEqual(['controlplane']);
    const nodes = list(k, 'v1/nodes');
    expect(nodes.map(name)).toEqual(['controlplane']);
    expect((nodes[0]?.spec as JsonObject).taints).toBeUndefined();
    const dns = list(k, 'v1/pods', 'kube-system').filter((p) => name(p).startsWith('coredns-'));
    expect(dns.map((p) => (p.spec as JsonObject).nodeName)).toEqual(['controlplane', 'controlplane']);
  });

  test('both definitions share network and API server settings', () => {
    expect(apiServerConfig(KUBEADM_1N)).toEqual(apiServerConfig(KUBEADM_1CP_2W));
    expect(apiServerConfig(KUBEADM_1CP_2W)).toEqual(DEFAULT_APISERVER);
  });
});

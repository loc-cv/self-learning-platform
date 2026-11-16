// k8s.object on the kubeadm-1cp-2w cluster: counting by name, selector and all; exists: false;
// where clauses; cluster-scoped kinds; the errors that make a check unevaluable.

import { describe, expect, test } from 'vitest';
import type { JsonObject } from '../apimachinery/json.ts';
import { api, cluster, deployment, runCheck } from './testenv.ts';

const configMap = (name: string, labels: JsonObject, data: JsonObject): JsonObject => ({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name, labels }, data });

function withConfigMaps() {
  const k = cluster();
  api(k, (c) => c.resource('v1/configmaps').create('default', configMap('app-a', { app: 'shop' }, { mode: 'fast', replicas: '3' })));
  api(k, (c) => c.resource('v1/configmaps').create('default', configMap('app-b', { app: 'shop' }, { mode: 'slow', replicas: '3' })));
  return k;
}

describe('k8s.object', () => {
  test('by name: present, absent', () => {
    const k = withConfigMaps();
    expect(runCheck('k8s.object', k, { kind: 'ConfigMap', name: 'app-a' })).toEqual({ pass: true, expected: 'at least 1 ConfigMap named app-a in namespace default', observed: 'found 1 ConfigMap: app-a' });
    expect(runCheck('k8s.object', k, { kind: 'ConfigMap', namespace: 'kube-system', name: 'app-a' })).toEqual({
      pass: false,
      expected: 'at least 1 ConfigMap named app-a in namespace kube-system',
      observed: 'no ConfigMap named app-a in namespace kube-system',
    });
  });

  test('by selector with a count; terminating objects are counted', () => {
    const k = withConfigMaps();
    expect(runCheck('k8s.object', k, { kind: 'ConfigMap', selector: 'app=shop', count: 2 })).toEqual({ pass: true, expected: '2 ConfigMaps matching app=shop in namespace default', observed: 'found 2 ConfigMaps: app-a, app-b' });
    expect(runCheck('k8s.object', k, { kind: 'ConfigMap', selector: 'app=shop', max: 1 }).pass).toBe(false);
    expect(runCheck('k8s.object', k, { kind: 'ConfigMap', selector: 'app=shop', min: 1, max: 3 }).expected).toBe('between 1 and 3 ConfigMaps matching app=shop in namespace default');
    // A Pod with a finalizer stays, terminating, after its deletion.
    api(k, (c) => c.resource('v1/configmaps').create('default', { ...configMap('held', { app: 'held' }, {}), metadata: { name: 'held', labels: { app: 'held' }, finalizers: ['example.com/hold'] } }));
    api(k, (c) => c.resource('v1/configmaps').delete('default', 'held'));
    expect(runCheck('k8s.object', k, { kind: 'ConfigMap', selector: 'app=held', count: 1 }).pass).toBe(true);
  });

  test('exists: false', () => {
    const k = withConfigMaps();
    expect(runCheck('k8s.object', k, { kind: 'ConfigMap', name: 'gone', exists: false })).toEqual({ pass: true, expected: 'no ConfigMap named gone in namespace default', observed: 'no ConfigMap named gone in namespace default exists' });
    expect(runCheck('k8s.object', k, { kind: 'ConfigMap', selector: 'app=shop', exists: false })).toEqual({
      pass: false,
      expected: 'no ConfigMap matching app=shop in namespace default',
      observed: 'found 2 ConfigMaps: app-a, app-b',
    });
  });

  test('where clauses hold for every selected object', () => {
    const k = withConfigMaps();
    const pass = runCheck('k8s.object', k, { kind: 'ConfigMap', selector: 'app=shop', where: [{ path: '{.data.replicas}', equals: 3 }, { path: '{.data.mode}', in: ['fast', 'slow'] }] });
    expect(pass).toEqual({
      pass: true,
      expected: 'at least 1 ConfigMap matching app=shop in namespace default, each with {.data.replicas} equals 3 and {.data.mode} is one of "fast", "slow"',
      observed: 'found 2 ConfigMaps: app-a, app-b; every clause holds',
    });
    const fail = runCheck('k8s.object', k, { kind: 'ConfigMap', selector: 'app=shop', where: [{ path: '{.data.mode}', equals: 'fast' }, { path: '{.data.extra}', exists: true }] });
    expect(fail.pass).toBe(false);
    expect(fail.observed).toBe('app-a: {.data.extra} is not set; app-b: {.data.mode} is "slow"; app-b: {.data.extra} is not set');
  });

  test('a Deployment by apiVersion and kind, with a numeric where', () => {
    const k = cluster();
    api(k, (c) => c.resource('apps/v1/deployments').create('default', deployment('web', 'nginx:1.27', 2)));
    expect(runCheck('k8s.object', k, { kind: 'Deployment', apiVersion: 'apps/v1', name: 'web', where: [{ path: '{.spec.replicas}', gte: 2 }, { path: '{.spec.template.spec.containers[*].image}', matches: '^nginx:' }] }).pass).toBe(true);
    expect(runCheck('k8s.object', k, { kind: 'Deployment', name: 'web', where: [{ path: '{.spec.replicas}', lte: 1 }] }).observed).toBe('web: {.spec.replicas} is 2');
  });

  test('cluster-scoped kinds: every object cluster-wide', () => {
    const k = cluster();
    expect(runCheck('k8s.object', k, { kind: 'Node', count: 3 })).toEqual({ pass: true, expected: '3 Nodes cluster-wide', observed: 'found 3 Nodes: controlplane, node01, node02' });
    expect(runCheck('k8s.object', k, { kind: 'Node', name: 'controlplane', where: [{ path: "{.metadata.labels['node-role.kubernetes.io/control-plane']}", exists: true }] }).pass).toBe(true);
  });

  test('errors: unknown kind, bad selector, conflicting arguments, unsupported JSONPath, namespace on a cluster-scoped kind', () => {
    const k = cluster();
    const error = (args: JsonObject) => {
      const r = runCheck('k8s.object', k, args);
      expect(r.pass).toBe(false);
      return r.error;
    };
    expect(error({ kind: 'Widget' })).toBe('no matches for kind "Widget": no API group serves it');
    expect(error({ kind: 'Deployment', apiVersion: 'apps/v2' })).toBe('no matches for kind "Deployment" in version "apps/v2"');
    expect(error({ kind: 'ConfigMap', selector: 'app in (a' })).toBe("unable to parse requirement: found '', expected: ',' or ')'");
    expect(error({ kind: 'ConfigMap', name: 'a', selector: 'app=a' })).toBe('name and selector are mutually exclusive');
    expect(error({ kind: 'ConfigMap', name: 'a', exists: false, count: 0 })).toBe('exists: false excludes count, min, max and where');
    expect(error({ kind: 'ConfigMap', count: 1, min: 1 })).toBe('count excludes min and max');
    expect(error({ kind: 'ConfigMap', where: [{ path: '{..name}', exists: true }] })).toBe('unsupported JSONPath syntax in "{..name}": recursive descent (..)');
    expect(error({ kind: 'Node', namespace: 'default' })).toBe('Node is cluster-scoped; remove namespace');
  });

  test('no API server serving is an error', () => {
    const k = cluster();
    k.act('stop', (ctx) => {
      const servers = (ctx.world.slices.k8s as { apiServers: Record<string, unknown> }).apiServers;
      for (const key of Object.keys(servers)) delete servers[key];
    });
    expect(runCheck('k8s.object', k, { kind: 'Node' }).error).toBe('no Kubernetes API server is serving');
  });
});

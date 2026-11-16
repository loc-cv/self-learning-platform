// The EndpointSlice controller in virtual time, against the object shapes of
// fixtures/golden/v1.37.2/controllers/endpoints.yaml (real v1.37.2): which Pods become
// endpoints and with which conditions, named target ports per Pod, relabelling, terminating Pods,
// selectorless Services, Service deletion, repair of edited and deleted slices, a Pod on a missing
// Node, and determinism.

import { describe, expect, test } from 'vitest';
import type { TraceRecord } from '@simlab/kernel';
import type { JsonObject } from '../../apimachinery/json.ts';
import { api, bootCluster, endpointsByPod, events, meta, pod, podIP, podUID, service, slicesOf } from './testenv.ts';
import { deepHash, discoveryEndpointPortValue, fnv128aHex } from './hash.ts';

const webPort = [{ name: 'http', containerPort: 8080 }];
const frontPorts = [
  { name: 'web', port: 80, targetPort: 'http' },
  { name: 'metrics', port: 9100, targetPort: 9100 },
];

/** The fixture's scenario: two ready web Pods and a running, not-ready Pod, then the Service. */
function fixtureScenario(traces?: TraceRecord[]) {
  const k = bootCluster(traces ? { traces } : {});
  for (const n of ['web-a', 'web-b']) api(k, 'v1/pods').create(pod(n, { labels: { app: 'web', tier: 'web' }, ports: webPort }));
  api(k, 'v1/pods').create(pod('slow', { labels: { tier: 'web', extra: 'x' }, notReady: true, ports: webPort }));
  k.advance(3000);
  const svc = api(k, 'v1/services').create(service('front', { tier: 'web' }, frontPorts));
  k.advance(100);
  return { k, svc };
}

const epFor = (k: ReturnType<typeof bootCluster>, name: string, conditions: JsonObject, nodeName: string): JsonObject => ({
  addresses: [podIP(k, name)],
  conditions,
  nodeName,
  targetRef: { kind: 'Pod', name, namespace: 'default', uid: podUID(k, name) },
});
const READY = { ready: true, serving: true, terminating: false };
const NOT_READY = { ready: false, serving: false, terminating: false };

describe('hashes', () => {
  test('fnv128a matches Go hash/fnv; ports sort by the hash of their dump', () => {
    // The FNV-1a 128 test vector of "a".
    expect(fnv128aHex([0x61])).toBe('d228cb696f1a8caf78912b704e4a8964');
    const web = deepHash(discoveryEndpointPortValue({ name: 'web', port: 8080, protocol: 'TCP' }));
    const metrics = deepHash(discoveryEndpointPortValue({ name: 'metrics', port: 9100, protocol: 'TCP' }));
    // The fixture lists metrics before web.
    expect(metrics < web).toBe(true);
  });
});

describe('the fixture scenario', () => {
  test('one slice: ready and not-ready endpoints, sorted ports, labels, owner, trigger time', () => {
    const { k, svc } = fixtureScenario();
    const slices = slicesOf(k, 'front');
    expect(slices).toHaveLength(1);
    const s = slices[0] as JsonObject;
    expect(s.addressType).toBe('IPv4');
    expect(meta(s).generateName).toBe('front-');
    expect(meta(s).name).toMatch(/^front-[bcdfghjklmnpqrstvwxz2456789]{5}$/);
    expect(meta(s).generation).toBe(1);
    expect(meta(s).labels).toEqual({ 'endpointslice.kubernetes.io/managed-by': 'endpointslice-controller.k8s.io', 'kubernetes.io/service-name': 'front' });
    // First sync of a Service the tracker does not know: its creation time.
    expect(meta(s).annotations).toEqual({ 'endpoints.kubernetes.io/last-change-trigger-time': meta(svc).creationTimestamp });
    expect(meta(s).ownerReferences).toEqual([{ apiVersion: 'v1', blockOwnerDeletion: true, controller: true, kind: 'Service', name: 'front', uid: meta(svc).uid }]);
    expect(s.ports).toEqual([
      { name: 'metrics', port: 9100, protocol: 'TCP' },
      { name: 'web', port: 8080, protocol: 'TCP' },
    ]);
    // The fake kubelet binds round robin: web-a and slow on node01, web-b on node02.
    expect(endpointsByPod(s)).toEqual([epFor(k, 'slow', NOT_READY, 'node01'), epFor(k, 'web-a', READY, 'node01'), epFor(k, 'web-b', READY, 'node02')]);
  });

  test('relabelling a Pod out removes its endpoint and the trigger time; relabelling it back restores it', () => {
    const { k } = fixtureScenario();
    const name = meta(slicesOf(k, 'front')[0]).name;
    api(k, 'v1/pods').patch('slow', { metadata: { labels: { tier: null } } });
    k.advance(100);
    let s = slicesOf(k, 'front')[0] as JsonObject;
    expect(meta(s).name).toBe(name);
    expect(meta(s).generation).toBe(2);
    // No Pod became ready since the last sync: the annotation is cleared (as in the fixture).
    expect(meta(s).annotations).toBeUndefined();
    expect(endpointsByPod(s).map((e) => (e.targetRef as JsonObject).name)).toEqual(['web-a', 'web-b']);
    api(k, 'v1/pods').patch('slow', { metadata: { labels: { tier: 'web' } } });
    k.advance(100);
    s = slicesOf(k, 'front')[0] as JsonObject;
    expect(meta(s).generation).toBe(3);
    expect(endpointsByPod(s)).toEqual([epFor(k, 'slow', NOT_READY, 'node01'), epFor(k, 'web-a', READY, 'node01'), epFor(k, 'web-b', READY, 'node02')]);
  });

  test('a Pod becoming ready updates its conditions and sets the trigger time to its Ready transition', () => {
    const k = bootCluster();
    api(k, 'v1/services').create(service('front', { tier: 'web' }, frontPorts));
    api(k, 'v1/pods').create(pod('web-a', { labels: { tier: 'web' }, ports: webPort }));
    k.advance(100);
    // No Pod has an IP yet: a placeholder slice without ports or endpoints.
    let slices = slicesOf(k, 'front');
    expect(slices).toHaveLength(1);
    expect(slices[0]?.endpoints).toBeNull();
    expect(slices[0]?.ports).toBeNull();
    const name = meta(slices[0]).name;
    k.advance(3000);
    slices = slicesOf(k, 'front');
    expect(slices).toHaveLength(1);
    // The placeholder is reused, not replaced.
    expect(meta(slices[0]).name).toBe(name);
    const ready = ((api(k, 'v1/pods').get('web-a')?.status as JsonObject).conditions as JsonObject[]).find((c) => c.type === 'Ready');
    expect((meta(slices[0]).annotations as JsonObject)['endpoints.kubernetes.io/last-change-trigger-time']).toBe(ready?.lastTransitionTime);
    expect(endpointsByPod(slices[0] as JsonObject)).toEqual([epFor(k, 'web-a', READY, 'node01')]);
  });
});

describe('endpoint membership', () => {
  test('a named targetPort resolves per Pod: one slice per port set', () => {
    const k = bootCluster();
    api(k, 'v1/pods').create(pod('a', { labels: { app: 'x' }, ports: [{ name: 'http', containerPort: 8080 }] }));
    api(k, 'v1/pods').create(pod('b', { labels: { app: 'x' }, ports: [{ name: 'http', containerPort: 9090 }] }));
    api(k, 'v1/pods').create(pod('c', { labels: { app: 'x' } }));
    api(k, 'v1/services').create(service('x', { app: 'x' }, [{ name: 'web', port: 80, targetPort: 'http' }]));
    k.advance(3000);
    const slices = slicesOf(k, 'x');
    const byPort = (port: number | undefined) => slices.find((s) => ((s.ports as JsonObject[] | null)?.[0]?.port as number | undefined) === port) as JsonObject;
    expect(slices).toHaveLength(3);
    expect(endpointsByPod(byPort(8080)).map((e) => (e.targetRef as JsonObject).name)).toEqual(['a']);
    expect(endpointsByPod(byPort(9090)).map((e) => (e.targetRef as JsonObject).name)).toEqual(['b']);
    // Pod c has no port named http: its endpoint has no ports (getEndpointPorts skips the port).
    expect(endpointsByPod(byPort(undefined)).map((e) => (e.targetRef as JsonObject).name)).toEqual(['c']);
    expect(byPort(undefined).ports).toBeNull();
  });

  test('a terminating Pod stays as serving and terminating, not ready, until it is gone', () => {
    const k = bootCluster();
    for (const n of ['a', 'b']) api(k, 'v1/pods').create(pod(n, { labels: { app: 'x' }, ports: webPort }));
    api(k, 'v1/services').create(service('x', { app: 'x' }, [{ port: 80, targetPort: 8080 }]));
    k.advance(3000);
    api(k, 'v1/pods').del('a');
    k.advance(100);
    let s = slicesOf(k, 'x')[0] as JsonObject;
    expect(endpointsByPod(s)[0]?.conditions).toEqual({ ready: false, serving: true, terminating: true });
    expect(endpointsByPod(s)[1]?.conditions).toEqual(READY);
    k.advance(2000);
    s = slicesOf(k, 'x')[0] as JsonObject;
    expect(endpointsByPod(s).map((e) => (e.targetRef as JsonObject).name)).toEqual(['b']);
    // An unnamed Service port: the endpoint port has an empty name.
    expect(s.ports).toEqual([{ name: '', port: 8080, protocol: 'TCP' }]);
  });

  test('publishNotReadyAddresses makes a not-ready Pod ready', () => {
    const k = bootCluster();
    api(k, 'v1/pods').create(pod('slow', { labels: { app: 'x' }, notReady: true }));
    api(k, 'v1/services').create(service('x', { app: 'x' }, [{ port: 80 }], { publishNotReadyAddresses: true }));
    k.advance(3000);
    expect(endpointsByPod(slicesOf(k, 'x')[0] as JsonObject)[0]?.conditions).toEqual({ ready: true, serving: false, terminating: false });
  });

  test('Service labels are copied; a headless Service gets the headless label', () => {
    const k = bootCluster();
    api(k, 'v1/pods').create(pod('a', { labels: { app: 'x' } }));
    api(k, 'v1/services').create(service('x', { app: 'x' }, [{ port: 80 }], { clusterIP: 'None' }, { labels: { team: 'a', 'kubernetes.io/service-name': 'evil' } }));
    k.advance(3000);
    expect(meta(slicesOf(k, 'x')[0]).labels).toEqual({
      team: 'a',
      'service.kubernetes.io/headless': '',
      'kubernetes.io/service-name': 'x',
      'endpointslice.kubernetes.io/managed-by': 'endpointslice-controller.k8s.io',
    });
    api(k, 'v1/services').patch('x', { metadata: { labels: { team: 'b' } } });
    k.advance(100);
    expect((meta(slicesOf(k, 'x')[0]).labels as JsonObject).team).toBe('b');
  });

  test('a Service without a selector gets no managed slice; the kubernetes slice is untouched', () => {
    const k = bootCluster();
    const before = api(k, 'discovery.k8s.io/v1/endpointslices').list();
    api(k, 'v1/services').create(service('manual', undefined, [{ port: 80, targetPort: 8080 }]));
    k.advance(2000);
    expect(slicesOf(k, 'manual')).toEqual([]);
    expect(api(k, 'discovery.k8s.io/v1/endpointslices').list()).toEqual(before);
  });

  test('a Pod on a Node that does not exist is skipped with a Warning event, and retried after 1 s', () => {
    const traces: TraceRecord[] = [];
    const k = bootCluster({ nodes: ['node01'], traces });
    for (const n of ['a', 'b']) api(k, 'v1/pods').create(pod(n, { labels: { app: 'x' } }));
    api(k, 'v1/services').create(service('x', { app: 'x' }, [{ port: 80 }]));
    k.advance(3000);
    expect(endpointsByPod(slicesOf(k, 'x')[0] as JsonObject).map((e) => (e.targetRef as JsonObject).name)).toEqual(['a']);
    const ev = events(k).find((e) => e.reason === 'FailedToUpdateEndpointSlices');
    expect(ev?.type).toBe('Warning');
    expect(ev?.message).toBe('Error updating Endpoint Slices for Service default/x: skipping Pod b for Service default/x: Node node02 Not Found');
    expect(ev?.source).toEqual({ component: 'endpoint-slice-controller' });
    const retry = traces.find((t) => t.kind === 'controller.error' && t.source === 'k8s.controller/endpointslice');
    expect(retry?.message).toMatch(/^error syncing default\/x, retrying in 1000 ms: /);
    // The Node appears: the next retry includes the Pod.
    api(k, 'v1/nodes').create({ apiVersion: 'v1', kind: 'Node', metadata: { name: 'node02' } }, undefined);
    k.advance(10_000);
    expect(endpointsByPod(slicesOf(k, 'x')[0] as JsonObject).map((e) => (e.targetRef as JsonObject).name)).toEqual(['a', 'b']);
  });
});

describe('slices the controller owns', () => {
  test('a deleted slice is recreated, an edited one restored, after endpointSliceChangeMinSyncDelay', () => {
    const { k } = fixtureScenario();
    const slices = api(k, 'discovery.k8s.io/v1/endpointslices');
    const s = slicesOf(k, 'front')[0] as JsonObject;
    const want = endpointsByPod(s);
    slices.update({ ...s, endpoints: [] });
    k.advance(900);
    expect(endpointsByPod(slicesOf(k, 'front')[0] as JsonObject)).toEqual([]);
    k.advance(200);
    expect(endpointsByPod(slicesOf(k, 'front')[0] as JsonObject)).toEqual(want);
    slices.del(meta(s).name as string);
    k.advance(1200);
    const again = slicesOf(k, 'front');
    expect(again).toHaveLength(1);
    expect(meta(again[0]).name).not.toBe(meta(s).name);
    expect(endpointsByPod(again[0] as JsonObject)).toEqual(want);
  });

  test("the controller's own writes do not queue its Service again", () => {
    const traces: TraceRecord[] = [];
    fixtureScenario(traces);
    const syncs = traces.filter((t) => t.kind === 'controller.sync' && t.source === 'k8s.controller/endpointslice' && t.subject === 'default/front');
    // The Service's ADDED event; the slice's ADDED event finds the tracker's generation.
    expect(syncs).toHaveLength(1);
  });

  test("deleting the Service removes its slices (garbage collector, by ownerReference)", () => {
    const { k } = fixtureScenario();
    api(k, 'v1/services').del('front');
    k.advance(1000);
    expect(slicesOf(k, 'front')).toEqual([]);
  });
});

test('same seed, same world hash', () => {
  const run = () => {
    const { k } = fixtureScenario();
    api(k, 'v1/pods').patch('slow', { metadata: { labels: { tier: null } } });
    api(k, 'v1/pods').del('web-a');
    k.advance(5000);
    return k.hash();
  };
  expect(run()).toBe(run());
});

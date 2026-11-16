// The Endpoints controller in virtual time, against the object shapes of
// fixtures/golden/v1.37.2/controllers/endpoints.yaml (real v1.37.2), and RepackSubsets and
// truncation on their own.

import { describe, expect, test } from 'vitest';
import type { JsonObject } from '../../apimachinery/json.ts';
import { api, bootCluster, events, meta, pod, podIP, podUID, service } from '../endpointslice/testenv.ts';
import { repackSubsets } from './repack.ts';
import { truncateEndpoints } from './controller.ts';
import { startControllerManager } from '../manager.ts';
import { DEFAULT_APISERVER } from '../../apiserver/config.ts';

const webPort = [{ name: 'http', containerPort: 8080 }];
const frontPorts = [
  { name: 'web', port: 80, targetPort: 'http' },
  { name: 'metrics', port: 9100, targetPort: 9100 },
];

function fixtureScenario() {
  const k = bootCluster();
  for (const n of ['web-a', 'web-b']) api(k, 'v1/pods').create(pod(n, { labels: { app: 'web', tier: 'web' }, ports: webPort }));
  api(k, 'v1/pods').create(pod('slow', { labels: { tier: 'web', extra: 'x' }, notReady: true, ports: webPort }));
  k.advance(3000);
  const svc = api(k, 'v1/services').create(service('front', { tier: 'web' }, frontPorts));
  k.advance(100);
  return { k, svc };
}

const addr = (k: ReturnType<typeof bootCluster>, name: string, nodeName: string): JsonObject => ({
  ip: podIP(k, name),
  nodeName,
  targetRef: { kind: 'Pod', name, namespace: 'default', uid: podUID(k, name) },
});
const byIP = (a: JsonObject, b: JsonObject): number => ((a.ip as string) < (b.ip as string) ? -1 : 1);

describe('the fixture scenario', () => {
  test('one subset: ready addresses, not-ready addresses, ports sorted by hash; managed-by label; trigger time', () => {
    const { k, svc } = fixtureScenario();
    const ep = api(k, 'v1/endpoints').get('front') as JsonObject;
    expect(meta(ep).labels).toEqual({ 'endpoints.kubernetes.io/managed-by': 'endpoint-controller' });
    expect(meta(ep).annotations).toEqual({ 'endpoints.kubernetes.io/last-change-trigger-time': meta(svc).creationTimestamp });
    expect(meta(ep).ownerReferences).toBeUndefined();
    expect(ep.subsets).toEqual([
      {
        addresses: [addr(k, 'web-a', 'node01'), addr(k, 'web-b', 'node02')].sort(byIP),
        notReadyAddresses: [addr(k, 'slow', 'node01')],
        ports: [
          { name: 'metrics', port: 9100, protocol: 'TCP' },
          { name: 'web', port: 8080, protocol: 'TCP' },
        ],
      },
    ]);
  });

  test('relabelling a Pod out drops it and the trigger time', () => {
    const { k } = fixtureScenario();
    api(k, 'v1/pods').patch('slow', { metadata: { labels: { tier: null } } });
    k.advance(100);
    const ep = api(k, 'v1/endpoints').get('front') as JsonObject;
    expect(meta(ep).annotations).toBeUndefined();
    expect((ep.subsets as JsonObject[])[0]?.notReadyAddresses).toBeUndefined();
    expect(((ep.subsets as JsonObject[])[0]?.addresses as JsonObject[]).map((a) => (a.targetRef as JsonObject).name).sort()).toEqual(['web-a', 'web-b']);
  });
});

describe('membership', () => {
  test('a named targetPort resolving to different numbers gives one subset per port set', () => {
    const k = bootCluster();
    api(k, 'v1/pods').create(pod('a', { labels: { app: 'x' }, ports: [{ name: 'http', containerPort: 8080 }] }));
    api(k, 'v1/pods').create(pod('b', { labels: { app: 'x' }, ports: [{ name: 'http', containerPort: 9090 }] }));
    api(k, 'v1/services').create(service('x', { app: 'x' }, [{ name: 'web', port: 80, targetPort: 'http' }]));
    k.advance(3000);
    const subsets = (api(k, 'v1/endpoints').get('x') as JsonObject).subsets as JsonObject[];
    expect(subsets).toHaveLength(2);
    const ports = subsets.map((s) => ((s.ports as JsonObject[])[0] as JsonObject).port).sort();
    expect(ports).toEqual([8080, 9090]);
    for (const s of subsets) expect((s.addresses as JsonObject[]).map((a) => (a.targetRef as JsonObject).name)).toEqual([(s.ports as JsonObject[])[0]?.port === 8080 ? 'a' : 'b']);
  });

  test('a Pod without an IP is absent; a terminating Pod is dropped at once', () => {
    const k = bootCluster();
    api(k, 'v1/services').create(service('x', { app: 'x' }, [{ port: 80, targetPort: 8080 }]));
    for (const n of ['a', 'b']) api(k, 'v1/pods').create(pod(n, { labels: { app: 'x' } }));
    k.advance(100);
    let ep = api(k, 'v1/endpoints').get('x') as JsonObject;
    // Created at once, empty: no Pod has an IP yet.
    expect(ep.subsets).toBeUndefined();
    expect(meta(ep).labels).toEqual({ 'endpoints.kubernetes.io/managed-by': 'endpoint-controller' });
    k.advance(3000);
    api(k, 'v1/pods').del('a');
    k.advance(100);
    ep = api(k, 'v1/endpoints').get('x') as JsonObject;
    expect(ep.subsets).toEqual([{ addresses: [addr(k, 'b', 'node02')], ports: [{ port: 8080, protocol: 'TCP' }] }]);
  });

  test('publishNotReadyAddresses lists a not-ready Pod as ready; a headless Service gets the headless label', () => {
    const k = bootCluster();
    api(k, 'v1/pods').create(pod('slow', { labels: { app: 'x' }, notReady: true }));
    api(k, 'v1/services').create(service('x', { app: 'x' }, [], { clusterIP: 'None', publishNotReadyAddresses: true }, { labels: { team: 'a' } }));
    k.advance(3000);
    const ep = api(k, 'v1/endpoints').get('x') as JsonObject;
    expect(meta(ep).labels).toEqual({ team: 'a', 'service.kubernetes.io/headless': '', 'endpoints.kubernetes.io/managed-by': 'endpoint-controller' });
    // Headless without ports: addresses without ports.
    expect(ep.subsets).toEqual([{ addresses: [addr(k, 'slow', 'node01')] }]);
  });

  test('a Service without a selector gets no Endpoints from the controller', () => {
    const k = bootCluster();
    api(k, 'v1/services').create(service('manual', undefined, [{ port: 80, targetPort: 8080 }]));
    k.advance(2000);
    expect(api(k, 'v1/endpoints').get('manual')).toBeUndefined();
  });

  test('deleting the Service deletes its Endpoints; deleting the Endpoints recreates them', () => {
    const { k } = fixtureScenario();
    const first = api(k, 'v1/endpoints').get('front') as JsonObject;
    api(k, 'v1/endpoints').del('front');
    k.advance(100);
    const again = api(k, 'v1/endpoints').get('front') as JsonObject;
    expect(meta(again).uid).not.toBe(meta(first).uid);
    expect(again.subsets).toEqual(first.subsets);
    api(k, 'v1/services').del('front');
    k.advance(100);
    expect(api(k, 'v1/endpoints').get('front')).toBeUndefined();
    expect(events(k).filter((e) => (e.source as JsonObject | undefined)?.component === 'endpoint-controller')).toEqual([]);
  });

  test('leftover Endpoints without a Service are removed at controller start; ones created later are left alone', () => {
    const k = bootCluster({ controllers: [] });
    const orphan = (name: string): JsonObject => ({ apiVersion: 'v1', kind: 'Endpoints', metadata: { name }, subsets: [{ addresses: [{ ip: '10.0.0.1' }], ports: [{ port: 80 }] }] });
    api(k, 'v1/endpoints').create(orphan('leftover'));
    k.act('kcm', (ctx) => startControllerManager(ctx, DEFAULT_APISERVER, { controllers: ['endpoints'] }));
    api(k, 'v1/endpoints').create(orphan('later'));
    k.advance(1000);
    // checkLeftoverEndpoints queues every Endpoints object once; without a Service it is deleted.
    expect(api(k, 'v1/endpoints').get('leftover')).toBeUndefined();
    expect(api(k, 'v1/endpoints').get('later')).toBeDefined();
  });
});

describe('RepackSubsets and truncation', () => {
  const a = (ip: string, uid: string): JsonObject => ({ ip, nodeName: 'n', targetRef: { kind: 'Pod', namespace: 'd', name: uid, uid } });
  test('addresses sharing ports merge; not ready wins over ready for the same port', () => {
    const p80 = { name: 'a', port: 80, protocol: 'TCP' };
    const p81 = { name: 'b', port: 81, protocol: 'TCP' };
    const out = repackSubsets([
      { addresses: [a('10.0.0.2', 'u2')], ports: [p80] },
      { addresses: [a('10.0.0.1', 'u1')], ports: [p80] },
      { addresses: [a('10.0.0.2', 'u2')], ports: [p81] },
      { notReadyAddresses: [a('10.0.0.2', 'u2')], ports: [p81] },
      { addresses: [a('10.0.0.1', 'u1')], ports: [p81] },
    ]);
    expect(out).toHaveLength(2);
    const s80 = out.find((s) => (s.ports as JsonObject[])[0]?.port === 80) as JsonObject;
    const s81 = out.find((s) => (s.ports as JsonObject[])[0]?.port === 81) as JsonObject;
    expect(s80).toEqual({ addresses: [a('10.0.0.1', 'u1'), a('10.0.0.2', 'u2')], ports: [p80] });
    expect(s81).toEqual({ addresses: [a('10.0.0.1', 'u1')], notReadyAddresses: [a('10.0.0.2', 'u2')], ports: [p81] });
  });

  test('over 1000 addresses: not-ready ones are cut first, proportionally', () => {
    const many = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => a(`${prefix}.${i}`, `${prefix}-${i}`));
    const subsets: JsonObject[] = [
      { addresses: many(900, '10.1'), notReadyAddresses: many(100, '10.2') },
      { notReadyAddresses: many(100, '10.3') },
    ];
    expect(truncateEndpoints(subsets)).toBe(true);
    expect((subsets[0]?.addresses as JsonObject[]).length).toBe(900);
    expect((subsets[0]?.notReadyAddresses as JsonObject[]).length).toBe(50);
    expect((subsets[1]?.notReadyAddresses as JsonObject[]).length).toBe(50);
    expect(truncateEndpoints([{ addresses: many(1000, '10.4') }])).toBe(false);
  });
});

test('same seed, same world hash', () => {
  const run = () => {
    const { k } = fixtureScenario();
    api(k, 'v1/pods').patch('slow', { metadata: { labels: { tier: null } } });
    k.advance(5000);
    return k.hash();
  };
  expect(run()).toBe(run());
});

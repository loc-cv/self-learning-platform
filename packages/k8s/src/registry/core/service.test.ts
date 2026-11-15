// Services through the request pipeline: what kube-apiserver creates at start, ClusterIP and
// NodePort allocation and release, dry run, type changes, and the errors the allocators give.
// Expected strings and objects were checked against the v1.37.2 oracle (dry-run and real requests
// on a fresh control plane); the allocated values are random there, so ranges are checked here.

import { describe, expect, test } from 'vitest';
import { bootKernel, createRegistry, DEFAULT_START_TIME, type Ctx, type Kernel } from '@simlab/kernel';
import { hostPlugin } from '@simlab/host';
import { k8sPlugin } from '../../plugin.ts';
import { bootstrapApiServer } from '../../apiserver/bootstrap.ts';
import { DEFAULT_APISERVER } from '../../apiserver/config.ts';
import { handle } from '../../apiserver/pipeline.ts';
import { rangeGet, etcdData } from '../../apiserver/store.ts';
import type { ApiRequest, ApiResponse } from '../../apiserver/types.ts';
import type { Json, JsonObject } from '../../apimachinery/json.ts';
import { NODE_PORTS_KEY } from './service-portallocator.ts';

const registry = createRegistry([hostPlugin, k8sPlugin]);

function boot(seed = 1): Kernel {
  const k = bootKernel(registry, { seed, startTime: DEFAULT_START_TIME });
  k.act('bootstrap', (ctx) => bootstrapApiServer(ctx, DEFAULT_APISERVER));
  return k;
}

type Req = Partial<ApiRequest> & Pick<ApiRequest, 'verb'>;
// The namespace is ignored for cluster-scoped resources (IPAddress, ServiceCIDR).
const svcs = { group: '', version: 'v1', resource: 'services', namespace: 'default' };

function req(k: Kernel, r: Req): ApiResponse {
  return k.act('test', (ctx: Ctx) => handle(ctx, DEFAULT_APISERVER, { ...svcs, ...r }));
}

const body = (r: ApiResponse): JsonObject => {
  if (!r.ok) throw new Error(`expected success, got ${JSON.stringify(r)}`);
  return r.object as JsonObject;
};
const message = (r: ApiResponse): string => (!r.ok && 'status' in r ? String(r.status.message) : `not an error: ${JSON.stringify(r)}`);
const spec = (o: JsonObject): JsonObject => o.spec as JsonObject;
const service = (name: string, s: JsonObject): JsonObject => ({ apiVersion: 'v1', kind: 'Service', metadata: { name }, spec: s });
const create = (k: Kernel, name: string, s: JsonObject, dryRun = false): ApiResponse =>
  req(k, { verb: 'create', body: service(name, s), ...(dryRun ? { options: { dryRun: true } } : {}) });

const ipToNum = (ip: string): number => ip.split('.').reduce((a, b) => a * 256 + Number(b), 0);
const ipaddress = (k: Kernel, name: string): ApiResponse => req(k, { verb: 'get', group: 'networking.k8s.io', resource: 'ipaddresses', name });
const nodePorts = (k: Kernel): Json | undefined => k.act('read', (ctx: Ctx) => rangeGet(etcdData(ctx, DEFAULT_APISERVER.etcd), NODE_PORTS_KEY));
const reduced = (o: JsonObject): JsonObject => {
  const m = o.metadata as JsonObject;
  return { ...o, metadata: { name: m.name as string, namespace: m.namespace as string, labels: m.labels as Json } };
};

describe('bootstrap', () => {
  test('the kubernetes Service, its IPAddress, the ServiceCIDR, Endpoints and EndpointSlice', () => {
    const k = boot();
    const svc = body(req(k, { verb: 'get', name: 'kubernetes' }));
    expect(svc.metadata).toMatchObject({ labels: { component: 'apiserver', provider: 'kubernetes' } });
    expect(spec(svc)).toEqual({
      ports: [{ name: 'https', protocol: 'TCP', port: 443, targetPort: 6443 }],
      clusterIP: '10.96.0.1',
      clusterIPs: ['10.96.0.1'],
      type: 'ClusterIP',
      sessionAffinity: 'None',
      ipFamilies: ['IPv4'],
      ipFamilyPolicy: 'SingleStack',
      internalTrafficPolicy: 'Cluster',
    });
    expect(body(ipaddress(k, '10.96.0.1'))).toMatchObject({
      metadata: { name: '10.96.0.1', labels: { 'ipaddress.kubernetes.io/ip-family': 'IPv4', 'ipaddress.kubernetes.io/managed-by': 'ipallocator.k8s.io' } },
      spec: { parentRef: { resource: 'services', namespace: 'default', name: 'kubernetes' } },
    });
    const cidr = body(req(k, { verb: 'get', group: 'networking.k8s.io', resource: 'servicecidrs', name: 'kubernetes' }));
    expect(cidr.spec).toEqual({ cidrs: ['10.96.0.0/12'] });
    expect(cidr.status).toMatchObject({ conditions: [{ type: 'Ready', status: 'True', reason: '', message: 'Kubernetes default Service CIDR is ready' }] });
    const ep = body(req(k, { verb: 'get', resource: 'endpoints', name: 'kubernetes' }));
    expect(reduced(ep)).toEqual({
      kind: 'Endpoints',
      apiVersion: 'v1',
      metadata: { name: 'kubernetes', namespace: 'default', labels: { 'endpointslice.kubernetes.io/skip-mirror': 'true' } },
      subsets: [{ addresses: [{ ip: '172.16.0.10' }], ports: [{ name: 'https', port: 6443, protocol: 'TCP' }] }],
    });
    const eps = body(req(k, { verb: 'get', group: 'discovery.k8s.io', resource: 'endpointslices', name: 'kubernetes' }));
    expect(reduced(eps)).toEqual({
      kind: 'EndpointSlice',
      apiVersion: 'discovery.k8s.io/v1',
      metadata: { name: 'kubernetes', namespace: 'default', labels: { 'kubernetes.io/service-name': 'kubernetes' } },
      addressType: 'IPv4',
      endpoints: [{ addresses: ['172.16.0.10'], conditions: { ready: true } }],
      ports: [{ name: 'https', protocol: 'TCP', port: 6443 }],
    });
  });
});

describe('ClusterIP allocation', () => {
  test('a random address of the upper sub-range, recorded as an IPAddress, released on delete', () => {
    for (const seed of [1, 2, 3]) {
      const k = boot(seed);
      const s = spec(body(create(k, 'web', { selector: { app: 'web' }, ports: [{ port: 80 }] })));
      const ip = s.clusterIP as string;
      // 10.96.0.0/12: first 10.96.0.1, last 10.111.255.254, range offset 256 → upper sub-range from 10.96.1.1.
      expect(ipToNum(ip)).toBeGreaterThanOrEqual(ipToNum('10.96.1.1'));
      expect(ipToNum(ip)).toBeLessThanOrEqual(ipToNum('10.111.255.254'));
      expect(s.clusterIPs).toEqual([ip]);
      expect(body(ipaddress(k, ip)).spec).toEqual({ parentRef: { resource: 'services', namespace: 'default', name: 'web' } });
      expect(body(req(k, { verb: 'delete', name: 'web' })).kind).toBe('Service');
      expect(ipaddress(k, ip).code).toBe(404);
    }
  });

  test('a requested address: taken, outside the range, the network and broadcast addresses', () => {
    const k = boot();
    expect(spec(body(create(k, 'fixed', { clusterIP: '10.96.100.100', ports: [{ port: 80 }] }))).clusterIP).toBe('10.96.100.100');
    expect(message(create(k, 'taken', { clusterIP: '10.96.100.100', ports: [{ port: 80 }] }))).toBe(
      'Service "taken" is invalid: spec.clusterIPs: Invalid value: ["10.96.100.100"]: failed to allocate IP 10.96.100.100: provided IP is already allocated',
    );
    for (const ip of ['192.168.0.10', '10.96.0.0', '10.111.255.255']) {
      expect(message(create(k, 'edge', { clusterIP: ip, ports: [{ port: 80 }] }))).toBe(
        `Service "edge" is invalid: spec.clusterIPs: Invalid value: ["${ip}"]: failed to allocate IP ${ip}: the provided network does not match the current range`,
      );
    }
    expect(message(create(k, 'zeros', { clusterIP: '10.96.000.5', ports: [{ port: 80 }] }))).toBe('Service "zeros" is invalid: spec.clusterIPs[0]: Invalid value: "10.96.000.5": must not have leading 0s');
  });

  test('allocation errors come alone, before validation', () => {
    const k = boot();
    // checked against the v1.37.2 oracle: two ports asking for one NodePort fail in the allocator.
    expect(message(create(k, 'np', { type: 'NodePort', ports: [{ port: 80, nodePort: 30001, name: 'a' }, { port: 81, nodePort: 30001, name: 'b' }] }))).toBe(
      'Service "np" is invalid: spec.ports[1].nodePort: Invalid value: 30001: provided port is already allocated',
    );
    expect(message(create(k, 'bad', { clusterIP: '192.168.0.10', ports: [{ port: 80 }, { port: 81 }] }))).toContain('the provided network does not match the current range');
  });

  test('clusterIP may not change', () => {
    const k = boot();
    const r = req(k, { verb: 'patch', name: 'kubernetes', body: { spec: { clusterIP: '10.96.0.2' } }, options: { patchType: 'merge' } });
    expect(message(r)).toBe('Service "kubernetes" is invalid: spec.clusterIPs[0]: Invalid value: ["10.96.0.2"]: may not change once set');
  });

  test('headless and selectorless: RequireDualStack with both families, no address', () => {
    const k = boot();
    expect(spec(body(create(k, 'hl', { clusterIP: 'None' })))).toMatchObject({ clusterIP: 'None', clusterIPs: ['None'], ipFamilies: ['IPv4', 'IPv6'], ipFamilyPolicy: 'RequireDualStack' });
  });

  test('ExternalName gets no address and no internalTrafficPolicy', () => {
    const k = boot();
    const s = spec(body(create(k, 'ext', { type: 'ExternalName', externalName: 'x.com', internalTrafficPolicy: 'Cluster' })));
    expect(s).toEqual({ type: 'ExternalName', sessionAffinity: 'None', externalName: 'x.com' });
  });
});

describe('NodePort allocation', () => {
  test('random ports of the upper sub-range, one per port number, released on delete and on a type change', () => {
    const k = boot();
    const s = spec(body(create(k, 'np', { type: 'NodePort', ports: [{ name: 'a', port: 80 }, { name: 'b', port: 81 }, { name: 'c', port: 80, protocol: 'UDP' }] })));
    const ports = (s.ports as JsonObject[]).map((p) => p.nodePort as number);
    // 30000-32767: range offset min(max(16, 2768/32), 128) = 86.
    for (const p of ports) expect(p).toBeGreaterThanOrEqual(30086);
    expect(ports[2]).toBe(ports[0]);
    expect(nodePorts(k)).toEqual({ range: '30000-32767', ports: [...new Set(ports)].sort((a, b) => a - b) });
    // To ClusterIP: the NodePorts the old type needed go.
    const cip = body(req(k, { verb: 'patch', name: 'np', body: { spec: { type: 'ClusterIP', externalTrafficPolicy: null } }, options: { patchType: 'merge' } }));
    expect((spec(cip).ports as JsonObject[]).every((p) => p.nodePort === undefined)).toBe(true);
    expect(nodePorts(k)).toEqual({ range: '30000-32767', ports: [] });
    // Back to NodePort: new ports.
    const np2 = body(req(k, { verb: 'patch', name: 'np', body: { spec: { type: 'NodePort' } }, options: { patchType: 'merge' } }));
    const again = (spec(np2).ports as JsonObject[]).map((p) => p.nodePort as number);
    expect(again.every((p) => p >= 30086 && p <= 32767)).toBe(true);
    body(req(k, { verb: 'delete', name: 'np' }));
    expect(nodePorts(k)).toEqual({ range: '30000-32767', ports: [] });
  });

  test('a requested port: outside the range, taken; a resubmitted object keeps its ports', () => {
    const k = boot();
    expect(message(create(k, 'low', { type: 'NodePort', ports: [{ port: 80, nodePort: 80 }] }))).toBe(
      'Service "low" is invalid: spec.ports[0].nodePort: Invalid value: 80: provided port is not in the valid range. The range of valid ports is 30000-32767',
    );
    const first = body(create(k, 'a', { type: 'NodePort', ports: [{ port: 80, nodePort: 30080 }] }));
    expect(message(create(k, 'b', { type: 'NodePort', ports: [{ port: 80, nodePort: 30080 }] }))).toBe(
      'Service "b" is invalid: spec.ports[0].nodePort: Invalid value: 30080: provided port is already allocated',
    );
    // PUT of the object without clusterIP and nodePort: patchAllocatedValues fills them in.
    const put = body(req(k, { verb: 'update', name: 'a', body: service('a', { type: 'NodePort', ports: [{ port: 80 }] }) }));
    expect(spec(put).clusterIP).toBe(spec(first).clusterIP);
    expect((spec(put).ports as JsonObject[])[0]?.nodePort).toBe(30080);
  });

  test('LoadBalancer with externalTrafficPolicy Local gets a health check port', () => {
    const k = boot();
    const s = spec(body(create(k, 'lb', { type: 'LoadBalancer', externalTrafficPolicy: 'Local', ports: [{ port: 443 }] })));
    expect(s.allocateLoadBalancerNodePorts).toBe(true);
    expect(s.healthCheckNodePort).toBeGreaterThanOrEqual(30000);
    expect(s.healthCheckNodePort).not.toBe((s.ports as JsonObject[])[0]?.nodePort);
  });
});

describe('dry run', () => {
  test('nothing is allocated; the dry-run allocators answer as upstream', () => {
    const k = boot();
    // checked against the v1.37.2 oracle.
    const s = spec(body(create(k, 'dry', { type: 'NodePort', ports: [{ name: 'a', port: 80 }, { name: 'b', port: 81 }, { name: 'c', port: 80, protocol: 'UDP' }] }, true)));
    expect(s.clusterIP).toBe('10.96.0.0');
    expect((s.ports as JsonObject[]).map((p) => p.nodePort)).toEqual([32769, 32770, 32769]);
    expect(nodePorts(k)).toBeUndefined();
    expect(spec(body(create(k, 'dry', { clusterIP: '10.96.0.1', ports: [{ port: 80 }] }, true))).clusterIP).toBe('10.96.0.1');
    expect(message(create(k, 'dry', { clusterIP: '192.168.0.10', ports: [{ port: 80 }] }, true))).toBe(
      'Service "dry" is invalid: spec.clusterIPs: Invalid value: ["192.168.0.10"]: failed to allocate IP 192.168.0.10: the provided IP (192.168.0.10) is not in the valid range. The range of valid IPs is 10.96.0.0/12',
    );
    expect(spec(body(create(k, 'dry', { type: 'NodePort', ports: [{ name: 'a', port: 80, nodePort: 80 }] }, true))).clusterIP).toBe('10.96.0.0');
    expect(req(k, { verb: 'get', name: 'dry' }).code).toBe(404);
  });
});

describe('warnings and field selectors', () => {
  test('GetWarningsForService', () => {
    const k = boot();
    // checked against the v1.37.2 oracle, in this order.
    const r = create(k, 'w', { type: 'LoadBalancer', externalIPs: ['2001:db8:0::1'], externalName: 'x.com', loadBalancerIP: '2001:db8:0::5', clusterIP: '10.96.0.7', ports: [{ port: 80 }], trafficDistribution: 'PreferClose' }, true);
    expect(r.warnings).toEqual([
      'spec.externalIPs[0]: IPv6 address "2001:db8:0::1" should be in RFC 5952 canonical format ("2001:db8::1")',
      'spec.externalIPs is deprecated and may no longer be implemented in some clusters',
      'spec.loadBalancerIP: IPv6 address "2001:db8:0::5" should be in RFC 5952 canonical format ("2001:db8::5")',
      'spec.externalName is ignored when spec.type is not "ExternalName"',
      'spec.trafficDistribution: "PreferClose" is deprecated; use "PreferSameZone"',
    ]);
    const h = create(k, 'h', { clusterIP: 'None', selector: { a: 'b' }, externalIPs: ['1.2.3.4'], loadBalancerIP: '1.2.3.5', sessionAffinity: 'ClientIP', ports: [{ port: 80 }] }, true);
    expect(h.warnings).toEqual(['spec.loadBalancerIP is ignored for headless services', 'spec.externalIPs is ignored for headless services', 'spec.SessionAffinity is ignored for headless services']);
  });

  test('spec.type and spec.clusterIP select; other labels are refused', () => {
    const k = boot();
    body(create(k, 'np', { type: 'NodePort', ports: [{ port: 80 }] }));
    const list = body(req(k, { verb: 'list', options: { fieldSelector: 'spec.type=NodePort' } }));
    expect((list.items as JsonObject[]).map((i) => (i.metadata as JsonObject).name)).toEqual(['np']);
    const byIP = body(req(k, { verb: 'list', options: { fieldSelector: 'spec.clusterIP=10.96.0.1' } }));
    expect((byIP.items as JsonObject[]).map((i) => (i.metadata as JsonObject).name)).toEqual(['kubernetes']);
    expect(message(req(k, { verb: 'list', options: { fieldSelector: 'spec.ports=80' } }))).toBe('field label not supported: spec.ports');
  });
});

describe('validation', () => {
  // Each message was captured from the v1.37.2 oracle with the same dry-run request.
  const RFC1123_LABEL =
    "a lowercase RFC 1123 label must consist of lower case alphanumeric characters or '-', and must start and end with an alphanumeric character (e.g. 'my-name',  or '123-abc', regex used for validation is '[a-z0-9]([-a-z0-9]*[a-z0-9])?')";
  const RFC1123_SUBDOMAIN =
    "a lowercase RFC 1123 subdomain must consist of lower case alphanumeric characters, '-' or '.', and must start and end with an alphanumeric character (e.g. 'example.com', regex used for validation is '[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*')";
  const cases: [string, JsonObject, string][] = [
    [
      'v2',
      { type: 'ExternalName', externalName: 'Bad_Name.', clusterIP: '10.96.5.5', ipFamilyPolicy: 'SingleStack' },
      `[spec.clusterIPs: Forbidden: may not be set for ExternalName services, spec.ipFamilyPolicy: Forbidden: may not be set for ExternalName services, spec.externalName: Invalid value: "Bad_Name": ${RFC1123_SUBDOMAIN}]`,
    ],
    ['v3', { type: 'ExternalName' }, 'spec.externalName: Required value'],
    [
      'v4',
      {
        ports: [{ port: 80, nodePort: 30005, targetPort: 'Bad--name', name: 'A' }, { port: 80, name: 'a', appProtocol: 'x/y/z' }],
        sessionAffinity: 'Sticky',
        loadBalancerSourceRanges: ['10.0.0.0/8'],
        allocateLoadBalancerNodePorts: false,
        externalTrafficPolicy: 'Local',
        healthCheckNodePort: 30100,
        internalTrafficPolicy: 'Both',
        loadBalancerClass: 'x',
        selector: { a: 'b c' },
      },
      '[' +
        [
          `spec.ports[0].name: Invalid value: "A": ${RFC1123_LABEL}`,
          'spec.ports[0].targetPort: Invalid value: "Bad--name": must contain only alpha-numeric characters (a-z, 0-9), and hyphens (-)',
          'spec.ports[0].targetPort: Invalid value: "Bad--name": must not contain consecutive hyphens',
          "spec.ports[1].appProtocol: Invalid value: \"x/y/z\": a valid label key must consist of alphanumeric characters, '-', '_' or '.', and must start and end with an alphanumeric character (e.g. 'MyName',  or 'my.name',  or '123-abc', regex used for validation is '([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9]') with an optional DNS subdomain prefix and '/' (e.g. 'example.com/MyName')",
          "spec.selector: Invalid value: \"b c\": a valid label must be an empty string or consist of alphanumeric characters, '-', '_' or '.', and must start and end with an alphanumeric character (e.g. 'MyValue',  or 'my_value',  or '12345', regex used for validation is '(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?')",
          'spec.sessionAffinity: Unsupported value: "Sticky": supported values: "ClientIP", "None"',
          "spec.ports[0].nodePort: Forbidden: may not be used when `type` is 'ClusterIP'",
          'spec.ports[1]: Duplicate value: {"Name":"","Protocol":"TCP","AppProtocol":null,"Port":80,"TargetPort":0,"NodePort":0}',
          "spec.LoadBalancerSourceRanges: Forbidden: may only be used when `type` is 'LoadBalancer'",
          "spec.allocateLoadBalancerNodePorts: Forbidden: may only be used when `type` is 'LoadBalancer'",
          "spec.loadBalancerClass: Forbidden: may only be used when `type` is 'LoadBalancer'",
          'spec.externalTrafficPolicy: Invalid value: "Local": may only be set for externally-accessible services',
          "spec.healthCheckNodePort: Invalid value: 30100: may only be set when `type` is 'LoadBalancer' and `externalTrafficPolicy` is 'Local'",
          'spec.internalTrafficPolicy: Unsupported value: "Both": supported values: "Cluster", "Local"',
        ].join(', ') +
        ']',
    ],
    [
      'v5',
      { type: 'LoadBalancer', ports: [{ port: 80 }], externalTrafficPolicy: 'Local', sessionAffinity: 'ClientIP', sessionAffinityConfig: { clientIP: { timeoutSeconds: 0 } } },
      'spec.sessionAffinityConfig.clientIP.timeoutSeconds: Invalid value: 0: must be greater than 0 and less than 86400',
    ],
    [
      'v6',
      { clusterIPs: ['10.96.5.5', '10.96.5.6'], ports: [{ port: 80 }] },
      '[spec.clusterIPs: Invalid value: ["10.96.5.5","10.96.5.6"]: must be empty when `clusterIP` is not specified, spec.clusterIPs: Invalid value: ["10.96.5.5","10.96.5.6"]: may specify no more than one IP for each IP family]',
    ],
    ['v7', { ipFamilies: ['IPv6'], ports: [{ port: 80 }] }, 'spec.ipFamilies[0]: Invalid value: "IPv6": not configured on this cluster'],
    ['v8', { ipFamilyPolicy: 'RequireDualStack', ports: [{ port: 80 }] }, 'spec.ipFamilyPolicy: Invalid value: "RequireDualStack": this cluster is not configured for dual-stack services'],
    ['v9', { clusterIP: 'fd00::5', ports: [{ port: 80 }] }, 'spec.clusterIPs[0]: Invalid value: ["fd00::5"]: IPv6 is not configured on this cluster'],
  ];
  test.each(cases)('svc-%s', (name, s, expected) => {
    const k = boot();
    expect(message(create(k, `svc-${name}`, s, true))).toBe(`Service "svc-${name}" is invalid: ${expected}`);
  });

  test('ClientIP affinity gets the default timeout', () => {
    const k = boot();
    expect(spec(body(create(k, 'svc-v1', { sessionAffinity: 'ClientIP', ports: [{ port: 80 }] }, true))).sessionAffinityConfig).toEqual({ clientIP: { timeoutSeconds: 10800 } });
  });
});

describe('type changes', () => {
  test('to ExternalName releases the ClusterIP; back to ClusterIP allocates one', () => {
    const k = boot();
    const ip = spec(body(create(k, 'sw', { ports: [{ port: 80 }] }))).clusterIP as string;
    const ext = body(req(k, { verb: 'patch', name: 'sw', body: { spec: { type: 'ExternalName', externalName: 'x.com' } }, options: { patchType: 'merge' } }));
    expect(spec(ext)).toMatchObject({ type: 'ExternalName', externalName: 'x.com' });
    expect(spec(ext).clusterIP).toBeUndefined();
    expect(spec(ext).ipFamilies).toBeUndefined();
    expect(spec(ext).internalTrafficPolicy).toBeUndefined();
    expect(ipaddress(k, ip).code).toBe(404);
    const back = body(req(k, { verb: 'patch', name: 'sw', body: { spec: { type: 'ClusterIP', externalName: null } }, options: { patchType: 'merge' } }));
    const ip2 = spec(back).clusterIP as string;
    expect(spec(back).clusterIPs).toEqual([ip2]);
    expect(ipaddress(k, ip2).code).toBe(200);
  });

  test('a dry-run update allocates nothing', () => {
    const k = boot();
    body(create(k, 'd', { ports: [{ port: 80 }] }));
    const r = body(req(k, { verb: 'patch', name: 'd', body: { spec: { type: 'NodePort' } }, options: { patchType: 'merge', dryRun: true } }));
    expect((spec(r).ports as JsonObject[])[0]?.nodePort).toBe(32769);
    expect(nodePorts(k)).toBeUndefined();
  });
});

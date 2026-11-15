// Node, Secret, ServiceAccount and Lease through the request pipeline: the parts of their
// strategies the fixtures do not reach. Expected values checked against the v1.37.2 oracle.

import { describe, expect, test } from 'vitest';
import { bootKernel, createRegistry, DEFAULT_START_TIME, type Ctx, type Kernel } from '@simlab/kernel';
import { hostPlugin } from '@simlab/host';
import { k8sPlugin } from '../../plugin.ts';
import { bootstrapApiServer } from '../../apiserver/bootstrap.ts';
import { DEFAULT_APISERVER } from '../../apiserver/config.ts';
import { handle } from '../../apiserver/pipeline.ts';
import type { ApiRequest, ApiResponse } from '../../apiserver/types.ts';
import { encodeBase64 } from '../../apimachinery/base64.ts';
import type { JsonObject } from '../../apimachinery/json.ts';

const registry = createRegistry([hostPlugin, k8sPlugin]);

function boot(): Kernel {
  const k = bootKernel(registry, { seed: 1, startTime: DEFAULT_START_TIME });
  k.act('bootstrap', (ctx) => bootstrapApiServer(ctx, DEFAULT_APISERVER));
  return k;
}

function req(k: Kernel, r: Partial<ApiRequest> & Pick<ApiRequest, 'verb' | 'resource'>): ApiResponse {
  return k.act('test', (ctx: Ctx) => handle(ctx, DEFAULT_APISERVER, { group: '', version: 'v1', ...r }));
}

const body = (r: ApiResponse): JsonObject => {
  if (!r.ok) throw new Error(`expected success, got ${JSON.stringify(r)}`);
  return r.object as JsonObject;
};
const message = (r: ApiResponse): string => (!r.ok && 'status' in r ? (r.status.message as string) : `ok ${r.code}`);

describe('Node', () => {
  const nodes = { resource: 'nodes' };
  const create = (k: Kernel, name: string, extra: JsonObject = {}): JsonObject =>
    body(req(k, { ...nodes, verb: 'create', body: { apiVersion: 'v1', kind: 'Node', metadata: { name }, spec: { podCIDR: '10.244.1.0/24' }, ...extra } }));

  test('create drops disabled fields and warns about externalID and non-canonical CIDRs', () => {
    const k = boot();
    const r = req(k, {
      ...nodes,
      verb: 'create',
      body: { metadata: { name: 'n1' }, spec: { podCIDRs: ['10.244.9.0/24', 'FD00:0::/64'], externalID: 'x', podPreemptionPolicy: {} }, status: { config: { error: 'e' } } },
    });
    expect(r.ok && r.warnings).toEqual(['spec.externalID: this field is deprecated, and is unused by Kubernetes', 'spec.podCIDRs[1]: IPv6 CIDR value "FD00:0::/64" should be in RFC 5952 canonical format ("fd00::/64")']);
    const n = body(r);
    expect(n.spec).toEqual({ podCIDR: '10.244.9.0/24', podCIDRs: ['10.244.9.0/24', 'FD00:0::/64'], externalID: 'x' });
    expect((n.status as JsonObject).config).toBeUndefined();
  });

  test('the main resource keeps the status, the status subresource keeps the spec', () => {
    const k = boot();
    create(k, 'n1', { status: { capacity: { cpu: '2' } } });
    const updated = body(req(k, { ...nodes, verb: 'patch', name: 'n1', body: { spec: { unschedulable: true }, status: { capacity: { cpu: '4' } } } }));
    expect(updated.spec).toMatchObject({ unschedulable: true });
    expect((updated.status as JsonObject).capacity).toEqual({ cpu: '2' });
    const status = body(req(k, { ...nodes, verb: 'patch', name: 'n1', subresource: 'status', body: { spec: { unschedulable: false }, status: { capacity: { cpu: '4' } } } }));
    expect(status.spec).toMatchObject({ unschedulable: true });
    expect((status.status as JsonObject).capacity).toEqual({ cpu: '4' });
  });

  test('field selectors: spec.unschedulable and metadata.name; no metadata.namespace', () => {
    const k = boot();
    create(k, 'n1');
    create(k, 'n2', { spec: { unschedulable: true } });
    const names = (fieldSelector: string): string[] => (body(req(k, { ...nodes, verb: 'list', options: { fieldSelector } })).items as JsonObject[]).map((i) => (i.metadata as JsonObject).name as string);
    expect(names('spec.unschedulable=true')).toEqual(['n2']);
    expect(names('spec.unschedulable=false')).toEqual(['n1']);
    expect(names('metadata.name!=n1')).toEqual(['n2']);
    expect(message(req(k, { ...nodes, verb: 'list', options: { fieldSelector: 'metadata.namespace=x' } }))).toBe('field label not supported: metadata.namespace');
  });

  test('pod CIDRs are fixed once set', () => {
    const k = boot();
    create(k, 'n1');
    expect(message(req(k, { ...nodes, verb: 'patch', name: 'n1', body: { spec: { podCIDR: '10.244.2.0/24' } } }))).toBe(
      'Node "n1" is invalid: spec.podCIDRs: Forbidden: node updates may not change podCIDR except from "" to valid',
    );
  });
});

describe('Secret', () => {
  test('a kubernetes.io/tls Secret with PEM inputs switched gets the tls.X509KeyPair warning', () => {
    const k = boot();
    const pem = (type: string): string => encodeBase64(`-----BEGIN ${type}-----\nAAAA\n-----END ${type}-----\n`);
    const r = req(k, { resource: 'secrets', namespace: 'default', verb: 'create', body: { metadata: { name: 's' }, type: 'kubernetes.io/tls', data: { 'tls.crt': pem('PRIVATE KEY'), 'tls.key': pem('PRIVATE KEY') } } });
    expect(r.code).toBe(201);
    expect(r.warnings).toEqual(['tls: failed to find certificate PEM data in certificate input, but did find a private key; PEM inputs may have been switched']);
  });

  test('field selector on type', () => {
    const k = boot();
    req(k, { resource: 'secrets', namespace: 'default', verb: 'create', body: { metadata: { name: 'a' }, stringData: { x: 'y' } } });
    req(k, { resource: 'secrets', namespace: 'default', verb: 'create', body: { metadata: { name: 'b' }, type: 'example.com/x' } });
    const items = body(req(k, { resource: 'secrets', namespace: 'default', verb: 'list', options: { fieldSelector: 'type=example.com/x' } })).items as JsonObject[];
    expect(items.map((i) => (i.metadata as JsonObject).name)).toEqual(['b']);
  });
});

describe('ServiceAccount', () => {
  test('secret references keep only their name; delete returns the object', () => {
    const k = boot();
    const sa = body(req(k, { resource: 'serviceaccounts', namespace: 'default', verb: 'create', body: { metadata: { name: 'robot' }, secrets: [{ name: 'a', namespace: 'x', uid: 'u' }] } }));
    expect(sa.secrets).toEqual([{ name: 'a' }]);
    const deleted = body(req(k, { resource: 'serviceaccounts', namespace: 'default', verb: 'delete', name: 'robot' }));
    expect(deleted.kind).toBe('ServiceAccount');
  });
});

describe('Lease', () => {
  const leases = { group: 'coordination.k8s.io', resource: 'leases', namespace: 'default' };
  test('a PUT needs a resourceVersion, but creates a missing Lease', () => {
    const k = boot();
    const created = req(k, { ...leases, verb: 'update', name: 'l', body: { metadata: { name: 'l' }, spec: { holderIdentity: 'a' } } });
    expect(created.code).toBe(201);
    expect(message(req(k, { ...leases, verb: 'update', name: 'l', body: { metadata: { name: 'l' }, spec: { holderIdentity: 'b' } } }))).toBe(
      'leases.coordination.k8s.io "l" is invalid: metadata.resourceVersion: Invalid value: 0: must be specified for an update',
    );
  });
});

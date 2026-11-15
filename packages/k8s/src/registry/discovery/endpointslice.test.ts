// Endpoints and EndpointSlices through the request pipeline: validation (the handwritten rules
// and, for EndpointSlice, the declarative ones that replace the covered handwritten errors),
// warnings, the generation of slices and create on update. Expected messages were captured from
// the v1.37.2 oracle with the same requests.

import { describe, expect, test } from 'vitest';
import { bootKernel, createRegistry, DEFAULT_START_TIME, type Ctx, type Kernel } from '@simlab/kernel';
import { hostPlugin } from '@simlab/host';
import { k8sPlugin } from '../../plugin.ts';
import { bootstrapApiServer } from '../../apiserver/bootstrap.ts';
import { DEFAULT_APISERVER } from '../../apiserver/config.ts';
import { handle } from '../../apiserver/pipeline.ts';
import type { ApiRequest, ApiResponse } from '../../apiserver/types.ts';
import type { JsonObject } from '../../apimachinery/json.ts';

const registry = createRegistry([hostPlugin, k8sPlugin]);

function boot(): Kernel {
  const k = bootKernel(registry, { seed: 1, startTime: DEFAULT_START_TIME });
  k.act('bootstrap', (ctx) => bootstrapApiServer(ctx, DEFAULT_APISERVER));
  return k;
}

type Req = Partial<ApiRequest> & Pick<ApiRequest, 'verb'>;
const slices = { group: 'discovery.k8s.io', version: 'v1', resource: 'endpointslices', namespace: 'default' };
const endpoints = { group: '', version: 'v1', resource: 'endpoints', namespace: 'default' };

const req = (k: Kernel, api: typeof slices, r: Req): ApiResponse => k.act('test', (ctx: Ctx) => handle(ctx, DEFAULT_APISERVER, { ...api, ...r }));
const body = (r: ApiResponse): JsonObject => {
  if (!r.ok) throw new Error(`expected success, got ${JSON.stringify(r)}`);
  return r.object as JsonObject;
};
const message = (r: ApiResponse): string => (!r.ok && 'status' in r ? String(r.status.message) : `not an error: ${JSON.stringify(r)}`);
const slice = (o: JsonObject): JsonObject => ({ apiVersion: 'discovery.k8s.io/v1', kind: 'EndpointSlice', ...o });
const merge = (b: JsonObject) => ({ body: b, options: { patchType: 'merge' as const } });

const RFC1123_SUBDOMAIN =
  "a lowercase RFC 1123 subdomain must consist of lower case alphanumeric characters, '-' or '.', and must start and end with an alphanumeric character (e.g. 'example.com', regex used for validation is '[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*')";
const RFC1123_LABEL =
  "a lowercase RFC 1123 label must consist of lower case alphanumeric characters or '-', and must start and end with an alphanumeric character (e.g. 'my-name',  or '123-abc', regex used for validation is '[a-z0-9]([-a-z0-9]*[a-z0-9])?')";

describe('EndpointSlice validation', () => {
  test('declarative errors replace the covered handwritten ones and come last', () => {
    const k = boot();
    const r = req(k, slices, { verb: 'create', body: slice({ metadata: { name: 'misc-es' }, endpoints: [{ addresses: [] }], ports: [{ port: 80, name: 'a' }, { port: 81, name: 'a', protocol: 'HTTP' }] }) });
    expect(message(r)).toBe(
      'EndpointSlice.discovery.k8s.io "misc-es" is invalid: [ports[1].name: Duplicate value: "a", ports[1].protocol: Unsupported value: "HTTP": supported values: "SCTP", "TCP", "UDP", addressType: Required value, endpoints[0].addresses: Required value]',
    );
    expect(message(req(k, slices, { verb: 'create', body: slice({ metadata: { name: 'misc-es' }, addressType: 'IPX', endpoints: [{ addresses: ['1.2.3.4'] }] }) }))).toBe(
      'EndpointSlice.discovery.k8s.io "misc-es" is invalid: addressType: Unsupported value: "IPX": supported values: "FQDN", "IPv4", "IPv6"',
    );
  });

  test('addresses per address type, node name, hostname', () => {
    const k = boot();
    const r = req(k, slices, {
      verb: 'create',
      body: slice({ metadata: { name: 'misc-es' }, addressType: 'IPv4', endpoints: [{ addresses: ['1.2.3', '::1', '127.0.0.1', '010.1.1.1'], nodeName: 'Bad_Node', hostname: 'A.b' }] }),
    });
    expect(message(r)).toBe(
      'EndpointSlice.discovery.k8s.io "misc-es" is invalid: [' +
        [
          'endpoints[0].addresses[0]: Invalid value: "1.2.3": must be a valid IP address, (e.g. 10.9.8.7 or 2001:db8::ffff)',
          'endpoints[0].addresses: Invalid value: "::1": must be an IPv4 address',
          'endpoints[0].addresses[1]: Invalid value: "::1": may not be in the loopback range (127.0.0.0/8, ::1/128)',
          'endpoints[0].addresses[2]: Invalid value: "127.0.0.1": may not be in the loopback range (127.0.0.0/8, ::1/128)',
          'endpoints[0].addresses[3]: Invalid value: "010.1.1.1": must not have leading 0s',
          `endpoints[0].nodeName: Invalid value: "Bad_Node": ${RFC1123_SUBDOMAIN}`,
          `endpoints[0].hostname: Invalid value: "A.b": ${RFC1123_LABEL}`,
        ].join(', ') +
        ']',
    );
    expect(message(req(k, slices, { verb: 'create', body: slice({ metadata: { name: 'misc-es' }, addressType: 'FQDN', endpoints: [{ addresses: ['foo.com', 'Bad_Name'] }] }) }))).toBe(
      `EndpointSlice.discovery.k8s.io "misc-es" is invalid: endpoints[0].addresses[1]: Invalid value: "Bad_Name": ${RFC1123_SUBDOMAIN}`,
    );
  });

  test('addressType is immutable (the declarative error, with a null value)', () => {
    const k = boot();
    body(req(k, slices, { verb: 'create', body: slice({ metadata: { name: 'misc-es1' }, addressType: 'IPv4', endpoints: [{ addresses: ['10.1.1.1'] }] }) }));
    expect(message(req(k, slices, { verb: 'patch', name: 'misc-es1', ...merge({ addressType: 'IPv6' }) }))).toBe(
      'EndpointSlice.discovery.k8s.io "misc-es1" is invalid: addressType: Invalid value: null: field is immutable',
    );
    expect(message(req(k, slices, { verb: 'patch', name: 'misc-es1', ...merge({ addressType: 'IPX', endpoints: [{ addresses: [] }] }) }))).toBe(
      'EndpointSlice.discovery.k8s.io "misc-es1" is invalid: [addressType: Unsupported value: "IPX": supported values: "FQDN", "IPv4", "IPv6", addressType: Invalid value: null: field is immutable, endpoints[0].addresses: Required value]',
    );
    expect(message(req(k, slices, { verb: 'patch', name: 'misc-es1', ...merge({ addressType: '', metadata: { labels: { a: 'b' } } }) }))).toBe(
      'EndpointSlice.discovery.k8s.io "misc-es1" is invalid: [addressType: Required value, addressType: Invalid value: null: field is immutable]',
    );
  });
});

describe('EndpointSlice strategy', () => {
  test('generation starts at 1 and moves with anything but metadata, or the labels', () => {
    const k = boot();
    const created = body(req(k, slices, { verb: 'create', body: slice({ metadata: { name: 'g' }, addressType: 'IPv4', endpoints: [{ addresses: ['10.1.1.1'] }] }) }));
    expect((created.metadata as JsonObject).generation).toBe(1);
    const ann = body(req(k, slices, { verb: 'patch', name: 'g', ...merge({ metadata: { annotations: { a: 'b' } } }) }));
    expect((ann.metadata as JsonObject).generation).toBe(1);
    const lab = body(req(k, slices, { verb: 'patch', name: 'g', ...merge({ metadata: { labels: { a: 'b' } } }) }));
    expect((lab.metadata as JsonObject).generation).toBe(2);
    const eps = body(req(k, slices, { verb: 'patch', name: 'g', ...merge({ endpoints: [{ addresses: ['10.1.1.2'] }] }) }));
    expect((eps.metadata as JsonObject).generation).toBe(3);
  });

  test('FQDN is deprecated; non-canonical addresses warn', () => {
    const k = boot();
    const r = req(k, slices, { verb: 'create', body: slice({ metadata: { name: 'f' }, addressType: 'FQDN', endpoints: [{ addresses: ['example.com'] }] }) });
    expect(r.warnings).toEqual(['spec.addressType: FQDN endpoints are deprecated']);
    const v6 = req(k, slices, { verb: 'create', body: slice({ metadata: { name: 'v6' }, addressType: 'IPv6', endpoints: [{ addresses: ['2001:db8::1'] }] }) });
    expect(v6.ok).toBe(true);
  });

  test('no create on update', () => {
    const k = boot();
    expect(req(k, slices, { verb: 'update', name: 'none', body: slice({ metadata: { name: 'none' }, addressType: 'IPv4', endpoints: [] }) }).code).toBe(404);
  });
});

describe('Endpoints', () => {
  test('validation of subsets, addresses and ports, after the deprecation warning', () => {
    const k = boot();
    const r = req(k, endpoints, {
      verb: 'create',
      body: {
        apiVersion: 'v1',
        kind: 'Endpoints',
        metadata: { name: 'misc-ep' },
        subsets: [{ ports: [{ port: 0 }, { port: 80, name: 'a', protocol: 'HTTP' }] }, { addresses: [{ ip: '1.2.3.4', hostname: 'A', nodeName: 'Bad_N' }, { ip: '0.0.0.0' }], notReadyAddresses: [{ ip: '169.254.1.1' }, { ip: '224.0.0.1' }] }],
      },
    });
    expect(message(r)).toBe(
      'Endpoints "misc-ep" is invalid: [' +
        [
          'subsets[0]: Required value: must specify `addresses` or `notReadyAddresses`',
          'subsets[0].ports[0].name: Required value',
          'subsets[0].ports[0].port: Invalid value: 0: must be between 1 and 65535, inclusive',
          'subsets[0].ports[1].protocol: Unsupported value: "HTTP": supported values: "SCTP", "TCP", "UDP"',
          `subsets[1].addresses[0].hostname: Invalid value: "A": ${RFC1123_LABEL}`,
          `subsets[1].addresses[0].nodeName: Invalid value: "Bad_N": ${RFC1123_SUBDOMAIN}`,
          'subsets[1].addresses[1].ip: Invalid value: "0.0.0.0": may not be unspecified (0.0.0.0)',
          'subsets[1].notReadyAddresses[0].ip: Invalid value: "169.254.1.1": may not be in the link-local range (169.254.0.0/16, fe80::/10)',
          'subsets[1].notReadyAddresses[1].ip: Invalid value: "224.0.0.1": may not be in the link-local multicast range (224.0.0.0/24, ff02::/10)',
        ].join(', ') +
        ']',
    );
    expect(message(req(k, endpoints, { verb: 'create', body: { apiVersion: 'v1', kind: 'Endpoints', metadata: { name: 'misc-ep' }, subsets: [{ addresses: [{ ip: 'x' }] }] } }))).toBe(
      'Endpoints "misc-ep" is invalid: [subsets[0].addresses[0].ip: Invalid value: "x": must be a valid IP address, (e.g. 10.9.8.7 or 2001:db8::ffff), subsets[0].addresses[0].ip: Invalid value: "x": must be a valid IP address]',
    );
  });

  test('warnings and create on update', () => {
    const k = boot();
    const r = req(k, endpoints, { verb: 'update', name: 'm', body: { apiVersion: 'v1', kind: 'Endpoints', metadata: { name: 'm' }, subsets: [{ addresses: [{ ip: '2001:db8:0::1' }] }] } });
    expect(r.code).toBe(201);
    expect(r.warnings).toEqual(['v1 Endpoints is deprecated in v1.33+; use discovery.k8s.io/v1 EndpointSlice', 'subsets[0].addresses[0].ip: IPv6 address "2001:db8:0::1" should be in RFC 5952 canonical format ("2001:db8::1")']);
  });
});

// Node defaulting, pod CIDR conversion and validation. Messages checked against the v1.37.2
// oracle unless noted.

import { describe, expect, test } from 'vitest';
import { aggregate, type FieldError } from '../../../apimachinery/field.ts';
import type { JsonObject } from '../../../apimachinery/json.ts';
import { convertNodeSpecPodCIDRs, setObjectDefaultsNode } from '../v1/defaults/node.ts';
import { validateNode, validateNodeUpdate } from './node.ts';

const all = (errs: FieldError[]): string => (errs.length === 0 ? '' : aggregate(errs));
const node = (spec: JsonObject, status: JsonObject = {}): JsonObject => ({ metadata: { name: 'n1', resourceVersion: '1' }, spec, status });
const gaps: string[] = [];
const notPorted = (w: string): void => {
  gaps.push(w);
};

describe('defaults and conversion', () => {
  test('allocatable defaults to capacity; quantities round up to milli', () => {
    const n = node({}, { capacity: { cpu: '1500u', pods: '10' } });
    setObjectDefaultsNode(n);
    expect(n.status).toEqual({ capacity: { cpu: '2m', pods: '10' }, allocatable: { cpu: '2m', pods: '10' } });
  });

  test('podCIDR fills podCIDRs, wins when they disagree, and is podCIDRs[0] on the way out', () => {
    const a = node({ podCIDR: '10.244.9.0/24' });
    convertNodeSpecPodCIDRs(a);
    expect(a.spec).toEqual({ podCIDR: '10.244.9.0/24', podCIDRs: ['10.244.9.0/24'] });
    const b = node({ podCIDR: '10.2.0.0/24', podCIDRs: ['10.1.0.0/24', 'fd00::/64'] });
    convertNodeSpecPodCIDRs(b);
    expect(b.spec).toEqual({ podCIDR: '10.2.0.0/24', podCIDRs: ['10.2.0.0/24'] });
    const c = node({ podCIDRs: ['10.1.0.0/24', 'fd00::/64'] });
    convertNodeSpecPodCIDRs(c);
    expect(c.spec).toEqual({ podCIDR: '10.1.0.0/24', podCIDRs: ['10.1.0.0/24', 'fd00::/64'] });
  });
});

describe('validateNode', () => {
  test('taints (reported under metadata.taints) and pod CIDRs', () => {
    const n = node({
      podCIDRs: ['10.1.0.0/24', '10.2.0.0/24', 'x'],
      taints: [
        { key: 'a', effect: 'NoSchedule' },
        { key: 'a', effect: 'NoSchedule', value: 'v' },
        { key: 'b/c/d', effect: 'Bad' },
        { key: 'k', value: '-bad-', effect: '' },
      ],
    });
    expect(all(validateNode(n, notPorted))).toBe(
      '[metadata.taints[1]: Duplicate value: {"Key":"a","Value":"v","Effect":"NoSchedule","TimeAdded":null}: taints must be unique by key and effect pair, ' +
        "metadata.taints[2].key: Invalid value: \"b/c/d\": a valid label key must consist of alphanumeric characters, '-', '_' or '.', and must start and end with an alphanumeric character (e.g. 'MyName',  or 'my.name',  or '123-abc', regex used for validation is '([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9]') with an optional DNS subdomain prefix and '/' (e.g. 'example.com/MyName'), " +
        'metadata.taints[2].effect: Unsupported value: "Bad": supported values: "NoSchedule", "PreferNoSchedule", "NoExecute", ' +
        "metadata.taints[3].value: Invalid value: \"-bad-\": a valid label must be an empty string or consist of alphanumeric characters, '-', '_' or '.', and must start and end with an alphanumeric character (e.g. 'MyValue',  or 'my_value',  or '12345', regex used for validation is '(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?'), " +
        'metadata.taints[3].effect: Required value, ' +
        'spec.podCIDRs[2]: Invalid value: "x": must be a valid CIDR value, (e.g. 10.9.8.0/24 or 2001:db8::/64), ' +
        'spec.podCIDRs: Internal error: invalid PodCIDRs. failed to check with dual stack with error:invalid CIDR[2]: <nil> (invalid CIDR address: x), ' +
        'spec.podCIDRs: Invalid value: ["10.1.0.0/24","10.2.0.0/24","x"]: may specify no more than one CIDR for each IP family]',
    );
  });

  test('strict CIDR rules', () => {
    const one = (c: string): string => all(validateNode(node({ podCIDRs: [c] }), notPorted));
    expect(one('10.244.9.1/24')).toBe('spec.podCIDRs[0]: Invalid value: "10.244.9.1/24": must not have bits set beyond the prefix length');
    expect(one('010.1.0.0/24')).toBe('spec.podCIDRs[0]: Invalid value: "010.1.0.0/24": must not have leading 0s in IP or prefix length');
    expect(one('10.1.0.0/024')).toBe('spec.podCIDRs[0]: Invalid value: "10.1.0.0/024": must not have leading 0s in IP or prefix length');
    expect(one('::ffff:10.0.0.0/120')).toBe('spec.podCIDRs[0]: Invalid value: "::ffff:10.0.0.0/120": must not have an IPv4-mapped IPv6 address');
    expect(one('fd00:0::/64')).toBe('');
    expect(all(validateNode(node({ podCIDRs: ['10.1.0.0/24', 'fd00::/64'] }), notPorted))).toBe('');
  });

  test('capacity, swap and declared features', () => {
    const n = node({}, { capacity: { cpu: '-1', pods: '1500m', 'example.com/gpu': '500m' }, nodeInfo: { swap: { capacity: 0 } }, declaredFeatures: ['b', 'A', 'A'] });
    expect(all(validateNode(n, notPorted))).toBe(
      '[status.capacity.cpu: Invalid value: "-1": must be greater than or equal to 0, ' +
        'status.capacity.example.com/gpu: Invalid value: "500m": must be an integer, ' +
        'status.capacity.pods: Invalid value: "1500m": must be an integer, ' +
        'metadata.nodeSwapStatus.capacity: Invalid value: 0: must be greater than zero, ' +
        'status.declaredFeatures[0]: Invalid value: "b": invalid feature name "b": must start with an UpperCamelCase segment, with subsequent segments separated by \'/\' (e.g., MyFeature or MyFeature/mySubFeature), and contain only alphanumeric characters and slashes, ' +
        'status.declaredFeatures[1]: Invalid value: "A": list must be sorted alphabetically, ' +
        'status.declaredFeatures[2]: Duplicate value: "A"]',
    );
  });
});

describe('validateNodeUpdate', () => {
  test('podCIDRs, providerID and externalID may not change once set', () => {
    const old = node({ podCIDR: '10.1.0.0/24', podCIDRs: ['10.1.0.0/24'], providerID: 'p' });
    const next = node({ podCIDR: '10.9.0.0/24', podCIDRs: ['10.9.0.0/24'], providerID: 'q', externalID: 'x' });
    expect(all(validateNodeUpdate(next, old, notPorted))).toBe(
      '[spec.podCIDRs: Forbidden: node updates may not change podCIDR except from "" to valid, spec.providerID: Invalid value: null: field cannot be modified once set, spec.externalID: Forbidden: may not be updated]',
    );
    expect(all(validateNodeUpdate(node({ podCIDRs: ['10.1.0.0/24'] }), node({}), notPorted))).toBe('');
    expect(all(validateNodeUpdate(node({}), node({ providerID: 'p' }), notPorted))).toBe('spec.providerID: Invalid value: null: field cannot be cleared once set');
  });

  test('duplicate addresses', () => {
    const a = { type: 'InternalIP', address: '1.2.3.4' };
    expect(all(validateNodeUpdate(node({}, { addresses: [a, a] }), node({}), notPorted))).toBe('status.addresses[1]: Duplicate value: {"Type":"InternalIP","Address":"1.2.3.4"}');
  });
});

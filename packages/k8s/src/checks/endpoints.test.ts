// k8s.endpoints in virtual time: the EndpointSlice controller publishes the ready Pods of a
// Service; a selector that matches no Pod, a Service without a selector, a missing Service.

import { describe, expect, test } from 'vitest';
import { api, cluster, deployment, runCheck, service } from './testenv.ts';

describe('k8s.endpoints', () => {
  test('the ready Pods of a Deployment behind a Service', () => {
    const k = cluster();
    api(k, (c) => c.resource('apps/v1/deployments').create('default', deployment('web', 'nginx:1.27', 2)));
    api(k, (c) => c.resource('v1/services').create('default', service('web', { app: 'web' })));
    k.advance(60_000);
    const r = runCheck('k8s.endpoints', k, { namespace: 'default', service: 'web', count: 2 });
    expect(r.pass).toBe(true);
    expect(r.expected).toBe('Service web in namespace default has 2 ready endpoints');
    expect(r.observed).toMatch(/^2 ready endpoints: 10\.244\.\d+\.\d+, 10\.244\.\d+\.\d+$/);
    expect(runCheck('k8s.endpoints', k, { namespace: 'default', service: 'web', min: 3 }).pass).toBe(false);
  });

  test("a selector that matches no Pod; no selector; a missing Service", () => {
    const k = cluster();
    api(k, (c) => c.resource('v1/services').create('default', service('typo', { app: 'wbe' })));
    api(k, (c) => c.resource('v1/services').create('default', service('manual', undefined)));
    k.advance(5_000);
    expect(runCheck('k8s.endpoints', k, { namespace: 'default', service: 'typo' })).toEqual({
      pass: false,
      expected: 'Service typo in namespace default has at least 1 ready endpoint',
      observed: "no ready endpoint; the Service's selector app=wbe matches no Pod in namespace default",
    });
    expect(runCheck('k8s.endpoints', k, { namespace: 'default', service: 'manual' }).observed).toBe('no ready endpoint; the Service has no selector');
    expect(runCheck('k8s.endpoints', k, { namespace: 'default', service: 'typo', count: 0 }).pass).toBe(true);
    expect(runCheck('k8s.endpoints', k, { namespace: 'default', service: 'nope' })).toEqual({
      pass: false,
      expected: 'Service nope in namespace default has at least 1 ready endpoint',
      observed: 'services "nope" not found',
    });
  });
});

// k8s.podsReady in virtual time: Pods of a Deployment become ready; an unschedulable Pod and one
// whose image cannot be pulled are named with the status fields that explain them.

import { describe, expect, test } from 'vitest';
import type { JsonObject } from '../apimachinery/json.ts';
import { api, cluster, deployment, runCheck } from './testenv.ts';

const pod = (name: string, image: string, extra: JsonObject = {}): JsonObject => ({
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name, labels: { app: 'web' } },
  spec: { containers: [{ name: 'nginx', image }], ...extra },
});

describe('k8s.podsReady', () => {
  test('the Pods of a Deployment: not ready at first, ready after the rollout', () => {
    const k = cluster();
    api(k, (c) => c.resource('apps/v1/deployments').create('default', deployment('web', 'nginx:1.27', 3)));
    const early = runCheck('k8s.podsReady', k, { namespace: 'default', selector: 'app=web', count: 3 });
    expect(early).toEqual({ pass: false, expected: '3 ready Pods matching app=web in namespace default', observed: 'no Pod matches app=web in namespace default' });
    k.advance(60_000);
    expect(runCheck('k8s.podsReady', k, { namespace: 'default', selector: 'app=web', count: 3 })).toEqual({ pass: true, expected: '3 ready Pods matching app=web in namespace default', observed: '3 of 3 Pods ready' });
    expect(runCheck('k8s.podsReady', k, { namespace: 'default', selector: 'app=web', min: 4 }).pass).toBe(false);
    expect(runCheck('k8s.podsReady', k, { namespace: 'default', selector: 'app=web' }).expected).toBe('at least 1 ready Pod matching app=web in namespace default');
  });

  test('not ready: unschedulable, image pull back-off, terminating', () => {
    const k = cluster();
    api(k, (c) => c.resource('v1/pods').create('default', pod('ok', 'nginx:1.27')));
    api(k, (c) => c.resource('v1/pods').create('default', pod('pinned', 'nginx:1.27', { nodeSelector: { disk: 'ssd' } })));
    api(k, (c) => c.resource('v1/pods').create('default', pod('typo', 'nginx:1.99')));
    k.advance(60_000);
    const r = runCheck('k8s.podsReady', k, { namespace: 'default', selector: 'app=web', count: 3 });
    expect(r.pass).toBe(false);
    // The kubelet alternates ErrImagePull and ImagePullBackOff while it backs off.
    expect(r.observed).toMatch(/^1 of 3 Pods ready; pinned is Pending \(PodScheduled False: Unschedulable\); typo is Pending \(container nginx: (ErrImagePull|ImagePullBackOff)\)$/);
    expect(runCheck('k8s.podsReady', k, { namespace: 'default', selector: 'app=web', count: 1 }).pass).toBe(true);
    // A terminating Pod is not ready, whatever its condition says.
    api(k, (c) => c.resource('v1/pods').delete('default', 'ok'));
    const t = runCheck('k8s.podsReady', k, { namespace: 'default', selector: 'app=web', count: 1 });
    expect(t.pass).toBe(false);
    expect(t.observed).toMatch(/^0 of 3 Pods ready; ok is terminating; pinned is Pending/);
  });

  test('an invalid selector is an error', () => {
    const r = runCheck('k8s.podsReady', cluster(), { namespace: 'default', selector: 'a b' });
    expect(r.pass).toBe(false);
    expect(r.error).toBeDefined();
  });
});

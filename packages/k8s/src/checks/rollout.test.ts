// k8s.rollout in virtual time: the status viewer's lines while a Deployment rolls out, success,
// the progress-deadline failure, a missing Deployment, and the kinds that arrive later.

import { describe, expect, test } from 'vitest';
import { api, cluster, deployment, runCheck } from './testenv.ts';

const args = { namespace: 'default', name: 'web' };
const expected = 'the rollout of Deployment web in namespace default is complete';

describe('k8s.rollout', () => {
  test('waiting, then rolled out', () => {
    const k = cluster();
    api(k, (c) => c.resource('apps/v1/deployments').create('default', deployment('web', 'nginx:1.27', 2)));
    expect(runCheck('k8s.rollout', k, args)).toEqual({ pass: false, expected, observed: 'Waiting for deployment spec update to be observed...' });
    k.advance(1_000);
    expect(runCheck('k8s.rollout', k, args).observed).toMatch(/^Waiting for deployment "web" rollout to finish: /);
    k.advance(60_000);
    expect(runCheck('k8s.rollout', k, args)).toEqual({ pass: true, expected, observed: 'deployment "web" successfully rolled out' });
  });

  test('a rollout past its progress deadline fails with kubectl\'s error', () => {
    const k = cluster();
    api(k, (c) => c.resource('apps/v1/deployments').create('default', deployment('web', 'nginx:1.99', 2, { progressDeadlineSeconds: 10 })));
    k.advance(60_000);
    expect(runCheck('k8s.rollout', k, args)).toEqual({ pass: false, expected, observed: 'deployment "web" exceeded its progress deadline' });
  });

  test('a missing Deployment fails; StatefulSet is not evaluated yet', () => {
    const k = cluster();
    expect(runCheck('k8s.rollout', k, args)).toEqual({ pass: false, expected, observed: 'deployments.apps "web" not found' });
    const r = runCheck('k8s.rollout', k, { ...args, kind: 'StatefulSet' });
    expect(r.pass).toBe(false);
    expect(r.error).toBe('[sim] k8s.rollout supports Deployment only; StatefulSet arrives with phase 18a');
  });
});

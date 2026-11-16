// k8s.nodeHasTaint on the kubeadm-1cp-2w cluster: the control plane's kubeadm taint, a taint a
// learner adds, a wrong value or effect, a missing Node.

import { describe, expect, test } from 'vitest';
import { api, cluster, runCheck } from './testenv.ts';
import { taintString } from './nodetaint.ts';

const CP_TAINT = 'node-role.kubernetes.io/control-plane';

describe('k8s.nodeHasTaint', () => {
  test('the control plane carries the kubeadm taint; the workers do not', () => {
    const k = cluster();
    expect(runCheck('k8s.nodeHasTaint', k, { nodes: ['controlplane'], key: CP_TAINT, effect: 'NoSchedule' })).toEqual({
      pass: true,
      expected: `Node controlplane carries a taint ${CP_TAINT}:NoSchedule (any value)`,
      observed: 'controlplane carries it',
    });
    expect(runCheck('k8s.nodeHasTaint', k, { nodes: ['controlplane', 'node01'], key: CP_TAINT })).toEqual({
      pass: false,
      expected: `Nodes controlplane, node01 each carry a taint ${CP_TAINT} (any value) (any effect)`,
      observed: 'node01 has no taints',
    });
  });

  test('a taint added to a worker; wrong value and effect; a missing Node', () => {
    const k = cluster();
    api(k, (c) => c.resource('v1/nodes').patch(undefined, 'node01', { spec: { taints: [{ key: 'gpu', value: 'true', effect: 'NoSchedule' }] } }));
    expect(runCheck('k8s.nodeHasTaint', k, { nodes: ['node01'], key: 'gpu', value: 'true', effect: 'NoSchedule' }).pass).toBe(true);
    expect(runCheck('k8s.nodeHasTaint', k, { nodes: ['node01'], key: 'gpu', value: 'false' }).observed).toBe('node01 has no taint gpu=false; its taints: gpu=true:NoSchedule');
    expect(runCheck('k8s.nodeHasTaint', k, { nodes: ['node01'], key: 'gpu', effect: 'NoExecute' }).pass).toBe(false);
    expect(runCheck('k8s.nodeHasTaint', k, { nodes: ['node01', 'node09'], key: 'gpu' })).toEqual({
      pass: false,
      expected: 'Nodes node01, node09 each carry a taint gpu (any value) (any effect)',
      observed: 'nodes "node09" not found',
    });
  });

  test('taintString follows Taint.ToString', () => {
    expect(taintString({ key: 'a', value: 'b', effect: 'NoSchedule' })).toBe('a=b:NoSchedule');
    expect(taintString({ key: 'a', effect: 'NoSchedule' })).toBe('a:NoSchedule');
    expect(taintString({ key: 'a', value: 'b' })).toBe('a=b:');
    expect(taintString({ key: 'a' })).toBe('a');
  });
});

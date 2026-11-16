// k8s.unchanged and k8s.notRecreated against a baseline forked "after setup": changes in place,
// deletion, deletion and creation again, objects added, and the item bugs that make them errors.

import { describe, expect, test } from 'vitest';
import { forkWorld } from '@simlab/kernel';
import type { JsonObject } from '../apimachinery/json.ts';
import { api, cluster, runCheck } from './testenv.ts';

const configMap = (name: string, data: JsonObject): JsonObject => ({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name, labels: { app: 'shop' } }, data });

/** Setup: two ConfigMaps and a taint on node01; the baseline is the world then. */
function setup() {
  const k = cluster();
  api(k, (c) => c.resource('v1/configmaps').create('default', configMap('a', { mode: 'fast' })));
  api(k, (c) => c.resource('v1/configmaps').create('default', configMap('b', { mode: 'slow' })));
  api(k, (c) => c.resource('v1/nodes').patch(undefined, 'node01', { spec: { taints: [{ key: 'gpu', value: 'true', effect: 'NoSchedule' }] } }));
  return { k, baseline: forkWorld(k.world) };
}

describe('k8s.unchanged', () => {
  test('untouched passes; a change in place names the path, old and new value', () => {
    const { k, baseline } = setup();
    const args = { kind: 'Node', name: 'node01', paths: ['{.spec.taints}'] };
    expect(runCheck('k8s.unchanged', k, args, baseline)).toEqual({
      pass: true,
      expected: 'Node node01 cluster-wide is the object setup left, with {.spec.taints} unchanged',
      observed: 'node01 unchanged',
    });
    api(k, (c) => c.resource('v1/nodes').patch(undefined, 'node01', { spec: { taints: null } }));
    expect(runCheck('k8s.unchanged', k, args, baseline)).toEqual({
      pass: false,
      expected: 'Node node01 cluster-wide is the object setup left, with {.spec.taints} unchanged',
      observed: '{.spec.taints} of node01 was [{"effect":"NoSchedule","key":"gpu","value":"true"}], is now unset',
    });
  });

  test('by selector: deleted, recreated, added', () => {
    const { k, baseline } = setup();
    const args = { kind: 'ConfigMap', selector: 'app=shop', paths: ['{.data}'] };
    expect(runCheck('k8s.unchanged', k, args, baseline)).toMatchObject({ pass: true, expected: 'every ConfigMap matching app=shop in namespace default is the object setup left, with {.data} unchanged', observed: 'all 2 objects unchanged' });
    api(k, (c) => c.resource('v1/configmaps').delete('default', 'a'));
    api(k, (c) => c.resource('v1/configmaps').create('default', configMap('a', { mode: 'fast' })));
    api(k, (c) => c.resource('v1/configmaps').delete('default', 'b'));
    api(k, (c) => c.resource('v1/configmaps').create('default', configMap('c', {})));
    expect(runCheck('k8s.unchanged', k, args, baseline)).toMatchObject({ pass: false, observed: 'a was deleted and created again; b was deleted; c was added' });
  });

  test('nothing selected after setup, or an unsupported path, is an error', () => {
    const { k, baseline } = setup();
    expect(runCheck('k8s.unchanged', k, { kind: 'ConfigMap', name: 'zzz', paths: ['{.data}'] }, baseline).error).toBe('no ConfigMap named zzz in namespace default existed after setup');
    expect(runCheck('k8s.unchanged', k, { kind: 'ConfigMap', name: 'a', paths: ['{.items[?(@.x)]}'] }, baseline).error).toMatch(/^unsupported JSONPath syntax/);
  });
});

describe('k8s.notRecreated', () => {
  test('same uid passes; changes in place are fine; deleted; deleted and created again', () => {
    const { k, baseline } = setup();
    const args = { kind: 'ConfigMap', name: 'a' };
    const uid = ((api(k, (c) => c.resource('v1/configmaps').get('default', 'a')).metadata as JsonObject).uid) as string;
    api(k, (c) => c.resource('v1/configmaps').patch('default', 'a', { data: { mode: 'slow' } }));
    expect(runCheck('k8s.notRecreated', k, args, baseline)).toEqual({ pass: true, expected: 'ConfigMap a in namespace default is the object setup left (same uid)', observed: `a still has uid ${uid}` });
    api(k, (c) => c.resource('v1/configmaps').delete('default', 'a'));
    expect(runCheck('k8s.notRecreated', k, args, baseline)).toMatchObject({ pass: false, observed: 'a was deleted' });
    api(k, (c) => c.resource('v1/configmaps').create('default', configMap('a', {})));
    const r = runCheck('k8s.notRecreated', k, args, baseline);
    expect(r.pass).toBe(false);
    expect(r.observed).toMatch(new RegExp(`^a was deleted and created again \\(uid ${uid}, now [0-9a-f-]{36}\\)$`));
    expect(r.error).toBeUndefined();
  });

  test('absent from the baseline is an error', () => {
    const { k, baseline } = setup();
    expect(runCheck('k8s.notRecreated', k, { kind: 'ConfigMap', name: 'later' }, baseline).error).toBe('ConfigMap later in namespace default did not exist after setup');
  });
});

// Strategic merge patch over the vendored API types: the patch meta the server and kubectl apply
// read (merge keys of containers, env, ports, volumes; retainKeys of the Deployment strategy and
// of volumes), and the three-way patches kubectl apply sends. Expected patches are what the
// algorithm of upstream's patch.go yields for these types (its own tables are in
// patch.upstream.test.ts); the server-side application of such patches is compared with the real
// API server in fixtures/golden/v1.37.2/api/strategic-patch.yaml.

import { describe, expect, test } from 'vitest';
import type { JsonObject } from '../json.ts';
import { schema } from '../../openapi/schema.ts';
import { createThreeWayMergePatch, createTwoWayMergePatch, patchMetaFor, strategicMergePatch } from './index.ts';

const DEPLOYMENT = (schema().kind('apps/v1', 'Deployment') as { id: string }).id;
const POD = (schema().kind('v1', 'Pod') as { id: string }).id;

const deployment = (containers: JsonObject[], extra: JsonObject = {}): JsonObject => ({
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: { name: 'web' },
  spec: { replicas: 2, selector: { matchLabels: { app: 'web' } }, template: { metadata: { labels: { app: 'web' } }, spec: { containers } }, ...extra },
});

describe('patch meta from the Go types', () => {
  test('containers merge by name, env by name, ports by containerPort', () => {
    const podSpec = patchMetaFor(POD).lookupPatchMetadataForStruct('spec')[0];
    const [container, containers] = podSpec.lookupPatchMetadataForSlice('containers');
    expect(containers).toEqual({ patchStrategies: ['merge'], patchMergeKey: 'name' });
    expect(container.lookupPatchMetadataForSlice('env')[1]).toEqual({ patchStrategies: ['merge'], patchMergeKey: 'name' });
    expect(container.lookupPatchMetadataForSlice('ports')[1]).toEqual({ patchStrategies: ['merge'], patchMergeKey: 'containerPort' });
    expect(podSpec.lookupPatchMetadataForSlice('volumes')[1]).toEqual({ patchStrategies: ['merge', 'retainKeys'], patchMergeKey: 'name' });
    // No tag: [""], as strings.Split("", ",") gives.
    expect(podSpec.lookupPatchMetadataForSlice('tolerations')[1]).toEqual({ patchStrategies: [''], patchMergeKey: '' });
  });

  test('lookup errors name the struct and the kind, as forkedjson and meta.go print them', () => {
    const spec = patchMetaFor(POD).lookupPatchMetadataForStruct('spec')[0];
    expect(() => spec.lookupPatchMetadataForStruct('containerz')).toThrow('unable to find api field in struct PodSpec for the json field "containerz"');
    const labels = patchMetaFor(POD).lookupPatchMetadataForStruct('metadata')[0].lookupPatchMetadataForStruct('labels')[0];
    expect(() => labels.lookupPatchMetadataForStruct('x')).toThrow('merging an object in json but data type is not struct, instead is: map');
    expect(() => spec.lookupPatchMetadataForSlice('nodeName')).toThrow('expected slice or array type, but got: struct');
    // Case-insensitive match when no exact one (encoding/json's field matching).
    expect(spec.lookupPatchMetadataForSlice('Containers')[1].patchMergeKey).toBe('name');
  });
});

describe('three-way patches (kubectl apply)', () => {
  const app = { name: 'app', image: 'nginx:1.27', env: [{ name: 'A', value: '1' }, { name: 'B', value: '2' }] };
  const sidecar = { name: 'sidecar', image: 'busybox:1.36' };

  test('removing a container: $setElementOrder and a $patch delete item', () => {
    const original = deployment([app, sidecar]);
    const current = deployment([{ ...app, imagePullPolicy: 'IfNotPresent' }, { ...sidecar, imagePullPolicy: 'IfNotPresent' }]);
    const modified = deployment([app]);
    expect(createThreeWayMergePatch(original, modified, current, DEPLOYMENT, true)).toEqual({
      ok: { spec: { template: { spec: { '$setElementOrder/containers': [{ name: 'app' }], containers: [{ $patch: 'delete', name: 'sidecar' }] } } } },
    });
  });

  test('a changed env item and a field removed from the configuration', () => {
    const original = deployment([app], { minReadySeconds: 5 });
    const current = deployment([app], { minReadySeconds: 5, progressDeadlineSeconds: 600 });
    const modified = deployment([{ ...app, env: [{ name: 'A', value: '1' }, { name: 'B', value: '20' }] }]);
    expect(createThreeWayMergePatch(original, modified, current, DEPLOYMENT, true)).toEqual({
      ok: {
        spec: {
          minReadySeconds: null,
          template: { spec: { '$setElementOrder/containers': [{ name: 'app' }], containers: [{ '$setElementOrder/env': [{ name: 'A' }, { name: 'B' }], env: [{ name: 'B', value: '20' }], name: 'app' }] } },
        },
      },
    });
  });

  test('no change: an empty patch, whatever the server added', () => {
    const original = deployment([app]);
    const current = deployment([{ ...app, terminationMessagePath: '/dev/termination-log' }], { revisionHistoryLimit: 10 });
    expect(createThreeWayMergePatch(original, original, current, DEPLOYMENT, true)).toEqual({ ok: {} });
  });

  test('the strategy has retainKeys: switching to Recreate sends $retainKeys', () => {
    const original = deployment([app], { strategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: 1 } } });
    const modified = deployment([app], { strategy: { type: 'Recreate' } });
    expect(createThreeWayMergePatch(original, modified, original, DEPLOYMENT, true)).toEqual({
      ok: { spec: { strategy: { $retainKeys: ['type'], rollingUpdate: null, type: 'Recreate' } } },
    });
  });

  test('without --overwrite, a change made since the last apply conflicts (mergepatch.ErrConflict, YAML documents)', () => {
    const original = deployment([app]);
    const current = { ...deployment([app]), spec: { ...(deployment([app]).spec as JsonObject), replicas: 5 } };
    const modified = { ...deployment([app]), spec: { ...(deployment([app]).spec as JsonObject), replicas: 3 } };
    expect(createThreeWayMergePatch(original, modified, current, DEPLOYMENT, false)).toEqual({
      error: 'patch:\nspec:\n  replicas: 3\n\nconflicts with changes made from original to current:\nspec:\n  replicas: 5\n\n',
      sentinel: 'ErrConflict',
    });
    expect(createThreeWayMergePatch(original, modified, current, DEPLOYMENT, true)).toEqual({ ok: { spec: { replicas: 3 } } });
  });

  test('no last-applied configuration: nothing is deleted', () => {
    const current = deployment([app, sidecar]);
    expect(createThreeWayMergePatch(undefined, deployment([app]), current, DEPLOYMENT, true)).toEqual({
      ok: { spec: { template: { spec: { '$setElementOrder/containers': [{ name: 'app' }] } } } },
    });
  });

  test('two-way patch of a Node taint list: no patch strategy, the whole list', () => {
    const node = (taints?: JsonObject[]): JsonObject => ({ apiVersion: 'v1', kind: 'Node', metadata: { name: 'n' }, spec: taints ? { taints } : {} });
    const nodeType = (schema().kind('v1', 'Node') as { id: string }).id;
    expect(createTwoWayMergePatch(node([{ key: 'a', effect: 'NoSchedule' }]), node([{ key: 'a', effect: 'NoSchedule' }, { key: 'b', effect: 'NoSchedule' }]), nodeType)).toEqual({
      ok: { spec: { taints: [{ effect: 'NoSchedule', key: 'a' }, { effect: 'NoSchedule', key: 'b' }] } },
    });
    expect(createTwoWayMergePatch(node([{ key: 'a', effect: 'NoSchedule' }]), node(), nodeType)).toEqual({ ok: { spec: { taints: null } } });
  });
});

describe('applying patches', () => {
  test('an apply patch merged into the live object keeps server-side items in place', () => {
    const live = deployment([
      { name: 'app', image: 'nginx:1.27' },
      { name: 'injected', image: 'proxy:1' },
      { name: 'sidecar', image: 'busybox:1.36' },
    ]);
    const patch = { spec: { template: { spec: { '$setElementOrder/containers': [{ name: 'app' }, { name: 'log' }], containers: [{ name: 'log', image: 'busybox:1.37' }, { $patch: 'delete', name: 'sidecar' }] } } } };
    const r = strategicMergePatch(live, patch, DEPLOYMENT);
    const names = 'ok' in r ? ((r.ok.spec as JsonObject).template as { spec: { containers: { name: string }[] } }).spec.containers.map((c) => c.name) : r.error;
    expect(names).toEqual(['app', 'injected', 'log']);
  });

  test('error texts print values as Go does', () => {
    const live = deployment([{ name: 'app', image: 'nginx:1.27' }]);
    const bad = (containers: unknown[]) => strategicMergePatch(live, { spec: { template: { spec: { containers } } } } as JsonObject, DEPLOYMENT);
    expect(bad([{ name: 'app', $patch: 7 }])).toEqual({ error: 'unknown patch type: %!s(int64=7) in map: map[$patch:7 name:app]' });
    expect(bad([{ image: 'x', ports: [{ containerPort: 80 }] }])).toEqual({ error: 'map: map[image:x ports:[map[containerPort:80]]] does not contain declared merge key: name' });
    expect(bad(['app'])).toEqual({ error: 'list element types are not identical: [[map[image:nginx:1.27 name:app]] [app]]' });
    expect(bad([{ name: 'app', $patch: 'merge' }])).toEqual({ error: 'merging lists cannot yet be specified in the patch' });
    expect(strategicMergePatch(live, { metadata: { '$setElementOrder/finalizers': 'x' } }, DEPLOYMENT)).toEqual({ error: 'expected a []interface {}, but received a string' });
  });

  test('a patch with $patch: replace on a map replaces it; $patch: delete empties it', () => {
    const live = deployment([{ name: 'app', image: 'nginx:1.27' }], { strategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: 1 } } });
    const r1 = strategicMergePatch(live, { spec: { strategy: { $patch: 'replace', type: 'Recreate' } } }, DEPLOYMENT);
    expect('ok' in r1 && (r1.ok.spec as JsonObject).strategy).toEqual({ type: 'Recreate' });
    const r2 = strategicMergePatch(live, { spec: { strategy: { $patch: 'delete' } } }, DEPLOYMENT);
    expect('ok' in r2 && (r2.ok.spec as JsonObject).strategy).toEqual({});
  });

  test('inputs are not modified', () => {
    const live = deployment([{ name: 'app', image: 'nginx:1.27' }]);
    const patch = { spec: { template: { spec: { containers: [{ name: 'app', image: 'nginx:1.28' }] } } } };
    const before = JSON.stringify([live, patch]);
    strategicMergePatch(live, patch, DEPLOYMENT);
    createThreeWayMergePatch(live, live, live, DEPLOYMENT, true);
    expect(JSON.stringify([live, patch])).toBe(before);
  });
});

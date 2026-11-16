// Resource arguments and their errors. Expected texts: the real kubectl v1.37.2 on this workstation
// (2026-11-16) and fixtures/golden/v1.37.2/errors/not-found.yaml.

import { describe, expect, test } from 'vitest';
import { errorMessage } from '../cli/errors.ts';
import { expandCategory, mappingFor } from '../client/restmapper.ts';
import { buildPlan, type Plan } from './builder.ts';

const resolved = (arg: string) => {
  const m = mappingFor(arg);
  return 'type' in m ? errorMessage(m).text : `${m.group}/${m.version}/${m.resource}`;
};

describe('RESTMapper', () => {
  test.each([
    ['pods', '/v1/pods'],
    ['pod', '/v1/pods'],
    ['po', '/v1/pods'],
    ['PODS', '/v1/pods'],
    ['deploy', 'apps/v1/deployments'],
    ['deployment.apps', 'apps/v1/deployments'],
    ['deployments.v1.apps', 'apps/v1/deployments'],
    ['deploy.apps', 'apps/v1/deployments'],
    ['svc', '/v1/services'],
    ['ns', '/v1/namespaces'],
    ['no', '/v1/nodes'],
    ['cm', '/v1/configmaps'],
    ['sa', '/v1/serviceaccounts'],
    ['ep', '/v1/endpoints'],
    ['rs', 'apps/v1/replicasets'],
    // core/v1 Events come first: the core group has the highest priority.
    ['events', '/v1/events'],
    ['ev', '/v1/events'],
    ['events.events.k8s.io', 'events.k8s.io/v1/events'],
    ['endpointslices', 'discovery.k8s.io/v1/endpointslices'],
    ['storageclass.storage', 'storage.k8s.io/v1/storageclasses'],
  ])('%s', (arg, want) => {
    expect(resolved(arg)).toBe(want);
  });
  test('unknown types', () => {
    expect(resolved('pdos')).toBe('error: the server doesn\'t have a resource type "pdos"\n');
    expect(resolved('pods.v2')).toBe('error: the server doesn\'t have a resource type "pods" in group "v2"\n');
  });
  test('the all category in discovery order', () => {
    expect(expandCategory('all')).toEqual([
      'pods',
      'replicationcontrollers',
      'services',
      'daemonsets.apps',
      'deployments.apps',
      'replicasets.apps',
      'statefulsets.apps',
      'horizontalpodautoscalers.autoscaling',
      'cronjobs.batch',
      'jobs.batch',
    ]);
  });
});

const plan = (args: string[], extra: Partial<Parameters<typeof buildPlan>[0]> = {}): Plan | string => {
  const r = buildPlan({ args, namespace: 'default', allNamespaces: false, ...extra });
  return 'type' in r ? errorMessage(r).text : r;
};

const describePlan = (p: Plan | string) =>
  typeof p === 'string' ? p : p.visits.map((v) => `${v.kind} ${v.mapping.resource}${v.kind === 'get' ? `/${v.name}` : ''} ns=${v.namespace}`);

describe('resource.Builder', () => {
  test('one type lists, names get, type/name pairs, comma types with names', () => {
    expect(describePlan(plan(['pods']))).toEqual(['list pods ns=default']);
    expect(describePlan(plan(['pods', 'a', 'b']))).toEqual(['get pods/a ns=default', 'get pods/b ns=default']);
    expect(describePlan(plan(['pod/a', 'svc/b']))).toEqual(['get pods/a ns=default', 'get services/b ns=default']);
    expect(describePlan(plan(['pods,svc', 'x']))).toEqual(['get pods/x ns=default', 'get services/x ns=default']);
    expect(describePlan(plan(['rs,pods'], { labelSelector: 'app=web' }))).toEqual(['list replicasets ns=default', 'list pods ns=default']);
    expect(describePlan(plan(['nodes']))).toEqual(['list nodes ns=']);
    expect(describePlan(plan(['pods'], { allNamespaces: true }))).toEqual(['list pods ns=']);
  });
  test('single item implied', () => {
    expect((plan(['pod', 'a']) as Plan).singleItemImplied).toBe(true);
    expect((plan(['pod/a']) as Plan).singleItemImplied).toBe(true);
    expect((plan(['pod', 'a', 'b']) as Plan).singleItemImplied).toBe(false);
    expect((plan(['pods']) as Plan).singleItemImplied).toBe(false);
  });
  test('all expands to its members, marked as coming from the category', () => {
    const p = plan(['all']) as Plan;
    expect(p.visits.map((v) => v.mapping.resource)).toContain('cronjobs');
    expect(p.visits.every((v) => v.kind === 'list' && v.fromCategory)).toBe(true);
    const q = plan(['all,pods']) as Plan;
    const pods = q.visits.find((v) => v.mapping.resource === 'pods');
    expect(pods?.kind === 'list' && pods.fromCategory).toBe(false);
  });
  test('the real errors', () => {
    expect(plan(['pods/x', 'pods'])).toBe(
      "error: there is no need to specify a resource type as a separate argument when passing arguments in resource/name form (e.g. 'kubectl get resource/<resource_name>' instead of 'kubectl get resource resource/<resource_name>'\n",
    );
    expect(plan(['pods/x/y'])).toBe('error: arguments in resource/name form may not have more than one slash\n');
    expect(plan(['pdos'])).toBe('error: the server doesn\'t have a resource type "pdos"\n');
    expect(plan(['pods.v2'])).toBe('error: the server doesn\'t have a resource type "pods" in group "v2"\n');
    expect(plan(['pods', 'x'], { labelSelector: 'a=b' })).toBe('error: name cannot be provided when a selector is specified\n');
    expect(plan(['pod/x'], { labelSelector: 'a=b' })).toBe('error: selectors and the all flag cannot be used when passing resource/name arguments\n');
    expect(plan(['pods', 'x'], { allNamespaces: true })).toBe('error: a resource cannot be retrieved by name across all namespaces\n');
    expect(plan(['pods,svc'], { singleResourceType: true })).toBe('error: you may only specify a single resource type\n');
  });
});

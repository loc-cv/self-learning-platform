// Deployments and ReplicaSets through the request pipeline: validation, generation, the status and
// scale subresources, beyond the golden fixtures. Messages marked "oracle" were checked against the
// real v1.37.2 API server.

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

function req(k: Kernel, resource: string, r: Partial<ApiRequest> & Pick<ApiRequest, 'verb'>): ApiResponse {
  return k.act('test', (ctx: Ctx) => handle(ctx, DEFAULT_APISERVER, { group: 'apps', version: 'v1', resource, namespace: 'default', ...r }));
}

const template = (labels: JsonObject = { a: 'b' }, spec: JsonObject = {}): JsonObject => ({ metadata: { labels }, spec: { containers: [{ name: 'a', image: 'nginx' }], ...spec } });
const deployment = (name: string, spec: JsonObject, metadata: JsonObject = {}): JsonObject => ({
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: { name, ...metadata },
  spec: { selector: { matchLabels: { a: 'b' } }, template: template(), ...spec },
});
const replicaSet = (name: string, spec: JsonObject, metadata: JsonObject = {}): JsonObject => ({
  apiVersion: 'apps/v1',
  kind: 'ReplicaSet',
  metadata: { name, ...metadata },
  spec: { selector: { matchLabels: { a: 'b' } }, template: template(), ...spec },
});
const ok = (r: ApiResponse): JsonObject => {
  if (!r.ok) throw new Error(`expected success, got ${JSON.stringify(r)}`);
  return r.object as JsonObject;
};
const message = (r: ApiResponse): string => (!r.ok && 'status' in r ? (r.status.message as string) : `ok ${r.code}`);
const meta = (o: JsonObject): JsonObject => o.metadata as JsonObject;

describe('Deployment validation (oracle messages)', () => {
  test('template labels are checked at spec.template.labels; the strategy is printed as the internal struct', () => {
    const k = boot();
    const r = req(k, 'deployments', {
      verb: 'create',
      body: deployment('dep-a', { strategy: { type: 'Sometimes' }, minReadySeconds: 700, template: template({ a: 'b', 'bad key': 'x' }, { activeDeadlineSeconds: 5 }) }),
    });
    expect(message(r)).toBe(
      'Deployment.apps "dep-a" is invalid: [spec.template.labels: Invalid value: "bad key": name part must consist of alphanumeric characters, \'-\', \'_\' or \'.\', and must start and end with an alphanumeric character (e.g. \'MyName\',  or \'my.name\',  or \'123-abc\', regex used for validation is \'([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9]\'), spec.template.spec.activeDeadlineSeconds: Forbidden: activeDeadlineSeconds in ReplicaSet is not Supported, spec.strategy: Unsupported value: {"Type":"Sometimes","RollingUpdate":null}: supported values: "Recreate", "RollingUpdate", spec.progressDeadlineSeconds: Invalid value: 600: must be greater than minReadySeconds]',
    );
  });

  test('rolling update bounds and the revision history limit', () => {
    const k = boot();
    const r = req(k, 'deployments', { verb: 'create', body: deployment('dep-b', { strategy: { rollingUpdate: { maxUnavailable: '150%', maxSurge: -1 } }, revisionHistoryLimit: -1 }) });
    expect(message(r)).toBe(
      'Deployment.apps "dep-b" is invalid: [spec.strategy.rollingUpdate.maxSurge: Invalid value: -1: must be greater than or equal to 0, spec.strategy.rollingUpdate.maxUnavailable: Invalid value: "150%": must not be greater than 100%, spec.revisionHistoryLimit: Invalid value: -1: must be greater than or equal to 0]',
    );
  });

  test('a template host port must match its container port only when set', () => {
    const k = boot();
    const r = req(k, 'deployments', {
      verb: 'create',
      body: deployment('dep-c', {
        strategy: { type: 'Recreate', rollingUpdate: { maxSurge: 1 } },
        template: { metadata: { labels: { a: 'b' } }, spec: { hostNetwork: true, containers: [{ name: 'a', image: 'nginx', ports: [{ containerPort: 80, hostPort: 81 }, { containerPort: 90 }] }] } },
      }),
    });
    expect(message(r)).toBe(
      "Deployment.apps \"dep-c\" is invalid: [spec.template.spec.containers[0].ports[0].hostPort: Invalid value: 81: must match `containerPort` when `hostNetwork` is true, spec.strategy.rollingUpdate: Forbidden: may not be specified when strategy `type` is 'Recreate']",
    );
  });

  test('a ReplicaSet uses the core finalizer rule and checks replicas and minReadySeconds', () => {
    const k = boot();
    const r = req(k, 'replicasets', { verb: 'create', body: replicaSet('rs-a', { replicas: -2, minReadySeconds: -1 }, { finalizers: ['foo'] }) });
    expect(message(r)).toBe(
      'ReplicaSet.apps "rs-a" is invalid: [metadata.finalizers[0]: Invalid value: "foo": name is neither a standard finalizer name nor is it fully qualified, spec.replicas: Invalid value: -2: must be greater than or equal to 0, spec.minReadySeconds: Invalid value: -1: must be greater than or equal to 0]',
    );
  });

  test('a name with dots is valid but warned about (oracle)', () => {
    const k = boot();
    const r = req(k, 'deployments', { verb: 'create', body: deployment('dep.v1', {}) });
    expect(r.code).toBe(201);
    expect(r.warnings).toEqual(['metadata.name: this is used in Pod names and hostnames, which can result in surprising behavior; a DNS label is recommended: [must not contain dots]']);
  });
});

describe('generation and subresources', () => {
  test('a ReplicaSet bumps generation on spec changes only', () => {
    const k = boot();
    ok(req(k, 'replicasets', { verb: 'create', body: replicaSet('rs', { replicas: 1 }) }));
    expect(meta(ok(req(k, 'replicasets', { verb: 'patch', name: 'rs', body: { metadata: { annotations: { x: 'y' } } } }))).generation).toBe(1);
    expect(meta(ok(req(k, 'replicasets', { verb: 'patch', name: 'rs', body: { spec: { replicas: 3 } } }))).generation).toBe(2);
  });

  test('the ReplicaSet status subresource keeps the spec; status counts are validated', () => {
    const k = boot();
    ok(req(k, 'replicasets', { verb: 'create', body: replicaSet('rs', { replicas: 1 }) }));
    const r = ok(req(k, 'replicasets', { verb: 'patch', name: 'rs', subresource: 'status', body: { spec: { replicas: 5 }, status: { replicas: 1, readyReplicas: 1 } } }));
    expect((r.spec as JsonObject).replicas).toBe(1);
    expect(r.status).toEqual({ replicas: 1, readyReplicas: 1 });
    const bad = req(k, 'replicasets', { verb: 'patch', name: 'rs', subresource: 'status', body: { status: { replicas: 1, availableReplicas: 2 } } });
    expect(message(bad)).toBe(
      'ReplicaSet.apps "rs" is invalid: [status.availableReplicas: Invalid value: 2: cannot be greater than status.replicas, status.availableReplicas: Invalid value: 2: cannot be greater than readyReplicas]',
    );
  });

  test('the Deployment status subresource keeps labels and refuses a lower collisionCount', () => {
    const k = boot();
    ok(req(k, 'deployments', { verb: 'create', body: deployment('d', {}, { labels: { keep: 'me' } }) }));
    const r = ok(req(k, 'deployments', { verb: 'patch', name: 'd', subresource: 'status', body: { metadata: { labels: { other: 'x' } }, status: { collisionCount: 2 } } }));
    expect(meta(r).labels).toEqual({ keep: 'me' });
    const bad = req(k, 'deployments', { verb: 'patch', name: 'd', subresource: 'status', body: { status: { collisionCount: 1 } } });
    expect(message(bad)).toBe('Deployment.apps "d" is invalid: status.collisionCount: Invalid value: 1: cannot be decremented');
  });

  test('GET scale of a ReplicaSet: autoscaling/v1 Scale with the selector as a string', () => {
    const k = boot();
    ok(req(k, 'replicasets', { verb: 'create', body: replicaSet('rs', { replicas: 3, selector: { matchLabels: { a: 'b' }, matchExpressions: [{ key: 'tier', operator: 'Exists' }] }, template: template({ a: 'b', tier: 'x' }) }) }));
    const scale = ok(req(k, 'replicasets', { verb: 'get', name: 'rs', subresource: 'scale' }));
    expect(scale.kind).toBe('Scale');
    expect(scale.apiVersion).toBe('autoscaling/v1');
    expect(scale.spec).toEqual({ replicas: 3 });
    expect(scale.status).toEqual({ replicas: 0, selector: 'a=b,tier' });
    expect(Object.keys(meta(scale))).toEqual(['name', 'namespace', 'uid', 'resourceVersion', 'creationTimestamp']);
  });
});

describe('fixtures/golden/v1.37.2/objects/defaulted.yaml', () => {
  test('the minimal Deployment is stored with the spec the real server stores', () => {
    const k = boot();
    const d = ok(
      req(k, 'deployments', {
        verb: 'create',
        body: { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'minimal' }, spec: { selector: { matchLabels: { app: 'minimal' } }, template: { metadata: { labels: { app: 'minimal' } }, spec: { containers: [{ name: 'app', image: 'nginx:1.27' }] } } } },
      }),
    );
    expect(d.spec).toEqual({
      progressDeadlineSeconds: 600,
      replicas: 1,
      revisionHistoryLimit: 10,
      selector: { matchLabels: { app: 'minimal' } },
      strategy: { rollingUpdate: { maxSurge: '25%', maxUnavailable: '25%' }, type: 'RollingUpdate' },
      template: {
        metadata: { labels: { app: 'minimal' } },
        spec: {
          containers: [{ image: 'nginx:1.27', imagePullPolicy: 'IfNotPresent', name: 'app', resources: {}, terminationMessagePath: '/dev/termination-log', terminationMessagePolicy: 'File' }],
          dnsPolicy: 'ClusterFirst',
          restartPolicy: 'Always',
          schedulerName: 'default-scheduler',
          securityContext: {},
          terminationGracePeriodSeconds: 30,
        },
      },
    });
  });
});

const daemonSet = (name: string, spec: JsonObject = {}, metadata: JsonObject = {}): JsonObject => ({
  apiVersion: 'apps/v1',
  kind: 'DaemonSet',
  metadata: { name, ...metadata },
  spec: { selector: { matchLabels: { a: 'b' } }, template: template(), ...spec },
});
const TG = 'deprecated.daemonset.template.generation';
const annotations = (o: JsonObject): JsonObject => meta(o).annotations as JsonObject;

describe('DaemonSet (beyond fixtures/golden/cases/api/daemonset.yaml)', () => {
  test('a template generation that is not a number fails the patch decoding, as Invalid on patch (oracle)', () => {
    const k = boot();
    ok(req(k, 'daemonsets', { verb: 'create', body: daemonSet('ds') }));
    const r = req(k, 'daemonsets', { verb: 'patch', name: 'ds', options: { patchType: 'merge' }, body: { metadata: { annotations: { [TG]: 'x' } } } });
    expect(r.code).toBe(422);
    expect(message(r)).toMatch(/^ "" is invalid: patch: Invalid value: "\{\\"apiVersion\\":\\"apps\/v1\\",.*\}": strconv\.ParseInt: parsing "x": invalid syntax$/);
  });

  test('the conversion error wins over strict field validation; out of range is its own error', () => {
    // upstream: apimachinery/pkg/runtime/serializer/versioning/versioning.go Decode converts
    // before it returns the strict decoding errors; strconv.ParseInt's range error.
    const k = boot();
    const body = { ...daemonSet('ds', {}, { annotations: { [TG]: '9223372036854775808' } }), extra: 1 };
    const r = req(k, 'daemonsets', { verb: 'create', body, options: { fieldValidation: 'Strict' } });
    expect(r.code).toBe(400);
    expect(message(r)).toBe('DaemonSet in version "v1" cannot be handled as a DaemonSet: strconv.ParseInt: parsing "9223372036854775808": value out of range');
  });

  test('the template generation is written back as strconv.FormatInt prints it', () => {
    const k = boot();
    const ds = ok(req(k, 'daemonsets', { verb: 'create', body: daemonSet('ds', {}, { annotations: { [TG]: '+007' } }) }));
    expect(annotations(ds)[TG]).toBe('7');
  });

  test('an update that changes nothing is not written, without the annotation in the body too', () => {
    const k = boot();
    const created = ok(req(k, 'daemonsets', { verb: 'create', body: daemonSet('ds') }));
    const same = ok(req(k, 'daemonsets', { verb: 'update', name: 'ds', body: daemonSet('ds') }));
    expect(meta(same).resourceVersion).toBe(meta(created).resourceVersion);
    expect(meta(same).generation).toBe(1);
    expect(annotations(same)[TG]).toBe('1');
  });

  test('the status subresource keeps spec and template generation and answers GET', () => {
    const k = boot();
    ok(req(k, 'daemonsets', { verb: 'create', body: daemonSet('ds') }));
    const status = { currentNumberScheduled: 2, numberMisscheduled: 0, desiredNumberScheduled: 2, numberReady: 1, observedGeneration: 1 };
    const body = { ...daemonSet('ds', { minReadySeconds: 9 }, { annotations: { [TG]: '4' } }), status };
    const written = ok(req(k, 'daemonsets', { verb: 'update', name: 'ds', subresource: 'status', body }));
    expect((written.spec as JsonObject).minReadySeconds).toBeUndefined();
    expect(annotations(written)[TG]).toBe('1');
    expect(written.status).toEqual(status);
    const got = ok(req(k, 'daemonsets', { verb: 'get', name: 'ds', subresource: 'status' }));
    expect(got.status).toEqual(status);
    // A spec write keeps the status the controller wrote.
    const updated = ok(req(k, 'daemonsets', { verb: 'patch', name: 'ds', options: { patchType: 'merge' }, body: { spec: { minReadySeconds: 3 }, status: { numberReady: 0 } } }));
    expect(updated.status).toEqual(status);
    expect(meta(updated).generation).toBe(2);
  });

  test('field selectors name metadata only (the message: oracle); no scale subresource', () => {
    const k = boot();
    ok(req(k, 'daemonsets', { verb: 'create', body: daemonSet('one') }));
    ok(req(k, 'daemonsets', { verb: 'create', body: daemonSet('two') }));
    const list = ok(req(k, 'daemonsets', { verb: 'list', options: { fieldSelector: 'metadata.name=two' } }));
    expect((list.items as JsonObject[]).map((d) => meta(d).name)).toEqual(['two']);
    const bad = req(k, 'daemonsets', { verb: 'list', options: { fieldSelector: 'status.numberReady=1' } });
    // upstream: apimachinery/pkg/apis/meta/v1/conversion.go DefaultMetaV1FieldSelectorConversion
    expect(message(bad)).toBe('"status.numberReady" is not a known field selector: only "metadata.name", "metadata.namespace"');
    expect(req(k, 'daemonsets', { verb: 'get', name: 'one', subresource: 'scale' }).ok).toBe(false);
  });
});

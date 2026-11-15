// Pods through the request pipeline: defaulting, validation and strategy rules beyond the golden
// fixtures (fixtures/golden/v1.37.2/api/*.yaml). Messages marked "oracle" were checked against the
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
import { POD_UPDATE_FORBIDDEN } from '../../apis/core/validation/pod.ts';

const registry = createRegistry([hostPlugin, k8sPlugin]);

function boot(): Kernel {
  const k = bootKernel(registry, { seed: 1, startTime: DEFAULT_START_TIME });
  k.act('bootstrap', (ctx) => bootstrapApiServer(ctx, DEFAULT_APISERVER));
  return k;
}

function req(k: Kernel, r: Partial<ApiRequest> & Pick<ApiRequest, 'verb'>): ApiResponse {
  return k.act('test', (ctx: Ctx) => handle(ctx, DEFAULT_APISERVER, { group: '', version: 'v1', resource: 'pods', namespace: 'default', ...r }));
}

const pod = (name: string, spec: JsonObject, metadata: JsonObject = {}): JsonObject => ({ apiVersion: 'v1', kind: 'Pod', metadata: { name, ...metadata }, spec });
const ok = (r: ApiResponse): JsonObject => {
  if (!r.ok) throw new Error(`expected success, got ${JSON.stringify(r)}`);
  return r.object as JsonObject;
};
const message = (r: ApiResponse): string => (!r.ok && 'status' in r ? (r.status.message as string) : `ok ${r.code}`);
const create = (k: Kernel, name: string, spec: JsonObject, metadata: JsonObject = {}): ApiResponse => req(k, { verb: 'create', body: pod(name, spec, metadata) });
const spec = (o: JsonObject): JsonObject => o.spec as JsonObject;
const status = (o: JsonObject): JsonObject => o.status as JsonObject;
const meta = (o: JsonObject): JsonObject => o.metadata as JsonObject;
const c0 = (o: JsonObject): JsonObject => (spec(o).containers as JsonObject[])[0] as JsonObject;

describe('defaults', () => {
  test('image pull policy follows the tag: none or latest is Always, a digest or another tag IfNotPresent', () => {
    const k = boot();
    const policy = (image: string, n: string): unknown => c0(ok(create(k, n, { containers: [{ name: 'a', image }] }))).imagePullPolicy;
    expect(policy('nginx', 'a')).toBe('Always');
    expect(policy('nginx:latest', 'b')).toBe('Always');
    expect(policy('registry.k8s.io/pause', 'c')).toBe('Always');
    expect(policy('localhost:5000/app', 'd')).toBe('Always');
    expect(policy('nginx:1.27', 'e')).toBe('IfNotPresent');
    expect(policy(`nginx@sha256:${'a'.repeat(64)}`, 'f')).toBe('IfNotPresent');
    expect(policy('NGINX', 'g')).toBe('IfNotPresent');
  });

  test('requests come from limits on a Pod, quantities round up to milli (oracle)', () => {
    const k = boot();
    const p = ok(create(k, 'p4', { containers: [{ name: 'a', image: 'nginx', resources: { limits: { cpu: '0.0001', 'example.com/gpu': '1' }, requests: { cpu: '0.00001' } } }] }));
    expect(c0(p).resources).toEqual({ limits: { cpu: '1m', 'example.com/gpu': '1' }, requests: { cpu: '1m', 'example.com/gpu': '1' } });
    expect(status(p).qosClass).toBe('Burstable');
  });

  test('host network copies container ports to host ports; enableServiceLinks defaults on a Pod', () => {
    const k = boot();
    const p = ok(create(k, 'hn', { hostNetwork: true, containers: [{ name: 'a', image: 'nginx', ports: [{ containerPort: 8080 }] }] }));
    expect((c0(p).ports as JsonObject[])[0]).toEqual({ hostPort: 8080, containerPort: 8080, protocol: 'TCP' });
    expect(spec(p).enableServiceLinks).toBe(true);
  });

  test('a volume with no source is an emptyDir; probes and handlers get their defaults', () => {
    const k = boot();
    const p = ok(
      create(k, 'v', {
        volumes: [{ name: 'scratch' }, { name: 'dapi', downwardAPI: { items: [{ path: 'n', fieldRef: { fieldPath: 'metadata.name' } }] } }],
        containers: [{ name: 'a', image: 'nginx', livenessProbe: { httpGet: { port: 80 } }, lifecycle: { preStop: { httpGet: { port: 80 } } } }],
      }),
    );
    expect(spec(p).volumes).toEqual([
      { name: 'scratch', emptyDir: {} },
      { name: 'dapi', downwardAPI: { items: [{ path: 'n', fieldRef: { apiVersion: 'v1', fieldPath: 'metadata.name' } }], defaultMode: 420 } },
    ]);
    expect(c0(p).livenessProbe).toEqual({ httpGet: { path: '/', port: 80, scheme: 'HTTP' }, timeoutSeconds: 1, periodSeconds: 10, successThreshold: 1, failureThreshold: 3 });
    expect(c0(p).lifecycle).toEqual({ preStop: { httpGet: { path: '/', port: 80, scheme: 'HTTP' } } });
  });

  test('lifecycle.stopSignal is dropped while ContainerStopSignals is off (oracle)', () => {
    const k = boot();
    const p = ok(create(k, 'ss', { containers: [{ name: 'a', image: 'nginx', lifecycle: { stopSignal: 'SIGUSR1' } }] }));
    expect(c0(p).lifecycle).toBeUndefined();
  });

  test('a gated Pod starts with PodScheduled=False, SchedulingGated (oracle)', () => {
    const k = boot();
    const p = ok(create(k, 'gated', { schedulingGates: [{ name: 'example.com/g' }], containers: [{ name: 'a', image: 'nginx' }] }));
    const conditions = status(p).conditions as JsonObject[];
    expect(conditions).toHaveLength(1);
    expect(conditions[0]).toMatchObject({ type: 'PodScheduled', status: 'False', lastProbeTime: null, reason: 'SchedulingGated', message: 'Scheduling is blocked due to non-empty scheduling gates' });
  });

  test('QoS: Guaranteed needs requests equal to limits for cpu and memory in every container', () => {
    const k = boot();
    const qos = (n: string, resources: JsonObject): unknown => status(ok(create(k, n, { containers: [{ name: 'a', image: 'nginx', resources }] }))).qosClass;
    expect(qos('q1', {})).toBe('BestEffort');
    expect(qos('q2', { limits: { cpu: '1', memory: '1Gi' } })).toBe('Guaranteed');
    expect(qos('q3', { limits: { cpu: '1' } })).toBe('Burstable');
    expect(qos('q4', { requests: { cpu: '500m' }, limits: { cpu: '1', memory: '1Gi' } })).toBe('Burstable');
  });
});

describe('validation (oracle messages)', () => {
  test('a security context printed as the internal struct', () => {
    const k = boot();
    const r = create(k, 'p1', { containers: [{ name: 'a', image: 'nginx', securityContext: { privileged: true, allowPrivilegeEscalation: false, capabilities: { add: ['CAP_SYS_ADMIN'] } } }] });
    const sc =
      '{"Capabilities":{"Add":["CAP_SYS_ADMIN"],"Drop":null},"Privileged":true,"SELinuxOptions":null,"WindowsOptions":null,"RunAsUser":null,"RunAsGroup":null,"RunAsNonRoot":null,"ReadOnlyRootFilesystem":null,"AllowPrivilegeEscalation":false,"ProcMount":null,"SeccompProfile":null,"AppArmorProfile":null}';
    expect(message(r)).toBe(
      `Pod "p1" is invalid: [spec.containers[0].securityContext: Invalid value: ${sc}: cannot set \`allowPrivilegeEscalation\` to false and \`privileged\` to true, spec.containers[0].securityContext: Invalid value: ${sc}: cannot set \`allowPrivilegeEscalation\` to false and \`capabilities.Add\` CAP_SYS_ADMIN]`,
    );
  });

  test('a volume with an error is not mountable; init containers may not have probes', () => {
    const k = boot();
    const r = create(k, 'p2', {
      initContainers: [{ name: 'i', image: 'busybox', livenessProbe: { exec: { command: ['true'] } } }],
      containers: [{ name: 'a', image: 'nginx', volumeMounts: [{ name: 'v', mountPath: '/x' }, { name: 'w', mountPath: '/x' }] }],
      volumes: [{ name: 'v', hostPath: { path: '/a/../b', type: 'Bogus' } }],
    });
    expect(message(r)).toBe(
      'Pod "p2" is invalid: [spec.volumes[0].hostPath.path: Invalid value: "/a/../b": must not contain \'..\', spec.volumes[0].hostPath.type: Unsupported value: "Bogus": supported values: "", "BlockDevice", "CharDevice", "Directory", "DirectoryOrCreate", "File", "FileOrCreate", "Socket", spec.containers[0].volumeMounts[0].name: Not found: "v", spec.containers[0].volumeMounts[1].name: Not found: "w", spec.containers[0].volumeMounts[1].mountPath: Invalid value: "/x": must be unique, spec.initContainers[0].livenessProbe: Forbidden: may not be set for init containers without restartPolicy=Always]',
    );
  });

  test('a sidecar (restartPolicy Always) may have probes', () => {
    const k = boot();
    const r = create(k, 'sidecar', {
      initContainers: [{ name: 'i', image: 'busybox', restartPolicy: 'Always', readinessProbe: { exec: { command: ['true'] } } }],
      containers: [{ name: 'a', image: 'nginx' }],
    });
    expect(message(r)).toBe('ok 201');
  });

  test('env names, downward API paths, value with valueFrom, resources, host network ports', () => {
    const k = boot();
    const r = create(k, 'p3', {
      hostNetwork: true,
      containers: [
        {
          name: 'a',
          image: 'nginx',
          ports: [{ containerPort: 80, hostPort: 81 }],
          env: [
            { name: 'A=B', value: 'x', valueFrom: { fieldRef: { fieldPath: 'metadata.labels' } } },
            { name: 'B', valueFrom: {} },
          ],
          resources: { limits: { memory: '1Gi' }, requests: { memory: '2Gi' } },
        },
      ],
    });
    expect(message(r)).toBe(
      'Pod "p3" is invalid: [spec.containers[0].env[0].name: Invalid value: "A=B": a valid environment variable name must consist only of printable ASCII characters other than \'=\', spec.containers[0].env[0].valueFrom.fieldRef.fieldPath: Unsupported value: "metadata.labels": supported values: "metadata.name", "metadata.namespace", "metadata.uid", "spec.nodeName", "spec.serviceAccountName", "status.hostIP", "status.hostIPs", "status.podIP", "status.podIPs", spec.containers[0].env[0].valueFrom: Invalid value: "": may not be specified when `value` is not empty, spec.containers[0].env[1].valueFrom: Invalid value: "": must specify one of: `fieldRef`, `resourceFieldRef`, `configMapKeyRef`, `secretKeyRef` or `fileKeyRef`, spec.containers[0].resources.requests: Invalid value: "2Gi": must be less than or equal to memory limit of 1Gi, spec.containers[0].ports[0].hostPort: Invalid value: 81: must match `containerPort` when `hostNetwork` is true]',
    );
  });

  test('probe port names, node affinity terms, tolerations, image whitespace', () => {
    const k = boot();
    const r = create(k, 'p5', {
      tolerations: [
        { key: 'k', operator: 'Exists', value: 'v' },
        { operator: 'Equal', tolerationSeconds: 5, effect: 'NoSchedule' },
      ],
      affinity: { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [] } } },
      containers: [{ name: 'a', image: ' nginx', readinessProbe: { httpGet: { port: 'toolongportname1' }, successThreshold: 2 } }],
    });
    expect(message(r)).toBe(
      'Pod "p5" is invalid: [spec.containers[0].readinessProbe.httpGet.port: Invalid value: "toolongportname1": must be no more than 15 characters, spec.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms: Required value: must have at least one node selector term, spec.tolerations[0].operator: Invalid value: "v": value must be empty when `operator` is \'Exists\', spec.tolerations[1].operator: Invalid value: "Equal": operator must be Exists when `key` is empty, which means "match all values and all keys", spec.tolerations[1].effect: Invalid value: "NoSchedule": effect must be \'NoExecute\' when `tolerationSeconds` is set, spec.containers[0].image: Invalid value: " nginx": must not have leading or trailing whitespace]',
    );
  });

  test('list paths upstream uses for envFrom, subPath and mountPropagation; init host ports at index 0', () => {
    const k = boot();
    const r = create(k, 'hp', {
      initContainers: [
        { name: 'i0', image: 'busybox' },
        { name: 'i1', image: 'busybox', ports: [{ containerPort: 80, hostPort: 8080 }, { containerPort: 81, hostPort: 8080 }] },
      ],
      containers: [
        {
          name: 'a',
          image: 'nginx',
          envFrom: [{ prefix: '1X' }, { configMapRef: { name: 'Bad_' }, secretRef: { name: 's' } }],
          volumeMounts: [{ name: 'v', mountPath: '/m', subPath: '/abs', mountPropagation: 'Bidirectional' }],
        },
      ],
      volumes: [{ name: 'v', emptyDir: {} }],
    });
    expect(message(r)).toBe(
      "Pod \"hp\" is invalid: [spec.containers[0].envFrom: Invalid value: \"\": must specify one of: `configMapRef` or `secretRef`, spec.containers[0].envFrom[1].configMapRef.name: Invalid value: \"Bad_\": a lowercase RFC 1123 subdomain must consist of lower case alphanumeric characters, '-' or '.', and must start and end with an alphanumeric character (e.g. 'example.com', regex used for validation is '[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*'), spec.containers[0].envFrom: Invalid value: \"\": may not have more than one field specified at a time, spec.containers[0].volumeMounts.subPath: Invalid value: \"/abs\": must be a relative path, spec.containers[0].volumeMounts.mountPropagation: Forbidden: Bidirectional mount propagation is available only to privileged containers, spec.initContainers[0].ports[1].hostPort: Duplicate value: \"TCP//8080\"]",
    );
  });

  test('a name that is a subdomain but not a label gets a warning', () => {
    const k = boot();
    const r = create(k, 'web.v1', { containers: [{ name: 'a', image: 'nginx' }] });
    expect(r.warnings).toEqual([
      "metadata.name: this is used in the Pod's hostname, which can result in surprising behavior; a DNS label is recommended: [must not contain dots]",
    ]);
  });
});

describe('updates', () => {
  const base = { containers: [{ name: 'a', image: 'nginx:1.27' }], tolerations: [{ key: 'k', operator: 'Exists', effect: 'NoExecute', tolerationSeconds: 10 }] };

  test('the image may change and bumps generation; other spec fields are forbidden', () => {
    const k = boot();
    ok(create(k, 'u', base));
    const patched = ok(req(k, { verb: 'patch', name: 'u', body: { spec: { containers: [{ name: 'a', image: 'nginx:1.28' }] } } }));
    expect(meta(patched).generation).toBe(2);
    expect(c0(patched).image).toBe('nginx:1.28');
    const label = ok(req(k, { verb: 'patch', name: 'u', body: { metadata: { labels: { a: 'b' } } } }));
    expect(meta(label).generation).toBe(2);
    const bad = req(k, { verb: 'patch', name: 'u', body: { spec: { restartPolicy: 'Never' } } });
    expect(message(bad)).toBe(`Pod "u" is invalid: spec: Forbidden: ${POD_UPDATE_FORBIDDEN}`);
  });

  test('containers may not be added; tolerations may only be added, tolerationSeconds may change', () => {
    const k = boot();
    ok(create(k, 'u', base));
    const add = req(k, { verb: 'patch', name: 'u', body: { spec: { containers: [{ name: 'a', image: 'nginx' }, { name: 'b', image: 'nginx' }] } } });
    expect(message(add)).toBe('Pod "u" is invalid: spec.containers: Forbidden: pod updates may not add or remove containers');
    const seconds = req(k, { verb: 'patch', name: 'u', body: { spec: { tolerations: [{ key: 'k', operator: 'Exists', effect: 'NoExecute', tolerationSeconds: 5 }] } } });
    expect(message(seconds)).toBe('ok 200');
    const removed = req(k, { verb: 'patch', name: 'u', body: { spec: { tolerations: [] } } });
    expect(message(removed)).toBe('Pod "u" is invalid: spec.tolerations: Forbidden: existing toleration can not be modified except its tolerationSeconds');
  });

  test('activeDeadlineSeconds may be set and lowered, not raised or removed', () => {
    const k = boot();
    ok(create(k, 'd', { ...base, activeDeadlineSeconds: 100 }));
    expect(message(req(k, { verb: 'patch', name: 'd', body: { spec: { activeDeadlineSeconds: 50 } } }))).toBe('ok 200');
    expect(message(req(k, { verb: 'patch', name: 'd', body: { spec: { activeDeadlineSeconds: 60 } } }))).toBe(
      'Pod "d" is invalid: spec.activeDeadlineSeconds: Invalid value: 60: must be less than or equal to previous value',
    );
    expect(message(req(k, { verb: 'patch', name: 'd', body: { spec: { activeDeadlineSeconds: null } } }))).toBe(
      'Pod "d" is invalid: spec.activeDeadlineSeconds: Invalid value: null: must not update from a positive integer to nil value',
    );
  });

  test('the status subresource keeps the spec and the QoS class', () => {
    const k = boot();
    ok(create(k, 's', base));
    const r = ok(req(k, { verb: 'patch', name: 's', subresource: 'status', body: { spec: { restartPolicy: 'Never' }, status: { phase: 'Running', qosClass: '' } } }));
    expect(spec(r).restartPolicy).toBe('Always');
    expect(status(r)).toMatchObject({ phase: 'Running', qosClass: 'BestEffort' });
    expect(meta(r).generation).toBe(1);
  });
});

describe('field selectors', () => {
  test('pods select on spec.nodeName (and the old spec.host); unknown labels are refused', () => {
    const k = boot();
    ok(create(k, 'bound', { nodeName: 'node01', containers: [{ name: 'a', image: 'nginx' }] }));
    ok(create(k, 'free', { containers: [{ name: 'a', image: 'nginx' }] }));
    const names = (fieldSelector: string): unknown => (ok(req(k, { verb: 'list', options: { fieldSelector } })).items as JsonObject[]).map((i) => meta(i).name);
    expect(names('spec.nodeName=node01')).toEqual(['bound']);
    expect(names('spec.host=node01')).toEqual(['bound']);
    expect(names('spec.nodeName=')).toEqual(['free']);
    expect(names('status.phase=Pending,spec.hostNetwork=false')).toEqual(['bound', 'free']);
    expect(message(req(k, { verb: 'list', options: { fieldSelector: 'spec.image=x' } }))).toBe('field label not supported: spec.image');
  });
});

describe('fixtures/golden/v1.37.2/objects/defaulted.yaml', () => {
  test('the minimal Pod has the real spec minus what admission plugins add (phase 20b)', () => {
    const k = boot();
    const p = ok(create(k, 'minimal', { nodeName: 'node02', containers: [{ name: 'app', image: 'busybox:1.37', command: ['sleep', '3600'] }] }));
    expect(spec(p)).toEqual({
      containers: [{ command: ['sleep', '3600'], image: 'busybox:1.37', imagePullPolicy: 'IfNotPresent', name: 'app', resources: {}, terminationMessagePath: '/dev/termination-log', terminationMessagePolicy: 'File' }],
      dnsPolicy: 'ClusterFirst',
      enableServiceLinks: true,
      nodeName: 'node02',
      restartPolicy: 'Always',
      schedulerName: 'default-scheduler',
      securityContext: {},
      terminationGracePeriodSeconds: 30,
    });
    expect(status(p)).toEqual({ phase: 'Pending', qosClass: 'BestEffort' });
  });
});

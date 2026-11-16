// The expected rows of upstream's printer unit tests, ported to check the TypeScript printers.
// upstream: pkg/printers/internalversion/printers_test.go (the Test* functions cited per describe);
// staging/src/k8s.io/apimachinery/pkg/util/duration/duration_test.go.
//
// Upstream builds internal Go structs; here each object is the v1 JSON the API server stores for
// that struct (zero-valued fields that Go serializes without omitempty are written out, zero
// metav1.Time as null). Upstream ages come from time.Now().Add(-x) and a print a moment later;
// here the clock is a fixed NOW and timestamps are NOW-x as RFC 3339 (metav1.Time truncated to the
// second, metav1.MicroTime with six fractional digits). Upstream cases have no names: each case
// here is named by its index in upstream's table (the "%d mismatch" of the Go test) and the comment
// above it. Upstream compares whole rows after clearing Row.Object, so cells and conditions
// (absent where upstream has none) are compared.

import { formatRfc3339, millisFromCivil } from '@simlab/kernel';
import { describe, expect, test } from 'vitest';
import type { Json, JsonObject } from '../apimachinery/json.ts';
import { humanDuration, shortHumanDuration } from './duration.ts';
import { printHandler } from './handlers.ts';
import type { TableRowCondition } from './types.ts';

const NOW = millisFromCivil(2026, 11, 13, 12, 0, 0);
const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;
const D = 24 * H;

/** metav1.Time at NOW + offset (ms), as marshalled: RFC 3339, truncated to the second. */
const at = (offset: number): string => formatRfc3339(Math.floor((NOW + offset) / S) * S);
/** metav1.MicroTime at NOW + offset (ms): RFC 3339 with six fractional digits. */
const microAt = (offset: number): string => {
  const t = NOW + offset;
  const ms = ((t % S) + S) % S;
  return `${formatRfc3339(t - ms).slice(0, -1)}.${String(ms * 1000).padStart(6, '0')}Z`;
};

type Row = { cells: Json[]; conditions?: TableRowCondition[] };
type Case = { name: string; obj: JsonObject; wide?: boolean; expected: Row[] };

function print(group: string, kind: string, o: JsonObject, wide = false): Row[] {
  const handler = printHandler(group, kind);
  if (handler === undefined) throw new Error(`no printer for ${group}/${kind}`);
  return handler.print(o, { noHeaders: false, wide, now: NOW }).map((r) => (r.conditions === undefined ? { cells: r.cells } : { cells: r.cells, conditions: r.conditions }));
}

function run(group: string, kind: string, cases: Case[], wide?: boolean): void {
  cases.forEach((c, i) => {
    test(`${i}: ${c.name}`, () => {
      expect(print(group, kind, c.obj, wide ?? c.wide ?? false)).toEqual(c.expected);
    });
  });
}

const meta = (name: string, creationTimestamp: string | null = null, extra: JsonObject = {}): JsonObject => ({ name, creationTimestamp, ...extra });

// upstream: pkg/printers/internalversion/printers.go podSuccessConditions, podFailedConditions.
const podSuccessConditions: TableRowCondition[] = [{ type: 'Completed', status: 'True', reason: 'Succeeded', message: 'The pod has completed successfully.' }];
const podFailedConditions: TableRowCondition[] = [{ type: 'Completed', status: 'True', reason: 'Failed', message: 'The pod failed.' }];

// upstream: pkg/printers/internalversion/printers_test.go TestPrintEvent
describe('TestPrintEvent', () => {
  const event = (f: JsonObject): JsonObject => ({
    metadata: meta(''),
    involvedObject: {},
    reason: '',
    message: '',
    source: {},
    firstTimestamp: null,
    lastTimestamp: null,
    eventTime: null,
    type: '',
    reportingComponent: '',
    reportingInstance: '',
    ...f,
  });
  const deployment = { kind: 'Deployment', name: 'Deployment Name', fieldPath: 'spec.containers{foo}' };
  const wideSource = { component: 'kubelet', host: 'Node1' };
  run('', 'Event', [
    {
      name: 'Basic event; no generate options',
      obj: event({
        source: { component: 'kubelet' },
        involvedObject: { kind: 'Pod', name: 'Pod Name', fieldPath: 'spec.containers{foo}' },
        reason: 'Event Reason',
        message: 'Message Data',
        firstTimestamp: at(-3 * D),
        lastTimestamp: at(-2 * D),
        count: 6,
        type: 'Normal',
        metadata: meta('event1'),
      }),
      expected: [{ cells: ['2d', 'Normal', 'Event Reason', 'pod/Pod Name', 'Message Data'] }],
    },
    {
      name: 'Basic event; generate options=Wide',
      wide: true,
      obj: event({
        source: wideSource,
        involvedObject: deployment,
        reason: 'Event Reason',
        message: 'Message Data',
        firstTimestamp: at(-3 * D),
        lastTimestamp: at(-2 * D),
        count: 6,
        type: 'Warning',
        metadata: meta('event2'),
      }),
      expected: [{ cells: ['2d', 'Warning', 'Event Reason', 'deployment/Deployment Name', 'spec.containers{foo}', 'kubelet, Node1', 'Message Data', '3d', 6, 'event2'] }],
    },
    {
      name: 'Basic event, w/o FirstTimestamp set',
      wide: true,
      obj: event({
        source: wideSource,
        involvedObject: deployment,
        reason: 'Event Reason',
        message: 'Message Data',
        eventTime: microAt(-3 * D),
        lastTimestamp: at(-3 * D),
        count: 1,
        type: 'Warning',
        metadata: meta('event3'),
      }),
      expected: [{ cells: ['3d', 'Warning', 'Event Reason', 'deployment/Deployment Name', 'spec.containers{foo}', 'kubelet, Node1', 'Message Data', '3d', 1, 'event3'] }],
    },
    {
      name: 'Basic event, w/o LastTimestamp set',
      wide: true,
      obj: event({
        source: wideSource,
        involvedObject: deployment,
        reason: 'Event Reason',
        message: 'Message Data',
        eventTime: microAt(-3 * D),
        firstTimestamp: at(-3 * D),
        count: 1,
        type: 'Warning',
        metadata: meta('event4'),
      }),
      expected: [{ cells: ['3d', 'Warning', 'Event Reason', 'deployment/Deployment Name', 'spec.containers{foo}', 'kubelet, Node1', 'Message Data', '3d', 1, 'event4'] }],
    },
    {
      name: 'Basic event, w/o FirstTimestamp and LastTimestamp set',
      wide: true,
      obj: event({
        source: wideSource,
        involvedObject: deployment,
        reason: 'Event Reason',
        message: 'Message Data',
        eventTime: microAt(-3 * D),
        count: 1,
        type: 'Warning',
        metadata: meta('event5'),
      }),
      expected: [{ cells: ['3d', 'Warning', 'Event Reason', 'deployment/Deployment Name', 'spec.containers{foo}', 'kubelet, Node1', 'Message Data', '3d', 1, 'event5'] }],
    },
    {
      name: 'Basic event serie, w/o FirstTimestamp, LastTimestamp and Count set',
      wide: true,
      obj: event({
        source: wideSource,
        involvedObject: deployment,
        series: { count: 2, lastObservedTime: microAt(-2 * D) },
        reason: 'Event Reason',
        message: 'Message Data',
        eventTime: microAt(-3 * D),
        type: 'Warning',
        metadata: meta('event6'),
      }),
      expected: [{ cells: ['2d', 'Warning', 'Event Reason', 'deployment/Deployment Name', 'spec.containers{foo}', 'kubelet, Node1', 'Message Data', '3d', 2, 'event6'] }],
    },
    {
      name: 'Singleton event, w/o FirstTimestamp, LastTimestamp and Count set',
      wide: true,
      obj: event({
        source: wideSource,
        involvedObject: deployment,
        reason: 'Event Reason',
        message: 'Message Data',
        eventTime: microAt(-3 * D),
        type: 'Warning',
        metadata: meta('event7'),
      }),
      expected: [{ cells: ['3d', 'Warning', 'Event Reason', 'deployment/Deployment Name', 'spec.containers{foo}', 'kubelet, Node1', 'Message Data', '3d', 1, 'event7'] }],
    },
    {
      name: 'Basic event, with empty Source; generate options=Wide',
      wide: true,
      obj: event({
        // Event.ReportingController is `reportingComponent` in JSON.
        reportingComponent: 'kubelet',
        reportingInstance: 'test',
        involvedObject: deployment,
        reason: 'Event Reason',
        message: 'Message Data',
        firstTimestamp: at(-3 * D),
        lastTimestamp: at(-2 * D),
        count: 6,
        type: 'Warning',
        metadata: meta('event2'),
      }),
      expected: [{ cells: ['2d', 'Warning', 'Event Reason', 'deployment/Deployment Name', 'spec.containers{foo}', 'kubelet, test', 'Message Data', '3d', 6, 'event2'] }],
    },
  ]);
});

// upstream: pkg/printers/internalversion/printers_test.go TestPrintNamespace
describe('TestPrintNamespace', () => {
  run('', 'Namespace', [
    {
      name: 'Basic namespace with status and age.',
      obj: { metadata: meta('namespace1', at(1900)), spec: {}, status: { phase: 'FooStatus' } },
      expected: [{ cells: ['namespace1', 'FooStatus', '0s'] }],
    },
    {
      name: 'Basic namespace without status or age.',
      obj: { metadata: meta('namespace2'), spec: {}, status: {} },
      expected: [{ cells: ['namespace2', '', '<unknown>'] }],
    },
  ]);
});

// upstream: pkg/printers/internalversion/printers_test.go TestPrintSecret
describe('TestPrintSecret', () => {
  run('', 'Secret', [
    {
      name: 'Basic namespace with type, data, and age.',
      // "secret data" in base64, as []byte marshals.
      obj: { metadata: meta('secret1', at(1900)), type: 'kubernetes.io/service-account-token', data: { token: 'c2VjcmV0IGRhdGE=' } },
      expected: [{ cells: ['secret1', 'kubernetes.io/service-account-token', 1, '0s'] }],
    },
    {
      name: 'Basic namespace with type and age; no data.',
      obj: { metadata: meta('secret1', at(1900)), type: 'kubernetes.io/service-account-token' },
      expected: [{ cells: ['secret1', 'kubernetes.io/service-account-token', 0, '0s'] }],
    },
  ]);
});

// upstream: pkg/printers/internalversion/printers_test.go TestPrintServiceAccount
describe('TestPrintServiceAccount', () => {
  run('', 'ServiceAccount', [
    {
      name: 'Basic service account without secrets',
      obj: { metadata: meta('sa1', at(1900)) },
      expected: [{ cells: ['sa1', '0s'] }],
    },
    {
      name: 'Basic service account with two secrets.',
      obj: { metadata: meta('sa1', at(1900)), secrets: [{ name: 'Secret1' }, { name: 'Secret2' }] },
      expected: [{ cells: ['sa1', '0s'] }],
    },
  ]);
});

// Node JSON: NodeSystemInfo's fields have no omitempty, so a stored Node carries them all.
const nodeInfo = (f: JsonObject = {}): JsonObject => ({
  machineID: '',
  systemUUID: '',
  bootID: '',
  kernelVersion: '',
  osImage: '',
  containerRuntimeVersion: '',
  kubeletVersion: '',
  kubeProxyVersion: '',
  operatingSystem: '',
  architecture: '',
  ...f,
});
const nodeCond = (type: string, status: string): JsonObject => ({ type, status, lastHeartbeatTime: null, lastTransitionTime: null });
function node(name: string, f: { labels?: JsonObject; unschedulable?: boolean; conditions?: JsonObject[]; addresses?: JsonObject[]; info?: JsonObject } = {}): JsonObject {
  const status: JsonObject = { daemonEndpoints: { kubeletEndpoint: { Port: 0 } }, nodeInfo: nodeInfo(f.info) };
  if (f.conditions !== undefined) status.conditions = f.conditions;
  if (f.addresses !== undefined) status.addresses = f.addresses;
  return {
    metadata: meta(name, null, f.labels === undefined ? {} : { labels: f.labels }),
    spec: f.unschedulable === true ? { unschedulable: true } : {},
    status,
  };
}
const external = (address: string): JsonObject => ({ type: 'ExternalIP', address });
const internal = (address: string): JsonObject => ({ type: 'InternalIP', address });

// upstream: pkg/printers/internalversion/printers_test.go TestPrintNodeStatus
describe('TestPrintNodeStatus', () => {
  run('', 'Node', [
    { name: 'foo1', obj: node('foo1', { conditions: [nodeCond('Ready', 'True')] }), expected: [{ cells: ['foo1', 'Ready', '<none>', '<unknown>', ''] }] },
    { name: 'foo2', obj: node('foo2', { unschedulable: true, conditions: [nodeCond('Ready', 'True')] }), expected: [{ cells: ['foo2', 'Ready,SchedulingDisabled', '<none>', '<unknown>', ''] }] },
    { name: 'foo3', obj: node('foo3', { conditions: [nodeCond('Ready', 'True'), nodeCond('Ready', 'True')] }), expected: [{ cells: ['foo3', 'Ready', '<none>', '<unknown>', ''] }] },
    { name: 'foo4', obj: node('foo4', { conditions: [nodeCond('Ready', 'False')] }), expected: [{ cells: ['foo4', 'NotReady', '<none>', '<unknown>', ''] }] },
    { name: 'foo5', obj: node('foo5', { unschedulable: true, conditions: [nodeCond('Ready', 'False')] }), expected: [{ cells: ['foo5', 'NotReady,SchedulingDisabled', '<none>', '<unknown>', ''] }] },
    { name: 'foo6', obj: node('foo6', { conditions: [nodeCond('InvalidValue', 'True')] }), expected: [{ cells: ['foo6', 'Unknown', '<none>', '<unknown>', ''] }] },
    { name: 'foo7', obj: node('foo7', { conditions: [nodeCond('', '')] }), expected: [{ cells: ['foo7', 'Unknown', '<none>', '<unknown>', ''] }] },
    { name: 'foo8', obj: node('foo8', { unschedulable: true, conditions: [nodeCond('InvalidValue', 'True')] }), expected: [{ cells: ['foo8', 'Unknown,SchedulingDisabled', '<none>', '<unknown>', ''] }] },
    { name: 'foo9', obj: node('foo9', { unschedulable: true, conditions: [nodeCond('', '')] }), expected: [{ cells: ['foo9', 'Unknown,SchedulingDisabled', '<none>', '<unknown>', ''] }] },
  ]);
});

// upstream: pkg/printers/internalversion/printers_test.go TestPrintNodeRole
describe('TestPrintNodeRole', () => {
  run('', 'Node', [
    { name: 'foo9', obj: node('foo9'), expected: [{ cells: ['foo9', 'Unknown', '<none>', '<unknown>', ''] }] },
    {
      name: 'foo10',
      obj: node('foo10', { labels: { 'node-role.kubernetes.io/master': '', 'node-role.kubernetes.io/control-plane': '', 'node-role.kubernetes.io/proxy': '', 'kubernetes.io/role': 'node' } }),
      expected: [{ cells: ['foo10', 'Unknown', 'control-plane,master,node,proxy', '<unknown>', ''] }],
    },
    { name: 'foo11', obj: node('foo11', { labels: { 'kubernetes.io/role': 'node' } }), expected: [{ cells: ['foo11', 'Unknown', 'node', '<unknown>', ''] }] },
  ]);
});

// upstream: pkg/printers/internalversion/printers_test.go TestPrintNodeOSImage
describe('TestPrintNodeOSImage', () => {
  run(
    '',
    'Node',
    [
      {
        name: 'foo1',
        obj: node('foo1', { info: { osImage: 'fake-os-image' }, addresses: [external('1.1.1.1')] }),
        expected: [{ cells: ['foo1', 'Unknown', '<none>', '<unknown>', '', '<none>', '1.1.1.1', 'fake-os-image', '<unknown>', '<unknown>'] }],
      },
      {
        name: 'foo2',
        obj: node('foo2', { info: { kernelVersion: 'fake-kernel-version' }, addresses: [external('1.1.1.1')] }),
        expected: [{ cells: ['foo2', 'Unknown', '<none>', '<unknown>', '', '<none>', '1.1.1.1', '<unknown>', 'fake-kernel-version', '<unknown>'] }],
      },
    ],
    true,
  );
});

// upstream: pkg/printers/internalversion/printers_test.go TestPrintNodeKernelVersion
describe('TestPrintNodeKernelVersion', () => {
  run(
    '',
    'Node',
    [
      {
        name: 'foo1',
        obj: node('foo1', { info: { kernelVersion: 'fake-kernel-version' }, addresses: [external('1.1.1.1')] }),
        expected: [{ cells: ['foo1', 'Unknown', '<none>', '<unknown>', '', '<none>', '1.1.1.1', '<unknown>', 'fake-kernel-version', '<unknown>'] }],
      },
      {
        name: 'foo2',
        obj: node('foo2', { info: { osImage: 'fake-os-image' }, addresses: [external('1.1.1.1')] }),
        expected: [{ cells: ['foo2', 'Unknown', '<none>', '<unknown>', '', '<none>', '1.1.1.1', 'fake-os-image', '<unknown>', '<unknown>'] }],
      },
    ],
    true,
  );
});

// upstream: pkg/printers/internalversion/printers_test.go TestPrintNodeArch
describe('TestPrintNodeArch', () => {
  run(
    '',
    'Node',
    [
      {
        name: 'case 1: KernelVersion with Arch',
        obj: node('foo', { info: { kernelVersion: 'fake-kernel-version', architecture: 'fake-arch-amd64' }, addresses: [external('1.1.1.1')] }),
        expected: [{ cells: ['foo', 'Unknown', '<none>', '<unknown>', '', '<none>', '1.1.1.1', '<unknown>', 'fake-kernel-version (fake-arch-amd64)', '<unknown>'] }],
      },
      {
        name: 'case 2: KernelVersion unknown with Arch',
        obj: node('foo', { info: { architecture: 'fake-arch-arm64' }, addresses: [external('1.1.1.1')] }),
        expected: [{ cells: ['foo', 'Unknown', '<none>', '<unknown>', '', '<none>', '1.1.1.1', '<unknown>', '<unknown> (fake-arch-arm64)', '<unknown>'] }],
      },
      {
        name: 'case 3: KernelVersion with Arch unknowngs',
        obj: node('foo', { info: { kernelVersion: 'fake-kernel-version' }, addresses: [external('1.1.1.1')] }),
        expected: [{ cells: ['foo', 'Unknown', '<none>', '<unknown>', '', '<none>', '1.1.1.1', '<unknown>', 'fake-kernel-version', '<unknown>'] }],
      },
    ],
    true,
  );
});

// upstream: pkg/printers/internalversion/printers_test.go TestPrintNodeContainerRuntimeVersion
describe('TestPrintNodeContainerRuntimeVersion', () => {
  run(
    '',
    'Node',
    [
      {
        name: 'foo1',
        obj: node('foo1', { info: { containerRuntimeVersion: 'foo://1.2.3' }, addresses: [external('1.1.1.1')] }),
        expected: [{ cells: ['foo1', 'Unknown', '<none>', '<unknown>', '', '<none>', '1.1.1.1', '<unknown>', '<unknown>', 'foo://1.2.3'] }],
      },
      {
        name: 'foo2',
        obj: node('foo2', { addresses: [external('1.1.1.1')] }),
        expected: [{ cells: ['foo2', 'Unknown', '<none>', '<unknown>', '', '<none>', '1.1.1.1', '<unknown>', '<unknown>', '<unknown>'] }],
      },
    ],
    true,
  );
});

// upstream: pkg/printers/internalversion/printers_test.go TestPrintNodeName
describe('TestPrintNodeName', () => {
  run('', 'Node', [
    { name: '127.0.0.1', obj: node('127.0.0.1'), expected: [{ cells: ['127.0.0.1', 'Unknown', '<none>', '<unknown>', ''] }] },
    { name: '(empty name)', obj: node(''), expected: [{ cells: ['', 'Unknown', '<none>', '<unknown>', ''] }] },
  ]);
});

// upstream: pkg/printers/internalversion/printers_test.go TestPrintNodeExternalIP
describe('TestPrintNodeExternalIP', () => {
  run(
    '',
    'Node',
    [
      { name: 'foo1', obj: node('foo1', { addresses: [external('1.1.1.1')] }), expected: [{ cells: ['foo1', 'Unknown', '<none>', '<unknown>', '', '<none>', '1.1.1.1', '<unknown>', '<unknown>', '<unknown>'] }] },
      { name: 'foo2', obj: node('foo2', { addresses: [internal('1.1.1.1')] }), expected: [{ cells: ['foo2', 'Unknown', '<none>', '<unknown>', '', '1.1.1.1', '<none>', '<unknown>', '<unknown>', '<unknown>'] }] },
      {
        name: 'foo3',
        obj: node('foo3', { addresses: [external('2.2.2.2'), internal('3.3.3.3'), external('4.4.4.4')] }),
        expected: [{ cells: ['foo3', 'Unknown', '<none>', '<unknown>', '', '3.3.3.3', '2.2.2.2', '<unknown>', '<unknown>', '<unknown>'] }],
      },
    ],
    true,
  );
});

// upstream: pkg/printers/internalversion/printers_test.go TestPrintNodeInternalIP
describe('TestPrintNodeInternalIP', () => {
  run(
    '',
    'Node',
    [
      { name: 'foo1', obj: node('foo1', { addresses: [internal('1.1.1.1')] }), expected: [{ cells: ['foo1', 'Unknown', '<none>', '<unknown>', '', '1.1.1.1', '<none>', '<unknown>', '<unknown>', '<unknown>'] }] },
      { name: 'foo2', obj: node('foo2', { addresses: [external('1.1.1.1')] }), expected: [{ cells: ['foo2', 'Unknown', '<none>', '<unknown>', '', '<none>', '1.1.1.1', '<unknown>', '<unknown>', '<unknown>'] }] },
      {
        name: 'foo3',
        obj: node('foo3', { addresses: [internal('2.2.2.2'), external('3.3.3.3'), internal('4.4.4.4')] }),
        expected: [{ cells: ['foo3', 'Unknown', '<none>', '<unknown>', '', '2.2.2.2', '3.3.3.3', '<unknown>', '<unknown>', '<unknown>'] }],
      },
    ],
    true,
  );
});

// Service JSON: ServicePort.targetPort is an IntOrString struct, serialized as 0 when unset.
const svcPort = (port: number, protocol: string, nodePort?: number): JsonObject => ({ protocol, port, targetPort: 0, ...(nodePort === undefined ? {} : { nodePort }) });
function service(name: string, spec: JsonObject, ingress?: JsonObject[]): JsonObject {
  return { metadata: meta(name), spec, status: { loadBalancer: ingress === undefined ? {} : { ingress } } };
}

// upstream: pkg/printers/internalversion/printers_test.go TestPrintServiceLoadBalancer
describe('TestPrintServiceLoadBalancer', () => {
  const ports3 = [svcPort(80, 'TCP'), svcPort(8090, 'UDP'), svcPort(8000, 'TCP')];
  const ingress3 = [{ ip: '2.3.4.5' }, { ip: '3.4.5.6' }, { ip: '5.6.7.8', hostname: 'host5678' }];
  run('', 'Service', [
    {
      name: "Test load balancer service with multiple external IP's",
      obj: service('service1', { clusterIPs: ['1.2.3.4'], type: 'LoadBalancer', ports: [svcPort(80, 'TCP')] }, [{ ip: '2.3.4.5' }, { ip: '3.4.5.6' }]),
      expected: [{ cells: ['service1', 'LoadBalancer', '1.2.3.4', '2.3.4.5,3.4.5.6', '80/TCP', '<unknown>'] }],
    },
    {
      name: 'Test load balancer service with pending external IP.',
      obj: service('service2', { clusterIPs: ['1.3.4.5'], type: 'LoadBalancer', ports: [svcPort(80, 'TCP'), svcPort(8090, 'UDP'), svcPort(8000, 'TCP'), svcPort(7777, 'SCTP')] }),
      expected: [{ cells: ['service2', 'LoadBalancer', '1.3.4.5', '<pending>', '80/TCP,8090/UDP,8000/TCP,7777/SCTP', '<unknown>'] }],
    },
    {
      name: 'Test load balancer service with multiple ports.',
      obj: service('service3', { clusterIPs: ['1.4.5.6'], type: 'LoadBalancer', ports: ports3 }, [{ ip: '2.3.4.5' }]),
      expected: [{ cells: ['service3', 'LoadBalancer', '1.4.5.6', '2.3.4.5', '80/TCP,8090/UDP,8000/TCP', '<unknown>'] }],
    },
    {
      name: "Long external IP's list gets elided.",
      obj: service('service4', { clusterIPs: ['1.5.6.7'], type: 'LoadBalancer', ports: ports3 }, ingress3),
      expected: [{ cells: ['service4', 'LoadBalancer', '1.5.6.7', '2.3.4.5,3.4.5...', '80/TCP,8090/UDP,8000/TCP', '<unknown>'] }],
    },
    {
      name: 'Generate options: Wide, includes selectors.',
      wide: true,
      obj: service('service4', { clusterIPs: ['1.5.6.7'], type: 'LoadBalancer', ports: ports3, selector: { foo: 'bar' } }, ingress3),
      expected: [{ cells: ['service4', 'LoadBalancer', '1.5.6.7', '2.3.4.5,3.4.5.6,5.6.7.8', '80/TCP,8090/UDP,8000/TCP', '<unknown>', 'foo=bar'] }],
    },
  ]);
});

// Pod JSON helpers. make([]api.Container, n) is n containers with empty names; ContainerStatus
// carries name, state, lastState, ready, restartCount, image and imageID even when zero.
const containers = (n: number): JsonObject[] => Array.from({ length: n }, () => ({ name: '', resources: {} }));
const cs = (f: JsonObject = {}): JsonObject => ({ name: '', state: {}, lastState: {}, ready: false, restartCount: 0, image: '', imageID: '', ...f });
const running = (startedAt: string | null = null): JsonObject => ({ running: { startedAt } });
const waiting = (reason?: string): JsonObject => ({ waiting: reason === undefined ? {} : { reason } });
const terminated = (f: JsonObject = {}): JsonObject => ({ terminated: { exitCode: 0, startedAt: null, finishedAt: null, ...f } });
/** LastTerminationState{Terminated: {FinishedAt: NOW + offset}}. */
const lastFinished = (offset: number): JsonObject => terminated({ finishedAt: at(offset) });
const podCond = (type: string, status: string, f: JsonObject = {}): JsonObject => ({ type, status, lastProbeTime: null, lastTransitionTime: null, ...f });
function pod(name: string, spec: JsonObject, status: JsonObject, extraMeta: JsonObject = {}): JsonObject {
  return { metadata: meta(name, null, extraMeta), spec, status };
}
const deleteTime = at(-10 * S);

// upstream: pkg/printers/internalversion/printers_test.go TestPrintPod
describe('TestPrintPod', () => {
  run('', 'Pod', [
    {
      name: 'Test name, num of containers, restarts, container ready status',
      obj: pod('test1', { containers: containers(2) }, { phase: 'podPhase', containerStatuses: [cs({ ready: true, restartCount: 3, state: running() }), cs({ restartCount: 3 })] }),
      expected: [{ cells: ['test1', '1/2', 'podPhase', '6', '<unknown>'] }],
    },
    {
      name: 'Test container error overwrites pod phase',
      obj: pod('test2', { containers: containers(2) }, { phase: 'podPhase', containerStatuses: [cs({ ready: true, restartCount: 3, state: running() }), cs({ state: waiting('ContainerWaitingReason'), restartCount: 3 })] }),
      expected: [{ cells: ['test2', '1/2', 'ContainerWaitingReason', '6', '<unknown>'] }],
    },
    {
      name: 'Test the same as the above but with Terminated state and the first container overwrites the rest',
      obj: pod(
        'test3',
        { containers: containers(2) },
        { phase: 'podPhase', containerStatuses: [cs({ state: waiting('ContainerWaitingReason'), restartCount: 3 }), cs({ state: terminated({ reason: 'ContainerTerminatedReason' }), restartCount: 3 })] },
      ),
      expected: [{ cells: ['test3', '0/2', 'ContainerWaitingReason', '6', '<unknown>'] }],
    },
    {
      name: 'Test ready is not enough for reporting running',
      obj: pod('test4', { containers: containers(2) }, { phase: 'podPhase', containerStatuses: [cs({ ready: true, restartCount: 3, state: running() }), cs({ ready: true, restartCount: 3 })] }),
      expected: [{ cells: ['test4', '1/2', 'podPhase', '6', '<unknown>'] }],
    },
    {
      name: 'Test ready is not enough for reporting running',
      obj: pod('test5', { containers: containers(2) }, { reason: 'podReason', phase: 'podPhase', containerStatuses: [cs({ ready: true, restartCount: 3, state: running() }), cs({ ready: true, restartCount: 3 })] }),
      expected: [{ cells: ['test5', '1/2', 'podReason', '6', '<unknown>'] }],
    },
    {
      name: 'Test pod has 2 containers, one is running and the other is completed, w/o ready condition',
      obj: pod(
        'test6',
        { containers: containers(2) },
        { phase: 'Running', containerStatuses: [cs({ ready: true, restartCount: 3, state: terminated({ reason: 'Completed', exitCode: 0 }) }), cs({ ready: true, restartCount: 3, state: running() })] },
      ),
      expected: [{ cells: ['test6', '1/2', 'NotReady', '6', '<unknown>'] }],
    },
    {
      name: 'Test pod has 2 containers, one is running and the other is completed, with ready condition',
      obj: pod(
        'test6',
        { containers: containers(2) },
        {
          phase: 'Running',
          containerStatuses: [cs({ ready: true, restartCount: 3, state: terminated({ reason: 'Completed', exitCode: 0 }) }), cs({ ready: true, restartCount: 3, state: running() })],
          conditions: [podCond('Ready', 'True', { lastProbeTime: at(0) })],
        },
      ),
      expected: [{ cells: ['test6', '1/2', 'Running', '6', '<unknown>'] }],
    },
    {
      name: 'Test pod has 1 init container restarting and 1 container not running',
      obj: pod(
        'test7',
        { initContainers: containers(1), containers: containers(1) },
        {
          phase: 'podPhase',
          initContainerStatuses: [cs({ ready: false, restartCount: 3, state: running(), lastState: lastFinished(-10 * S) })],
          containerStatuses: [cs({ ready: false, restartCount: 0, state: waiting() })],
        },
      ),
      expected: [{ cells: ['test7', '0/1', 'Init:0/1', '3 (10s ago)', '<unknown>'] }],
    },
    {
      name: 'Test pod has 2 init containers, one restarting and the other not running, and 1 container not running',
      obj: pod(
        'test8',
        { initContainers: containers(2), containers: containers(1) },
        {
          phase: 'podPhase',
          initContainerStatuses: [cs({ ready: false, restartCount: 3, state: running(), lastState: lastFinished(-10 * S) }), cs({ ready: false, state: waiting() })],
          containerStatuses: [cs({ ready: false, state: waiting() })],
        },
      ),
      expected: [{ cells: ['test8', '0/1', 'Init:0/2', '3 (10s ago)', '<unknown>'] }],
    },
    {
      name: 'Test pod has 2 init containers, one completed without restarts and the other restarting, and 1 container not running',
      obj: pod(
        'test9',
        { initContainers: containers(2), containers: containers(1) },
        {
          phase: 'podPhase',
          initContainerStatuses: [cs({ ready: false, state: terminated() }), cs({ ready: false, restartCount: 3, state: running(), lastState: lastFinished(-10 * S) })],
          containerStatuses: [cs({ ready: false, state: waiting() })],
        },
      ),
      expected: [{ cells: ['test9', '0/1', 'Init:1/2', '3 (10s ago)', '<unknown>'] }],
    },
    {
      name: 'Test pod has 2 init containers, one completed with restarts and the other restarting, and 1 container not running',
      obj: pod(
        'test10',
        { initContainers: containers(2), containers: containers(1) },
        {
          phase: 'podPhase',
          initContainerStatuses: [
            cs({ ready: false, restartCount: 2, state: terminated(), lastState: lastFinished(-2 * MIN) }),
            cs({ ready: false, restartCount: 3, state: running(), lastState: lastFinished(-10 * S) }),
          ],
          containerStatuses: [cs({ ready: false, state: waiting() })],
        },
      ),
      expected: [{ cells: ['test10', '0/1', 'Init:1/2', '5 (10s ago)', '<unknown>'] }],
    },
    {
      name: 'Test pod has 1 init container completed with restarts and one container restarting',
      obj: pod(
        'test11',
        { initContainers: containers(1), containers: containers(1) },
        {
          phase: 'Running',
          initContainerStatuses: [cs({ ready: false, restartCount: 2, state: terminated(), lastState: lastFinished(-2 * MIN) })],
          containerStatuses: [cs({ ready: false, restartCount: 4, state: running(), lastState: lastFinished(-20 * S) })],
        },
      ),
      expected: [{ cells: ['test11', '0/1', 'Running', '4 (20s ago)', '<unknown>'] }],
    },
    {
      name: 'Test pod has 1 container that restarted 5d ago',
      obj: pod('test12', { containers: containers(1) }, { phase: 'Running', containerStatuses: [cs({ ready: true, restartCount: 3, state: running(), lastState: lastFinished(-5 * D) })] }),
      expected: [{ cells: ['test12', '1/1', 'Running', '3 (5d ago)', '<unknown>'] }],
    },
    {
      name: 'Test pod has 2 containers, one has never restarted and the other has restarted 10d ago',
      obj: pod(
        'test13',
        { containers: containers(2) },
        { phase: 'Running', containerStatuses: [cs({ ready: true, restartCount: 0, state: running() }), cs({ ready: true, restartCount: 3, state: running(), lastState: lastFinished(-10 * D) })] },
      ),
      expected: [{ cells: ['test13', '2/2', 'Running', '3 (10d ago)', '<unknown>'] }],
    },
    {
      name: 'Test pod has 2 containers, one restarted 5d ago and the other restarted 20d ago',
      obj: pod(
        'test14',
        { containers: containers(2) },
        {
          phase: 'Running',
          containerStatuses: [cs({ ready: true, restartCount: 6, state: running(), lastState: lastFinished(-5 * D) }), cs({ ready: true, restartCount: 3, state: running(), lastState: lastFinished(-20 * D) })],
        },
      ),
      expected: [{ cells: ['test14', '2/2', 'Running', '9 (5d ago)', '<unknown>'] }],
    },
    {
      name: 'Test PodScheduled condition with reason SchedulingGated',
      obj: pod('test15', { containers: containers(2) }, { phase: 'podPhase', conditions: [podCond('PodScheduled', 'False', { reason: 'SchedulingGated' })] }),
      expected: [{ cells: ['test15', '0/2', 'SchedulingGated', '0', '<unknown>'] }],
    },
    {
      name: 'Test pod condition succeed',
      obj: pod('test16', { containers: containers(1) }, { phase: 'Succeeded', containerStatuses: [cs({ ready: false, state: terminated({ reason: 'Completed', exitCode: 0 }) })] }),
      expected: [{ conditions: podSuccessConditions, cells: ['test16', '0/1', 'Completed', '0', '<unknown>'] }],
    },
    {
      name: 'Test pod condition failed',
      obj: pod('test17', { containers: containers(1) }, { phase: 'Failed', containerStatuses: [cs({ ready: false, state: terminated({ reason: 'Error', exitCode: 1 }) })] }),
      expected: [{ conditions: podFailedConditions, cells: ['test17', '0/1', 'Error', '0', '<unknown>'] }],
    },
    {
      name: 'Test pod condition succeed with deletion',
      obj: pod('test18', { containers: containers(1) }, { phase: 'Succeeded', containerStatuses: [cs({ ready: false, state: terminated({ reason: 'Completed', exitCode: 0 }) })] }, { deletionTimestamp: deleteTime }),
      expected: [{ conditions: podSuccessConditions, cells: ['test18', '0/1', 'Completed', '0', '<unknown>'] }],
    },
    {
      name: 'Test pod condition running with deletion',
      obj: pod('test19', { containers: containers(1) }, { phase: 'Running', containerStatuses: [cs({ ready: false, state: running() })] }, { deletionTimestamp: deleteTime }),
      expected: [{ cells: ['test19', '0/1', 'Terminating', '0', '<unknown>'] }],
    },
    {
      name: 'Test pod condition pending with deletion',
      obj: pod('test20', { containers: containers(1) }, { phase: 'Pending' }, { deletionTimestamp: deleteTime }),
      expected: [{ cells: ['test20', '0/1', 'Terminating', '0', '<unknown>'] }],
    },
    {
      name: 'Test the two containers. They are ready and State are Error/Running',
      obj: pod(
        'test21',
        { containers: containers(2) },
        {
          phase: 'Failed',
          containerStatuses: [cs({ ready: false, state: terminated({ finishedAt: at(0), exitCode: 1, reason: 'podCrash' }) }), cs({ ready: true, state: running(at(0)) })],
        },
      ),
      expected: [{ cells: ['test21', '1/2', 'podCrash', '0', '<unknown>'], conditions: podFailedConditions }],
    },
    {
      name: 'Test the two containers. They are ready and State are Running/Error',
      obj: pod(
        'test22',
        { containers: containers(2) },
        {
          phase: 'Failed',
          containerStatuses: [cs({ ready: true, state: running(at(0)) }), cs({ ready: false, state: terminated({ finishedAt: at(0), exitCode: 1, reason: 'podCrash' }) })],
        },
      ),
      expected: [{ cells: ['test22', '1/2', 'podCrash', '0', '<unknown>'], conditions: podFailedConditions }],
    },
    {
      name: 'Test the three containers. They are ready and State are Running/Error/Completed',
      obj: pod(
        'test23',
        { containers: containers(3) },
        {
          phase: 'Failed',
          containerStatuses: [
            cs({ ready: true, state: running(at(0)) }),
            cs({ ready: true, state: terminated({ finishedAt: at(0), exitCode: 1, reason: 'podCrash' }) }),
            cs({ ready: true, state: terminated({ finishedAt: at(0), exitCode: 0 }) }),
          ],
        },
      ),
      expected: [{ cells: ['test23', '1/3', 'podCrash', '0', '<unknown>'], conditions: podFailedConditions }],
    },
    {
      name: 'Test the three containers. They are notReady and State are Running/Error/Completed',
      obj: pod(
        'test24',
        { containers: containers(3) },
        {
          phase: 'Failed',
          containerStatuses: [
            cs({ ready: false, state: running(at(0)) }),
            cs({ ready: false, state: terminated({ finishedAt: at(0), exitCode: 1, reason: 'podCrash' }) }),
            cs({ ready: false, state: terminated({ finishedAt: at(0), exitCode: 0 }) }),
          ],
        },
      ),
      expected: [{ cells: ['test24', '0/3', 'podCrash', '0', '<unknown>'], conditions: podFailedConditions }],
    },
  ]);
});

// upstream: pkg/printers/internalversion/printers_test.go TestPrintPodWithRestartableInitContainer
describe('TestPrintPodWithRestartableInitContainer', () => {
  const sidecars = [
    { name: 'restartable-init-1', resources: {}, restartPolicy: 'Always' },
    { name: 'restartable-init-2', resources: {}, restartPolicy: 'Always' },
  ];
  run('', 'Pod', [
    {
      name: 'Test pod has 2 restartable init containers, the first one running but not started.',
      obj: pod(
        'test1',
        { initContainers: sidecars, containers: containers(1) },
        {
          phase: 'Pending',
          initContainerStatuses: [
            cs({ name: 'restartable-init-1', ready: false, restartCount: 3, state: running(), started: false, lastState: lastFinished(-10 * S) }),
            cs({ name: 'restartable-init-2', ready: false, state: waiting(), started: false }),
          ],
          containerStatuses: [cs({ ready: false, restartCount: 0, state: waiting() })],
          conditions: [podCond('Initialized', 'False')],
        },
      ),
      expected: [{ cells: ['test1', '0/3', 'Init:0/2', '3 (10s ago)', '<unknown>'] }],
    },
    {
      name: 'Test pod has 2 restartable init containers, the first one started and the second one running but not started.',
      obj: pod(
        'test1',
        { initContainers: sidecars, containers: containers(1) },
        {
          phase: 'Pending',
          initContainerStatuses: [
            cs({ name: 'restartable-init-1', ready: false, restartCount: 3, state: running(), started: true, lastState: lastFinished(-10 * S) }),
            cs({ name: 'restartable-init-2', ready: false, state: running(), started: false }),
          ],
          containerStatuses: [cs({ ready: false, restartCount: 0, state: waiting() })],
          conditions: [podCond('Initialized', 'False')],
        },
      ),
      expected: [{ cells: ['test1', '0/3', 'Init:1/2', '3 (10s ago)', '<unknown>'] }],
    },
    {
      name: 'Test pod has 2 restartable init containers started and 1 container running',
      obj: pod(
        'test2',
        { initContainers: sidecars, containers: containers(1) },
        {
          phase: 'Running',
          initContainerStatuses: [
            cs({ name: 'restartable-init-1', ready: false, restartCount: 3, state: running(), started: true, lastState: lastFinished(-10 * S) }),
            cs({ name: 'restartable-init-2', ready: false, state: running(), started: true }),
          ],
          containerStatuses: [cs({ ready: true, restartCount: 4, state: running(), lastState: lastFinished(-20 * S) })],
          conditions: [podCond('Initialized', 'True')],
        },
      ),
      expected: [{ cells: ['test2', '1/3', 'Running', '7 (10s ago)', '<unknown>'] }],
    },
    {
      name: 'Test pod has 2 restartable init containers completed with non-zero and 1 container completed',
      obj: pod(
        'test3',
        { initContainers: sidecars, containers: containers(1) },
        {
          phase: 'Succeeded',
          initContainerStatuses: [
            cs({ name: 'restartable-init-1', ready: false, restartCount: 3, state: terminated({ reason: 'Error', exitCode: 137 }), started: false, lastState: lastFinished(-10 * S) }),
            cs({ name: 'restartable-init-2', ready: false, state: terminated({ reason: 'Error', exitCode: 137 }), started: false }),
          ],
          containerStatuses: [cs({ ready: false, restartCount: 4, state: terminated({ reason: 'Completed', exitCode: 0 }), lastState: lastFinished(-20 * S) })],
          conditions: [podCond('Initialized', 'True')],
        },
      ),
      expected: [
        {
          cells: ['test3', '0/3', 'Completed', '7 (10s ago)', '<unknown>'],
          conditions: [{ type: 'Completed', status: 'True', reason: 'Succeeded', message: 'The pod has completed successfully.' }],
        },
      ],
    },
    {
      name: 'Test pod has container statuses for non-existent initContainers and containers',
      obj: pod(
        'test4',
        {
          initContainers: [
            { name: 'init1', image: 'initimage', resources: {} },
            { name: 'sidecar1', image: 'sidecarimage', resources: {}, restartPolicy: 'Always' },
          ],
          containers: [{ name: 'container1', image: 'containerimage', resources: {} }],
        },
        {
          phase: 'Running',
          initContainerStatuses: [cs({ name: 'initinvalid' }), cs({ name: 'init1' }), cs({ name: 'sidecar1' })],
          containerStatuses: [cs({ name: 'containerinvalid' }), cs({ name: 'container1' })],
        },
      ),
      expected: [{ cells: ['test4', '0/2', 'Init:0/2', '0', '<unknown>'] }],
    },
  ]);
});

// upstream: pkg/printers/internalversion/printers_test.go TestPrintPodwide
describe('TestPrintPodwide', () => {
  const gated = (podIPs: JsonObject[]): JsonObject =>
    pod(
      'test1',
      { containers: containers(2), nodeName: 'test1', readinessGates: [{ conditionType: 'condition1' }, { conditionType: 'condition2' }, { conditionType: 'condition3' }] },
      {
        conditions: [podCond('condition1', 'False'), podCond('condition2', 'True')],
        phase: 'podPhase',
        podIPs,
        containerStatuses: [cs({ ready: true, restartCount: 3, state: running() }), cs({ restartCount: 3 })],
        nominatedNodeName: 'node1',
      },
    );
  run(
    '',
    'Pod',
    [
      {
        name: 'Test when the NodeName and PodIP are not none',
        obj: gated([{ ip: '1.1.1.1' }]),
        expected: [{ cells: ['test1', '1/2', 'podPhase', '6', '<unknown>', '1.1.1.1', 'test1', 'node1', '1/3'] }],
      },
      {
        name: 'Test when the NodeName and PodIP are not none',
        obj: gated([{ ip: '1.1.1.1' }, { ip: '2001:db8::' }]),
        expected: [{ cells: ['test1', '1/2', 'podPhase', '6', '<unknown>', '1.1.1.1', 'test1', 'node1', '1/3'] }],
      },
      {
        name: 'Test when the NodeName and PodIP are none',
        obj: pod('test2', { containers: containers(2), nodeName: '' }, { phase: 'podPhase', containerStatuses: [cs({ ready: true, restartCount: 3, state: running() }), cs({ state: waiting('ContainerWaitingReason'), restartCount: 3 })] }),
        expected: [{ cells: ['test2', '1/2', 'ContainerWaitingReason', '6', '<unknown>', '<none>', '<none>', '<none>', '<none>'] }],
      },
    ],
    true,
  );
});

// upstream: pkg/printers/internalversion/printers_test.go TestPrintPodConditions
describe('TestPrintPodConditions', () => {
  const statuses = (): JsonObject[] => [cs({ ready: true, restartCount: 3, state: running() }), cs({ restartCount: 3 })];
  const runningPod = pod('test1', { containers: containers(2) }, { phase: 'Running', containerStatuses: statuses() }, { labels: { a: '1', b: '2' } });
  const succeededPod = pod('test1', { containers: containers(2) }, { phase: 'Succeeded', containerStatuses: statuses() }, { labels: { a: '1', b: '2' } });
  const failedPod = pod('test2', { containers: containers(2) }, { phase: 'Failed', containerStatuses: statuses() }, { labels: { b: '2' } });
  run('', 'Pod', [
    { name: 'Should not have TableRowCondition', obj: runningPod, expected: [{ cells: ['test1', '1/2', 'Running', '6', '<unknown>'] }] },
    { name: 'Should have TableRowCondition: podSuccessConditions', obj: succeededPod, expected: [{ cells: ['test1', '1/2', 'Succeeded', '6', '<unknown>'], conditions: podSuccessConditions }] },
    { name: 'Should have TableRowCondition: podFailedCondition', obj: failedPod, expected: [{ cells: ['test2', '1/2', 'Failed', '6', '<unknown>'], conditions: podFailedConditions }] },
  ]);
});

// upstream: pkg/printers/internalversion/printers_test.go TestPrintPodList
describe('TestPrintPodList', () => {
  // printPodList prints each item with printPod and concatenates the rows.
  test("0: Test podList's pod: name, num of containers, restarts, container ready status", () => {
    const items = [
      pod('test1', { containers: containers(2) }, { phase: 'podPhase', containerStatuses: [cs({ ready: true, restartCount: 3, state: running() }), cs({ ready: true, restartCount: 3, state: running() })] }),
      pod('test2', { containers: containers(1) }, { phase: 'podPhase', containerStatuses: [cs({ ready: true, restartCount: 1, state: running() })] }),
    ];
    expect(items.flatMap((p) => print('', 'Pod', p))).toEqual([{ cells: ['test1', '2/2', 'podPhase', '6', '<unknown>'] }, { cells: ['test2', '1/1', 'podPhase', '1', '<unknown>'] }]);
  });
});

// upstream: pkg/printers/internalversion/printers_test.go TestPrintNonTerminatedPod
describe('TestPrintNonTerminatedPod', () => {
  const statuses = (): JsonObject[] => [cs({ ready: true, restartCount: 3, state: running() }), cs({ restartCount: 3 })];
  run('', 'Pod', [
    { name: 'Test pod phase Running should be printed', obj: pod('test1', { containers: containers(2) }, { phase: 'Running', containerStatuses: statuses() }), expected: [{ cells: ['test1', '1/2', 'Running', '6', '<unknown>'] }] },
    { name: 'Test pod phase Pending should be printed', obj: pod('test2', { containers: containers(2) }, { phase: 'Pending', containerStatuses: statuses() }), expected: [{ cells: ['test2', '1/2', 'Pending', '6', '<unknown>'] }] },
    { name: 'Test pod phase Unknown should be printed', obj: pod('test3', { containers: containers(2) }, { phase: 'Unknown', containerStatuses: statuses() }), expected: [{ cells: ['test3', '1/2', 'Unknown', '6', '<unknown>'] }] },
    {
      name: 'Test pod phase Succeeded should be printed',
      obj: pod('test4', { containers: containers(2) }, { phase: 'Succeeded', containerStatuses: statuses() }),
      expected: [{ cells: ['test4', '1/2', 'Succeeded', '6', '<unknown>'], conditions: podSuccessConditions }],
    },
    {
      name: "Test pod phase Failed shouldn't be printed",
      obj: pod('test5', { containers: containers(2) }, { phase: 'Failed', containerStatuses: [cs({ ready: true, restartCount: 3, state: running() }), cs({ ready: true, restartCount: 3 })] }),
      expected: [{ cells: ['test5', '1/2', 'Failed', '6', '<unknown>'], conditions: podFailedConditions }],
    },
  ]);
});

const fakeTemplate = (): JsonObject => ({
  metadata: { creationTimestamp: null },
  spec: {
    containers: [
      { name: 'fake-container1', image: 'fake-image1', resources: {} },
      { name: 'fake-container2', image: 'fake-image2', resources: {} },
    ],
  },
});

// upstream: pkg/printers/internalversion/printers_test.go TestPrintDeployment
describe('TestPrintDeployment', () => {
  const testDeployment: JsonObject = {
    metadata: meta('test1', at(1900)),
    spec: { replicas: 5, template: fakeTemplate(), selector: { matchLabels: { foo: 'bar' } }, strategy: {} },
    status: { replicas: 10, updatedReplicas: 2, availableReplicas: 1, unavailableReplicas: 4 },
  };
  run('apps', 'Deployment', [
    { name: 'Test Deployment with no generate options.', obj: testDeployment, expected: [{ cells: ['test1', '0/5', 2, 1, '0s'] }] },
    { name: 'Test generate options: Wide.', wide: true, obj: testDeployment, expected: [{ cells: ['test1', '0/5', 2, 1, '0s', 'fake-container1,fake-container2', 'fake-image1,fake-image2', 'foo=bar'] }] },
  ]);
});

// upstream: pkg/printers/internalversion/printers_test.go TestPrintDaemonSet
describe('TestPrintDaemonSet', () => {
  const testDaemonSet: JsonObject = {
    metadata: meta('test1', at(1900)),
    spec: { template: fakeTemplate(), selector: { matchLabels: { foo: 'bar' } }, updateStrategy: {} },
    // NumberAvailable 0 is omitted (omitempty).
    status: { currentNumberScheduled: 2, desiredNumberScheduled: 3, numberReady: 1, updatedNumberScheduled: 2, numberMisscheduled: 0 },
  };
  run('apps', 'DaemonSet', [
    { name: 'Test generate daemon set with no generate options.', obj: testDaemonSet, expected: [{ cells: ['test1', 3, 2, 1, 2, 0, '<none>', '0s'] }] },
    {
      name: 'Test generate daemon set with "Wide" generate options.',
      wide: true,
      obj: testDaemonSet,
      expected: [{ cells: ['test1', 3, 2, 1, 2, 0, '<none>', '0s', 'fake-container1,fake-container2', 'fake-image1,fake-image2', 'foo=bar'] }],
    },
  ]);
});

// upstream: pkg/printers/internalversion/printers_test.go TestPrintService
describe('TestPrintService', () => {
  const singleExternalIP = ['80.11.12.10'];
  const mulExternalIP = ['80.11.12.10', '80.11.12.11'];
  run('', 'Service', [
    {
      name: 'Test name, cluster ip, port with protocol',
      // The selector does NOT get printed.
      obj: service('test1', { type: 'ClusterIP', ports: [svcPort(2233, 'tcp')], clusterIPs: ['10.9.8.7'], selector: { foo: 'bar' } }),
      expected: [{ cells: ['test1', 'ClusterIP', '10.9.8.7', '<none>', '2233/tcp', '<unknown>'] }],
    },
    {
      name: 'Test generate options: Wide includes selectors.',
      wide: true,
      obj: service('test1', { type: 'ClusterIP', ports: [svcPort(2233, 'tcp')], clusterIPs: ['10.9.8.7'], selector: { foo: 'bar' } }),
      expected: [{ cells: ['test1', 'ClusterIP', '10.9.8.7', '<none>', '2233/tcp', '<unknown>', 'foo=bar'] }],
    },
    {
      name: 'Test NodePort service',
      obj: service('test2', { type: 'NodePort', ports: [svcPort(8888, 'tcp', 9999)], clusterIPs: ['10.9.8.7'] }),
      expected: [{ cells: ['test2', 'NodePort', '10.9.8.7', '<none>', '8888:9999/tcp', '<unknown>'] }],
    },
    {
      name: 'Test LoadBalancer service',
      obj: service('test3', { type: 'LoadBalancer', ports: [svcPort(8888, 'tcp')], clusterIPs: ['10.9.8.7'] }),
      expected: [{ cells: ['test3', 'LoadBalancer', '10.9.8.7', '<pending>', '8888/tcp', '<unknown>'] }],
    },
    {
      name: 'Test LoadBalancer service with single ExternalIP and no LoadBalancerStatus',
      obj: service('test4', { type: 'LoadBalancer', ports: [svcPort(8888, 'tcp')], clusterIPs: ['10.9.8.7'], externalIPs: singleExternalIP }),
      expected: [{ cells: ['test4', 'LoadBalancer', '10.9.8.7', '80.11.12.10', '8888/tcp', '<unknown>'] }],
    },
    {
      name: 'Test LoadBalancer service with single ExternalIP',
      obj: service('test5', { type: 'LoadBalancer', ports: [svcPort(8888, 'tcp')], clusterIPs: ['10.9.8.7'], externalIPs: singleExternalIP }, [{ ip: '3.4.5.6', hostname: 'test.cluster.com' }]),
      expected: [{ cells: ['test5', 'LoadBalancer', '10.9.8.7', '3.4.5.6,80.11.12.10', '8888/tcp', '<unknown>'] }],
    },
    {
      name: 'Test LoadBalancer service with mul ExternalIPs',
      obj: service('test6', { type: 'LoadBalancer', ports: [svcPort(8888, 'tcp')], clusterIPs: ['10.9.8.7'], externalIPs: mulExternalIP }, [
        { ip: '2.3.4.5', hostname: 'test.cluster.local' },
        { ip: '3.4.5.6', hostname: 'test.cluster.com' },
      ]),
      expected: [{ cells: ['test6', 'LoadBalancer', '10.9.8.7', '2.3.4.5,3.4.5.6,80.11.12.10,80.11.12.11', '8888/tcp', '<unknown>'] }],
    },
    {
      name: 'Test ExternalName service',
      obj: service('test7', { type: 'ExternalName', externalName: 'my.database.example.com' }),
      expected: [{ cells: ['test7', 'ExternalName', '<none>', 'my.database.example.com', '<none>', '<unknown>'] }],
    },
  ]);
});

// upstream: pkg/printers/internalversion/printers_test.go TestPrintConfigMap
describe('TestPrintConfigMap', () => {
  run('', 'ConfigMap', [
    { name: 'Basic config map with no data.', obj: { metadata: meta('configmap1', at(1900)) }, expected: [{ cells: ['configmap1', 0, '0s'] }] },
    { name: 'Basic config map with one data entry', obj: { metadata: meta('configmap2', at(1900)), data: { foo: 'bar' } }, expected: [{ cells: ['configmap2', 1, '0s'] }] },
    {
      name: 'Basic config map with one data and one binary data entry.',
      // "binary data" in base64.
      obj: { metadata: meta('configmap3', at(1900)), data: { foo: 'bar' }, binaryData: { bin: 'YmluYXJ5IGRhdGE=' } },
      expected: [{ cells: ['configmap3', 2, '0s'] }],
    },
  ]);
});

// upstream: pkg/printers/internalversion/printers_test.go TestPrintReplicaSet
describe('TestPrintReplicaSet', () => {
  const rs = (): JsonObject => ({
    metadata: meta('test1', at(1900)),
    spec: { replicas: 5, template: fakeTemplate(), selector: { matchLabels: { foo: 'bar' } } },
    status: { replicas: 5, readyReplicas: 2 },
  });
  run('apps', 'ReplicaSet', [
    { name: 'Generate options empty', obj: rs(), expected: [{ cells: ['test1', 5, 5, 2, '0s'] }] },
    { name: 'Generate options "Wide"', wide: true, obj: rs(), expected: [{ cells: ['test1', 5, 5, 2, '0s', 'fake-container1,fake-container2', 'fake-image1,fake-image2', 'foo=bar'] }] },
  ]);
});

// upstream: pkg/printers/internalversion/printers_test.go TestPrintLease
describe('TestPrintLease', () => {
  run('coordination.k8s.io', 'Lease', [
    // Upstream's cases have no comments; named by the lease.
    { name: 'lease1', obj: { metadata: meta('lease1', at(1900)), spec: { holderIdentity: 'holder1' } }, expected: [{ cells: ['lease1', 'holder1', '0s'] }] },
    { name: 'lease2', obj: { metadata: meta('lease2', at(-300 * S)), spec: { holderIdentity: 'holder2' } }, expected: [{ cells: ['lease2', 'holder2', '5m'] }] },
  ]);
});

// upstream: pkg/printers/internalversion/printers_test.go TestPrintEndpoint
describe('TestPrintEndpoint', () => {
  run('', 'Endpoints', [
    { name: "Basic endpoint with no IP's", obj: { metadata: meta('endpoint1', at(1900)) }, expected: [{ cells: ['endpoint1', '<none>', '0s'] }] },
    {
      name: 'Endpoint with no ports',
      obj: { metadata: meta('endpoint3', at(-300 * S)), subsets: [{ addresses: [{ ip: '1.2.3.4' }, { ip: '5.6.7.8' }] }] },
      expected: [{ cells: ['endpoint3', '1.2.3.4,5.6.7.8', '5m'] }],
    },
    {
      name: "Basic endpoint with two IP's and one port",
      obj: { metadata: meta('endpoint2', at(1900)), subsets: [{ addresses: [{ ip: '1.2.3.4' }, { ip: '5.6.7.8' }], ports: [{ port: 8001, protocol: 'tcp' }] }] },
      expected: [{ cells: ['endpoint2', '1.2.3.4:8001,5.6.7.8:8001', '0s'] }],
    },
    {
      name: 'Basic endpoint with greater than three IP\'s triggering "more" string',
      obj: {
        metadata: meta('endpoint2', at(1900)),
        subsets: [{ addresses: [{ ip: '1.2.3.4' }, { ip: '5.6.7.8' }, { ip: '9.8.7.6' }, { ip: '6.6.6.6' }], ports: [{ port: 8001, protocol: 'tcp' }] }],
      },
      expected: [{ cells: ['endpoint2', '1.2.3.4:8001,5.6.7.8:8001,9.8.7.6:8001 + 1 more...', '0s'] }],
    },
  ]);
});

// upstream: pkg/printers/internalversion/printers_test.go TestPrintEndpointSlice
describe('TestPrintEndpointSlice', () => {
  const ep = (addresses: string[]): JsonObject => ({ addresses, conditions: {} });
  const port = (name: string, p: number): JsonObject => ({ name, port: p, protocol: 'TCP' });
  run('discovery.k8s.io', 'EndpointSlice', [
    // Upstream's cases have no comments; named by the slice.
    {
      name: 'abcslice.123',
      obj: { metadata: meta('abcslice.123', at(1900)), addressType: 'IPv4', ports: [port('http', 80)], endpoints: [ep(['10.1.2.3', '2001:db8::1234:5678'])] },
      expected: [{ cells: ['abcslice.123', 'IPv4', '80', '10.1.2.3,2001:db8::1234:5678', '0s'] }],
    },
    {
      name: 'longerslicename.123',
      obj: {
        metadata: meta('longerslicename.123', at(-300 * S)),
        addressType: 'IPv6',
        ports: [port('http', 80), port('https', 443)],
        endpoints: [ep(['10.1.2.3', '2001:db8::1234:5678']), ep(['10.2.3.4', '2001:db8::2345:6789'])],
      },
      expected: [{ cells: ['longerslicename.123', 'IPv6', '80,443', '10.1.2.3,2001:db8::1234:5678,10.2.3.4 + 1 more...', '5m'] }],
    },
    {
      name: 'multiportslice.123',
      obj: {
        metadata: meta('multiportslice.123', at(-300 * S)),
        addressType: 'IPv4',
        ports: [port('http', 80), port('https', 443), port('extra1', 3000), port('extra2', 3001)],
        endpoints: [ep(['10.1.2.3', '2001:db8::1234:5678']), ep(['10.2.3.4', '2001:db8::2345:6789'])],
      },
      expected: [{ cells: ['multiportslice.123', 'IPv4', '80,443,3000 + 1 more...', '10.1.2.3,2001:db8::1234:5678,10.2.3.4 + 1 more...', '5m'] }],
    },
  ]);
});

// upstream: pkg/printers/internalversion/printers_test.go TestPrintScale
describe('TestPrintScale', () => {
  run('autoscaling', 'Scale', [
    {
      name: 'test-autoscaling',
      obj: { metadata: meta('test-autoscaling', at(1900)), spec: { replicas: 2 }, status: { replicas: 1 } },
      expected: [{ cells: ['test-autoscaling', 2, 1, '0s'] }],
    },
  ]);
});

// upstream: pkg/printers/internalversion/printers_test.go TestPrintIPAddress
describe('TestPrintIPAddress', () => {
  run('networking.k8s.io', 'IPAddress', [
    {
      name: '192.168.2.2',
      obj: { metadata: meta('192.168.2.2', at(-10 * 365 * D)), spec: { parentRef: { group: 'mygroup', resource: 'myresource', namespace: 'mynamespace', name: 'myname' } } },
      // Columns: Name, ParentRef, Age
      expected: [{ cells: ['192.168.2.2', 'myresource.mygroup/mynamespace/myname', '10y'] }],
    },
  ]);
});

// upstream: pkg/printers/internalversion/printers_test.go TestPrintServiceCIDR
describe('TestPrintServiceCIDR', () => {
  const ipv4CIDR = '10.1.0.0/16';
  const ipv6CIDR = 'fd00:1:1::/64';
  run('networking.k8s.io', 'ServiceCIDR', [
    { name: 'Test name, IPv4 only.', obj: { metadata: meta('test1'), spec: { cidrs: [ipv4CIDR] }, status: {} }, expected: [{ cells: ['test1', ipv4CIDR, '<unknown>'] }] },
    { name: 'Test name, IPv6 only.', obj: { metadata: meta('test5'), spec: { cidrs: [ipv6CIDR] }, status: {} }, expected: [{ cells: ['test5', ipv6CIDR, '<unknown>'] }] },
    { name: 'Test name, DualStack.', obj: { metadata: meta('test9'), spec: { cidrs: [ipv4CIDR, ipv6CIDR] }, status: {} }, expected: [{ cells: ['test9', `${ipv4CIDR},${ipv6CIDR}`, '<unknown>'] }] },
  ]);
});

// Durations in microseconds (the port's unit); Go's are nanoseconds. Each case is named by the Go
// expression of its duration (upstream names its subtests by time.Duration.String()).
const US_MS = 1000;
const US_S = 1000 * US_MS;
const US_MIN = 60 * US_S;
const US_H = 60 * US_MIN;
const US_D = 24 * US_H;
const US_Y = 365 * US_D;

function runDurations(f: (us: number) => string, cases: [string, number, string][]): void {
  for (const [name, us, want] of cases) {
    test(name, () => {
      expect(f(us)).toBe(want);
    });
  }
}

// upstream: staging/src/k8s.io/apimachinery/pkg/util/duration/duration_test.go TestHumanDuration
describe('TestHumanDuration', () => {
  runDurations(humanDuration, [
    ['time.Second', US_S, '1s'],
    ['70 * time.Second', 70 * US_S, '70s'],
    ['190 * time.Second', 190 * US_S, '3m10s'],
    ['70 * time.Minute', 70 * US_MIN, '70m'],
    ['47 * time.Hour', 47 * US_H, '47h'],
    ['49 * time.Hour', 49 * US_H, '2d1h'],
    ['(8*24 + 2) * time.Hour', (8 * 24 + 2) * US_H, '8d'],
    ['(367 * 24) * time.Hour', 367 * 24 * US_H, '367d'],
    ['(365*2*24 + 25) * time.Hour', (365 * 2 * 24 + 25) * US_H, '2y1d'],
    ['(365*8*24 + 2) * time.Hour', (365 * 8 * 24 + 2) * US_H, '8y'],
  ]);
});

// upstream: staging/src/k8s.io/apimachinery/pkg/util/duration/duration_test.go TestHumanDurationBoundaries
describe('TestHumanDurationBoundaries', () => {
  runDurations(humanDuration, [
    ['-2 * time.Second', -2 * US_S, '<invalid>'],
    // Upstream adds 1ns; the smallest step in microseconds is 1µs.
    ['-2*time.Second + 1', -2 * US_S + 1, '0s'],
    ['0', 0, '0s'],
    ['time.Second - time.Millisecond', US_S - US_MS, '0s'],
    ['2*time.Minute - time.Millisecond', 2 * US_MIN - US_MS, '119s'],
    ['2 * time.Minute', 2 * US_MIN, '2m'],
    ['2*time.Minute + time.Second', 2 * US_MIN + US_S, '2m1s'],
    ['10*time.Minute - time.Millisecond', 10 * US_MIN - US_MS, '9m59s'],
    ['10 * time.Minute', 10 * US_MIN, '10m'],
    ['10*time.Minute + time.Second', 10 * US_MIN + US_S, '10m'],
    ['3*time.Hour - time.Millisecond', 3 * US_H - US_MS, '179m'],
    ['3 * time.Hour', 3 * US_H, '3h'],
    ['3*time.Hour + time.Minute', 3 * US_H + US_MIN, '3h1m'],
    ['8*time.Hour - time.Millisecond', 8 * US_H - US_MS, '7h59m'],
    ['8 * time.Hour', 8 * US_H, '8h'],
    ['8*time.Hour + 59*time.Minute', 8 * US_H + 59 * US_MIN, '8h'],
    ['2*24*time.Hour - time.Millisecond', 2 * US_D - US_MS, '47h'],
    ['2 * 24 * time.Hour', 2 * US_D, '2d'],
    ['2*24*time.Hour + time.Hour', 2 * US_D + US_H, '2d1h'],
    ['8*24*time.Hour - time.Millisecond', 8 * US_D - US_MS, '7d23h'],
    ['8 * 24 * time.Hour', 8 * US_D, '8d'],
    ['8*24*time.Hour + 23*time.Hour', 8 * US_D + 23 * US_H, '8d'],
    ['2*365*24*time.Hour - time.Millisecond', 2 * US_Y - US_MS, '729d'],
    ['2 * 365 * 24 * time.Hour', 2 * US_Y, '2y'],
    ['2*365*24*time.Hour + 23*time.Hour', 2 * US_Y + 23 * US_H, '2y'],
    ['2*365*24*time.Hour + 23*time.Hour + 59*time.Minute', 2 * US_Y + 23 * US_H + 59 * US_MIN, '2y'],
    ['2*365*24*time.Hour + 24*time.Hour - time.Millisecond', 2 * US_Y + 24 * US_H - US_MS, '2y'],
    ['2*365*24*time.Hour + 24*time.Hour', 2 * US_Y + 24 * US_H, '2y1d'],
    ['3 * 365 * 24 * time.Hour', 3 * US_Y, '3y'],
    ['4 * 365 * 24 * time.Hour', 4 * US_Y, '4y'],
    ['5 * 365 * 24 * time.Hour', 5 * US_Y, '5y'],
    ['6 * 365 * 24 * time.Hour', 6 * US_Y, '6y'],
    ['7 * 365 * 24 * time.Hour', 7 * US_Y, '7y'],
    ['8*365*24*time.Hour - time.Millisecond', 8 * US_Y - US_MS, '7y364d'],
    ['8 * 365 * 24 * time.Hour', 8 * US_Y, '8y'],
    ['8*365*24*time.Hour + 364*24*time.Hour', 8 * US_Y + 364 * US_D, '8y'],
    ['9 * 365 * 24 * time.Hour', 9 * US_Y, '9y'],
  ]);
});

// upstream: staging/src/k8s.io/apimachinery/pkg/util/duration/duration_test.go TestShortHumanDurationBoundaries
describe('TestShortHumanDurationBoundaries', () => {
  runDurations(shortHumanDuration, [
    ['-2 * time.Second', -2 * US_S, '<invalid>'],
    // Upstream adds 1ns; the smallest step in microseconds is 1µs.
    ['-2*time.Second + 1', -2 * US_S + 1, '0s'],
    ['0', 0, '0s'],
    ['time.Second - time.Millisecond', US_S - US_MS, '0s'],
    ['time.Second', US_S, '1s'],
    ['2*time.Second - time.Millisecond', 2 * US_S - US_MS, '1s'],
    ['time.Minute - time.Millisecond', US_MIN - US_MS, '59s'],
    ['time.Minute', US_MIN, '1m'],
    ['2*time.Minute - time.Millisecond', 2 * US_MIN - US_MS, '1m'],
    ['time.Hour - time.Millisecond', US_H - US_MS, '59m'],
    ['time.Hour', US_H, '1h'],
    ['2*time.Hour - time.Millisecond', 2 * US_H - US_MS, '1h'],
    ['24*time.Hour - time.Millisecond', US_D - US_MS, '23h'],
    ['24 * time.Hour', US_D, '1d'],
    ['2*24*time.Hour - time.Millisecond', 2 * US_D - US_MS, '1d'],
    ['365*24*time.Hour - time.Millisecond', US_Y - US_MS, '364d'],
    ['365 * 24 * time.Hour', US_Y, '1y'],
    ['2*365*24*time.Hour - time.Millisecond', 2 * US_Y - US_MS, '1y'],
    ['2 * 365 * 24 * time.Hour', 2 * US_Y, '2y'],
  ]);
});

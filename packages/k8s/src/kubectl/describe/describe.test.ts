// The describers' branches that no golden case reaches (the oracle has no kubelet, no load
// balancer and aggregates no events), against what upstream's code prints.
//   upstream: staging/src/k8s.io/kubectl/pkg/describe/describe.go DescribeEvents, describeService
//             (buildIngressString, formatEndpointSlices), printAnnotationsMultiline,
//             printNodeTaintsMultiline, DescribeProbe, describeStatus; Go time.Time{} formatted
//             with RFC1123Z

import { describe, expect, test } from 'vitest';
import type { JsonObject } from '../../apimachinery/json.ts';
import { describeEvents, printAnnotationsMultiline, printNodeTaintsMultiline } from './common.ts';
import { describePod, describeProbe } from './pod.ts';
import { describeService } from './service.ts';
import { rfc1123z, tabbedString } from './writer.ts';

const NOW = Date.UTC(2026, 10, 13, 9, 10, 0); // 09:10:00

describe('values', () => {
  test("Go's zero time in RFC1123Z", () => {
    expect(rfc1123z(undefined)).toBe('Mon, 01 Jan 0001 00:00:00 +0000');
    expect(rfc1123z('2026-11-13T09:00:05Z')).toBe('Fri, 13 Nov 2026 09:00:05 +0000');
  });
  test('probes of each kind', () => {
    const attrs = { initialDelaySeconds: 1, timeoutSeconds: 2, periodSeconds: 3, successThreshold: 1, failureThreshold: 4 };
    const a = 'delay=1s timeout=2s period=3s successThreshold=1 failureThreshold=4';
    expect(describeProbe({ ...attrs, httpGet: { host: 'example.com', port: 8080, path: 'health', scheme: 'HTTP' } })).toBe(`http-get http://example.com:8080/health ${a}`);
    expect(describeProbe({ ...attrs, httpGet: { port: 'web', path: '/a b', scheme: 'HTTPS' } })).toBe(`http-get https://:web/a%20b ${a}`);
    expect(describeProbe({ ...attrs, httpGet: { host: '::1', port: 80, scheme: 'HTTP' } })).toBe(`http-get http://[::1]:80 ${a}`);
    expect(describeProbe({ ...attrs, grpc: { port: 9000, service: 'health' } })).toBe(`grpc <pod>:9000 health ${a}`);
    expect(describeProbe({ ...attrs })).toBe(`unknown ${a}`);
  });
});

describe('sections', () => {
  test('annotations: last-applied-configuration is skipped; long and multi-line values fold', () => {
    const out = tabbedString((w) =>
      printAnnotationsMultiline(w, 'Annotations', {
        'kubectl.kubernetes.io/last-applied-configuration': '{"x":1}\n',
        b: `${'x'.repeat(200)}`,
        a: 'one\ntwo\n',
      }),
    );
    expect(out).toBe(`Annotations:  a:\n                one\n                two\n              b:\n                ${'x'.repeat(138)}...\n`);
    expect(tabbedString((w) => printAnnotationsMultiline(w, 'Annotations', { 'kubectl.kubernetes.io/last-applied-configuration': '{}' }))).toBe('Annotations:  <none>\n');
  });
  test('taints sorted by effect then key, in each form', () => {
    const out = tabbedString((w) =>
      printNodeTaintsMultiline(w, 'Taints', [
        { key: 'b', value: 'v', effect: 'NoSchedule' },
        { key: 'a', effect: 'NoSchedule' },
        { key: 'c', value: 'v' },
        { key: 'd', effect: 'NoExecute' },
      ]),
    );
    expect(out).toBe('Taints:  c=v:\n         d:NoExecute\n         a:NoSchedule\n         b=v:NoSchedule\n');
  });
  test('events: oldest lastTimestamp first; counts and series aggregate; fieldPath prefixes the message', () => {
    const events: JsonObject[] = [
      {
        type: 'Warning',
        reason: 'BackOff',
        message: 'Back-off restarting failed container app in pod x_default(u)\n',
        count: 6,
        firstTimestamp: '2026-11-13T09:00:00Z',
        lastTimestamp: '2026-11-13T09:08:30Z',
        source: { component: 'kubelet' },
        involvedObject: { fieldPath: 'spec.containers{app}' },
      },
      { type: 'Normal', reason: 'Scheduled', message: 'Successfully assigned default/x to node01', eventTime: '2026-11-13T08:59:59.500000Z', reportingComponent: 'default-scheduler', involvedObject: {} },
      {
        type: 'Normal',
        reason: 'Updated',
        message: 'm',
        eventTime: '2026-11-13T09:01:00.000000Z',
        series: { count: 3, lastObservedTime: '2026-11-13T09:09:00.000000Z' },
        lastTimestamp: '2026-11-13T09:05:00Z',
        reportingComponent: 'ctl',
        involvedObject: {},
      },
      { type: 'Normal', reason: 'Odd', message: 'none', involvedObject: {}, lastTimestamp: '2026-11-13T09:09:59Z' },
    ];
    expect(tabbedString((w) => describeEvents(events, w, NOW))).toBe(
      [
        'Events:',
        '  Type     Reason     Age                From               Message',
        '  ----     ------     ----               ----               -------',
        '  Normal   Scheduled  10m                default-scheduler  Successfully assigned default/x to node01',
        '  Normal   Updated    60s (x3 over 9m)   ctl                m',
        '  Warning  BackOff    90s (x6 over 10m)  kubelet            spec.containers{app}: Back-off restarting failed container app in pod x_default(u)',
        '  Normal   Odd        <unknown>                             none',
        '',
      ].join('\n'),
    );
  });
});

describe('describers', () => {
  test('service: load balancer ingress, not-ready endpoints left out, endpoints of a headless slice', () => {
    const svc: JsonObject = {
      metadata: { name: 'lb', namespace: 'default' },
      spec: { type: 'LoadBalancer', clusterIP: '10.96.0.20', clusterIPs: ['10.96.0.20'], ports: [{ name: 'http', port: 80, targetPort: 8080, protocol: 'TCP', nodePort: 30001 }], sessionAffinity: 'None', externalTrafficPolicy: 'Cluster' },
      status: { loadBalancer: { ingress: [{ ip: '203.0.113.5', ipMode: 'VIP' }, { hostname: 'lb.example.com' }] } },
    };
    const slices: JsonObject[] = [
      {
        ports: [{ name: 'http', port: 8080 }],
        endpoints: [
          { addresses: ['10.244.1.2'], conditions: { ready: true } },
          { addresses: ['10.244.1.3'], conditions: { ready: false } },
        ],
      },
    ];
    const out = describeService(svc, slices, [], NOW);
    expect(out).toContain('LoadBalancer Ingress:     203.0.113.5 (VIP), lb.example.com\n');
    expect(out).toContain('Endpoints:                10.244.1.2:8080\n');
    expect(out).toContain('IP Families:              <none>\n');
    const none = describeService(svc, [{ ports: [{ name: 'http', port: 8080 }], endpoints: [{ addresses: ['10.244.1.3'], conditions: { ready: false } }] }], undefined, NOW);
    expect(none).toContain('Endpoints:                \n');
    expect(none).not.toContain('Events:');
    const headless = describeService(svc, [{ endpoints: [1, 2, 3, 4].map((i) => ({ addresses: [`10.244.1.${i}`] })) }], undefined, NOW);
    expect(headless).toContain('Endpoints:                10.244.1.1,10.244.1.2,10.244.1.3 + 1 more...\n');
  });
  test('pod: a terminating Pod and a container that was terminated by a signal', () => {
    const pod: JsonObject = {
      metadata: { name: 'x', namespace: 'default', deletionTimestamp: '2026-11-13T09:10:30Z', deletionGracePeriodSeconds: 30 },
      spec: { nodeName: 'node01', containers: [{ name: 'app', image: 'busybox' }] },
      status: {
        phase: 'Running',
        hostIP: '172.16.0.11',
        qosClass: 'BestEffort',
        containerStatuses: [
          {
            name: 'app',
            ready: false,
            restartCount: 1,
            containerID: 'containerd://abc',
            imageID: 'docker.io/library/busybox@sha256:00',
            state: { terminated: { exitCode: 137, signal: 9, reason: 'Error', message: 'killed', startedAt: '2026-11-13T09:00:00Z', finishedAt: '2026-11-13T09:05:00Z' } },
          },
        ],
      },
    };
    const out = describePod(pod, undefined, NOW);
    expect(out).toContain('Status:                    Terminating (lasts <invalid>)\nTermination Grace Period:  30s\n');
    expect(out).toContain(
      [
        '    State:          Terminated',
        '      Reason:       Error',
        '      Message:      killed',
        '      Exit Code:    137',
        '      Signal:       9',
        '      Started:      Fri, 13 Nov 2026 09:00:00 +0000',
        '      Finished:     Fri, 13 Nov 2026 09:05:00 +0000',
        '    Ready:          False',
        '    Restart Count:  1',
      ].join('\n'),
    );
  });
});

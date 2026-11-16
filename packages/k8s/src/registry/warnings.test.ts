// WarningsOnUpdate of the strategies that only warn on some updates: DaemonSets when the template
// generation changes (pkg/registry/apps/daemonset/strategy.go), Pods never on the main resource
// and on status for its IPs (pkg/registry/core/pod/strategy.go). Create and the Deployment
// generation rule are compared with the real server in fixtures/golden/cases/api/warnings.yaml.

import { describe, expect, it } from 'vitest';
import type { ApiObject } from '../apiserver/store.ts';
import type { StrategyCtx } from '../apiserver/types.ts';
import type { JsonObject } from '../apimachinery/json.ts';
import { daemonSetStrategy } from './apps/daemonset.ts';
import { podStrategy } from './core/pod.ts';

// The warnings read neither the context nor the stored object's bookkeeping.
const ctx = {} as StrategyCtx;
const stored = (o: JsonObject): ApiObject => o as ApiObject;

const ds = (tg: string): JsonObject => ({
  metadata: { name: 'agent', annotations: { 'deprecated.daemonset.template.generation': tg } },
  spec: { template: { spec: { terminationGracePeriodSeconds: -1, containers: [{ name: 'a', image: 'busybox' }] } } },
});

describe('WarningsOnUpdate', () => {
  it('warns about a DaemonSet template only when the template generation changed', () => {
    const warning = 'spec.template.spec.terminationGracePeriodSeconds: must be >= 0; negative values are invalid and will be treated as 1';
    expect(daemonSetStrategy.warningsOnUpdate?.(ds('2'), stored(ds('1')), ctx)).toEqual([warning]);
    expect(daemonSetStrategy.warningsOnUpdate?.(ds('1'), stored(ds('1')), ctx)).toEqual([]);
    expect(daemonSetStrategy.warningsOnCreate?.(ds('1'), ctx)).toEqual([warning]);
  });

  it('has no Pod update warnings, and checks the IPs of a status update', () => {
    const pod: JsonObject = { metadata: { name: 'p' }, spec: { terminationGracePeriodSeconds: -1 }, status: { podIPs: [{ ip: '2001:db8:0:0::1' }], hostIPs: [{ ip: '10.0.0.1' }] } };
    expect(podStrategy.warningsOnUpdate?.(pod, stored(pod), ctx) ?? []).toEqual([]);
    expect(podStrategy.status?.warningsOnUpdate?.(pod, stored(pod), ctx)).toEqual([
      'status.podIPs[0].ip: IPv6 address "2001:db8:0:0::1" should be in RFC 5952 canonical format ("2001:db8::1")',
    ]);
  });
});

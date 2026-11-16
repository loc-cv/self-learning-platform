// The event recorder: client-go's correlator semantics (de-duplication with counts, aggregation of
// similar events, the per-object spam filter), driven through a toy controller's SyncCtx.event.

import { describe, expect, test } from 'vitest';
import { bootKernel, createRegistry, DEFAULT_START_TIME, type Contribution, type Kernel, type Plugin } from '@simlab/kernel';
import { hostPlugin } from '@simlab/host';
import { k8sPlugin } from '../plugin.ts';
import { bootstrapApiServer } from '../apiserver/bootstrap.ts';
import { DEFAULT_APISERVER } from '../apiserver/config.ts';
import { createClient } from '../client/client.ts';
import type { JsonObject } from '../apimachinery/json.ts';
import { CONTROLLER, enqueue, startController } from './runtime.ts';
import type { ControllerSpec } from './types.ts';

/** Records the event its key describes about the ConfigMap `subject`: `<reason>|<message>`. */
const emitter: ControllerSpec = {
  name: 'test-emitter',
  component: 'kube-controller-manager',
  serviceAccount: 'test-emitter',
  eventSource: 'test-controller',
  watches: [],
  latency: 0,
  sync(c, key) {
    const [reason, message] = key.split('|') as [string, string];
    const subject = c.get('v1/configmaps', 'default', 'subject');
    if (subject) c.event(subject, 'Normal', reason, message);
    return { done: true };
  },
};

const registry = createRegistry([hostPlugin, k8sPlugin, { name: 'test', requires: ['k8s'], contributions: { [CONTROLLER]: [emitter as unknown as Contribution] } } satisfies Plugin]);

function boot(): Kernel {
  const k = bootKernel(registry, { seed: 1, startTime: DEFAULT_START_TIME });
  k.act('bootstrap', (ctx) => bootstrapApiServer(ctx, DEFAULT_APISERVER));
  k.act('subject', (ctx) => createClient(ctx, DEFAULT_APISERVER).resource('v1/configmaps').create('default', { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'subject' } }));
  k.act('start', (ctx) => startController(ctx, 'kcm', 'test-emitter', DEFAULT_APISERVER));
  return k;
}

function emit(k: Kernel, reason: string, message: string): void {
  k.act('emit', (ctx) => enqueue(ctx, 'kcm/test-emitter', `${reason}|${message}`, 0, 'test'));
  k.advance(1);
}

function events(k: Kernel): JsonObject[] {
  const r = k.act('list', (ctx) => createClient(ctx, DEFAULT_APISERVER).resource('v1/events').list('default'));
  if (!r.ok) throw new Error('list');
  return ((r.object as JsonObject).items as JsonObject[]).sort((a, b) => String(a.firstTimestamp).localeCompare(String(b.firstTimestamp)));
}

describe('event recorder', () => {
  test('an event names its object, source and reporting controller as the legacy recorder does', () => {
    const k = boot();
    emit(k, 'Hello', 'hello there');
    const [e] = events(k);
    const m = e?.metadata as JsonObject;
    // GenerateEventName: <name>.<UnixNano in hex>; the event is recorded at the boot time.
    expect(m.name).toBe(`subject.${(BigInt(DEFAULT_START_TIME) * 1_000_000n).toString(16)}`);
    expect(e).toMatchObject({
      involvedObject: { kind: 'ConfigMap', namespace: 'default', name: 'subject', apiVersion: 'v1' },
      reason: 'Hello',
      message: 'hello there',
      source: { component: 'test-controller' },
      count: 1,
      type: 'Normal',
      reportingComponent: 'test-controller',
      reportingInstance: '',
    });
    expect(e?.firstTimestamp).toBe(e?.lastTimestamp);
  });

  test('the same event again increments count and lastTimestamp of the first one', () => {
    const k = boot();
    emit(k, 'Hello', 'same');
    k.advance(5000);
    emit(k, 'Hello', 'same');
    const es = events(k);
    expect(es).toHaveLength(1);
    expect(es[0]?.count).toBe(2);
    expect(es[0]?.firstTimestamp).not.toBe(es[0]?.lastTimestamp);
  });

  test('the tenth similar event within ten minutes is combined', () => {
    const k = boot();
    for (let i = 1; i <= 9; i++) emit(k, 'Varying', `message ${i}`);
    expect(events(k)).toHaveLength(9);
    emit(k, 'Varying', 'message 10');
    emit(k, 'Varying', 'message 11');
    const es = events(k);
    expect(es).toHaveLength(10);
    const combined = es.find((e) => String(e.message).startsWith('(combined'));
    expect(combined?.message).toBe('(combined from similar events): message 11');
    expect(combined?.count).toBe(2);
  });

  test('a source may burst 25 events about an object, then one per five minutes', () => {
    const k = boot();
    for (let i = 1; i <= 26; i++) emit(k, `R${i}`, 'm');
    expect(events(k)).toHaveLength(25);
    k.advance(300_000);
    emit(k, 'R27', 'm');
    emit(k, 'R28', 'm');
    expect(events(k).map((e) => e.reason)).toContain('R27');
    expect(events(k).map((e) => e.reason)).not.toContain('R28');
  });
});

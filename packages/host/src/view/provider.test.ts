import { expect, test } from 'vitest';
import { bootKernel, buildView, createRegistry, DEFAULT_START_TIME, validateView } from '@simlab/kernel';
import { createMachine } from '../machine.ts';
import { hostPlugin } from '../plugin.ts';
import { ubuntu1Topology } from '../topology.ts';

test('every machine but container sandboxes, with its role and addresses', () => {
  const registry = createRegistry([hostPlugin]);
  const k = bootKernel(registry, { seed: 1, startTime: DEFAULT_START_TIME });
  k.act('topology', (ctx) => {
    ubuntu1Topology.build(ctx, {});
    createMachine(ctx, { id: 'ws', hostname: 'workstation', kind: 'workstation', addresses: ['10.0.0.9'] });
    createMachine(ctx, { id: 'c1', hostname: 'c1', kind: 'container' });
  });
  const m = buildView(registry, k.world);
  expect(validateView(m)).toEqual([]);
  expect(m.entities).toEqual([
    { id: 'host/machine/node01', kind: 'host.Machine', label: 'node01', state: 'healthy', facts: [{ label: 'Role', value: 'node' }] },
    { id: 'host/machine/ws', kind: 'host.Machine', label: 'workstation', state: 'healthy', facts: [{ label: 'Role', value: 'workstation' }, { label: 'Address', value: '10.0.0.9' }] },
  ]);
  expect(m.kinds).toEqual([{ kind: 'host.Machine', shape: 'host', label: 'Machine', plural: 'Machines' }]);
});

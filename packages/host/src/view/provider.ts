// The host's view provider (PLAN.md §6.5): every machine, with its role and addresses. Container
// sandboxes are machines too (kind `container`), but they belong to the domain that runs them and
// are drawn by its provider, so they are left out here.

import { compareCodeUnits, type ViewEntity, type ViewPart, type ViewProviderSpec, type World } from '@simlab/kernel';
import type { HostSlice, Machine } from '../machine.ts';

export const MACHINE_KIND = 'host.Machine';

/** The view id of a machine, for other providers to place things on it. */
export const machineViewId = (id: string): string => `host/machine/${id}`;

/** The role words are the host's own `Machine.kind` values. */
const ROLE: Record<Machine['kind'], string> = { node: 'node', workstation: 'workstation', container: 'container' };

function machineEntity(m: Machine): ViewEntity {
  const facts = [{ label: 'Role', value: ROLE[m.kind] }];
  if (m.addresses && m.addresses.length > 0) facts.push({ label: 'Address', value: m.addresses.join(', ') });
  const e: ViewEntity = { id: machineViewId(m.id), kind: MACHINE_KIND, label: m.hostname, state: m.boot.state === 'running' ? 'healthy' : 'failed', facts };
  if (m.boot.state !== 'running') e.muted = true;
  return e;
}

export function hostView(world: World): ViewPart {
  const host = world.slices['host'] as HostSlice | undefined;
  const machines = host ? Object.keys(host.machines).sort(compareCodeUnits).map((id) => host.machines[id] as Machine) : [];
  return {
    kinds: [{ kind: MACHINE_KIND, shape: 'host', label: 'Machine', plural: 'Machines' }],
    entities: machines.filter((m) => m.kind !== 'container').map(machineEntity),
    relations: [],
  };
}

export const hostViewProvider: ViewProviderSpec = { name: 'host', view: hostView };

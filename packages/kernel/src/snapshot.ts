// Snapshot and restore (docs/ARCHITECTURE.md §2.7). A snapshot is the world serialized as JSON with
// a header naming the kernel schema, each slice's version and the engine version. Restore refuses
// any mismatch, then freezes the values again so later forks share them.

import { assertPlainData, deepFreeze } from './json.ts';
import type { Registry } from './registry.ts';
import { ENGINE_VERSION } from './version.ts';
import { KERNEL_SCHEMA, type World } from './world.ts';

export interface SnapshotHeader {
  kernelSchema: number;
  engine: string;
  slices: Record<string, number>;
}

interface SnapshotFile {
  header: SnapshotHeader;
  world: World;
}

function headerFor(registry: Registry): SnapshotHeader {
  const slices: Record<string, number> = {};
  for (const spec of registry.slices) slices[spec.name] = spec.version;
  return { kernelSchema: KERNEL_SCHEMA, engine: ENGINE_VERSION, slices };
}

/**
 * Serializes the world. Only valid when every program is quiescent (§3.4); the caller guarantees
 * that. Throws if the world holds anything that is not JSON data, which `JSON.stringify` would
 * otherwise drop or mangle silently.
 */
export function snapshot(world: World, registry: Registry): string {
  assertPlainData(world, 'world');
  const file: SnapshotFile = { header: headerFor(registry), world };
  return JSON.stringify(file);
}

export function restore(text: string, registry: Registry): World {
  const file = JSON.parse(text) as SnapshotFile;
  const want = headerFor(registry);
  const have = file.header;
  if (have.kernelSchema !== want.kernelSchema) {
    throw new Error(`snapshot has kernel schema ${have.kernelSchema}, this engine uses ${want.kernelSchema}`);
  }
  if (have.engine !== want.engine) {
    throw new Error(`snapshot was taken by engine ${have.engine}, this is engine ${want.engine}`);
  }
  const names = new Set([...Object.keys(have.slices), ...Object.keys(want.slices)]);
  for (const name of [...names].sort()) {
    if (have.slices[name] !== want.slices[name]) {
      throw new Error(
        `snapshot slice ${name} has version ${have.slices[name] ?? 'none'}, this engine has ${want.slices[name] ?? 'none'}`,
      );
    }
  }
  const world = file.world;
  for (const ev of world.queue) deepFreeze(ev);
  for (const key of Object.keys(world.topics)) deepFreeze(world.topics[key]);
  for (const spec of registry.slices) spec.adopt(world.slices[spec.name]);
  return world;
}

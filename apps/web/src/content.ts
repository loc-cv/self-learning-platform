// The bundled content: items by id and the list the item picker shows. The workspace opens
// lab-like items only; lessons, cards and exams get their screens in phase 12.

import content from 'virtual:simlab/content';
import { SCENARIO_KINDS, type Item } from '@simlab/learn';

export const ITEMS: Item[] = content.packs.flatMap((p) => p.items as unknown as Item[]).filter((i) => SCENARIO_KINDS.includes(i.kind));

const SKILLS = new Map(content.packs.flatMap((p) => p.pack.skills.map((s) => [s.id, s.title] as const)));

export function itemById(id: string): Item | undefined {
  return ITEMS.find((i) => i.id === id);
}

export function skillTitle(id: string): string {
  return SKILLS.get(id) ?? id;
}

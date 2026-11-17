// The bundled content: every item by id, the catalog the learning layer works from, and the
// Vietnamese sidecars. Exams are bundled and have no screen until phase 31.

import content, { type CurriculumDomain, type CurriculumExam } from 'virtual:simlab/content';
import { buildCatalog, localize, resolveSidecar, type AnyItem, type Catalog, type Sidecar, type SidecarResolution } from '@simlab/learn';

/** An item something can be done with today: everything except an exam. */
export type Practiced = Exclude<AnyItem, { kind: 'exam' }>;

const PACKS = content.packs.map((p) => ({ pack: p.pack, items: p.items as unknown as AnyItem[] }));

export const ITEMS: Practiced[] = PACKS.flatMap((p) => p.items).filter((i): i is Practiced => i.kind !== 'exam');
export const ITEMS_BY_ID: Readonly<Record<string, Practiced>> = Object.fromEntries(ITEMS.map((i) => [i.id, i]));
export const CATALOG: Catalog = buildCatalog(PACKS);
export const PACK_TITLES: Readonly<Record<string, string>> = Object.fromEntries(PACKS.map((p) => [p.pack.id, p.pack.title]));

const SIDECARS = new Map<string, Sidecar>(content.packs.flatMap((p) => p.sidecars.map((s) => [s.id, s] as const)));
const resolutions = new Map<string, SidecarResolution | undefined>();

export function itemById(id: string): Practiced | undefined {
  return ITEMS_BY_ID[id];
}

export function skillTitle(id: string): string {
  return CATALOG.skills[id]?.title ?? id;
}

/** The state of every text unit of the item against its sidecar; undefined when it has none. */
export function resolutionOf(id: string): SidecarResolution | undefined {
  if (!resolutions.has(id)) {
    const item = ITEMS_BY_ID[id];
    const sidecar = SIDECARS.get(id);
    resolutions.set(id, item && sidecar ? resolveSidecar(item, sidecar) : undefined);
  }
  return resolutions.get(id);
}

/** The item with its current Vietnamese in place, or undefined when it has no sidecar. */
export function localized<T extends Practiced>(item: T): T | undefined {
  const r = resolutionOf(item.id);
  return r ? localize(item, r) : undefined;
}

/** An item's title in Vietnamese, when its translation is current. */
export function titleVi(id: string): string | undefined {
  const u = resolutionOf(id)?.units.find((x) => x.key === 'title');
  return u?.state === 'current' ? u.translation : undefined;
}

/** The official curricula (docs/curriculum/competencies.yaml): exams, their domains and competencies. */
export const CURRICULUM: readonly CurriculumExam[] = content.curriculum;
const DOMAINS = new Map<string, CurriculumDomain & { exam: CurriculumExam }>(CURRICULUM.flatMap((e) => e.domains.map((d) => [d.id, { ...d, exam: e }] as const)));
const COMPETENCIES = new Map<string, string>(CURRICULUM.flatMap((e) => e.domains.flatMap((d) => d.competencies.map((c) => [c.id, c.text] as const))));

/** A curriculum domain by id (`cka.workloads`), with its exam. */
export function domainInfo(id: string): (CurriculumDomain & { exam: CurriculumExam }) | undefined {
  return DOMAINS.get(id);
}

/** The official wording of a competency. */
export function competencyText(id: string): string {
  return COMPETENCIES.get(id) ?? id;
}

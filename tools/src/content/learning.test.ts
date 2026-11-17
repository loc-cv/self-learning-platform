// The fixture pack of the learning model (packages/content/fixtures/learning): one item of each
// kind phase 11 added, validated on the real simulator by the code behind `npm run
// content:check`, and its sidecars read by the code behind `npm run content:i18n`.

import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { competencyIds, CONTENT_ROOT, isLabLike, kindOf, loadPacks, skillIds, strandedSidecars } from '@simlab/content';
import { buildCatalog, buildQueue, cardVariantOf, initialState, lessonVariantOf, localize, parseSidecar, PROGRESS_VERSION, resolveSidecar, applyEvent, type AnyItem, type CardItem, type LessonItem, type Sidecar } from '@simlab/learn';
import { checkItem, itemKinds, packProblems } from './check.ts';
import { formatReport, reportItem, totals } from './i18n.ts';

const packs = loadPacks(join(CONTENT_ROOT, 'fixtures'));
const files = packs.flatMap((p) => p.items);
const file = (id: string) => {
  const f = files.find((x) => x.fileId === id);
  if (!f) throw new Error(`no fixture ${id}`);
  return f;
};
const opts = { seeds: 2, skills: skillIds(packs), competencies: competencyIds(), items: itemKinds(packs) };

describe('the fixture pack', () => {
  test('loads: the manifest with prerequisites and a track, the items of every kind, the sidecars', () => {
    expect(packs.map((p) => p.pack.id)).toEqual(['fx']);
    const pack = packs[0]?.pack;
    expect(pack?.skills.map((s) => [s.id, s.requires])).toEqual([['fx.workloads.deployments', undefined], ['fx.workloads.scaling', ['fx.workloads.deployments']]]);
    expect(pack?.tracks?.[0]?.items.length).toBe(4);
    expect(Object.fromEntries(files.map((f) => [f.fileId, kindOf(f)]))).toEqual({
      'fx.exams.sample-01': 'exam',
      'fx.workloads.owner-card-01': 'card',
      'fx.workloads.scale-card-01': 'card',
      'fx.workloads.scale-drill-01': 'drill',
      'fx.workloads.scaling-lesson-01': 'lesson',
    });
    expect(files.filter(isLabLike).map((f) => f.fileId)).toEqual(['fx.workloads.scale-drill-01']);
    expect(files.filter((f) => f.sidecar).map((f) => f.sidecar?.file)).toEqual(['learning/workloads/fx.workloads.owner-card-01.vi.yaml', 'learning/workloads/fx.workloads.scaling-lesson-01.vi.yaml']);
    expect(strandedSidecars(join(CONTENT_ROOT, 'fixtures'))).toEqual([]);
  });

  test('the packs the apps load do not include it', () => {
    expect(loadPacks().map((p) => p.pack.id)).not.toContain('fx');
  });

  test('is a valid pack: skills, prerequisites, the track', () => {
    expect(packProblems(packs)).toEqual([]);
  });

  test.each(files.map((f) => [f.fileId, f] as const))('%s passes content validation on the simulator', (_id, f) => {
    const r = checkItem(f, opts);
    expect([...r.problems, ...r.seeds.flatMap((s) => s.problems.map((p) => `seed ${s.seed}: ${p}`))]).toEqual([]);
    expect(r.seeds.length).toBe(kindOf(f) === 'exam' ? 0 : 2);
  });

  test('a lesson whose task is already done, and an exam whose task is a lesson, are refused', () => {
    const lesson = JSON.parse(JSON.stringify(file('fx.workloads.scaling-lesson-01'))) as (typeof files)[number];
    const steps = (lesson.raw as unknown as LessonItem).steps;
    const task = steps.find((s) => 'task' in s) as { task: { checks: { with: Record<string, unknown> }[] } };
    (task.task.checks[0] as { with: Record<string, unknown> }).with['count'] = 1;
    const r = checkItem(lesson, opts);
    expect(r.seeds[0]?.problems).toContain('task 1, before its solution: every check passes; the item must fail before it is solved');
    const exam = JSON.parse(JSON.stringify(file('fx.exams.sample-01'))) as (typeof files)[number];
    (exam.raw as { tasks: { item: string }[] }).tasks[0] = { item: 'fx.workloads.scaling-lesson-01' } as never;
    expect(checkItem(exam, opts).problems.length).toBeGreaterThan(0);
  });

  test('variants of the lesson and of the card by command carry the seed\'s values', () => {
    const lesson = lessonVariantOf(file('fx.workloads.scaling-lesson-01').raw as unknown as LessonItem, 1);
    const n = String(lesson.params['replicas']);
    expect(lesson.steps.map((s) => Object.keys(s)[0])).toEqual(['text', 'figure', 'predict', 'task', 'predict', 'figure']);
    expect(lesson.steps[3]).toMatchObject({ task: { text: `Scale \`web\` in namespace \`${String(lesson.params['ns'])}\` to ${n} replicas.` } });
    const card = cardVariantOf(file('fx.workloads.scale-card-01').raw as unknown as CardItem, 1);
    expect(card.answer).toBe(`\`kubectl -n ${String(card.params['ns'])} scale deployment web --replicas=${String(card.params['replicas'])}\``);
  });

  test('the catalog drives the queue: the lesson first, then what it opens', () => {
    const catalog = buildCatalog(packs.map((p) => ({ pack: p.pack, items: p.items.map((f) => f.raw as unknown as AnyItem) })));
    expect(Object.keys(catalog.items).sort()).toEqual(['fx.workloads.owner-card-01', 'fx.workloads.scale-card-01', 'fx.workloads.scale-drill-01', 'fx.workloads.scaling-lesson-01']);
    const start = applyEvent(initialState(), { v: PROGRESS_VERSION, type: 'settings.changed', at: 0, settings: { activeTrack: 'fx.track.scaling' } });
    // The drill and the second card are on `scaling` alone, which needs `deployments` passed first.
    expect(buildQueue(start, catalog, 0).entries.map((e) => e.item)).toEqual(['fx.workloads.scaling-lesson-01', 'fx.workloads.owner-card-01']);
  });
});

describe('the translation report', () => {
  const reports = files.map(reportItem);
  const byId = Object.fromEntries(reports.map((r) => [r.id, r]));

  test('tells current, outdated and missing units apart', () => {
    expect(byId['fx.workloads.owner-card-01']?.resolution?.counts).toEqual({ current: 8, outdated: 0, missing: 3 });
    const lesson = byId['fx.workloads.scaling-lesson-01']?.resolution;
    expect(lesson?.counts).toEqual({ current: 4, outdated: 1, missing: 11 });
    expect(lesson?.units.filter((u) => u.state === 'outdated').map((u) => u.key)).toEqual(['steps.0']);
    expect(lesson?.orphaned).toEqual(['steps.9']);
    expect(lesson?.violations).toEqual(['steps.3.hints.0: code changed or missing: `kubectl scale`', 'steps.3.hints.0: code changed or missing: `spec.replicas`']);
    expect(byId['fx.workloads.scale-drill-01']).toMatchObject({ hasSidecar: false, resolution: { counts: { current: 0, outdated: 0, missing: 7 } } });
    expect(totals(reports)).toEqual({ items: 5, sidecars: 2, current: 12, outdated: 1, missing: 26 });
  });

  test('prints one line per item, the findings under it and the totals', () => {
    const lines = formatReport(reports, ['learning/x.vi.yaml'], false);
    expect(lines).toEqual([
      'fx.exams.sample-01: no sidecar, 1 units',
      'fx.workloads.owner-card-01: 8/11 current, 0 outdated, 3 missing',
      'fx.workloads.scale-card-01: no sidecar, 4 units',
      'fx.workloads.scale-drill-01: no sidecar, 7 units',
      'fx.workloads.scaling-lesson-01: 4/16 current, 1 outdated, 11 missing',
      '  orphaned: steps.9 matches no text unit of the item',
      '  steps.3.hints.0: code changed or missing: `kubectl scale`',
      '  steps.3.hints.0: code changed or missing: `spec.replicas`',
      'learning/x.vi.yaml: a sidecar with no item next to it',
      '5 items, 2 with a sidecar; 39 text units: 12 current, 1 outdated, 26 missing',
    ]);
    // With -v every unit that is not current is listed with the hash a translation records.
    expect(formatReport(reports, [], true)).toContain('  outdated: steps.0  (source: sha256:a21e54c891328e67)');
  });

  test('a sidecar that is not one is said, and the item falls back to English', () => {
    const f = file('fx.workloads.owner-card-01');
    const broken = reportItem({ ...f, sidecar: { file: 'x', raw: { id: f.fileId, lang: 'vi', units: { title: { source: 'nope', text: 'x' } } } } });
    expect(broken.invalid.length).toBe(1);
    expect(broken.resolution?.counts.current).toBe(0);
    const other = reportItem({ ...f, sidecar: { file: 'x', raw: { id: 'fx.other', lang: 'vi', units: { title: { source: 'sha256:0fc9ec514897c7b8', text: 'x' } } } } });
    expect(other.invalid).toEqual(['id is fx.other, the item is fx.workloads.owner-card-01']);
  });

  test('the localized card is Vietnamese where translated, English elsewhere, and still valid', () => {
    const f = file('fx.workloads.owner-card-01');
    const item = f.raw as unknown as CardItem;
    const { sidecar } = parseSidecar(f.sidecar?.raw ?? null);
    const vi = localize(item, resolveSidecar(item, sidecar as Sidecar));
    expect(vi.title).toBe('Ai tạo ra các Pod của một Deployment');
    expect(vi.choices).toEqual(['Deployment controller', 'ReplicaSet controller', 'kubelet']);
    // Entity labels were not translated: they stay as written.
    expect((vi.figure as { entities: { label: string }[] }).entities.map((e) => e.label)).toEqual(['web', 'web-5d9c', '2 of 3']);
    const r = checkItem({ ...f, raw: vi as never }, opts);
    expect([...r.problems, ...r.seeds.flatMap((s) => s.problems)]).toEqual([]);
  });
});

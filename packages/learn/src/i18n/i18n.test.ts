// Translation sidecars (docs/SCENARIO_FORMAT.md §13): text units, source hashes, and the state
// of every unit: current, outdated, missing.

import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import type { Json } from '@simlab/kernel';
import { counterCards, counterExam, counterItem, counterLesson } from '../testing.ts';
import { variantOf } from '../item/variant.ts';
import { sha256Hex } from './sha256.ts';
import { codeSpans, localize, parseSidecar, resolveSidecar, sidecarEntry, translationViolations, type Sidecar } from './sidecar.ts';
import { normalizeText, sourceHash, textUnits } from './units.ts';

describe('the source hash', () => {
  test('SHA-256 agrees with node:crypto, for any length and any script', () => {
    const samples = ['', 'abc', 'Tiếng Việt: các Pod đang chờ', '😀 emoji and \ud800 a lone surrogate', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(63), 'x'.repeat(64), 'x'.repeat(65), 'line\n'.repeat(1000)];
    for (const s of samples) expect(sha256Hex(s), JSON.stringify(s.slice(0, 20))).toBe(createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex'));
  });

  test('is taken after normalization, so whitespace noise does not make a translation outdated', () => {
    expect(normalizeText('\r\n\n  a  \r\nb\t\n\n\n')).toBe('  a\nb');
    expect(sourceHash('The `web` Deployment.\n')).toBe(sourceHash('\nThe `web` Deployment.   \r\n\r\n'));
    expect(sourceHash('The `web` Deployment.')).not.toBe(sourceHash('The `api` Deployment.'));
    expect(sourceHash('abc')).toBe('sha256:ba7816bf8f01cfea');
  });
});

describe('text units', () => {
  test('a lab: title, ticket, hints, check titles, solution names, debrief blocks and figure texts', () => {
    const keys = textUnits(counterItem()).map((u) => u.key);
    expect(keys).toEqual(['title', 'ticket', 'hints.0', 'hints.1', 'hints.2', 'checks.reached.title', 'checks.not-huge.title', 'solutions.0.name', 'solutions.1.name', 'debrief.0.caption', 'debrief.0.alt', 'debrief.1', 'debrief.2', 'debrief.3']);
  });

  test('a lesson: every step by its index, a task with its hints and checks', () => {
    expect(textUnits(counterLesson()).map((u) => u.key)).toEqual([
      'title', 'steps.0', 'steps.1.caption', 'steps.1.alt', 'steps.2.prompt', 'steps.2.choices.0', 'steps.2.choices.1', 'steps.2.explain',
      'steps.3.text', 'steps.3.hints.0', 'steps.3.checks.bumped.title', 'steps.4', 'steps.5.prompt', 'steps.5.explain', 'steps.6.text', 'steps.6.checks.ten.title', 'steps.7.caption', 'steps.7.alt',
    ]);
  });

  test('a card and an exam', () => {
    const { plain, choice, command } = counterCards();
    expect(textUnits(plain).map((u) => u.key)).toEqual(['title', 'prompt', 'figure.caption', 'figure.alt', 'figure.entities.box.label', 'figure.entities.c.label', 'answer']);
    expect(textUnits(choice).map((u) => u.key)).toEqual(['title', 'prompt', 'choices.0', 'choices.1', 'choices.2', 'answer']);
    expect(textUnits(command).map((u) => u.key)).toEqual(['title', 'prompt', 'figure.caption', 'figure.alt', 'answer', 'checks.goal.title']);
    expect(textUnits(counterExam()).map((u) => u.key)).toEqual(['title']);
  });

  test('every key is one the sidecar schema accepts, and every path leads to the text', () => {
    for (const item of [counterItem(), counterLesson(), ...Object.values(counterCards()), counterExam()]) {
      const units = textUnits(item);
      const sidecar = { id: item.id, lang: 'vi', units: Object.fromEntries(units.map((u) => [u.key, sidecarEntry(u.text, u.text)])) };
      expect(parseSidecar(sidecar as unknown as Json).problems).toEqual([]);
      for (const u of units) {
        let node: unknown = item;
        for (const part of u.path) node = (node as Record<string | number, unknown>)[part];
        expect(node, u.key).toBe(u.text);
      }
    }
  });

  test('a hint with `when`, a scene and written panel titles have units too', () => {
    const item = counterItem();
    (item.hints as unknown[])[1] = { text: 'Only for some.', when: { how: 'once' } };
    (item.debrief as unknown[])[0] = { figure: { kind: 'compare', left: { of: 'start', title: 'Before' }, right: { of: 'solved' }, caption: 'c', alt: 'a', notes: [{ text: 'n' }] } };
    (item.debrief as unknown[]).push({ figure: { kind: 'scene', caption: 'sc', alt: 'sa', frames: [{ caption: 'f0', notes: [{ text: 'fn' }] }, { caption: 'f1', steps: [{ bump: 1 }] }] } });
    const units = textUnits(item);
    expect(units.find((u) => u.key === 'hints.1')).toMatchObject({ text: 'Only for some.', path: ['hints', 1, 'text'] });
    expect(units.map((u) => u.key).filter((k) => k.startsWith('debrief.0') || k.startsWith('debrief.4'))).toEqual(['debrief.0.caption', 'debrief.0.alt', 'debrief.0.notes.0', 'debrief.0.left.title', 'debrief.4.caption', 'debrief.4.alt', 'debrief.4.frames.0.caption', 'debrief.4.frames.0.notes.0', 'debrief.4.frames.1.caption']);
  });
});

describe('a sidecar against its item', () => {
  const item = counterItem();
  const sidecar: Sidecar = {
    id: item.id,
    lang: 'vi',
    units: {
      title: sidecarEntry('Reach the target', 'Đạt mục tiêu'),
      ticket: sidecarEntry('Make the counter reach {{target}}.', 'Đưa bộ đếm lên {{target}}.'),
      // Translated from an earlier wording of the hint.
      'hints.0': sidecarEntry('Look at the box.', 'Hãy xem cái hộp.'),
      'hints.2': sidecarEntry('Bump it by {{target}}.', 'Tăng nó thêm {{target}}.'),
      'debrief.0.caption': sidecarEntry('The counter went from 1 to {{target}}.', 'Bộ đếm đi từ 1 đến {{target}}.'),
      'hints.9': sidecarEntry('Gone.', 'Đã xoá.'),
    },
  };

  test('translated, outdated and missing units are told apart; unknown keys are orphaned', () => {
    const r = resolveSidecar(item, sidecar);
    const state = Object.fromEntries(r.units.map((u) => [u.key, u.state]));
    expect(state).toMatchObject({ title: 'current', ticket: 'current', 'hints.0': 'outdated', 'hints.1': 'missing', 'hints.2': 'current', 'debrief.0.caption': 'current', 'debrief.0.alt': 'missing' });
    expect(r.counts).toEqual({ current: 4, outdated: 1, missing: 9 });
    expect(r.orphaned).toEqual(['hints.9']);
    expect(r.violations).toEqual([]);
    expect(r.units.find((u) => u.key === 'hints.0')).toMatchObject({ translation: 'Hãy xem cái hộp.', text: 'Look at the counter.', hash: sourceHash('Look at the counter.') });
  });

  test('no sidecar: everything is missing', () => {
    expect(resolveSidecar(item).counts).toEqual({ current: 0, outdated: 0, missing: 14 });
  });

  test('editing the English makes exactly that unit outdated', () => {
    const edited = counterItem();
    edited.title = 'Reach the goal';
    const r = resolveSidecar(edited, sidecar);
    expect(r.units.filter((u) => u.state === 'outdated').map((u) => u.key)).toEqual(['title', 'hints.0']);
  });

  test('the localized item shows Vietnamese where it is current and English elsewhere, and still runs', () => {
    const vi = localize(item, resolveSidecar(item, sidecar));
    expect(vi.title).toBe('Đạt mục tiêu');
    expect(vi.hints).toEqual(['Look at the counter.', 'It only goes up.', 'Tăng nó thêm {{target}}.']);
    expect(item.title).toBe('Reach the target');
    const v = variantOf(vi, 1);
    expect(v.ticket).toEqual([{ text: `Đưa bộ đếm lên ${String(v.params['target'])}.` }]);
    expect(v.debrief[0]).toMatchObject({ figure: { caption: `Bộ đếm đi từ 1 đến ${String(v.params['target'])}.`, alt: 'The counter on the box, before and after.' } });
    expect(v.checks).toEqual(variantOf(item, 1).checks);
  });

  test('a translation keeps the code and the placeholders of its source', () => {
    expect(codeSpans('Run `kubectl get pods` then:\n```bash\nkubectl describe pod x\n```\nand ``a `tick` b``.')).toEqual(['```bash\nkubectl describe pod x\n```', '`kubectl get pods`', '``a `tick` b``']);
    expect(translationViolations('Scale `web` to {{n}}.', 'Tăng `web` lên {{n}}.')).toEqual([]);
    expect(translationViolations('Scale `web` to {{n}}.', 'Tăng `ứng dụng web` lên {{ m }}.')).toEqual(['code changed or missing: `web`', 'placeholder {{n}} is missing', 'placeholder {{m}} is not in the source']);
    const bad: Sidecar = { id: item.id, lang: 'vi', units: { 'hints.2': sidecarEntry('Bump it by {{target}}.', 'Tăng nó.') } };
    expect(resolveSidecar(item, bad).violations).toEqual(['hints.2: placeholder {{target}} is missing']);
  });

  test('the sidecar schema refuses a bad hash, an empty text and a key no unit can have', () => {
    const ok = { id: 'x.y', lang: 'vi', units: { title: { source: 'sha256:0123456789abcdef', text: 'x' } } };
    expect(parseSidecar(ok).problems).toEqual([]);
    expect(parseSidecar({ ...ok, lang: 'fr' }).problems.length).toBe(1);
    expect(parseSidecar({ ...ok, units: { title: { source: 'md5:0', text: 'x' } } }).problems.length).toBe(1);
    expect(parseSidecar({ ...ok, units: { title: { source: 'sha256:0123456789abcdef', text: '' } } }).problems.length).toBe(1);
    expect(parseSidecar({ ...ok, units: { 'world.setup': { source: 'sha256:0123456789abcdef', text: 'x' } } }).problems.length).toBe(1);
  });
});

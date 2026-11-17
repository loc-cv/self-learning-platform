import { expect, test } from 'vitest';
import { createStore, DEFAULT_SETTINGS, withDefaults, type KeyValue } from './storage.ts';

const map = (): KeyValue => {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
};

test('the assist level is a setting: full by default, kept when stored, the default when unknown', () => {
  expect(DEFAULT_SETTINGS.assist).toBe('full');
  const s = createStore(map());
  expect(s.settings().assist).toBe('full');
  s.saveSettings({ ...s.settings(), assist: 'off' });
  expect(s.settings().assist).toBe('off');
  expect(withDefaults({ assist: 'some' }).assist).toBe('full');
  expect(withDefaults({ assist: 'view', theme: 'light' })).toMatchObject({ assist: 'view', theme: 'light', lang: 'en' });
  expect(withDefaults(null)).toEqual(DEFAULT_SETTINGS);
});

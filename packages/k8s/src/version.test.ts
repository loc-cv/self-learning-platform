import { expect, test } from 'vitest';
import { KUBERNETES_MINOR, KUBERNETES_TAG, KUBERNETES_VERSION } from './version.ts';

test('the pin is a full release version, not a range or a pre-release', () => {
  expect(KUBERNETES_VERSION).toMatch(/^1\.\d+\.\d+$/);
});

test('tag and minor derive from the one constant', () => {
  expect(KUBERNETES_TAG).toBe(`v${KUBERNETES_VERSION}`);
  expect(KUBERNETES_VERSION.startsWith(`${KUBERNETES_MINOR}.`)).toBe(true);
});

// Cases in the manner of staging/src/k8s.io/kubectl/pkg/cmd/version/skew_warning_test.go.

import { describe, expect, test } from 'vitest';
import { versionSkewWarning } from './skew.ts';

describe('versionSkewWarning', () => {
  test.each([
    ['v1.37.2', 'v1.37.2', ''],
    ['v1.37.2', 'v1.36.0', ''],
    ['v1.37.2', 'v1.38.1-rc.0', ''],
    ['v1.37.2', 'v1.35.4', 'version difference between client (1.37) and server (1.35) exceeds the supported minor version skew of +/-1'],
    ['v1.37.2', 'v1.39.0+k3s1', 'version difference between client (1.37) and server (1.39) exceeds the supported minor version skew of +/-1'],
    ['v1.37.2', 'v2.37.2', 'version difference between client (1.37) and server (2.37) exceeds the supported minor version skew of +/-1'],
  ])('client %s, server %s', (c, s, want) => {
    expect(versionSkewWarning(c, s)).toBe(want);
  });

  test('a version that does not parse', () => {
    expect(versionSkewWarning('v1.37.2', 'v1.37')).toBeUndefined();
  });
});

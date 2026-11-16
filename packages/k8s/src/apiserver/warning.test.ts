// upstream: staging/src/k8s.io/apiserver/pkg/endpoints/filters/warning_test.go (dedupe and
// truncation of the recorder).

import { describe, expect, it } from 'vitest';
import { recordWarnings } from './warning.ts';

describe('recordWarnings', () => {
  it('keeps the order, drops empty and repeated texts', () => {
    expect(recordWarnings(['a', '', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b', 'c']);
  });

  it('cuts every text to 256 runes once the total passes 4096, and stops at the limit', () => {
    const long = (c: string) => c.repeat(1000);
    const out = recordWarnings([long('a'), long('b'), long('c'), long('d'), long('e')]);
    // Four texts fit (4000 runes); the fifth starts truncation: all five are replayed cut.
    expect(out).toEqual(['a', 'b', 'c', 'd', 'e'].map((c) => c.repeat(256)));
    const many = Array.from({ length: 20 }, (_, i) => `${String(i).padStart(2, '0')}${'x'.repeat(998)}`);
    const cut = recordWarnings(many);
    // 16 texts of 256 runes reach 4096; the rest are dropped.
    expect(cut).toHaveLength(16);
    expect(cut.every((t) => [...t].length === 256)).toBe(true);
  });
});

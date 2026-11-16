import { describe, expect, test } from 'vitest';
import { hasTokens, matchTokens, token, TOKENS } from './tokens.ts';

describe('normalization tokens', () => {
  test('every pattern matches a real example and is anchorable', () => {
    const examples: Record<keyof typeof TOKENS, string[]> = {
      uid: ['3f1c2a9e-6b0d-4e51-9a3c-0d2e5f7a1b01'],
      rv: ['1', '48213'],
      time: ['1115 20:18:03.214429', '2026-11-16T03:00:40Z', '2026-11-16T03:00:40.123456Z', '2026-11-16T10:00:40+07:00', 'Mon, 16 Nov 2026 03:00:40 +0000'],
      age: ['5s', '2m3s', '10m', '4d', '2y3d'],
      ip: ['10.96.12.7', '10.244.1.1'],
      hash: ['7c5ddbdf54', '58f9c5b48'],
      suffix: ['x8k2p', '5ftvp'],
      hex: ['187a3b4c5d6e7f80'],
      port: ['31234'],
      node: ['node01', 'node02'],
      pid: ['210912'],
      cert: ['MIIBfzCCASWgAwIBAgIU\nFTETMBEGA1UEAwwK'],
      tmp: ['2132810196', '7'],
    };
    for (const [kind, values] of Object.entries(examples)) {
      const re = new RegExp(`^${TOKENS[kind as keyof typeof TOKENS].pattern}$`);
      for (const v of values) expect(re.test(v), `${kind}: ${v}`).toBe(true);
    }
  });

  test('kubectl placeholders are not tokens', () => {
    expect(hasTokens('<none>   <invalid>')).toBe(false);
    expect(hasTokens(`nginx-${token('hash', 1)}-${token('suffix')}`)).toBe(true);
  });

  test('a token matches any value of its kind, literal text must be equal', () => {
    expect(matchTokens('nginx   1/1   Running   <<age>>', 'nginx   1/1   Running   12s')).toBe(true);
    expect(matchTokens('nginx   1/1   Running   <<age>>', 'nginx   1/1   Pending   12s')).toBe(false);
    expect(matchTokens('IP: <<ip>>', 'IP: not-an-ip')).toBe(false);
    expect(matchTokens('a.b <<age>>', 'axb 5s')).toBe(false);
  });

  test('indexed tokens bind one value each', () => {
    const want = 'uid: <<uid:1>>\nowner: <<uid:1>>\nother: <<uid:2>>';
    const a = '3f1c2a9e-6b0d-4e51-9a3c-0d2e5f7a1b01';
    const b = '4f1c2a9e-6b0d-4e51-9a3c-0d2e5f7a1b02';
    expect(matchTokens(want, `uid: ${a}\nowner: ${a}\nother: ${b}`)).toBe(true);
    expect(matchTokens(want, `uid: ${a}\nowner: ${b}\nother: ${b}`)).toBe(false);
    expect(matchTokens(want, `uid: ${a}\nowner: ${a}\nother: ${a}`)).toBe(false);
  });
});

// generateName's suffix.
// upstream: staging/src/k8s.io/apiserver/pkg/storage/names/generate.go (base cut to 58 bytes, plus
// 5 random characters); staging/src/k8s.io/apimachinery/pkg/util/rand/rand.go String (the
// alphabet "bcdfghjklmnpqrstvwxz2456789": no vowels, no 0, 1, 3). Upstream draws from a
// process-wide source; here a named PRNG stream keeps runs reproducible.

import type { Ctx } from '@simlab/kernel';

export const NAME_ALPHABET = 'bcdfghjklmnpqrstvwxz2456789';
const MAX_GENERATED_NAME_LENGTH = 63 - 5;

export function randomString(ctx: Ctx, n: number): string {
  const r = ctx.random('k8s.names');
  let out = '';
  for (let i = 0; i < n; i++) out += NAME_ALPHABET[r.int(NAME_ALPHABET.length)];
  return out;
}

export function generateName(ctx: Ctx, base: string): string {
  return (base.length > MAX_GENERATED_NAME_LENGTH ? base.slice(0, MAX_GENERATED_NAME_LENGTH) : base) + randomString(ctx, 5);
}
